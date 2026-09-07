import { describe, it, expect } from 'vitest';
import { mergeHangarIntoMatrix, parseHangarPage } from '../rsi/ships.js';
import type { ShipMatrixEntry } from '../rsi/ships.js';
import { SHIP_NAME_CATALOG } from '../data/ship-name-info.js';

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

  // Reported by Shufflepuff [RAID] on Discord (2026-09-04): "Nova Tank"
  // and "Ursa Rover" showed up under "Unknown ships in my hangar". CIG
  // dropped the legacy suffixes in the Ship Matrix ("Nova", "Ursa") but
  // the hangar still lists the original SKU names, and the catalog only
  // carried the manufacturer-prefixed spellings.
  it('resolves an alias through the manufacturer-stripped hangar name', () => {
    const out = mergeHangarIntoMatrix({
      matrix: [entry(139, 'Ursa', MFG_RSI)],
      hangarNames: ['RSI Ursa Rover'],
      nameCatalog: [{ name: 'Ursa Rover', ids: ['139'] }],
      loanerTable: {},
    });
    expect(out.notFound).toEqual([]);
    const ursa = out.ships.find((s) => s.id === 139)!;
    expect(ursa.owned).toBe(true);
    expect(ursa.count).toBe(1);
  });

  it('prefers the raw-name alias over the stripped one', () => {
    const out = mergeHangarIntoMatrix({
      matrix: [entry(139, 'Ursa', MFG_RSI), entry(273, 'Ursa Medivac', MFG_RSI)],
      hangarNames: ['RSI Ursa Rover'],
      nameCatalog: [
        { name: 'RSI Ursa Rover', ids: ['273'] },
        { name: 'Ursa Rover', ids: ['139'] },
      ],
      loanerTable: {},
    });
    expect(out.ships.find((s) => s.id === 273)!.owned).toBe(true);
    expect(out.ships.find((s) => s.id === 139)!.owned).toBe(false);
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

  it('unions hangar matches with CCU ownership in ccuMode (no ccu-gatekeep)', () => {
    // @DAVosselman, 2026-04-24: her F7A Hornet Mk II and PTV were
    // scraped and matched (both appeared in the hangar-dump matched
    // list) but still didn't show as owned in the Ships grid. Root
    // cause: those pledges are legacy referral rewards missing from
    // RSI's CCU catalogue, so `ccuOwnedIds` didn't contain their
    // ids. In ccuMode the merge function previously refused to set
    // `ship.owned = true` from a hangar match — only CCU could flip
    // it. Fix is to union both signals: whichever source says
    // "owned", it's owned.
    const out = mergeHangarIntoMatrix({
      matrix: [
        entry(1, 'F7A Hornet Mk II'),
        entry(2, 'Aurora MR', MFG_RSI),
      ],
      hangarNames: ['F7A Hornet Mk II', 'Aurora MR'],
      nameCatalog: [],
      loanerTable: {},
      // CCU only reports Aurora — the F7A is the legacy-reward case.
      ccuOwnedIds: new Set([2]),
    });
    const hornet = out.ships.find((s) => s.id === 1)!;
    const aurora = out.ships.find((s) => s.id === 2)!;
    expect(hornet.owned).toBe(true);
    expect(hornet.count).toBe(1);
    expect(aurora.owned).toBe(true);
    expect(aurora.count).toBe(1);
  });

  it('matches when the matrix entry name has stray trailing whitespace', () => {
    // Reported on 2026-04-24: @DAVosselman's "C8X Pisces Expedition"
    // pledge appeared as "unknown" even though the matrix had the
    // ship. Turned out the matrix entry came back as
    // "C8X Pisces Expedition " with a trailing space — string-strict
    // byName lookup failed. The mapper now trims matrix names at the
    // indexing step.
    const out = mergeHangarIntoMatrix({
      matrix: [entry(42, 'C8X Pisces Expedition ')], // note the trailing space
      hangarNames: ['C8X Pisces Expedition'],
      nameCatalog: [],
      loanerTable: {},
    });
    const pisces = out.ships.find((s) => s.id === 42)!;
    expect(pisces.owned).toBe(true);
    expect(pisces.count).toBe(1);
    expect(out.notFound).toEqual([]);
    // Trimmed name flows through to the UI too.
    expect(pisces.name).toBe('C8X Pisces Expedition');
  });
});

