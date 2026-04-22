// Parser for the public Comm-Link listing page:
//   https://robertsspaceindustries.com/en/comm-link?page=N
// Each article is an <a class="hub-block">; we extract the fields the old
// extension used to display so the UI can stay simple.
//
// The same listing page embeds the server's search form, so we also pull
// the dropdown options (Channel, Series, Type, Sort) out of the HTML. The
// Series list in particular carries ~60 items with hand-curated slugs (e.g.
// "inside", "wingman", "loremakers") that cannot be derived from their human
// labels — scraping them is the only way to keep the popup's dropdown in
// sync with whatever CIG publishes.

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';

export const CommLinkArticle = z.object({
  href: z.string(),
  url: z.string(),
  title: z.string(),
  type: z.string(),
  section: z.string(),
  timeAgo: z.string(),
  comments: z.number().int(),
  image: z.string().nullable(),
  excerpt: z.string(),
  size: z.enum(['one_third', 'two_thirds', 'full']),
});
export type CommLinkArticle = z.infer<typeof CommLinkArticle>;

export interface CommLinkFormOption {
  /** Displayed label, e.g. "Inside Star Citizen". */
  label: string;
  /** URL parameter value, e.g. "inside". Empty string = "All" / no filter. */
  value: string;
}

export interface CommLinkFormOptions {
  channels: CommLinkFormOption[];
  series: CommLinkFormOption[];
  types: CommLinkFormOption[];
  sorts: CommLinkFormOption[];
}

export interface CommLinkListing {
  articles: CommLinkArticle[];
  /** Dropdown options scraped from the form on the same page. */
  options: CommLinkFormOptions;
}

export type CommLinkSort = 'publish_new' | 'publish_old';

export interface CommLinkSearchParams {
  page?: number;
  /** Channel slug (e.g. "transmission"). Empty/undefined = no filter. */
  channel?: string;
  /** Series slug (e.g. "inside"). Empty/undefined = no filter. */
  series?: string;
  /** Type slug ("post" | "slideshow" | "video" | "poll"). */
  type?: string;
  /** Free text search (matched server-side against title/excerpt). */
  text?: string;
  /** Sort order. Defaults to 'publish_new'. */
  sort?: CommLinkSort;
}

/**
 * Build the canonical Comm-Link listing URL. Empty/undefined params are
 * omitted so the URL stays cacheable by the background (matching keys)
 * regardless of whether the caller set optional fields.
 */
export function buildCommLinkUrl(params: CommLinkSearchParams = {}): string {
  const qs = new URLSearchParams();
  const page = params.page ?? 1;
  qs.set('page', String(page));
  if (params.channel) qs.set('channel', params.channel);
  if (params.series) qs.set('series', params.series);
  if (params.type) qs.set('type', params.type);
  if (params.text) qs.set('text', params.text);
  if (params.sort) qs.set('sort', params.sort);
  return `${RSI_BASE_URL}/en/comm-link?${qs.toString()}`;
}

const SIZE_CLASSES: ReadonlyArray<CommLinkArticle['size']> = [
  'one_third',
  'two_thirds',
  'full',
];

function extractBackgroundUrl(style: string | null): string | null {
  if (!style) return null;
  const match = /url\((['"]?)([^)'"]+)\1\)/.exec(style);
  const raw = match?.[2];
  if (!raw) return null;
  return raw.startsWith('http') ? raw : `${RSI_BASE_URL}${raw}`;
}

function sizeFromClass(classAttr: string | null): CommLinkArticle['size'] {
  if (!classAttr) return 'one_third';
  for (const size of SIZE_CLASSES) {
    if (classAttr.includes(size)) return size;
  }
  return 'one_third';
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').trim();
}

function parseArticles(document: Document): CommLinkArticle[] {
  const anchors = document.querySelectorAll('a.hub-block');
  const out: CommLinkArticle[] = [];

  for (const a of Array.from(anchors)) {
    const href = a.getAttribute('href') ?? '';
    if (!href) continue;

    const bg = a.querySelector('.background');
    const image = extractBackgroundUrl(bg?.getAttribute('style') ?? null);

    const typeLabel = text(a.querySelector('.type > span'));
    const title = text(a.querySelector('.title'));
    const section = text(a.querySelector('.section'));
    const timeAgo = text(a.querySelector('.time_ago .value'));
    const excerpt = text(a.querySelector('.body p')) || text(a.querySelector('.body'));

    const commentsText = text(a.querySelector('.comments'));
    const comments = Number.parseInt(commentsText.replace(/[^0-9]/g, ''), 10) || 0;

    const url = href.startsWith('http') ? href : `${RSI_BASE_URL}${href}`;

    out.push({
      href,
      url,
      title,
      type: typeLabel,
      section,
      timeAgo,
      comments,
      image,
      excerpt,
      size: sizeFromClass(a.getAttribute('class')),
    });
  }

  return out;
}

/**
 * Pull the `<li class="js-option option" rel="VALUE">LABEL</li>` entries out
 * of the selectlist matching `anchorSelector`. The hub-search form uses four
 * of these: one per dropdown. Empty `rel=""` entries become the canonical
 * "All" / no-filter option.
 */
function parseDropdownOptions(
  document: Document,
  anchorSelector: string,
): CommLinkFormOption[] {
  const anchor = document.querySelector(anchorSelector);
  if (!anchor) return [];
  const items = anchor.querySelectorAll('li.js-option');
  const out: CommLinkFormOption[] = [];
  for (const li of Array.from(items)) {
    const value = li.getAttribute('rel') ?? '';
    const label = text(li);
    if (!label) continue;
    out.push({ value, label });
  }
  return out;
}

// For the Sort + Type dropdowns there's no distinct class on the anchor, so
// we locate them via their adjacent hidden input by id and walk up to the
// selectlist. Channels and Series each have dedicated classes so they're
// picked directly.
function parseSortAndTypeOptions(
  document: Document,
  hiddenInputId: string,
): CommLinkFormOption[] {
  const input = document.querySelector(`input#${hiddenInputId}`);
  const anchor = input?.closest('a.js-selectlist');
  if (!anchor) return [];
  const out: CommLinkFormOption[] = [];
  for (const li of Array.from(anchor.querySelectorAll('li.js-option'))) {
    const value = li.getAttribute('rel') ?? '';
    const label = text(li);
    if (!label) continue;
    out.push({ value, label });
  }
  return out;
}

function parseFormOptions(document: Document): CommLinkFormOptions {
  return {
    channels: parseDropdownOptions(document, 'a.js-selectlist.js-channel'),
    series: parseDropdownOptions(document, 'a.js-selectlist.js-series'),
    types: parseSortAndTypeOptions(document, 'type'),
    sorts: parseSortAndTypeOptions(document, 'sort'),
  };
}

export function parseCommLinkListing(html: string): CommLinkListing {
  const { document } = parseHTML(html);
  return {
    articles: parseArticles(document as unknown as Document),
    options: parseFormOptions(document as unknown as Document),
  };
}
