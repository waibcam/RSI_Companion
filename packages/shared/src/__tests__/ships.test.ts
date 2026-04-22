import { describe, it, expect } from 'vitest';
import { mergeHangarIntoMatrix } from '../rsi/ships.js';
import type { ShipMatrixEntry } from '../rsi/ships.js';

// mergeHangarIntoMatrix is the core correctness boundary for the Ships module:
// the user's ownership list, loaner inheritance, and "ship not found" reports
// all depend on this one pure function. A regression here silently hides
// owned ships, double-counts pledges, or mis-attributes loaners — all hard
// to catch manually because the popup just renders whatever comes out.

const MFG_AEGIS = { id: 1, name: 'Aegis Dynamics', code: 'AEGS' };
const MFG_RSI = { id: 2, name: 'Roberts Space Industries', code: 'RSI' };

const entry = (
  id: number,
  name: string,
  mfg = MFG_AEGIS,
): ShipMatrixEntry => ({
  id,
  name,
  url: '',
  production_status: 'flight-ready',
  type: 'combat',
  focus: 'fighter',
  manufacturer: mfg,
  media: [],
});

const MATRIX: ShipMatrixEntry[] = [
  entry(1, 'Avenger Titan'),
  entry(2, 'Gladius'),
  entry(3, 'Aurora MR', MFG_RSI),
  entry(4, 'Constellation Andromeda', MFG_RSI),
];

describe('mergeHangarIntoMatrix', () => {
  it('flags a ship as owned when the hangar name matches exactly', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Gladius'],
      nameCatalog: [],
      loanerTable: {},
    });
    const gladius = out.ships.find((s) => s.id === 2)!;
    expect(gladius.owned).toBe(true);
    expect(gladius.count).toBe(1);
    expect(out.ownedCount).toBe(1);
    expect(out.notFound).toEqual([]);
  });

  it('counts duplicates in the hangar as multiple pledges of the same ship', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Gladius', 'Gladius', 'Gladius'],
      nameCatalog: [],
      loanerTable: {},
    });
    const gladius = out.ships.find((s) => s.id === 2)!;
    expect(gladius.count).toBe(3);
    expect(out.ownedCount).toBe(3);
  });

  it('uses the name catalog to resolve aliases', () => {
    // RSI lists "Aurora MR - LTI" as a hangar label; the catalog resolves
    // that marketing name to ship id "3" (Aurora MR).
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Aurora MR - LTI'],
      nameCatalog: [{ name: 'Aurora MR - LTI', ids: ['3'] }],
      loanerTable: {},
    });
    const aurora = out.ships.find((s) => s.id === 3)!;
    expect(aurora.owned).toBe(true);
    expect(aurora.count).toBe(1);
    expect(out.notFound).toEqual([]);
  });

  it('reports unknown hangar names in notFound', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Nonexistent Ship'],
      nameCatalog: [],
      loanerTable: {},
    });
    expect(out.notFound).toEqual(['Nonexistent Ship']);
    expect(out.ownedCount).toBe(0);
  });

  it('trims whitespace and drops empty hangar entries', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['  Gladius  ', '', '   '],
      nameCatalog: [],
      loanerTable: {},
    });
    expect(out.ownedCount).toBe(1);
    expect(out.notFound).toEqual([]);
  });

  it('marks loaner ships when the owned ship has a loaner entry', () => {
    // Own Constellation Andromeda (4), loaner entry gives you Avenger Titan (1).
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Constellation Andromeda'],
      nameCatalog: [],
      loanerTable: { '4': ['1'] },
    });
    const titan = out.ships.find((s) => s.id === 1)!;
    const connie = out.ships.find((s) => s.id === 4)!;
    expect(connie.owned).toBe(true);
    expect(titan.loaner).toBe(true);
    expect(titan.owned).toBe(false);
    expect(out.loanerIds).toContain(1);
  });

  it('does not downgrade an owned ship to a loaner', () => {
    // Own both the Constellation (4, has Titan as loaner) AND the Titan (1).
    // The Titan must stay owned=true — loaner flag only applies to unowned ships.
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Constellation Andromeda', 'Avenger Titan'],
      nameCatalog: [],
      loanerTable: { '4': ['1'] },
    });
    const titan = out.ships.find((s) => s.id === 1)!;
    expect(titan.owned).toBe(true);
    expect(titan.loaner).toBe(false);
  });

  it('sorts output by manufacturer + ship name, case-insensitive', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: [],
      nameCatalog: [],
      loanerTable: {},
    });
    // Aegis (A...) sorts before Roberts (r...) — both manufacturers' ships
    // must be grouped and alphabetical within the group.
    const names = out.ships.map((s) => s.sortedName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('ignores non-numeric loaner ids without crashing', () => {
    const out = mergeHangarIntoMatrix({
      matrix: MATRIX,
      hangarNames: ['Constellation Andromeda'],
      nameCatalog: [],
      loanerTable: { '4': ['not-a-number', '1'] },
    });
    // The good id still took effect, the bad one was silently dropped.
    const titan = out.ships.find((s) => s.id === 1)!;
    expect(titan.loaner).toBe(true);
  });
});