// parseHangarPage is the raw RSI HTML scraper. A pledge row in RSI's
// hangar wraps multiple items (ship + insurance + credits + digital
// download + FPS equipment …); we care only about the ones tagged
// `kind: Ship` or `kind: Vehicle`. Test fixtures below mirror the
// real markup shape captured from a signed-in /account/pledges page.
describe('parseHangarPage', () => {
  /** One item row as RSI renders it inside a pledge. */
  const item = ({
    title,
    kind,
    liner,
  }: {
    title: string;
    kind?: string;
    liner?: string;
  }): string => `
    <div class="item ">
      <div class="image"></div>
      <div class="text">
        <div class="title">${title}</div>
        ${kind ? `<div class="kind">${kind}</div>` : ''}
        ${liner ? `<div class="liner"><span>${liner}</span></div>` : ''}
      </div>
    </div>
  `;

  /** One pledge `<li>` wrapping N items. */
  const pledge = (name: string, items: string[]): string => `
    <li>
      <div class="row">
        <div class="basic-infos">
          <div class="title-col"><h3>${name}</h3></div>
        </div>
        <div class="items">
          <div class="with-images">
            ${items.join('\n')}
          </div>
        </div>
      </div>
    </li>
  `;

  const page = (rows: string[]): string => `
    <html><body>
      <ul class="list-items">
        ${rows.join('\n')}
      </ul>
    </body></html>
  `;

  it('extracts ships from standalone-ship pledges', () => {
    const html = page([
      pledge('Standalone Ship - Tumbril Cyclone', [
        item({ title: 'Cyclone', kind: 'Ship', liner: 'TMBL' }),
        item({ title: '6 Month Insurance', kind: 'Insurance' }),
      ]),
      pledge('Standalone Ship - Anvil Arrow', [
        item({ title: 'Arrow', kind: 'Ship', liner: 'ANVL' }),
        item({ title: '6 Month Insurance', kind: 'Insurance' }),
      ]),
    ]);
    expect(parseHangarPage(html).names).toEqual(['Cyclone', 'Arrow']);
  });

  it('extracts every ship inside a game-package pledge', () => {
    // The showstopper case: a Package row (UEE Exploration 2948) has
    // the Digital Download and the Insurance items listed BEFORE any
    // of the ships. The old scraper's single-`.kind`-per-`<li>`
    // logic saw "Insurance" first and dropped the whole pledge —
    // meaning the user permanently lost all five package ships. The
    // per-`.item` scan fixes it.
    const html = page([
      pledge('Package - UEE Exploration 2948 Pack', [
        item({ title: 'Star Citizen Digital Download' }),
        item({ title: 'Lifetime Insurance', kind: 'Insurance' }),
        item({ title: 'Starting Money: 20,000 UEC', kind: 'Credits' }),
        item({ title: 'Sabre Comet', kind: 'Ship', liner: 'AEGS' }),
        item({ title: 'Freelancer MIS', kind: 'Ship', liner: 'MISC' }),
        item({ title: 'Prowler', kind: 'Ship', liner: 'ESPR' }),
        item({ title: 'Vulture', kind: 'Ship', liner: 'DRAK' }),
        item({ title: 'CCC Aves Helmet', kind: 'FPS Equipment' }),
        item({
          title: 'Carrack Expedition with Pisces Expedition',
          kind: 'Ship',
          liner: 'ANVL',
        }),
        item({ title: 'Anvil Manufacturer Shirt', kind: 'FPS Equipment' }),
      ]),
    ]);
    expect(parseHangarPage(html).names).toEqual([
      'Sabre Comet',
      'Freelancer MIS',
      'Prowler',
      'Vulture',
      'Carrack Expedition with Pisces Expedition',
    ]);
  });

  it('accepts ground vehicles tagged as "Vehicle"', () => {
    // Modern RSI seems to tag every Greycat PTV as kind="Ship" but
    // historical data has vehicles as kind="Vehicle". Keep accepting
    // both so older accounts don't regress.
    const html = page([
      pledge('Standalone Vehicle - Greycat PTV', [
        item({ title: 'PTV', kind: 'Vehicle', liner: 'GRIN' }),
      ]),
    ]);
    expect(parseHangarPage(html).names).toEqual(['PTV']);
  });

  it('rejects items that are neither Ship nor Vehicle', () => {
    // Covers the whole zoo of non-ship item kinds the hangar can
    // surface: insurance, credits, download, subscription flair,
    // FPS gear, ship paint, components, multi-tools, etc.
    const html = page([
      pledge('Standalone Ship - Ship Paint + Flair', [
        item({ title: 'Star Citizen Digital Download' }), // no kind
        item({ title: 'Lifetime Insurance', kind: 'Insurance' }),
        item({ title: 'Starting Money: 5,000 UEC', kind: 'Credits' }),
        item({ title: 'Golden Ticket', kind: 'Subscriber Item' }),
        item({ title: 'CCC Aves Helmet', kind: 'FPS Equipment' }),
        item({ title: 'STV - Blue Steel Paint', kind: 'Ship Paint' }),
        item({ title: 'Behring M7A Laser Cannon', kind: 'Ship Component' }),
        item({ title: 'Pyro RYT Multi-Tool', kind: 'Multi-Tool' }),
      ]),
    ]);
    expect(parseHangarPage(html).names).toEqual([]);
  });

  it('ignores "Also Contains" items (hangar decorations, hats) that share the .item class', () => {
    // The pledge's "Also Contains" section lists non-reclaimable
    // extras like "Self-Land Hangar" or "Digital Star Citizen
    // Manual". They use the same `.item` class but have NO `.kind`
    // element — our `SHIP_ITEM_KINDS.has('')` check correctly drops
    // them.
    const html = page([
      pledge('Standalone Ship - Gladius', [
        item({ title: 'Gladius', kind: 'Ship' }),
        // "also-contains" items have no `.kind` in the real markup.
        item({ title: 'VFG Industrial Hangar' }),
        item({ title: 'Anvil Hat' }),
      ]),
    ]);
    expect(parseHangarPage(html).names).toEqual(['Gladius']);
  });

  it('reads pagination from the raquo.btn href', () => {
    const html = `
      <html><body>
        <ul class="list-items">
          ${pledge('Standalone Ship - Gladius', [item({ title: 'Gladius', kind: 'Ship' })])}
        </ul>
        <a class="raquo btn" href="/account/pledges?page=5&product-type=standalone_ship"></a>
      </body></html>
    `;
    const { names, maxPage } = parseHangarPage(html);
    expect(names).toEqual(['Gladius']);
    expect(maxPage).toBe(5);
  });
});

