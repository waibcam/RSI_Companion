// Centralised URLs for the "support / share" surface.
//
// Kept here (not inlined in components) because the same handful of
// links are referenced by:
//   - RatePrompt.svelte    — the timed "do you like the extension?"
//                            banner and its post-thumbs-up CTAs.
//   - Support.svelte       — always-visible "Help spread the word"
//                            section so users can upvote / rate
//                            without waiting for the timed prompt.
// Centralising avoids the same ID drifting in two places (which is
// how Edge URLs ended up with the wrong listing slug in 1.4.x's
// Privacy panel before we caught it).
//
// The IDs themselves are stable — once a listing is published, its
// id never changes. Slugs CAN change but only when the maintainer
// renames the listing. Update here if that ever happens.

/** Maintainer's RSI Community Hub announcement post. Surfaced as the
 *  primary "upvote" target — the upvote button on this page is the
 *  most useful place to send fans of the extension. */
export const COMMUNITY_HUB_POST_URL =
  'https://robertsspaceindustries.com/community-hub/post/rsi-companion-2DogcaI2cFYxI';

/** Public store listing IDs. */
const CHROME_EXT_ID = 'kopamahnjkchmgjkoejfconipkclhibf';
const EDGE_EXT_ID = 'nddoipijjeknejmobmdlkiphpahgdnjh';
const FIREFOX_SLUG = 'rsi-companion';
/** Slug used in the URL path before the extension ID. Stable as long
 *  as the listing's display name doesn't change. */
const STORE_LISTING_SLUG = 'rsi-companion';

/** WXT injects this at build time — one of 'chrome' / 'firefox' /
 *  'edge' / 'opera' / 'safari'. Falls back to 'chrome' on unknown
 *  channels so users still get a working link rather than a 404. */
const BROWSER: string =
  (import.meta as unknown as { env?: { BROWSER?: string } }).env?.BROWSER ?? 'chrome';

/** Friendly name of the current browser's store, for button labels
 *  ("Rate on Chrome Web Store"). */
export function storeName(): string {
  if (BROWSER === 'firefox') return 'Firefox AMO';
  if (BROWSER === 'edge') return 'Edge Add-ons';
  return 'Chrome Web Store';
}

/** Listing URL — the front page of the store entry. */
export function storeListingUrl(): string {
  if (BROWSER === 'firefox') {
    return `https://addons.mozilla.org/firefox/addon/${FIREFOX_SLUG}/`;
  }
  if (BROWSER === 'edge') {
    return `https://microsoftedge.microsoft.com/addons/detail/${STORE_LISTING_SLUG}/${EDGE_EXT_ID}`;
  }
  return `https://chromewebstore.google.com/detail/${STORE_LISTING_SLUG}/${CHROME_EXT_ID}`;
}

/** Review URL — the deepest link we can deep-link into for a "leave
 *  a rating" experience. Chrome and Firefox have an explicit
 *  /reviews/ path; Edge Add-ons has no review-deep-link, so we land
 *  on the listing page (the review controls sit below the fold). */
export function storeReviewUrl(): string {
  if (BROWSER === 'firefox') {
    return `https://addons.mozilla.org/firefox/addon/${FIREFOX_SLUG}/reviews/`;
  }
  if (BROWSER === 'edge') {
    return `https://microsoftedge.microsoft.com/addons/detail/${STORE_LISTING_SLUG}/${EDGE_EXT_ID}`;
  }
  return `https://chromewebstore.google.com/detail/${STORE_LISTING_SLUG}/${CHROME_EXT_ID}/reviews`;
}
