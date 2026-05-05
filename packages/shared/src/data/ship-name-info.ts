// Ship-name → matrix-id catalogue. Lives in its own module so popup
// chunks that don't need it (Comm-Link, Spectrum, Patch Notes, etc.)
// don't ship the ~48 kB JSON.
//
// Used by:
//   - `entrypoints/background.ts` Ships handler — reconciles
//     user-facing display names ("Sabre Comet", "Aurora LN") with
//     the numeric IDs the ship-matrix REST endpoint assigns.
//   - The Ships module reads it indirectly via the BG handler, never
//     imports it directly.

import shipNameInfoData from './ship-name-info.json';

/** Catalogue of ship-name aliases → matrix-id lists. */
export const SHIP_NAME_CATALOG: ReadonlyArray<{
  name: string;
  ids: string[];
}> = shipNameInfoData as Array<{ name: string; ids: string[] }>;
