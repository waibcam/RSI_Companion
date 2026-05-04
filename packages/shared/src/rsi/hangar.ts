// Rich hangar parser for the Hangar module.
//
// Distinct from `ships.ts#fetchHangar`, which extracts only ship NAMES
// for the matrix-overlay flow. Here we want the full per-pledge view
// — id, name, date, cost, gift/warbond/LTI flags, and the breakdown of
// every Ship row inside the pledge with its manufacturer + nickname —
// to power the new Hangar module's Pledges tab and the
// HangarXPLOR-compatible `shiplist.json` (HTF) export.
//
// The selectors below mirror HangarXPLOR's proven approach (MIT, see
// ship-codes.NOTICE.md) so that catalogues from the two tools are
// interchangeable. Our existing `ships.ts#parseHangarPage` works on the
// same DOM but at a coarser granularity; the two parsers coexist and
// cache independently. Future cleanup could factor a shared low-level
// "iterate pledge rows" helper, but the duplication is small and keeps
// each module's blast radius small if RSI re-skins one path.

import { parseHTML } from 'linkedom';
import { RSI_BASE_URL } from '../constants.js';
import { SHIP_CODES, type ShipCodeEntry } from '../data/index.js';
import { fetchWithTimeout } from '../net.js';
import {
  assertRsiHtmlNotLogin,
  assertRsiNotRedirectedToLogin,
  assertRsiOk,
} from './auth.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single ship row within a pledge. Multiple per pledge for combos /
 *  packages (e.g. UEE Exploration 2948 Pack has 5 ships). */
export interface HangarShipEntry {
  /** Display name with the manufacturer prefix stripped. Matches RSI's
   *  store-side ship naming (e.g. "Aurora LN", not
   *  "Roberts Space Industries Aurora LN"). */
  shipName: string;
  /** User-set custom name from the hangar's "Customize" feature. Null
   *  when the user hasn't renamed the ship. */
  shipNickname: string | null;
  /** Three- or four-letter manufacturer code (RSI, AEGS, ANVL, …). */
  manufacturerCode: string;
  /** Full manufacturer name (with parentheticals stripped). */
  manufacturerName: string;
  /** Absolute URL of the ship thumbnail RSI renders next to this row
   *  in the hangar. Null when the parser can't locate one — defensive
   *  against RSI markup variations. The popup uses the first ship's
   *  image as the pledge-row thumbnail. */
  imageUrl: string | null;
}

/** Pledge categorisation derived from the leading prefix on RSI's
 *  pledge title. Matches the categories the user sees on the hangar
 *  dropdown ("All types / Standalone Ships / Game Packages / Combo
 *  Packs / Add-Ons / …"). 'other' covers exotic / legacy rows that
 *  don't carry a recognised prefix. */
export type HangarPledgeType =
  | 'standalone-ship'
  | 'standalone-vehicle'
  | 'package'
  | 'combo'
  | 'pack'
  | 'add-on'
  | 'upgrade'
  | 'extra'
  | 'paint'
  | 'other';

/** One pledge row — what RSI's hangar calls a "package" or
 *  "standalone ship" line. Carries the 1..N ships it contains. */
