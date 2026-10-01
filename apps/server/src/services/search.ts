import {
  bboxContains,
  distanceKm,
  paletteSimilarity,
  WEATHER_PHENOMENON_LABEL,
  type PaletteColor,
  type SearchRelaxation,
  type SearchResult,
} from '@flil/shared';
import { getDb, parseJson } from '../db.js';
import { toInspirationDto, type InspirationRow, type SerializeContext } from './serialization.js';
import { paletteOf, type AssetRow } from './assets.js';
import { loadSpotGeom } from './windowEngine.js';

export interface SearchParams {
  q?: string;
  status?: string;
  tagIds?: string[];
  tagMode?: 'any' | 'all';
  /** 标签需要命中的个数（降级编排逐级下调：all → … → 1 → 忽略） */
  tagMinMatch?: number;
  anchors?: string[];
  phenomena?: string[];
  /** 天气现象需要同时满足的项数（降级编排逐级下调：全部 → 1 → 忽略） */
  phenomenaMinMatch?: number;
  season?: number[];
  hitRateMin?: number;
  minFillCount?: number;
  placeId?: string;
  bbox?: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  near?: { lat: number; lng: number; radiusKm?: number };
  paletteHex?: string;
  similarToAssetId?: string;
  excludeAlbum?: string;
  sort?: 'recent' | 'hit_rate' | 'window_heat' | 'distance' | 'rarity';
  /** 降级编排的命中数目标：命中数达到该值即停止放宽 */
  minHits?: number;
  page?: number;
  size?: number;
}

interface Candidate {
  row: InspirationRow;
  distance: number | null;
  similarity?: number;
}

type SearchInspirationRow = InspirationRow & { weather_profile?: string | null };

/** 周边检索半径逐级放宽的上限（km），避免“放宽”变成全球检索 */
const MAX_NEAR_RADIUS_KM = 1000;
/** 未显式给 minHits 时的默认命中数目标（至少填满一屏） */
const DEFAULT_TARGET_HITS = 24;

