// Ship matrix + hangar merge logic.
// - Ship matrix (public):  POST /ship-matrix/index
// - Hangar (auth):         GET /account/pledges?page=N  (HTML)
// - Ship-name catalog:     backend /ships/name-info     (resolves aliases)
// - Loaners table:         backend /loaners             (ship -> loaner ids)
//
// The merged output assigns `owned` and `loaner` flags onto each ship in the
// matrix so the popup can render a single flat list + filter it client-side.

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiHtmlNotLogin, assertRsiNotRedirectedToLogin, assertRsiOk } from './auth.js';

export const ShipManufacturer = z.object({
  id: z.number().int(),
  name: z.string(),
  code: z.string().default(''),
});
export type ShipManufacturer = z.infer<typeof ShipManufacturer>;

export const ShipMatrixEntry = z.object({
  id: z.coerce.number().int(),
  name: z.string(),
  url: z.string().default(''),
  production_status: z.string().nullable().default(''),
  type: z.string().nullable().default(''),
  focus: z.string().nullable().default(''),
  manufacturer: ShipManufacturer,
  media: z
    .array(
      z.object({
        images: z
          .object({
            slideshow: z.string().optional(),
            store_thumb: z.string().optional(),
            subscribers_vault_thumbnail: z.string().optional(),
          })
          .partial(),
      }),
    )
    .default([]),
});
export type ShipMatrixEntry = z.infer<typeof ShipMatrixEntry>;

export const ShipMatrixResponse = z.object({
  success: z.number().int(),
  data: z.array(ShipMatrixEntry).default([]),
});

export interface Ship extends ShipMatrixEntry {
  sortedName: string;
  owned: boolean;
  count: number;
  loaner: boolean;
  image: string | null;
}

export interface ShipListBundle {
  ships: Ship[];
  loanerIds: number[];
  ownedCount: number;
  notFound: string[];
}

function resolveImage(entry: ShipMatrixEntry): string | null {
  const path =
    entry.media[0]?.images.slideshow ??
    entry.media[0]?.images.store_thumb ??
    entry.media[0]?.images.subscribers_vault_thumbnail ??
    null;
  if (!path) return null;
  return path.startsWith('http') ? path : `${RSI_BASE_URL}${path}`;
}