export interface HangarPledge {
  pledgeId: string;
  /** Display-friendly name with the leading "Standalone Ship - " /
   *  "Package - " / "Combo - " prefix stripped. Used for the popup UI
   *  and the search index. */
  pledgeName: string;
  /** Raw RSI pledge title, prefix INCLUDED. Preserved verbatim so
   *  the HTF / shiplist.json export round-trips bit-for-bit with
   *  HangarXPLOR's output (which keeps the prefix). */
  pledgeNameRaw: string;
  /** Detected pledge category (drives the type-filter dropdown). */
  pledgeType: HangarPledgeType;
  /** Raw cost string as RSI renders it ("$45.00 USD", "€42,00 EUR"). */
  pledgeCost: string;
  /** Numeric cost in the pledge's currency, parsed for sorting +
   *  filtering. Falls back to 0 when the string can't be parsed. */
  pledgeCostNumeric: number;
  /** Raw "Mmm DD, YYYY" string after the "Created: " prefix is
   *  stripped. Kept as a string (no Date parse) to mirror HangarXPLOR's
   *  output shape; consumers that need a sortable timestamp should
   *  parse it themselves. */
  pledgeDate: string;
  lti: boolean;
  warbond: boolean;
  isMeltable: boolean;
  isGiftable: boolean;
  hasSquadron: boolean;
  hasStarcitizen: boolean;
  /** Pledge contents include at least one CCU / upgrade item. Used by
   *  the "Upgraded" filter. Distinct from pledgeType === 'upgrade'
   *  which only catches pledges whose TITLE was prefixed
   *  "Ship Upgrades - "; some packages bundle a CCU as a side item. */
  hasUpgrade: boolean;
  /** Pledge contents include at least one reward item (community
   *  events, referral rewards, etc.). Used by the "Reward" filter. */
  hasReward: boolean;
  /** True when this is a "free CCU" pledge — an upgrade-type pledge
   *  with zero cost (typical for referral / promotional CCUs). Used
   *  by the "Free CCUs" filter. */
  isFreeCcu: boolean;
  /** Absolute URL of the main thumbnail RSI renders next to the
   *  pledge row in /account/pledges. Lives at
   *  `.basic-infos .item-image-wrapper .image` as an inline
   *  `background-image` style, with no <img> element involved.
   *  Drives the popup's pledge-row thumbnail. Null when the parser
   *  can't locate one (defensive against markup variations). */
  imageUrl: string | null;
  ships: HangarShipEntry[];
}

/** A row in the HangarXPLOR-compatible `shiplist.json` export.
 *  Pledge attributes are denormalised onto each ship — one entry per
 *  ship, even when multiple ships share a pledge.
 *
 *  Field ORDER matters for byte-for-byte compat: HangarXPLOR's
 *  exporter emits keys in this exact sequence — ship_code first,
 *  ship_name (=user nickname when set, otherwise the actual ship
 *  name), manufacturer_code BEFORE manufacturer_name, then `lti`,
 *  then `name` (the actual ship name even when `ship_name` was
 *  overridden by a nickname), `warbond`, `entity_type`, and the
 *  pledge denorm at the end. JSON.stringify preserves insertion
 *  order for plain objects, so we just declare the interface in
 *  that order and build the literals in the same order. */
