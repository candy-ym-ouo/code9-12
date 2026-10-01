import { Router } from 'express';
import { searchQuerySchema } from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import { search, searchWithFallback, type SearchParams } from '../services/search.js';
import { getDb } from '../db.js';

export const searchRouter = Router();
searchRouter.use(authenticate());

function toParams(query: unknown): SearchParams {
  const q = searchQuerySchema.parse(query);
  const bbox = q.bbox
    ? (() => {
        const [minLat, minLng, maxLat, maxLng] = q.bbox.split(',').map(Number);
        return { minLat, minLng, maxLat, maxLng };
      })()
    : undefined;

  return {
    q: q.q,
    status: q.status,
    tagIds: q.tagIds ? q.tagIds.split(',').filter(Boolean) : undefined,
    tagMode: q.tagMode,
    anchors: q.anchors ? q.anchors.split(',').filter(Boolean) : undefined,
    phenomena: q.phenomena ? q.phenomena.split(',').filter(Boolean) : undefined,
    season: q.season ? q.season.split(',').map(Number).filter((n) => n >= 1 && n <= 12) : undefined,
    hitRateMin: q.hitRateMin,
    minFillCount: q.minFillCount,
    placeId: q.placeId,
    bbox,
    near:
      q.nearLat !== undefined && q.nearLng !== undefined
        ? { lat: q.nearLat, lng: q.nearLng, radiusKm: q.nearRadiusKm }
        : undefined,
    paletteHex: q.paletteHex,
    similarToAssetId: q.similarToAssetId,
    excludeAlbum: (query as Record<string, string>).excludeAlbum,
    sort: q.sort,
    minHits: q.minHits,
    page: q.page,
    size: q.size,
  };
}

/** 组合检索（含零结果兜底，见文档 6.6 / 15.3） */
searchRouter.get(
  '/search',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const params = toParams(req.query);
    const fallback = String(req.query.fallback ?? 'true') !== 'false';
    const result = fallback ? searchWithFallback(ctx.libraryId, ctx, params) : search(ctx.libraryId, ctx, params);
    ok(res, result);
  }),
);

/** 零结果兜底单独入口，便于前端"我就是要看放宽了什么" */
searchRouter.get(
  '/search/fallback',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, searchWithFallback(ctx.libraryId, ctx, toParams(req.query)));
  }),
);

/** 地图框选：只返回聚合点与数量；owner 返回精确点，member 返回模糊点 */
searchRouter.get(
  '/search/nearby',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const params = toParams(req.query);
    const result = search(ctx.libraryId, ctx, { ...params, size: 200 });
    const points = result.items
      .filter((i) => i.spot)
      .map((i) => ({
        inspirationId: i.id,
        title: i.title,
        kind: ctx.role === 'owner' ? 'precise' : 'fuzzy',
        lat: ctx.role === 'owner' && i.spot?.precise ? i.spot.precise.lat : i.spot?.fuzz.lat,
        lng: ctx.role === 'owner' && i.spot?.precise ? i.spot.precise.lng : i.spot?.fuzz.lng,
        fuzzLabel: i.spot?.fuzz.label ?? null,
        thumbUrl: i.assets[0]?.thumbUrl ?? null,
        verdict: i.windowSummary?.nextGoodAt ? 'has_window' : 'no_window',
      }))
      .filter((p) => p.lat !== null && p.lng !== null);

    ok(res, { points, total: result.total, fuzzLevel: ctx.defaultFuzzLevel });
  }),
);

/** 检索页的标签热榜（"库里最常用的标签是什么"） */
searchRouter.get(
  '/search/tag-stats',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const rows = getDb()
      .prepare(
        `SELECT t.id, t.domain, t.name, t.usage_count FROM tag t
         WHERE t.library_id = ? AND t.disabled = 0 AND t.usage_count > 0
         ORDER BY t.usage_count DESC LIMIT 40`,
      )
      .all(ctx.libraryId);
    ok(res, { items: rows });
  }),
);
