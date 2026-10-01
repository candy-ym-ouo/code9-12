import {
  WEATHER_PHENOMENON_LABEL,
  bboxContains,
  distanceKm,
  paletteSimilarity,
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
  anchors?: string[];
  phenomena?: string[];
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
  page?: number;
  size?: number;
}

interface Candidate {
  row: InspirationRow;
  distance: number | null;
  similarity?: number;
}

function fuzzPoint(geom: { lat: number; lng: number }): { lat: number; lng: number } {
  // 非 owner 的地理过滤用模糊点（约 500m 量化到 0.005°），与模糊化输出保持一致
  return { lat: Math.round(geom.lat / 0.005) * 0.005, lng: Math.round(geom.lng / 0.005) * 0.005 };
}

/**
 * 组合检索（文档 15.1）：SQL 收敛候选 → JS 做空间与色彩相似。
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

  if (params.tagIds?.length) {
    if (params.tagMode === 'all') {
      where.push(
        `(SELECT COUNT(DISTINCT tag_id) FROM inspiration_tag WHERE inspiration_id = i.id AND tag_id IN (${params.tagIds
          .map(() => '?')
          .join(',')})) = ?`,
      );
      args.push(...params.tagIds, params.tagIds.length);
    } else {
      where.push(
        `EXISTS (SELECT 1 FROM inspiration_tag WHERE inspiration_id = i.id AND tag_id IN (${params.tagIds
          .map(() => '?')
          .join(',')}))`,
      );
      args.push(...params.tagIds);
    }
  }

  if (params.anchors?.length) {
    where.push(`t.time_anchor IN (${params.anchors.map(() => '?').join(',')})`);
    args.push(...params.anchors);
  }

  if (params.phenomena?.length) {
    where.push(`(${params.phenomena.map(() => 't.weather_profile LIKE ?').join(' OR ')})`);
    for (const p of params.phenomena) args.push(`%"${p}"%`);
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
    SELECT i.* FROM inspiration i
    LEFT JOIN spot s ON s.id = i.spot_id
    LEFT JOIN timing t ON t.inspiration_id = i.id
    WHERE ${where.join(' AND ')}
    ORDER BY i.updated_at DESC, i.id ASC
    LIMIT 2000`;

  const rows = db.prepare(sql).all(...args) as InspirationRow[];
  let candidates: Candidate[] = [];

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
        if (params.near.radiusKm !== undefined && distance > params.near.radiusKm) continue;
      }
    }
    candidates.push({ row, distance });
  }

  const targetPalette = resolvePalette(params);
  if (targetPalette) {
    candidates = candidates
      .map((c) => {
        const asset = db
          .prepare('SELECT * FROM asset WHERE inspiration_id = ? ORDER BY created_at ASC, id ASC LIMIT 1')
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

  const sorted = sortCandidates(candidates, params.sort ?? 'recent');
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

function goodWindowCount(inspirationId: string): number {
  const until = new Date(Date.now() + 30 * 86400000).toISOString();
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM repro_window WHERE inspiration_id = ? AND verdict = 'good' AND start_at <= ?`,
      )
      .get(inspirationId, until) as { n: number }
  ).n;
}

function compareRecent(a: Candidate, b: Candidate): number {
  return (
    (a.row.updated_at < b.row.updated_at ? 1 : a.row.updated_at > b.row.updated_at ? -1 : 0) ||
    a.row.id.localeCompare(b.row.id)
  );
}

function sortCandidates(items: Candidate[], sort: NonNullable<SearchParams['sort']>): Candidate[] {
  const copy = [...items];
  switch (sort) {
    case 'hit_rate':
      return copy.sort(
        (a, b) =>
          b.row.hit_rate - a.row.hit_rate ||
          b.row.hit_count +
            b.row.partial_count +
            b.row.miss_count -
            (a.row.hit_count + a.row.partial_count + a.row.miss_count) ||
          compareRecent(a, b),
      );
    case 'distance':
      return copy.sort(
        (a, b) =>
          (a.distance ?? Number.POSITIVE_INFINITY) - (b.distance ?? Number.POSITIVE_INFINITY) ||
          compareRecent(a, b),
      );
    case 'window_heat':
      return copy.sort((a, b) => goodWindowCount(b.row.id) - goodWindowCount(a.row.id) || compareRecent(a, b));
    case 'rarity':
      return copy.sort((a, b) => goodWindowCount(a.row.id) - goodWindowCount(b.row.id) || compareRecent(a, b));
    default:
      return copy.sort(compareRecent);
  }
}

interface Relaxation {
  field: string;
  from: string;
  to: string;
  apply: (p: SearchParams) => void;
}

function cloneParams(params: SearchParams): SearchParams {
  return {
    ...params,
    tagIds: params.tagIds ? [...params.tagIds] : undefined,
    phenomena: params.phenomena ? [...params.phenomena] : undefined,
    anchors: params.anchors ? [...params.anchors] : undefined,
    season: params.season ? [...params.season] : undefined,
    bbox: params.bbox ? { ...params.bbox } : undefined,
    near: params.near ? { ...params.near } : undefined,
    page: 1,
  };
}

function tagNames(libraryId: string, tagIds: string[]): string {
  if (!tagIds.length) return '未指定标签';
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT name FROM tag WHERE library_id = ? AND id IN (${tagIds.map(() => '?').join(',')}) ORDER BY name ASC`,
    )
    .all(libraryId, ...tagIds) as { name: string }[];
  const names = rows.map((r) => r.name);
  return names.length ? names.join('、') : tagIds.join('、');
}

function roundKm(value: number): number {
  return Math.round(value * 100) / 100;
}

function bboxRadiusKm(bbox: NonNullable<SearchParams['bbox']>): number {
  const center = {
    lat: (bbox.minLat + bbox.maxLat) / 2,
    lng: (bbox.minLng + bbox.maxLng) / 2,
  };
  const corners = [
    { lat: bbox.minLat, lng: bbox.minLng },
    { lat: bbox.minLat, lng: bbox.maxLng },
    { lat: bbox.maxLat, lng: bbox.minLng },
    { lat: bbox.maxLat, lng: bbox.maxLng },
  ];
  return roundKm(Math.max(...corners.map((c) => distanceKm(center, c)), 0.1));
}

function weatherLabels(phenomena: string[]): string {
  return phenomena
    .map((p) => WEATHER_PHENOMENON_LABEL[p as keyof typeof WEATHER_PHENOMENON_LABEL] ?? p)
    .join('、');
}

function distanceStep(
  field: string,
  center: { lat: number; lng: number },
  fromLabel: string,
  nextRadius: number,
): Relaxation {
  return {
    field,
    from: fromLabel,
    to: `距离半径放宽至 ${nextRadius} km`,
    apply: (p) => {
      p.near = { ...center, radiusKm: nextRadius };
      delete p.bbox;
    },
  };
}

function pushDistanceSteps(
  plan: Relaxation[],
  center: { lat: number; lng: number },
  initialFromLabel: string,
  initialRadius: number,
): void {
  const maxRadiusKm = 500;
  let nextRadius = initialRadius;
  let fromLabel = initialFromLabel;
  let stepIndex = 1;

  while (nextRadius < maxRadiusKm) {
    const radius = roundKm(Math.min(nextRadius, maxRadiusKm));
    plan.push(distanceStep(stepIndex === 1 ? 'distance' : `distance:${stepIndex}`, center, fromLabel, radius));
    fromLabel = `距离半径 ${radius} km`;
    nextRadius = radius * 2;
    stepIndex += 1;
  }
}

/**
 * 降级只按固定维度逐级推进：标签（all → any → 去掉）→ 气象（去掉天气现象）
 * → 距离（框选转半径，随后半径倍增）。其它过滤条件保持不变，避免静默扩大语义。
 */