export interface HtfShipRow {
  ship_code: string;
  ship_name: string;
  manufacturer_code: string;
  manufacturer_name: string;
  lti: boolean;
  /** Real ship name from RSI's hangar (independent of the user's
   *  custom nickname). Identical to `ship_name` when no nickname was
   *  set. HangarXPLOR emits this field unconditionally — kept for
   *  consumer-tool compat even though it's redundant in the common
   *  case. */
  name: string;
  warbond: boolean;
  entity_type: 'ship';
  pledge_id: string;
  pledge_name: string;
  pledge_date: string;
  pledge_cost: string;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Manufacturer-prefix strip regex. Bumped from the HangarXPLOR original
 *  to add Mirai (Razor line — RSI's matrix lists it as a separate
 *  manufacturer since 2024) and to keep the longer names BEFORE their
 *  ambiguous prefixes (Greycat Industrial before Greycat). The `[^a-z0-9]+`
 *  trailing match means we eat one or more separators (space, dash,
 *  punctuation) so "Aegis Sabre" and "Aegis-Sabre" both strip cleanly. */
const MANUFACTURER_STRIP =
  /^(?:Aegis|Anvil|Aopoa|Banu|CNOU|Crusader|Drake|Greycat Industrial|Greycat|Esperia|Kruger|MISC|Mirai|Origin|RSI|Tumbril|Vanduul|Xi'an)[^a-z0-9]+/i;

/** Pledge-name prefix tokens RSI prepends in the hangar. Used both for
 *  the display-side strip AND to derive `pledgeType` (the type-filter
 *  dropdown). Order matters: we test these in order and the first
 *  match wins, so longer specific prefixes ("Standalone Vehicle - ")
 *  must come before their shorter substrings ("Standalone Ship - "
 *  vs. just "Standalone").
 *
 *  Note "Packs - " appears in real-world data (we saw "Packs - Roc &
 *  Brawl Pack" and "Packs - Fury Twin Pack") but isn't in HangarXPLOR's
 *  strip list. We handle it anyway because the hangar UI does. */
const PLEDGE_PREFIX_TYPE_MAP: Array<{ prefix: string; type: HangarPledgeType }> = [
  { prefix: 'Add-Ons - ', type: 'add-on' },
  { prefix: 'Standalone Vehicle - ', type: 'standalone-vehicle' },
  { prefix: 'Standalone Ship - ', type: 'standalone-ship' },
  { prefix: 'Combo - ', type: 'combo' },
  { prefix: 'Package - ', type: 'package' },
  { prefix: 'Ship Upgrades - ', type: 'upgrade' },
  { prefix: 'Extras - ', type: 'extra' },
  { prefix: 'Paints - ', type: 'paint' },
  { prefix: 'Packs - ', type: 'pack' },
];

/** Strip the leading hangar-prefix and return both the cleaned name
 *  and the detected type. The raw input is normalised first
 *  (collapse double spaces, trim) so we don't trip on stray
 *  whitespace that occasionally appears in RSI's HTML. */
function classifyPledgeName(name: string): {
  stripped: string;
  type: HangarPledgeType;
} {
  const normalised = name.replace(/\s{2,}/g, ' ').trim();
  const lower = normalised.toLowerCase();
  for (const { prefix, type } of PLEDGE_PREFIX_TYPE_MAP) {
    if (lower.startsWith(prefix.toLowerCase())) {
      return { stripped: normalised.slice(prefix.length).trimStart(), type };
    }
  }
  return { stripped: normalised, type: 'other' };
}

function stripManufacturerPrefix(name: string): string {
  return name.replace(MANUFACTURER_STRIP, '').trim() || name.trim();
}

function parseCostNumeric(raw: string): number {
  if (!raw) return 0;
  // Handles "$45.00 USD", "€42.00 EUR", "$1,234.56 USD" — strip
  // currency symbol(s), thousand-separator commas, ISO suffix, then
  // parseFloat. Locales that use comma-decimal (e.g. "42,00 EUR")
  // fall through with parseFloat returning 42 — close enough for
  // sort/filter purposes; the raw `pledgeCost` string is the
  // authoritative display.
  const cleaned = raw
    .replace(/[$€£¥]/g, '')
    .replace(/\s+(USD|EUR|GBP|CAD|AUD|JPY)\s*$/i, '')
    .replace(/,/g, '')
    .trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** Read a value-bearing element. RSI's hangar markup uses input-style
 *  hidden fields (`<input class="js-pledge-id" value="...">`) for the
 *  IDs and names, but older fixtures expose the same data as plain
 *  text. Try `value` attr first, then text content. */
function readValueOrText(el: Element | null): string {
  if (!el) return '';
  const valueAttr = el.getAttribute('value');
  if (valueAttr != null && valueAttr !== '') return valueAttr.trim();
  return (el.textContent ?? '').trim();
}

/** Lowercase substring check on every `.title` element under `root`.
 *  RSI uses these for human-readable item labels — "Lifetime Insurance",
 *  "Star Citizen Digital Download", "Squadron 42 Digital Download", … */
function anyTitleContains(root: ParentNode, needle: string): boolean {
  const lower = needle.toLowerCase();
  const titles = Array.from(root.querySelectorAll('.title'));
  return titles.some((t) => (t.textContent ?? '').toLowerCase().includes(lower));
}

/** Same idea for `.label` — RSI uses these for badges / chips
 *  ("Gift", "On hold", etc.). */
function anyLabelContains(root: ParentNode, needle: string): boolean {
  const lower = needle.toLowerCase();
  const labels = Array.from(root.querySelectorAll('.label'));
  return labels.some((l) => (l.textContent ?? '').toLowerCase().includes(lower));
}

/** Parse the ship rows under one pledge `<li>`. We iterate every
 *  `div.item` whose `.kind` is "Ship" or "Vehicle" — same vocabulary
 *  the existing `ships.ts` parser uses. The text block for each item
 *  may sit either directly under `.item > .title` (the "Also Contains"
 *  variant) or wrapped in `.item > .text > .title` (the default), so
 *  `querySelector` from `.item` downwards picks up both. */
const SHIP_ITEM_KINDS: ReadonlySet<string> = new Set(['ship', 'vehicle']);

/** Walks every `div.item` under the pledge and returns a Set of
 *  lowercased `.kind` values seen. Cheaper than running multiple
 *  `.kind:contains(...)` passes when we want to test several kinds
 *  (Upgrade, Reward, Skin, Decoration, …) on the same pledge. */
function collectItemKinds(pledgeEl: ParentNode): Set<string> {
  const kinds = new Set<string>();
  const items = Array.from(pledgeEl.querySelectorAll('.item'));
  for (const item of items) {
    const kindEl = item.querySelector('.kind');
    const k = (kindEl?.textContent ?? '').trim().toLowerCase();
    if (k) kinds.add(k);
  }
  return kinds;
}

/** Pull a thumbnail URL out of an arbitrary container, trying every
 *  shape RSI's hangar HTML has used:
 *    - `<div class="image" style="background-image:url('…')">` —
 *      the dominant shape in 2025+ markup. No <img> element; the
 *      URL lives in the inline style. (This is what
 *      `.basic-infos .item-image-wrapper .image` looks like at the
 *      pledge-row level.)
 *    - `<img src="…">` inside a `.image` / `.image-col` slot — older
 *      markup variant.
 *    - bare `<img>` anywhere in the container — last-resort fallback.
 *
 *  Returns absolute URL (prepends RSI_BASE_URL when relative,
 *  including protocol-relative `//foo` URLs) or null if nothing was
 *  found. */
function extractImageUrl(root: ParentNode): string | null {
  const ABSOLUTE = (raw: string): string => {
    const url = raw.trim();
    if (!url) return '';
    if (url.startsWith('http://') || url.startsWith('https://')) return url;
    if (url.startsWith('//')) return `https:${url}`;
    return `${RSI_BASE_URL}${url}`;
  };

  // 1. Inline `background-image: url(…)` on a `.image` div. We try
  //    a few selector variants because the wrapping element name
  //    varies (`.item-image-wrapper`, `.image-col`, etc.) but the
  //    final `.image` div is consistent.
  const bgSelectors = [
    '.item-image-wrapper .image',
    '.image-col .image',
    '.basic-infos .image',
    '.image',
  ];
  for (const sel of bgSelectors) {
    const el = root.querySelector(sel);
    if (!el) continue;
    const style = el.getAttribute('style') ?? '';
    const m = /background-image\s*:\s*url\(\s*(['"]?)([^'")]+)\1\s*\)/i.exec(style);
    if (m && m[2]) {
      const out = ABSOLUTE(m[2]);
      if (out) return out;
    }
  }

  // 2. <img> inside a .image / .image-col slot.
  const imgEl = root.querySelector('.image img, .image-col img');
  const src = imgEl?.getAttribute('src')?.trim();
  if (src) {
    const out = ABSOLUTE(src);
    if (out) return out;
  }

  // 3. Last-resort: any <img> within the root.
  const anyImg = root.querySelector('img')?.getAttribute('src')?.trim();
  if (anyImg) {
    const out = ABSOLUTE(anyImg);
    if (out) return out;
  }

  return null;
}

function parsePledgeShips(pledgeEl: ParentNode): HangarShipEntry[] {
  const out: HangarShipEntry[] = [];
  const items = Array.from(pledgeEl.querySelectorAll('.item'));
  for (const item of items) {
    const kindEl = item.querySelector('.kind');
    const kind = (kindEl?.textContent ?? '').trim().toLowerCase();
    if (!SHIP_ITEM_KINDS.has(kind)) continue;
    const titleEl = item.querySelector('.title');
    const rawTitle = (titleEl?.textContent ?? '').trim();
    if (!rawTitle) continue;

    const linerEl = item.querySelector('.liner');
    const linerSpan = linerEl?.querySelector('span') ?? null;
    const manufacturerCode = (linerSpan?.textContent ?? '').trim();
    // Manufacturer name lives in `.liner` minus its `<span>` (the code).
    // RSI sometimes sticks a parenthetical after — strip it.
    let manufacturerName = (linerEl?.textContent ?? '').trim();
    if (linerSpan) {
      manufacturerName = manufacturerName
        .replace(linerSpan.textContent ?? '', '')
        .trim();
    }
    manufacturerName = manufacturerName.replace(/\s*\([^)]*\)\s*$/, '').trim();

    const nicknameEl = item.querySelector('.custom-name-text');
    const nicknameRaw = (nicknameEl?.textContent ?? '').trim();
    const shipNickname = nicknameRaw.length > 0 ? nicknameRaw : null;

    out.push({
      shipName: stripManufacturerPrefix(rawTitle),
      shipNickname,
      manufacturerCode,
      manufacturerName,
      // Per-ship image: only present in markup variants that put a
      // thumbnail inside each `.item`. In current RSI markup this
      // is usually empty — the pledge-level image (extracted in
      // parseHangarPledgesPage below) is the actual thumbnail.
      imageUrl: extractImageUrl(item),
    });
  }
  return out;
}

/** Parse a single page of `/account/pledges` HTML. Visible for unit
 *  tests; production callers should use `fetchHangarPledges`. */
export interface HangarPagesResult {
  pledges: HangarPledge[];
  maxPage: number;
}

export function parseHangarPledgesPage(html: string): HangarPagesResult {
  const { document } = parseHTML(html);
  const pledges: HangarPledge[] = [];

  // RSI wraps each pledge in an `<li>` under `<ul class="list-items">`.
  // Both the existing `ships.ts` parser and HangarXPLOR target this
  // shape; we keep it consistent. Empty pages return an empty array.
  const rows = Array.from(document.querySelectorAll('ul.list-items > li'));
  for (const row of rows) {
    const pledgeIdEl = row.querySelector('.js-pledge-id');
    const pledgeNameEl = row.querySelector('.js-pledge-name');
    const pledgeValueEl = row.querySelector('.js-pledge-value');

    const pledgeId = readValueOrText(pledgeIdEl);
    const pledgeNameRaw = readValueOrText(pledgeNameEl);
    const { stripped: pledgeName, type: pledgeType } = classifyPledgeName(pledgeNameRaw);
    const pledgeCost = readValueOrText(pledgeValueEl);

    // Date col — first one in document order under the row, since
    // RSI also puts a "Last edited" date elsewhere.
    const dateEl = row.querySelector('.date-col');
    const pledgeDate = (dateEl?.textContent ?? '')
      .replace(/created:\s+/gi, '')
      .trim();

    const lti = anyTitleContains(row, 'Lifetime Insurance');
    const lname = pledgeName.toLowerCase();
    const warbond =
      lname.includes('warbond') ||
      lname.includes(' wb ') ||
      lname.endsWith(' wb') ||
      lname.includes('war bond');
    const isMeltable = row.querySelectorAll('.js-reclaim').length > 0;
    const cost = parseCostNumeric(pledgeCost);
    // HangarXPLOR caps "giftable" at $1000 because RSI flags some
    // promo-only pledges as gift-tagged but rejects the actual gift
    // call. The threshold is empirical, kept here for parity.
    const isGiftable = anyLabelContains(row, 'Gift') && cost <= 1000;
    const hasSquadron = anyTitleContains(row, 'Squadron 42 Digital Download');
    const hasStarcitizen = anyTitleContains(row, 'Star Citizen Digital Download');

    // Walk the items once to harvest the kinds (Upgrade / Reward) that
    // power the new filters. `parsePledgeShips` runs its own walk for
    // the Ship/Vehicle subset — duplicating one loop is cheaper than
    // wiring through a tuple, and the hangar typically has < 200
    // pledges.
    const itemKinds = collectItemKinds(row);
    const hasUpgrade = itemKinds.has('upgrade');
    const hasReward = itemKinds.has('reward');
    // "Free CCU" = upgrade-type pledge that cost the user nothing.
    // Catches both the title-prefix case ("Ship Upgrades - …") and
    // pledges that bundle a CCU as their only paid line item but
    // landed with $0 cost (referral / event grants).
    const isFreeCcu =
      cost === 0 && (pledgeType === 'upgrade' || hasUpgrade);

    const ships = parsePledgeShips(row);

    // Pledge-level thumbnail. Lives at
    // `.basic-infos .item-image-wrapper .image` as an inline
    // `background-image:url('…')` — confirmed against a real hangar
    // dump on 2026-05-04. The `extractImageUrl` helper falls back
    // through several selectors so this stays resilient if RSI
    // restructures (e.g. wrapping element renamed). Per-ship images
    // (s.imageUrl in `parsePledgeShips`) are usually empty in the
    // current markup; the popup falls back to this pledge-level
    // image when no per-ship one exists.
    const imageUrl = extractImageUrl(row);

    // Skip rows that have neither a usable id nor a name — defensive
    // against placeholder rows or RSI A/B-test variants.
    if (!pledgeId && !pledgeName && ships.length === 0) continue;

    pledges.push({
      pledgeId,
      pledgeName,
      pledgeNameRaw,
      pledgeType,
      pledgeCost,
      pledgeCostNumeric: cost,
      pledgeDate,
      lti,
      warbond,
      isMeltable,
      isGiftable,
      hasSquadron,
      hasStarcitizen,
      hasUpgrade,
      hasReward,
      isFreeCcu,
      imageUrl,
      ships,
    });
  }

  let maxPage = 1;
  const lastBtn = document.querySelector('a.raquo.btn');
  const href = lastBtn?.getAttribute('href') ?? '';
  const match = /page=(\d+)/.exec(href);
  if (match?.[1]) maxPage = Number.parseInt(match[1], 10) || 1;

  return { pledges, maxPage };
}

/** Fetch every page of `/account/pledges` and concatenate the parsed
 *  pledges. Mirrors `ships.ts#fetchHangar` (same loop, same safety cap)
 *  but returns rich pledge objects instead of bare ship names. */
export async function fetchHangarPledges(): Promise<HangarPledge[]> {
  const all: HangarPledge[] = [];
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
    const { pledges, maxPage } = parseHangarPledgesPage(html);
    all.push(...pledges);
    if (page >= maxPage) break;
    page += 1;
    if (page > 50) break; // safety cap, mirrors fetchHangar
  }
  return all;
}

// ---------------------------------------------------------------------------
// Ship-code resolver
// ---------------------------------------------------------------------------

/** Build the lookup index once at module load so resolution is O(1)
 *  instead of O(N) per ship. We key by lowercased trimmed ship_name —
 *  HangarXPLOR's exporter does the same. */
const shipCodeIndex = new Map<string, ShipCodeEntry>();
for (const entry of SHIP_CODES) {
  const key = entry.ship_name.trim().toLowerCase();
  if (key) shipCodeIndex.set(key, entry);
}

/** Deterministic fallback when the ship isn't in our seed table. RSI
 *  occasionally adds new chassis between our table updates; rather than
 *  drop those rows from the export we synthesize a best-effort code.
 *  Format mirrors HangarXPLOR's fallback: `<MFR_CODE>_<TITLE>` with
 *  whitespace-as-underscore + a token-safe character class. The result
 *  may not match an external tool's expected shape but at least it's
 *  unique and stable across runs. */
function fallbackShipCode(shipName: string, manufacturerCode: string): string {
  const slug = shipName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const mfr = manufacturerCode.trim() || 'UNK';
  return `${mfr}_${slug}`;
}

/** Resolve a ship to its canonical (ship_code, manufacturer_*) tuple
 *  for HTF export.
 *
 *  Lookup order:
 *    1. Exact case-insensitive match on the seed table.
 *    2. Strip a trailing " with <something>" suffix and retry. RSI's
 *       hangar HTML lumps bundled ships into a single display name —
 *       e.g. "Carrack Expedition with Pisces Expedition" — but the
 *       canonical entry in HangarXPLOR's table is just "Carrack
 *       Expedition" (the bundled Pisces would be exported as a
 *       separate row, not part of the parent ship's code). Confirmed
 *       against a real HangarXPLOR export where this exact ship
 *       resolved to `ANVL_Carrack_Expedition`.
 *    3. Strip an "and <something>" suffix and retry, covering the
 *       rarer "X and Y" mashups RSI sometimes ships.
 *    4. Synthesize a deterministic `<MFR>_<NAME>` slug as a last
 *       resort. Stable across runs but won't match an external tool's
 *       expected shape — visible in the export as a non-canonical
 *       code (good signal that we should add the entry to the table).
 */
export function resolveShipCode(
  shipName: string,
  manufacturerCode: string,
  manufacturerName: string,
): {
  ship_code: string;
  ship_name: string;
  manufacturer_code: string;
  manufacturer_name: string;
} {
  const trimmed = shipName.trim();
  const key = trimmed.toLowerCase();
  const hit = shipCodeIndex.get(key);
  if (hit) return { ...hit };

  // Fuzzy step: strip " with <X>" suffix. The canonical name lives
  // in the table; the bundled half (Pisces / Lynx / Archimedes) is
  // surfaced separately by the popup's BUNDLED_BY_SHIP_NAME table.
  const stripWith = trimmed.replace(/\s+with\s+.+$/i, '').trim();
  if (stripWith !== trimmed) {
    const fuzzyHit = shipCodeIndex.get(stripWith.toLowerCase());
    if (fuzzyHit) return { ...fuzzyHit };
  }
  // Same idea for "X and Y" mashups.
  const stripAnd = trimmed.replace(/\s+and\s+.+$/i, '').trim();
  if (stripAnd !== trimmed && stripAnd !== stripWith) {
    const fuzzyHit = shipCodeIndex.get(stripAnd.toLowerCase());
    if (fuzzyHit) return { ...fuzzyHit };
  }

  return {
    ship_code: fallbackShipCode(shipName, manufacturerCode),
    ship_name: shipName,
    manufacturer_code: manufacturerCode,
    manufacturer_name: manufacturerName || manufacturerCode || 'Unknown',
  };
}

// ---------------------------------------------------------------------------
// HTF (`shiplist.json`) builder
// ---------------------------------------------------------------------------

/** Build a HangarXPLOR-compatible flat ship list from the structured
 *  pledges. Pledge metadata (id / name / date / cost / flags) is
 *  denormalised onto every ship row — one row per ship, even when
 *  multiple ships share a pledge. Field order, sort order, and the
 *  nickname/`name` split all mirror HangarXPLOR exactly so the file
 *  is byte-equivalent to its output (modulo content of course):
 *
 *    - Sort: by `ship_name` alone, alphabetical ascending.
 *      Verified from a real HangarXPLOR export — they do NOT group
 *      by manufacturer first.
 *    - `ship_name` is the user's custom nickname when set, otherwise
 *      the ship's actual name. The actual name always lives in
 *      `name` regardless. Tools that key off `name` ignore nicknames;
 *      tools that show `ship_name` get the user-facing label.
 *    - `pledge_name` keeps RSI's prefix verbatim
 *      ("Standalone Ship - Anvil Arrow") — the popup-side strip is
 *      cosmetic only.
 *    - Field insertion order matches HangarXPLOR's literal:
 *      ship_code, ship_name, manufacturer_code, manufacturer_name,
 *      lti, name, warbond, entity_type, pledge_id, pledge_name,
 *      pledge_date, pledge_cost.
 *
 *  Bundled (transitive) ships from BUNDLES are intentionally NOT
 *  included here so the export stays strictly compatible with
 *  HangarXPLOR consumers — the popup shows them with a "+ bundled"
 *  badge for the user, but they don't survive into the JSON. */
export function buildHtfRows(pledges: ReadonlyArray<HangarPledge>): HtfShipRow[] {
  const rows: HtfShipRow[] = [];
  for (const p of pledges) {
    for (const s of p.ships) {
      const resolved = resolveShipCode(s.shipName, s.manufacturerCode, s.manufacturerName);
      // `ship_name` = nickname when set, otherwise the RAW hangar name
      //   (NOT the canonical from the seed table — HangarXPLOR keeps
      //   the user-facing label here so a non-nicknamed
      //   "Carrack Expedition with Pisces Expedition" stays as
      //   "Carrack Expedition with Pisces Expedition", not the
      //   short canonical "Carrack Expedition" the ship_code resolves
      //   to.)
      // `name` = always the raw hangar name. The fuzzy resolver only
      //   trims for ship_code lookup; the displayed/exported name
      //   keeps the full hangar display.
      const displayName =
        s.shipNickname && s.shipNickname.length > 0 ? s.shipNickname : s.shipName;
      rows.push({
        ship_code: resolved.ship_code,
        ship_name: displayName,
        manufacturer_code: resolved.manufacturer_code,
        manufacturer_name: resolved.manufacturer_name,
        lti: p.lti,
        name: s.shipName,
        warbond: p.warbond,
        entity_type: 'ship',
        pledge_id: p.pledgeId,
        pledge_name: p.pledgeNameRaw,
        pledge_date: p.pledgeDate,
        pledge_cost: p.pledgeCost,
      });
    }
  }
  // Match HangarXPLOR: sort by ship_name only (nickname-aware),
  // alphabetical. Confirmed against a live export — Aegis "Avenger
  // Titan Renegade" sat between two Anvil ships ("Arrow" and
  // "Buzz Lightyear" / "Caterpillar"), proving they don't group by
  // manufacturer.
  rows.sort((a, b) => a.ship_name.localeCompare(b.ship_name));
  return rows;
}

/** Build the matching CSV column set HangarXPLOR exports. Format
 *  matches the upstream tool's quoting style (verified against a
 *  real export):
 *    - Header row is unquoted, comma-space separator
 *      ("Manufacturer, Ship, Lti, Warbond, ID, Pledge, Cost, Date").
 *    - String fields are always double-quoted (even when they
 *      contain no commas), embedded quotes escaped via "" .
 *    - Booleans (`true`/`false`) are emitted unquoted.
 *    - Numeric pledge_id is emitted unquoted (it's a numeric string
 *      from RSI but consumers parse the field as a number).
 *  The Cost column carries the raw "$1,205.00 USD" string, which
 *  contains a literal comma — that's why string quoting matters. */
export function buildHtfCsv(pledges: ReadonlyArray<HangarPledge>): string {
  const rows = buildHtfRows(pledges);
  const header = 'Manufacturer, Ship, Lti, Warbond, ID, Pledge, Cost, Date';
  const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [
        quote(r.manufacturer_name),
        quote(r.ship_name),
        r.lti ? 'true' : 'false',
        r.warbond ? 'true' : 'false',
        // pledge_id arrives as a numeric string already — emit raw.
        // Defensive trim in case RSI ever pads it.
        r.pledge_id.trim(),
        quote(r.pledge_name),
        quote(r.pledge_cost),
        quote(r.pledge_date),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
