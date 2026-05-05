// Static reference data bundled with the extension.
//
// These datasets used to live on a personal backend server
// (rsi-companion.kamille.ovh) and were fetched on every extension boot.
// They change very rarely — loaner mappings shift when CIG releases a
// new ship (a few times a year), and the ship-name aliases only need
// updating when RSI renames a chassis. Shipping them as inlined JSON
// means the extension works completely offline for these lookups,
// doesn't depend on any hosted infrastructure, and has no latency hit
// at popup open.
//
// Trade-off: edits ship with the next extension release instead of a
// hot server edit. Acceptable — the data is stable enough.
//
// LIGHT vs HEAVY:
// The two heavy datasets (~48 kB SHIP_NAME_CATALOG, ~30 kB SHIP_CODES)
// live in their own modules — `./ship-name-info.ts` and
// `./ship-codes.ts` — so popup module chunks that don't need them
// (Comm-Link, Spectrum, Patch Notes, Settings, etc.) don't drag them
// in via the shared barrel. Consumers that DO need them
// (`rsi/hangar.ts`, `entrypoints/background.ts`) import them
// directly from those subpaths. They are intentionally NOT
// re-exported here.

import loanersData from './loaners.json';
import bundlesData from './bundles.json';
import releaseNotesData from './release-notes.json';

/** Ship-id → [loaner-id, ...] mapping. Same shape the legacy
 *  `/loaners` endpoint returned (without the success/code envelope). */
export const LOANERS: Record<string, string[]> = loanersData as Record<string, string[]>;

/** Ship-id → [bundled-child-ship-id, ...] mapping for ownership-
 *  transitive packages: buying the parent SKU gives you N child ships
 *  outright (NOT as loaners — real owned units, just consolidated
 *  into a single hangar entry on RSI's side). Sourced from the
 *  /ship-matrix description text, which lists each ship's included
 *  contents in plain English. Examples:
 *    Constellation Phoenix → Lynx + P-72 Archimedes
 *    Constellation Phoenix Emerald → Lynx + P-72 Archimedes Emerald
 *  Distinct from LOANERS: loaner = temporary chassis access while a
 *  ship is in development; bundle = ownership transitive across SKUs. */
export const BUNDLES: Record<string, string[]> = bundlesData as Record<string, string[]>;

/** Bundled release-notes timeline. Each entry's `notes` field is a
 *  JSON-stringified `{info, features}` the UI parses lazily. Shipped
 *  newest-first so the ReleaseNotes module renders in display order
 *  without sorting. */
export const RELEASE_NOTES: ReadonlyArray<{
  version: string;
  released_at: number;
  notes: string;
}> = releaseNotesData as Array<{
  version: string;
  released_at: number;
  notes: string;
}>;
