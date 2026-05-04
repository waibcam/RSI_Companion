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
import bundlesData from './bundles.json';
import shipNameInfoData from './ship-name-info.json';
import releaseNotesData from './release-notes.json';
import shipCodesData from './ship-codes.json';

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

/** Canonical (ship_code, manufacturer_code, manufacturer_name) lookup
 *  keyed by ship display name. The table was seeded from HangarXPLOR's
 *  matching reference list (MIT-licensed — see `ship-codes.NOTICE.md`)
 *  so that our HTF / `shiplist.json` exports plug straight into the
 *  third-party tooling ecosystem (value calculators, buyback helpers,
 *  ship-matching tools) without a translation step.
 *
 *  Schema per entry:
 *    { ship_code, ship_name, manufacturer_code, manufacturer_name }
 *
 *  Lookup strategy in the parser is "exact name match first, then
 *  fall back to a deterministic `<MFR>_<NAME>` slug" — see
 *  `resolveShipCode` in `rsi/hangar.ts`. */
export interface ShipCodeEntry {
  ship_code: string;
  ship_name: string;
  manufacturer_code: string;
  manufacturer_name: string;
}
export const SHIP_CODES: ReadonlyArray<ShipCodeEntry> =
  shipCodesData as ShipCodeEntry[];