export async function fetchShipMatrix(): Promise<ShipMatrixEntry[]> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/ship-matrix/index`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`ship-matrix returned ${response.status}`);
  const raw = (await response.json()) as unknown;
  const parsed = ShipMatrixResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) {
    throw new Error('ship-matrix response was not valid');
  }
  return parsed.data.data;
}

/** @internal Exposed alongside `parseHangarPage` for its unit tests. */
export interface HangarPageResult {
  names: string[];
  maxPage: number;
}

// Kinds the RSI hangar uses on rows that ARE ships we want to match
// against the ship-matrix. Exact-match (case-insensitive) so e.g.
// "Ship Paint", "Ship Component", "Ship Weapon", "Insurance",
// "Credits", "FPS Equipment" etc. are cleanly excluded. "Vehicle" is
// here too for ground-vehicle pledges that some older RSI rows still
// use (modern RSI tags PTV as "Ship", but we keep "Vehicle" as a
// defensive fallback).
const SHIP_ITEM_KINDS: ReadonlySet<string> = new Set(['ship', 'vehicle']);

/** @internal Exposed solely for the parseHangarPage unit tests. */
export function parseHangarPage(html: string): HangarPageResult {
  const { document } = parseHTML(html);
  const names: string[] = [];

  // Each pledge row (`<li>` under `ul.list-items`) wraps multiple
  // "items" — one per sub-component of the pledge. A standalone ship
  // pledge has the ship + insurance. A package has the ship(s) +
  // insurance + credits + "Star Citizen Digital Download" + any FPS
  // equipment (helmets, shirts) + subscription flair.
  //
  // The OLD scraper matched on the first `.kind` found inside the
  // whole `<li>`, which silently dropped any pledge whose first item
  // happened to be an Insurance or a Digital Download row (basically
  // every Game Package). We now iterate the nested `div.item`
  // elements directly and keep only the ones tagged `kind: Ship` or
  // `kind: Vehicle`.
  const items = document.querySelectorAll('div.item');
  for (const item of Array.from(items)) {
    // Both selectors below walk from `item` downwards. RSI's markup
    // nests the text block either directly (`.item > .title`, seen in
    // the "Also Contains" section) or inside a `.text` wrapper
    // (`.item > .text > .title`, the default). `querySelector` takes
    // the first match in document order in either case.
    const kindEl = item.querySelector('.kind');
    const kind = (kindEl?.textContent ?? '').trim().toLowerCase();
    if (!SHIP_ITEM_KINDS.has(kind)) continue;
    const titleEl = item.querySelector('.title');
    const title = (titleEl?.textContent ?? '').trim();
    if (title) names.push(title);
  }

  let maxPage = 1;
  const lastBtn = document.querySelector('a.raquo.btn');
  const href = lastBtn?.getAttribute('href') ?? '';
  const match = /page=(\d+)/.exec(href);
  if (match?.[1]) maxPage = Number.parseInt(match[1], 10) || 1;

  return { names, maxPage };
}

export async function fetchHangar(): Promise<string[]> {
  // Scrape the unfiltered "All" view of the hangar rather than the
  // per-product-type filtered URLs. Reason: legacy referral-ladder
  // rewards (reported by @DAVosselman on 2026-04-24: "Surf and Turf"
  // containing a PTV, "Gladius and Gold" containing an F7A Hornet
  // Mk II) have NO product_type classification on the server side —
  // they only show up under the default "All" view. Filtering by
  // product-type caused those pledges (and their ships) to be
  // silently dropped.
  //
  // Safety against the original reason we added the filter in the
  // first place (paints / tools / flair slipping through) is now the
  // per-\`div.item\` `kind` check in parseHangarPage: only items with
  // kind="Ship" or kind="Vehicle" are kept, so paint/component/
  // subscriber-flair pledges are harmless even when they live in the
  // same page we're walking.
  //
  // Known edge case this trades: the "upgrade" product-type carries
  // unapplied CCUs whose rows list the target ship. A user sitting
  // on pending CCUs will count those targets as owned here. Applied
  // CCUs don't show as separate rows (the original pledge morphs
  // into the upgraded ship), so most users aren't affected. If
  // anyone reports phantom ownership we'll revisit.
  const names: string[] = [];

  let page = 1;
  while (true) {
    const url = `${RSI_BASE_URL}/account/pledges?page=${page}`;
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      credentials: 'include',
    });
    assertRsiOk(response, `hangar page ${page}`);
    assertRsiNotRedirectedToLogin(response);
    const html = await response.text();
    assertRsiHtmlNotLogin(html);
    const { names: pageNames, maxPage } = parseHangarPage(html);
    names.push(...pageNames);
    if (page >= maxPage) break;
    page += 1;
    if (page > 50) break; // safety cap
  }

  return names;
}

interface MergeInput {
  matrix: ShipMatrixEntry[];
  hangarNames: string[];
  /** From backend /ships/name-info — aliases keyed by ship display name. */
  nameCatalog: Array<{ name: string; ids: string[] }>;
  /** From backend /loaners — { "<shipId>": ["loanerId", ...] }. */
  loanerTable: Record<string, string[]>;
  /** Optional authoritative set of owned ship ids, sourced from the CCU
   *  upgrade catalogue (`pledge.ccuInit` → ships[].owned). When provided:
   *    - `owned` on each ship comes from this set (server-authoritative).
   *    - `hangarNames` are still consumed but only for per-ship counts.
   *    - Ships owned per CCU with zero hangar-matched count fall back to 1
   *      so the UI shows them as owned even if the hangar HTML scrape
   *      renamed or missed them.
   *
   *  Omit this field (legacy path) and the merger falls back to marking
   *  owned purely from hangar name matches. The tests use this shape. */
  ccuOwnedIds?: ReadonlySet<number>;
}

/** Prefixes to try stripping from a ship name to bridge
 *  manufacturer-in-name vs manufacturer-omitted naming styles. RSI has
 *  been inconsistent over the years: sometimes the ship-matrix carries
 *  "Crusader Mercury Star Runner" while the hangar HTML lists just
 *  "Mercury Star Runner", sometimes vice versa. Auto-deriving both
 *  variants from the manufacturer's name + short code handles most of
 *  these mismatches without needing a hand-curated alias entry. */
function manufacturerPrefixes(m: ShipManufacturer): string[] {
  const out = new Set<string>();
  if (m.name) {
    out.add(m.name);
    // Ship names embed the short brand, not the legal-entity name —
    // "Crusader Mercury Star Runner" rather than "Crusader Industries
    // Mercury Star Runner". Peel off the first whitespace-delimited
    // token so "Crusader Industries" / "Aegis Dynamics" / "Drake
    // Interplanetary" / "Origin Jumpworks" all contribute their
    // familiar short form as a candidate prefix.
    const firstWord = m.name.split(/\s+/)[0];
    if (firstWord) out.add(firstWord);
  }
  if (m.code) out.add(m.code);
  return [...out].filter((s) => s.length > 0);
}

/** Case-insensitive prefix strip. Requires a whitespace boundary after
 *  the prefix so "Anvil" doesn't accidentally match "AnvilWings" or
 *  similar glued strings. Returns null when no prefix matched. */
function stripPrefix(name: string, prefixes: readonly string[]): string | null {
  const lower = name.toLowerCase();
  for (const p of prefixes) {
    const pl = p.toLowerCase();
    if (lower.startsWith(pl + ' ')) {
      return name.slice(p.length).trimStart();
    }
  }
  return null;
}

export function mergeHangarIntoMatrix(input: MergeInput): ShipListBundle {
  const { matrix, hangarNames, nameCatalog, loanerTable, ccuOwnedIds } = input;
  // Whether the caller handed us an authoritative owned-set from CCU. In
  // that mode the hangar-name matching below only bumps counts; `owned`
  // is solely driven by `ccuOwnedIds` and can't be set by hangar hits.
  const ccuMode = ccuOwnedIds != null;

  // Build two indexes in a single matrix pass so the per-hangar-name lookup
  // below is O(1) instead of O(matrix size). With ~1000 ships and ~100 hangar
  // entries, the old nested-loop shape was ~100k string compares on every
  // signed-in Ships tab refresh.
  //
  // Also auto-generates manufacturer-stripped variants on the matrix side
  // (see below) so Crusader-branded ships match regardless of whether the
  // matrix carries the "Crusader " prefix or not.
  const byId = new Map<number, Ship>();
  const byName = new Map<string, Ship>();
  // Global set of known manufacturer prefixes — used to strip the same
  // from hangar names at lookup time, covering the opposite asymmetry.
  const allPrefixes = new Set<string>();
  for (const entry of matrix) {
    // RSI occasionally ships matrix entries with stray whitespace around
    // the name (seen in the wild: `"C8X Pisces Expedition "` with a
    // trailing space — reported by @DAVosselman on 2026-04-24 when the
    // exact-match lookup failed against the hangar-side trimmed form).
    // Normalise once here so every downstream index sees a clean key
    // and the UI doesn't display stray whitespace either.
    const normalizedName = entry.name.trim();
    const ship: Ship = {
      ...entry,
      name: normalizedName,
      sortedName: `${entry.manufacturer.name} - ${normalizedName}`.toLowerCase(),
      owned: ccuMode ? ccuOwnedIds!.has(entry.id) : false,
      count: 0,
      loaner: false,
      image: resolveImage(entry),
    };
    byId.set(entry.id, ship);
    byName.set(normalizedName, ship);

    // Extra index: same ship keyed by its name minus the manufacturer
    // prefix. "Crusader Mercury Star Runner" also lives under
    // "Mercury Star Runner" so a hangar entry without the brand prefix
    // hits on the first lookup. Skipped when the matrix name doesn't
    // start with a prefix — then this entry is its own canonical form.
    const prefixes = manufacturerPrefixes(entry.manufacturer);
    for (const p of prefixes) allPrefixes.add(p);
    const stripped = stripPrefix(normalizedName, prefixes);
    // Only register stripped variants when they don't already clash
    // with another ship's canonical name — prevents a stripped
    // "Outland Mustang" from shadowing a real "Mustang" entry.
    if (stripped && !byName.has(stripped)) {
      byName.set(stripped, ship);
    }
  }
  // Alias index: the manually-curated catalog maps a display name to
  // one or more ship ids. Only needed for cases the automatic prefix
  // stripping can't cover (wholly renamed chassis, etc.). Fewer entries
  // required over time thanks to the prefix automation.
  const byAlias = new Map<string, Ship[]>();
  for (const alias of nameCatalog) {
    const ships: Ship[] = [];
    for (const idStr of alias.ids) {
      const id = Number.parseInt(idStr, 10);
      const ship = Number.isFinite(id) ? byId.get(id) : undefined;
      if (ship) ships.push(ship);
    }
    if (ships.length > 0) byAlias.set(alias.name, ships);
  }

  const prefixList = [...allPrefixes];
  const notFound: string[] = [];
  for (const rawName of hangarNames) {
    const name = rawName.trim();
    if (!name) continue;

    const direct = byName.get(name);
    if (direct) {
      if (!ccuMode) direct.owned = true;
      direct.count += 1;
      continue;
    }

    // Automatic prefix stripping on the hangar side — covers the
    // inverse asymmetry (hangar has "Crusader X", matrix has "X").
    // Falls through to the manual alias catalog if nothing sticks.
    const stripped = stripPrefix(name, prefixList);
    if (stripped) {
      const after = byName.get(stripped);
      if (after) {
        if (!ccuMode) after.owned = true;
        after.count += 1;
        continue;
      }
    }

    const aliased = byAlias.get(name);
    if (aliased) {
      for (const ship of aliased) {
        if (!ccuMode) ship.owned = true;
        ship.count += 1;
      }
      continue;
    }

    notFound.push(name);
  }

  // In CCU mode, a ship flagged owned server-side but with zero hangar
  // match (renamed SKU, hangar fetch partially failed) should still show
  // as owned. Default its count to 1 — close enough, and better than
  // the alternative (owned badge with "0" multiplier).
  if (ccuMode) {
    for (const ship of byId.values()) {
      if (ship.owned && ship.count === 0) ship.count = 1;
    }
  }

  const loanerIds = new Set<number>();
  for (const ship of byId.values()) {
    if (!ship.owned) continue;
    const loanerList = loanerTable[String(ship.id)];
    if (loanerList && loanerList.length > 0) {
      for (const loanerIdStr of loanerList) {
        const loanerId = Number.parseInt(loanerIdStr, 10);
        if (!Number.isFinite(loanerId)) continue;
        loanerIds.add(loanerId);
        const loanerShip = byId.get(loanerId);
        if (loanerShip && !loanerShip.owned) loanerShip.loaner = true;
      }
    } else {
      loanerIds.add(ship.id);
    }
  }

  const ships = [...byId.values()].sort((a, b) =>
    a.sortedName.localeCompare(b.sortedName),
  );
  const ownedCount = ships.reduce((n, s) => n + s.count, 0);

  return {
    ships,
    loanerIds: [...loanerIds],
    ownedCount,
    notFound,
  };
}