function fuzzPoint(geom: { lat: number; lng: number }): { lat: number; lng: number } {
  // 非 owner 的地理过滤用模糊点（约 500m 量化到 0.005°），与模糊化输出保持一致
  return { lat: Math.round(geom.lat / 0.005) * 0.005, lng: Math.round(geom.lng / 0.005) * 0.005 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function fmtKm(km: number): string {
  return Number.isInteger(km) ? String(km) : km.toFixed(1);
}

/** 以中心点不变按 factor 倍扩大框选范围（钳制在合法经纬度内） */
function expandBbox(
  bbox: NonNullable<SearchParams['bbox']>,
  factor: number,
): NonNullable<SearchParams['bbox']> {
  const centerLat = (bbox.minLat + bbox.maxLat) / 2;
  const centerLng = (bbox.minLng + bbox.maxLng) / 2;
  return {
    minLat: clamp(centerLat - ((centerLat - bbox.minLat) * factor), -90, 90),
    maxLat: clamp(centerLat + ((bbox.maxLat - centerLat) * factor), -90, 90),
    minLng: clamp(centerLng - ((centerLng - bbox.minLng) * factor), -180, 180),
    maxLng: clamp(centerLng + ((bbox.maxLng - centerLng) * factor), -180, 180),
  };
}

function phenomenonLabel(p: string): string {
  return WEATHER_PHENOMENON_LABEL[p as keyof typeof WEATHER_PHENOMENON_LABEL] ?? p;
}

/**
 * 组合检索（文档 15.1）：SQL 收敛候选 → JS 做空间、天气现象与色彩相似。
 * member 的地理过滤使用模糊坐标，避免精确位置成为旁路（文档 13.5）。
 */
export function search(libraryId: string, ctx: SerializeContext, params: SearchParams): SearchResult {
  const db = getDb();
  const where: string[] = ['i.library_id = ?', 'i.deleted_at IS NULL'];
  const args: (string | number)[] = [libraryId];

  if (params.status) {
    const statuses = params.status
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length) {
      where.push(`i.status IN (${statuses.map(() => '?').join(',')})`);
      args.push(...statuses);
    }
  }

  if (params.season?.length) {
    where.push(`(${params.season.map(() => 'i.season_tags LIKE ?').join(' OR ')})`);
    for (const m of params.season) args.push(`%"${m}"%`);
  }

  if (params.placeId) {
    where.push('s.place_id = ?');
    args.push(params.placeId);
  }
  if (params.hitRateMin !== undefined) {
    where.push('i.hit_rate >= ?');
    args.push(params.hitRateMin);
  }
  if (params.minFillCount !== undefined) {
    where.push('(i.hit_count + i.partial_count + i.miss_count) >= ?');
    args.push(params.minFillCount);
  }

  // 标签：按“需命中个数”过滤。降级编排把该值逐级下调（all → n-1 → … → 1 → 0 忽略）。
  const tagCount = params.tagIds?.length ?? 0;
  const tagRequired =
    tagCount > 0
      ? clamp(params.tagMinMatch ?? (params.tagMode === 'all' ? tagCount : 1), 0, tagCount)
      : 0;
  if (tagCount > 0 && tagRequired >= 1) {
    // 用 >=：命中更多标签的卡在放宽到更低档时仍然保留（放宽必须单调增加结果）
    where.push(
      `(SELECT COUNT(DISTINCT tag_id) FROM inspiration_tag WHERE inspiration_id = i.id AND tag_id IN (${params
        .tagIds!.map(() => '?')
        .join(',')})) >= ?`,
    );
    args.push(...params.tagIds!, tagRequired);
  }

  if (params.anchors?.length) {
    where.push(`t.time_anchor IN (${params.anchors.map(() => '?').join(',')})`);
    args.push(...params.anchors);
  }

  // 天气现象：需要“同时满足”的档（minMatch>=2）无法用 LIKE/OR 预筛（那只要求出现任意一项，
  // 会把“有雾无雪”这类候选误杀），因此只在 minMatch===1（语义恰为“出现任一”）时做 SQL 粗筛，
  // 其余档位取出全量候选后在 JS 里按交集计数精确判定。
  const phenomenaCount = params.phenomena?.length ?? 0;
  const phenomenaRequired =
    phenomenaCount > 0 ? clamp(params.phenomenaMinMatch ?? phenomenaCount, 0, phenomenaCount) : 0;
  if (phenomenaCount > 0 && phenomenaRequired === 1) {
    where.push(`(${params.phenomena!.map(() => 't.weather_profile LIKE ?').join(' OR ')})`);
    for (const p of params.phenomena!) args.push(`%"${p}"%`);
  }

  if (params.excludeAlbum) {
    where.push('NOT EXISTS (SELECT 1 FROM album_item WHERE album_id = ? AND inspiration_id = i.id)');
    args.push(params.excludeAlbum);
  }

  if (params.q && params.q.trim()) {
    where.push(
      `(i.id IN (SELECT inspiration_id FROM inspiration_fts WHERE inspiration_fts MATCH ?) OR i.title LIKE ?)`,
    );
    args.push(`${params.q.trim().replace(/"/g, '')}*`, `%${params.q.trim()}%`);
  }

  const sql = `
    SELECT i.*, t.weather_profile AS weather_profile FROM inspiration i
    LEFT JOIN spot s ON s.id = i.spot_id
    LEFT JOIN timing t ON t.inspiration_id = i.id
    WHERE ${where.join(' AND ')}
    ORDER BY i.updated_at DESC, i.id ASC
    LIMIT 500`;

  let rows = db.prepare(sql).all(...args) as SearchInspirationRow[];

  if (phenomenaCount > 0 && phenomenaRequired >= 1) {
    rows = rows.filter((row) => {
      const profile = parseJson<{ phenomena?: unknown }>(row.weather_profile ?? null, {});
      const have = new Set(
        Array.isArray(profile.phenomena) ? profile.phenomena.map((p) => String(p)) : [],
      );
      let hits = 0;
      for (const p of params.phenomena!) if (have.has(p)) hits++;
      return hits >= phenomenaRequired;
    });
  }

  const candidates: Candidate[] = [];
  for (const row of rows) {
    let distance: number | null = null;
    if (params.bbox || params.near) {
      if (!row.spot_id) continue;
      const geom = loadSpotGeom(row.spot_id);
      if (!geom) continue;
      const point = ctx.role === 'owner' ? { lat: geom.lat, lng: geom.lng } : fuzzPoint(geom);
      if (params.bbox && !bboxContains(params.bbox, point)) continue;
      if (params.near) {
        distance = distanceKm(params.near, point);
        if (params.near.radiusKm && distance > params.near.radiusKm) continue;
      }
    }
    candidates.push({ row, distance });
  }

  const targetPalette = resolvePalette(params);
  let working = candidates;
  if (targetPalette) {
    working = working
      .map((c) => {
        const asset = db
          .prepare('SELECT * FROM asset WHERE inspiration_id = ? ORDER BY created_at ASC LIMIT 1')
          .get(c.row.id) as AssetRow | undefined;
        return { ...c, similarity: asset ? paletteSimilarity(targetPalette, paletteOf(asset)) : 0 };
      })
      .filter((c) => (c.similarity ?? 0) >= 0.35)
      .sort(
        (a, b) =>
          (b.similarity ?? 0) - (a.similarity ?? 0) ||
          (a.row.updated_at < b.row.updated_at ? 1 : a.row.updated_at > b.row.updated_at ? -1 : 0) ||
          a.row.id.localeCompare(b.row.id),
      );
  }

  const sorted = sortCandidates(working, params.sort ?? 'recent');
  const page = params.page ?? 1;
  const size = params.size ?? 24;
  const paged = sorted.slice((page - 1) * size, page * size);

  return {
    items: paged.map((c) => toInspirationDto(c.row, ctx, { withWindowSummary: false })),
    total: sorted.length,
    relaxed: [],
  };
}

function resolvePalette(params: SearchParams): PaletteColor[] | null {
  const db = getDb();
  if (params.similarToAssetId) {
    const asset = db.prepare('SELECT * FROM asset WHERE id = ?').get(params.similarToAssetId) as
      | AssetRow
      | undefined;
    if (asset) return parseJson<PaletteColor[]>(asset.palette, []);
  }
  if (params.paletteHex) return [{ hex: params.paletteHex, ratio: 1 }];
  return null;
}

/** 单次检索内固定“30 天”时间锚并缓存计数，保证排序在同一次调用中确定且无重复计算 */
function makeHeatCounter(): (inspirationId: string) => number {
  const until = new Date(Date.now() + 30 * 86400000).toISOString();
  const cache = new Map<string, number>();
  return (inspirationId: string) => {
    const cached = cache.get(inspirationId);
    if (cached !== undefined) return cached;
    const n = (
      getDb()
        .prepare(
          `SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id = ? AND verdict = 'good' AND start_at <= ?`,
        )
        .get(inspirationId, until) as { n: number }
    ).n;
    cache.set(inspirationId, n);
    return n;
  };
}

function sortCandidates(items: Candidate[], sort: NonNullable<SearchParams['sort']>): Candidate[] {
  const copy = [...items];
  // 全部排序都以 id 作为最终决胜键，保证相同输入下顺序稳定（无随机、无并列翻转）
  const byId = (a: Candidate, b: Candidate) => a.row.id.localeCompare(b.row.id);
  const byRecent = (a: Candidate, b: Candidate) =>
    a.row.updated_at < b.row.updated_at ? 1 : a.row.updated_at > b.row.updated_at ? -1 : 0;
  const heatOf = makeHeatCounter();
  switch (sort) {
    case 'hit_rate':
      return copy.sort(
        (a, b) =>
          b.row.hit_rate - a.row.hit_rate ||
          b.row.hit_count +
            b.row.partial_count +
            b.row.miss_count -
            (a.row.hit_count + a.row.partial_count + a.row.miss_count) ||
          byId(a, b),
      );
    case 'distance':
      return copy.sort(
        (a, b) =>
          (a.distance ?? 1e9) - (b.distance ?? 1e9) || byRecent(a, b) || byId(a, b),
      );
    case 'window_heat':
      return copy.sort((a, b) => heatOf(b.row.id) - heatOf(a.row.id) || byId(a, b));
    case 'rarity':
      return copy.sort((a, b) => heatOf(a.row.id) - heatOf(b.row.id) || byId(a, b));
    default:
      return copy.sort((a, b) => byRecent(a, b) || byId(a, b));
  }
}

interface LadderStep {
  field: string;
  from: string;
  to: string;
  apply: (p: SearchParams) => void;
}

function loadTagNames(libraryId: string, ids: string[]): Map<string, string> {
  if (!ids.length) return new Map();
  const rows = getDb()
    .prepare(
      `SELECT id, name FROM tag WHERE library_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .all(libraryId, ...ids) as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * 降级阶梯（文档 15.3）：严格按「标签 → 气象 → 距离」顺序生成，
 * 每一级只放宽一个维度，且必须相对上一级确实更宽（单调，不会重新收紧）。
 */
function buildLadderSteps(params: SearchParams, tagNames: Map<string, string>): LadderStep[] {
  const steps: LadderStep[] = [];

  // ① 标签：需要命中的标签数逐级下调。r0 为初始严格态（all=全部，any=1）。
  // r0 <= 1（单标签 / 任一模式）时标签已是最宽档，无“先放松标签”的步骤，直接进入下一维度。
  const tagIds = params.tagIds ?? [];
  if (tagIds.length) {
    const explicit = params.tagMinMatch;
    const r0 =
      explicit !== undefined
        ? clamp(explicit, 0, tagIds.length)
        : clamp(params.tagMode === 'all' ? tagIds.length : 1, 1, tagIds.length);
    if (r0 >= 2) {
      const names = tagIds.map((id) => tagNames.get(id) ?? id);
      for (let k = r0 - 1; k >= 0; k--) {
        const next = k;
        steps.push({
          field: 'tagMinMatch',
          from:
            k === r0 - 1 && r0 === tagIds.length
              ? `标签全部命中（${r0}/${tagIds.length}）：${names.join('、')}`
              : `标签需命中 ${k + 1}/${tagIds.length} 个`,
          to: k === 0 ? '忽略标签要求' : `标签只需命中 ${k}/${tagIds.length} 个（任选）`,
          apply: (p) => {
            p.tagMinMatch = next;
          },
        });
      }
    }
  }

  // ② 气象：所选天气现象需同时满足的项数逐级下调（全部 → n-1 → … → 1 → 忽略）。
  const phenomena = params.phenomena ?? [];
  if (phenomena.length) {
    const explicit = params.phenomenaMinMatch;
    const r0 = explicit !== undefined ? clamp(explicit, 0, phenomena.length) : phenomena.length;
    if (r0 >= 1) {
      const labels = phenomena.map(phenomenonLabel);
      for (let k = r0 - 1; k >= 0; k--) {
        const next = k;
        steps.push({
          field: 'phenomenaMinMatch',
          from:
            k === r0 - 1 && r0 === phenomena.length
              ? `天气现象需同时满足全部 ${r0} 项：${labels.join('、')}`
              : `天气现象需满足 ${k + 1}/${phenomena.length} 项`,
          to: k === 0 ? '忽略天气现象要求' : `天气现象满足任意 ${k}/${phenomena.length} 项即可`,
          apply: (p) => {
            p.phenomenaMinMatch = next;
          },
        });
      }
    }
  }

  // ③ 距离：周边半径逐级翻倍（封顶 1000km）；未设半径时本就无距离上限，不产生步骤。
  if (params.near?.radiusKm) {
    let radius = params.near.radiusKm;
    while (radius < MAX_NEAR_RADIUS_KM) {
      const fromRadius = radius;
      const nextRadius = Math.min(radius * 2, MAX_NEAR_RADIUS_KM);
      steps.push({
        field: 'nearRadius',
        from: `周边检索半径 ${fmtKm(fromRadius)} km`,
        to:
          nextRadius === MAX_NEAR_RADIUS_KM && fromRadius * 2 >= MAX_NEAR_RADIUS_KM
            ? `周边检索半径扩大到上限 ${fmtKm(nextRadius)} km`
            : `周边检索半径扩大到 ${fmtKm(nextRadius)} km`,
        apply: (p) => {
          if (p.near) p.near = { ...p.near, radiusKm: nextRadius };
        },
      });
      radius = nextRadius;
    }
  }

  // ③ 距离（框选）：以中心点不变扩大 2 倍、再扩大到 4 倍，之后不再放宽。
  if (params.bbox) {
    for (const level of [2, 4]) {
      steps.push({
        field: 'bbox',
        from: level === 2 ? '地图框选范围' : '地图框选范围已扩大 2 倍',
        to: `地图框选范围以中心不变扩大 ${level} 倍`,
        apply: (p) => {
          if (p.bbox) p.bbox = expandBbox(p.bbox, 2);
        },
      });
    }
  }

  return steps;
}

function cloneParams(params: SearchParams): SearchParams {
  return {
    ...params,
    tagIds: params.tagIds ? [...params.tagIds] : undefined,
    phenomena: params.phenomena ? [...params.phenomena] : undefined,
    anchors: params.anchors ? [...params.anchors] : undefined,
    season: params.season ? [...params.season] : undefined,
    near: params.near ? { ...params.near } : undefined,
    bbox: params.bbox ? { ...params.bbox } : undefined,
  };
}

/**
 * 检索降级编排（文档 6.6 / 15.3）：
 * 命中数不足目标时，按「标签 → 气象 → 距离」逐级放宽，每一级都返回
 * “放宽了什么、放宽前后各命中多少张”，不允许静默放宽。
 * 相同输入必然得到相同排序与总数（阶梯由参数静态生成，无随机、无时间相关抖动）。
 */
export function searchWithFallback(
  libraryId: string,
  ctx: SerializeContext,
  params: SearchParams,
): SearchResult {
  const target = clamp(params.minHits ?? Math.max(params.size ?? DEFAULT_TARGET_HITS, DEFAULT_TARGET_HITS), 1, 100);

  const direct = search(libraryId, ctx, params);
  if (direct.total >= target) return direct;

  const working = cloneParams(params);
  const tagNames = loadTagNames(libraryId, working.tagIds ?? []);
  const ladder = buildLadderSteps(working, tagNames);

  const applied: SearchRelaxation[] = [];
  let current = direct;

  for (const step of ladder) {
    const hitsBefore = current.total;
    step.apply(working);
    current = search(libraryId, ctx, working);
    applied.push({
      field: step.field,
      from: step.from,
      to: step.to,
      hitsBefore,
      hitsAfter: current.total,
      note: `已放宽：${step.from} → ${step.to}（命中 ${hitsBefore} → ${current.total} 张）`,
    });
    if (current.total >= target) {
      return { ...current, relaxed: applied, minHits: target };
    }
  }

  if (current.total > 0) {
    return { ...current, relaxed: applied, minHits: target };
  }

  return {
    items: [],
    total: 0,
    relaxed: applied,
    minHits: target,
    suggestions: {
      tagIds: [],
      tagNames: [],
      message:
        '标签、气象与距离逐级放宽后仍无结果。可以：① 新建一张卡；② 检查是否要新增标签；③ 用「以图找相似」换个入口；④ 去收件箱把未整理的卡补上标签。',
    },
  };
}
