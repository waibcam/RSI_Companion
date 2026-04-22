// Static reference data bundled with the extension.
//
// These two datasets used to live on a personal backend server
// (rsi-companion.kamille.ovh) and were fetched on every extension boot.
// Both change very rarely — loaner mappings shift when CIG releases a
// new ship (a few times a year), and the ship-name aliases only need
// updating when RSI renames a chassis. Shipping them as inlined JSON
// means the extension works completely offline for these lookups,
// doesn't depend on any hosted infrastructure, and has no latency hit
// at popup open.
//
// Trade-off: edits ship with the next extension release instead of a
// hot server edit. Acceptable — the data is stable enough.

import loanersData from './loaners.json';
import shipNameInfoData from './ship-name-info.json';
import releaseNotesData from './release-notes.json';

/** Ship-id → [loaner-id, ...] mapping. Same shape the legacy
 *  `/loaners` endpoint returned (without the success/code envelope). */
export const LOANERS: Record<string, string[]> = loanersData as Record<string, string[]>;

/** Catalogue of ship-name aliases → matrix-id lists. The Ships module
 *  uses this to reconcile user-facing display names (e.g. "Sabre Comet")
 *  with the numeric IDs the ship-matrix REST endpoint assigns. */
export const SHIP_NAME_CATALOG: ReadonlyArray<{ name: string; ids: string[] }> =
  shipNameInfoData as Array<{ name: string; ids: string[] }>;

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