function relaxationPlan(libraryId: string, params: SearchParams): Relaxation[] {
  const plan: Relaxation[] = [];
  const labels = tagNames(libraryId, params.tagIds ?? []);

  if (params.tagIds?.length && params.tagIds.length > 1 && params.tagMode === 'all') {
    plan.push({
      field: 'tagMode',
      from: `标签「${labels}」必须全部命中`,
      to: '标签任一命中',
      apply: (p) => {
        p.tagMode = 'any';
      },
    });
  }

  if (params.tagIds?.length) {
    plan.push({
      field: 'tagIds',
      from: params.tagMode === 'all' ? `仍需命中标签「${labels}」` : `至少命中标签「${labels}」之一`,
      to: '忽略标签条件',
      apply: (p) => {
        delete p.tagIds;
        p.tagMode = 'any';
      },
    });
  }

  if (params.phenomena?.length) {
    plan.push({
      field: 'phenomena',
      from: `气象现象「${weatherLabels(params.phenomena)}」`,
      to: '忽略气象现象',
      apply: (p) => {
        delete p.phenomena;
      },
    });
  }

  if (params.bbox) {
    const center = {
      lat: (params.bbox.minLat + params.bbox.maxLat) / 2,
      lng: (params.bbox.minLng + params.bbox.maxLng) / 2,
    };
    const initialRadius = roundKm(bboxRadiusKm(params.bbox) * 2);
    pushDistanceSteps(plan, center, '仅保留地图框选范围内的机位', initialRadius);
  } else if (params.near?.radiusKm !== undefined) {
    const center = { lat: params.near.lat, lng: params.near.lng };
    const initialRadius = roundKm(params.near.radiusKm * 2);
    pushDistanceSteps(plan, center, `距离 ≤ ${roundKm(params.near.radiusKm)} km`, initialRadius);
  }

  return plan;
}

