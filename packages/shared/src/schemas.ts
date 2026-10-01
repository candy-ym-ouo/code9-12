import { z } from 'zod';
import {
  AnnotationKind,
  AssetRole,
  FuzzLevel,
  HitLevel,
  InspirationStatus,
  MissReason,
  TagDomain,
  TimeAnchor,
  WeatherPhenomenon,
} from './enums.js';

const zEnum = <T extends Record<string, string>>(e: T) =>
  z.enum(Object.values(e) as [string, ...string[]]);

export const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

export const weatherProfileSchema = z.object({
  cloudCoverPct: z.object({ min: z.number().min(0).max(100), max: z.number().min(0).max(100) }).optional(),
  precipProbPctMax: z.number().min(0).max(100).optional(),
  visibilityKmMin: z.number().min(0).max(100).optional(),
  windSpeedMax: z.number().min(0).max(60).optional(),
  tempC: z.object({ min: z.number(), max: z.number() }).optional(),
  phenomena: z.array(zEnum(WeatherPhenomenon)).optional(),
  hardRequirements: z.array(z.string()).optional(),
});

export const timingSchema = z.object({
  timeAnchor: zEnum(TimeAnchor),
  anchorOffsetMin: z.number().int().min(-1440).max(1440).default(0),
  elevationRange: z.array(z.number()).length(2).default([-90, 90]),
  azimuthRange: z.array(z.number()).length(2).nullable().default(null),
  azimuthTolerance: z.number().min(0).max(180).default(15),
  windowToleranceMin: z.number().int().min(1).max(180).default(12),
  weatherProfile: weatherProfileSchema.default({}),
  seasonWindow: z
    .object({ fromMonth: z.number().int().min(1).max(12), toMonth: z.number().int().min(1).max(12) })
    .nullable()
    .default(null),
  notes: z.string().max(2000).nullable().default(null),
});

export const createInspirationSchema = z.object({
  title: z.string().min(1).max(200),
  note: z.string().max(5000).nullable().optional(),
  seasonTags: z.array(z.number().int().min(1).max(12)).default([]),
});

export const updateInspirationSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  note: z.string().max(5000).nullable().optional(),
  seasonTags: z.array(z.number().int().min(1).max(12)).optional(),
  status: zEnum(InspirationStatus).optional(),
  spotId: z.string().min(1).nullable().optional(),
});

export const createTagSchema = z.object({
  domain: zEnum(TagDomain),
  name: z.string().min(1).max(60),
  parentId: z.string().nullable().optional(),
});

export const updateTagSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().optional(),
  disabled: z.boolean().optional(),
});

export const createPlaceSchema = z.object({
  name: z.string().min(1).max(120),
  city: z.string().max(60).nullable().optional(),
  district: z.string().max(60).nullable().optional(),
  addressText: z.string().max(300).nullable().optional(),
  category: z.string().max(30).nullable().optional(),
  centroid: latLngSchema.nullable().optional(),
});

export const createSpotSchema = z.object({
  placeId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  cameraBearing: z.number().min(0).max(360).default(0),
  elevationM: z.number().nullable().optional(),
  accessNote: z.string().max(2000).nullable().optional(),
  bestTimeNote: z.string().max(2000).nullable().optional(),
  visibility: z.enum(['private', 'fuzzy_shared']).default('private'),
  tz: z.string().max(64).default('Asia/Shanghai'),
});

export const updateSpotSchema = createSpotSchema.partial().omit({ placeId: true });

export const annotationSchema = z.object({
  kind: zEnum(AnnotationKind),
  geometry: z.record(z.unknown()),
  label: z.string().max(200).nullable().optional(),
});

export const albumRulesSchema = z.object({
  requireTags: z
    .array(
      z.object({
        tagIds: z.array(z.string()).min(1),
        min: z.number().int().min(1),
        required: z.boolean().default(true),
      }),
    )
    .default([]),
  requireAnchors: z
    .array(z.object({ anchor: zEnum(TimeAnchor), min: z.number().int().min(1), required: z.boolean().default(true) }))
    .default([]),
  requireWeather: z
    .array(
      z.object({
        phenomenon: zEnum(WeatherPhenomenon),
        min: z.number().int().min(1),
        required: z.boolean().default(false),
      }),
    )
    .default([]),
  requireResultShots: z.object({ min: z.number().int().min(1), required: z.boolean().default(false) }).optional(),
  totalMin: z.number().int().min(1).default(6),
  autoMatch: z.object({ enabled: z.boolean().default(true), minTagHits: z.number().int().min(1).default(2) }).default({
    enabled: true,
    minTagHits: 2,
  }),
});

export const createAlbumSchema = z.object({
  title: z.string().min(1).max(120),
  themeNote: z.string().max(2000).nullable().optional(),
  rules: albumRulesSchema.default({}),
});

export const createShareLinkSchema = z.object({
  scope: z.enum(['album', 'inspiration']),
  scopeId: z.string().min(1),
  /**
   * 允许任意级别：exact / g100 会在服务端被**强制降级**为 g500，
   * 而不是直接报错——避免"绕过校验就等于用了精确坐标"（文档 13.4）。
   */
  fuzzLevel: zEnum(FuzzLevel).default('g500'),
  expiresInDays: z.number().int().min(1).max(365).default(7),
  password: z.string().min(4).max(64).nullable().optional(),
});

export const createPlanSchema = z.object({
  windowId: z.string().min(1),
  commuteMin: z.number().int().min(0).max(600).default(30),
  companions: z.string().max(200).nullable().optional(),
  gearNote: z.string().max(1000).nullable().optional(),
});

export const fillResultSchema = z.object({
  hitLevel: zEnum(HitLevel),
  missReasons: z.array(zEnum(MissReason)).default([]),
  actualShotAt: z.string().datetime().nullable().optional(),
  actualWeather: z.record(z.unknown()).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

export const bulkTagSchema = z.object({
  ids: z.array(z.string()).min(1),
  addTagIds: z.array(z.string()).default([]),
  removeTagIds: z.array(z.string()).default([]),
});

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
  displayName: z.string().min(1).max(60),
  libraryName: z.string().min(1).max(120).optional(),
  tz: z.string().max(64).default('Asia/Shanghai'),
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const searchQuerySchema = z.object({
  q: z.string().optional(),
  status: z.string().optional(),
  tagIds: z.string().optional(),
  tagMode: z.enum(['any', 'all']).default('any'),
  anchors: z.string().optional(),
  phenomena: z.string().optional(),
  season: z.string().optional(),
  hitRateMin: z.coerce.number().min(0).max(1).optional(),
  minFillCount: z.coerce.number().int().min(0).optional(),
  placeId: z.string().optional(),
  bbox: z.string().optional(),
  nearLat: z.coerce.number().optional(),
  nearLng: z.coerce.number().optional(),
  radiusKm: z.coerce.number().positive().max(500).optional(),
  paletteHex: z.string().optional(),
  similarToAssetId: z.string().optional(),
  sort: z.enum(['recent', 'hit_rate', 'window_heat', 'distance', 'rarity']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(24),
});

export const offlineOpSchema = z.object({
  clientOpId: z.string().min(8).max(80),
  opType: z.enum(['create_inspiration', 'tag', 'fill_result', 'note']),
  payload: z.record(z.unknown()),
});

export { AssetRole };