// Guards the bundled alias catalog itself, not just the merge algorithm.
// Every name here is a hangar SKU a user actually reported as unmatched;
// the matrix ids are the live values from POST /ship-matrix/index.
describe('SHIP_NAME_CATALOG', () => {
  const RENAMED: Array<[hangarName: string, matrixId: number, matrixName: string]> = [
    ['Nova Tank', 154, 'Nova'],
    ['Ursa Rover', 139, 'Ursa'],
  ];

  for (const [hangarName, matrixId, matrixName] of RENAMED) {
    it(`resolves the legacy hangar name "${hangarName}" to ${matrixName}`, () => {
      const out = mergeHangarIntoMatrix({
        matrix: [entry(matrixId, matrixName, MFG_RSI)],
        hangarNames: [hangarName],
        nameCatalog: SHIP_NAME_CATALOG.map((e) => ({ ...e })),
        loanerTable: {},
      });
      expect(out.notFound).toEqual([]);
      expect(out.ships.find((s) => s.id === matrixId)!.owned).toBe(true);
    });
  }

  it('has no duplicate alias names', () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of SHIP_NAME_CATALOG) {
      if (seen.has(e.name)) dupes.push(e.name);
      seen.add(e.name);
    }
    expect(dupes).toEqual([]);
  });
});
