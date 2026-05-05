// Heavy ship-code lookup table — kept in its own module so consumers
// that don't need it (Comm-Link, Spectrum, Patch Notes, Settings…)
// don't drag the 305-entry JSON into their bundle.
//
// Used exclusively by:
//   - `rsi/hangar.ts#resolveShipCode` (the HTF / shiplist.json export
//     that round-trips with HangarXPLOR)
//   - any future tooling that needs the canonical (ship_code,
//     manufacturer_*) tuple for a display name.
//
// Lookup strategy in the parser is "exact name match first, then
// fall back to a deterministic `<MFR>_<NAME>` slug" — see
// `resolveShipCode` in `rsi/hangar.ts`.
//
// Seeded from HangarXPLOR's matching reference list (MIT-licensed —
// see `ship-codes.NOTICE.md`) so our exports plug straight into the
// third-party tooling ecosystem without a translation step.

import shipCodesData from './ship-codes.json';

export interface ShipCodeEntry {
  ship_code: string;
  ship_name: string;
  manufacturer_code: string;
  manufacturer_name: string;
}

export const SHIP_CODES: ReadonlyArray<ShipCodeEntry> =
  shipCodesData as ShipCodeEntry[];