function relaxationNote(step: Relaxation, before: number, after: number, target: number): string {
  return `已放宽：${step.from} → ${step.to}；当前命中 ${before} 张，少于目标 ${target} 张，放宽后命中 ${after} 张。`;
}

/** 命中不足一页时按固定顺序兜底；每次放宽都返回命中数变化，不允许静默放宽。 */
export function searchWithFallback(
  libraryId: string,
  ctx: SerializeContext,
  params: SearchParams,
): SearchResult {
  const target = Math.min(Math.max(params.size ?? 24, 1), 100);
  const requestedPage = Math.max(params.page ?? 1, 1);
  const working = cloneParams(params);

  const direct = search(libraryId, ctx, working);
  if (direct.total >= target) {
    return requestedPage === 1 ? direct : search(libraryId, ctx, { ...working, page: requestedPage });
  }

  const applied: SearchRelaxation[] = [];

  let hitCountBefore = direct.total;

  for (const step of relaxationPlan(libraryId, params)) {
    step.apply(working);
    const result = search(libraryId, ctx, working);
    const relaxed: SearchRelaxation = {
      field: step.field,
      from: step.from,
      to: step.to,
      hitCountBefore,
      hitCountAfter: result.total,
      note: relaxationNote(step, hitCountBefore, result.total, target),
    };
    applied.push(relaxed);
    hitCountBefore = result.total;

    if (result.total >= target) {
      const paged =
        requestedPage === 1 ? result : search(libraryId, ctx, { ...working, page: requestedPage });
      return { ...paged, relaxed: applied };
    }
  }

  const finalResult = search(libraryId, ctx, { ...working, page: requestedPage });
  if (finalResult.total > 0 || applied.length === 0) return { ...finalResult, relaxed: applied };

  return {
    items: [],
    total: 0,
    relaxed: applied,
    suggestions: {
      tagIds: [],
      tagNames: [],
      message:
        '按标签、气象与距离逐级放宽后仍无结果。可以：① 新建一张卡；② 检查是否要新增标签；③ 用「以图找相似」换个入口；④ 去收件箱把未整理的卡补上标签。',
    },
  };
}
