// Buy-back pledges — scraped from GET /account/buy-back-pledges (HTML, paginated).
// Each entry can be reclaimed via `/pledge/buyback/<id>` unless marked unavailable.

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiHtmlNotLogin, assertRsiNotRedirectedToLogin, assertRsiOk } from './auth.js';

export const BuyBackPledge = z.object({
  id: z.string(),
  title: z.string(),
  image: z.string().nullable(),
  fields: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  /** Direct reclaim link (/pledge/buyback/<id>). null when not directly reclaimable. */
  reclaimUrl: z.string().nullable(),
  /** True when only a CCU upgrade flow is available (no direct buy-back). */
  ccuOnly: z.boolean().default(false),
});
export type BuyBackPledge = z.infer<typeof BuyBackPledge>;

export interface BuyBackListPage {
  pledges: BuyBackPledge[];
  hasNextPage: boolean;
  page: number;
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

function resolveUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  return src.startsWith('http') ? src : `${RSI_BASE_URL}${src}`;
}

/** Case-insensitive attribute read. RSI writes the CCU pledge id as
 *  `data-pledgeId` (camelCase) and linkedom — unlike a browser's HTML
 *  parser — preserves the source casing verbatim, so a plain
 *  `getAttribute('data-pledgeid')` misses it. Scanning the attribute
 *  list works whichever casing RSI ships. */
function attrCaseInsensitive(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const want = name.toLowerCase();
  for (const at of Array.from(el.attributes ?? [])) {
    if (at.name.toLowerCase() === want) return at.value;
  }
  return null;
}

/** djb2 hash → base36 string. Used to synthesize a stable fallback ID
 *  for buy-back pledges that have neither a reclaim href nor a CCU data
 *  attribute to key off. Using `${page}:${pledges.length}` as a fallback
 *  broke cache and favourites: if RSI reorders the list or hides a
 *  previously-shown pledge, the same SKU gets assigned a different id,
 *  and the popup treats it as a new pledge. Hashing the title+image
 *  gives us a deterministic id tied to the pledge itself, not its
 *  position in the response. */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function parseBuyBackPage(html: string, page: number): BuyBackListPage {
  const { document } = parseHTML(html);
  const pledges: BuyBackPledge[] = [];
  /** How many times each base id has been emitted on this page. */
  const idCounts = new Map<string, number>();

  for (const card of Array.from(document.querySelectorAll('article.pledge'))) {
    const title = text(card.querySelector('h1'));
    const image = resolveUrl(card.querySelector('figure img')?.getAttribute('src'));

    const fields: Array<{ label: string; value: string }> = [];
    const dts = card.querySelectorAll('dl dt');
    const dds = card.querySelectorAll('dl dd');
    const n = Math.min(dts.length, dds.length);
    for (let i = 0; i < n; i++) {
      const label = text(dts[i]);
      const value = text(dds[i]);
      if (label) fields.push({ label, value });
    }

    // Direct reclaim anchor: a.holosmallbtn with a /pledge/buyback/<id> href.
    // Note: `div.unavailable` is always present in the DOM (toggled by CSS) so
    // it cannot be used as an availability signal.
    const reclaimAnchor = card.querySelector(
      'a.holosmallbtn[href^="/pledge/buyback/"]',
    ) as HTMLAnchorElement | null;
    const reclaimHref = reclaimAnchor?.getAttribute('href') ?? null;
    const reclaimUrl = resolveUrl(reclaimHref);

    const ccuOnly =
      !reclaimHref && Boolean(card.querySelector('a.holosmallbtn.js-open-ship-upgrades'));

    const idMatch = reclaimHref ? /\/pledge\/buyback\/(\d+)/.exec(reclaimHref) : null;
    const ccuId = ccuOnly
      ? attrCaseInsensitive(
          card.querySelector('a.holosmallbtn.js-open-ship-upgrades'),
          'data-pledgeid',
        )
      : null;
    // Content-hash fallback: deterministic across reorderings and pagination
    // shifts, so favourites and the popup-side cache don't break when RSI
    // rearranges the hangar list.
    const baseId = idMatch?.[1] ?? ccuId ?? `fb:${stableHash(`${title}|${image ?? ''}`)}`;

    // Two genuinely distinct pledges can share `baseId`: the content hash
    // collides for duplicate SKUs (two identical Auroras in buy-back have
    // the same title + image), and RSI itself repeats `data-pledgeId`
    // across CCU rows that point at the same source pledge. A duplicate id
    // crashes the popup's keyed `{#each ... (p.id)}` with
    // `each_key_duplicate`, so disambiguate repeats within the page.
    // The first occurrence keeps the bare id, which keeps the common
    // (non-duplicated) case byte-identical to what the cache already holds.
    const seenCount = idCounts.get(baseId) ?? 0;
    idCounts.set(baseId, seenCount + 1);
    const id = seenCount === 0 ? baseId : `${baseId}#${seenCount + 1}`;

    pledges.push({ id, title, image, fields, reclaimUrl, ccuOnly });
  }

  const hasNextPage = Boolean(document.querySelector('.pager a.raquo.btn'));

  return { pledges, hasNextPage, page };
}

export async function fetchBuyBackPage(page = 1): Promise<BuyBackListPage> {
  const url = `${RSI_BASE_URL}/account/buy-back-pledges${page > 1 ? `?page=${page}` : ''}`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    credentials: 'include',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  assertRsiOk(response, 'account/buy-back-pledges');
  assertRsiNotRedirectedToLogin(response);
  const html = await response.text();
  assertRsiHtmlNotLogin(html);
  return parseBuyBackPage(html, page);
}
