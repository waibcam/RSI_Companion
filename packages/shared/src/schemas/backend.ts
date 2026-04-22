// Zod schemas used by modules that render roadmap / release-note data.
//
// Historically these shapes came from a personal PHP backend at
// rsi-companion.kamille.ovh — kept here under the `Backend` namespace
// because the field layout is the one that backend used (and that the
// RSI roadmap endpoint happens to match after envelope-stripping).
// The backend itself is gone in v1.0.0:
//   - Loaners / ship-name-info: bundled as static JSON (see ../data)
//   - Roadmap: fetched directly from RSI (see ../rsi/roadmap.ts)
//   - Release notes: bundled JSON file (see the ReleaseNotes module)
//
// Only the types still actively used by the UI remain in this file.

import { z } from 'zod';

// ----------------------------------------------------------------------
// Release notes — shape of each bundled release entry.
// `notes` on the wire is a JSON string whose decoded shape is:
//   { info: string[], features: string[] }
// We keep it as a string here and decode lazily when rendering.
// ----------------------------------------------------------------------
export const ReleaseNoteRow = z.object({
  version: z.string(),
  released_at: z.number().int(),
  notes: z.string(),
});
export type ReleaseNoteRow = z.infer<typeof ReleaseNoteRow>;

export const ReleaseNoteDetails = z.object({
  info: z.array(z.string()).default([]),
  features: z.array(z.string()).default([]),
});
export type ReleaseNoteDetails = z.infer<typeof ReleaseNoteDetails>;

// ----------------------------------------------------------------------
// Roadmap — fields we render from RSI's /api/roadmap/v1/boards/<id>
// response (after stripping the `{success, code, msg, data}` envelope).
// ----------------------------------------------------------------------
export const RoadmapMeta = z.object({
  board_id: z.number().int(),
  fetched_at: z.number().int(),
  snapshot_ts: z.number().int(),
  cached: z.boolean(),
});
export type RoadmapMeta = z.infer<typeof RoadmapMeta>;

// Typed view of the RSI roadmap payload. We only validate the fields we
// actually render; everything else is passthrough. Legacy imports often
// contain null where RSI now sends strings, so we coerce.
const nullableString = z.preprocess(
  (v) => (v == null ? '' : v),
  z.string(),
);
export const RoadmapCardThumbnail = z
  .object({
    urls: z
      .object({
        square: z.string().optional(),
        rect: z.string().optional(),
        large: z.string().optional(),
        source: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .nullable();
export type RoadmapCardThumbnail = z.infer<typeof RoadmapCardThumbnail>;

export const RoadmapCard = z.object({
  id: z.number().int(),
  name: nullableString,
  description: nullableString,
  body: nullableString,
  release_id: z.number().int(),
  category_id: z.number().int(),
  status: nullableString,
  released: z.number().int().default(0),
  url_slug: nullableString,
  thumbnail: RoadmapCardThumbnail.optional(),
});
export type RoadmapCard = z.infer<typeof RoadmapCard>;

export const RoadmapRelease = z.object({
  id: z.number().int(),
  name: nullableString,
  description: nullableString,
  released: z.number().int().default(0),
  status: nullableString,
  patch_announcement_link: z.string().nullable().optional(),
  cards: z.array(RoadmapCard).default([]),
});
export type RoadmapRelease = z.infer<typeof RoadmapRelease>;

export const RoadmapCategory = z.object({
  id: z.number().int(),
  name: z.string(),
  order: z.number().int().default(0),
});
export type RoadmapCategory = z.infer<typeof RoadmapCategory>;

export const RoadmapPayload = z.object({
  name: z.string().default(''),
  description: z.string().default(''),
  releases: z.array(RoadmapRelease).default([]),
  categories: z.array(RoadmapCategory).default([]),
});
export type RoadmapPayload = z.infer<typeof RoadmapPayload>;
