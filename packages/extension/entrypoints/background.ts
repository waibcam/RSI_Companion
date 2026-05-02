// Firefox cross-version polyfill: `chrome.*` APIs only auto-promisify in
// Firefox 114+ (2023). Before that, and on forks that lag behind (Waterfox
// on Linux was the original report — see the Etyx Discord thread and the
// `TypeError: can't access property "notify:state" of undefined` backlog),
// `chrome.storage.local.get(key)` without a callback returns `undefined`,
// so every `await chrome.storage.*` below would resolve to `undefined` and
// the next `.property` access throws. The `browser` global has been
// Promise-returning since Firefox 45 (2016), so aliasing `chrome → browser`
// at the top of the service worker fixes the whole call tree in one line.
// No-op on Chrome/Edge where `browser` doesn't exist.
declare const browser: typeof chrome | undefined;
if (typeof browser !== 'undefined') {
  (globalThis as unknown as { chrome: typeof chrome }).chrome = browser;
}

import { z } from 'zod';
import {
  LOANERS,
  BUNDLES,
  Notify,
  RELEASE_NOTES,
  RSI_BASE_URL,
  RSI_COOKIE_LIVE,
  Rsi,
  Schemas,
  SHIP_NAME_CATALOG,
  fetchWithTimeout,
  log,
  CONTACTS_SYNC_TO_PTU_PORT,
  type ContactsSyncToPtuEntry,
  type ContactsSyncToPtuResponsePayload,
  type ContactsSyncToPtuStreamCommand,
  type ContactsSyncToPtuStreamEvent,
  type RsiMessage,
  type RsiMessageResult,
} from '@rsi-companion/shared';

const CACHE_PREFIX = 'cache:';
// Per-namespace schema version. Bump an entry here when the shape of entries
// under that prefix changes — only that namespace gets wiped on next start,
// the rest survive. Previously a single extension-version-wide migration
// nuked the entire cache on every release, forcing even unchanged shapes
// (like the expensive ~15-request Galactapedia index crawl) to rebuild.
//
// Naming is the cache-key prefix as written by handlers: the migration wipes
// exact matches and anything starting with `<prefix>:`. That means prefixes
// must not overlap — e.g. `spectrum` (bare) would also catch `spectrum:trending`.
// The separator keeps things disjoint.
const CACHE_NAMESPACE_VERSIONS: Record<string, number> = {
  'auth:identity': 1,
  // v2: cache entry shape gained an `options` field (search-form dropdowns).
  // Stale v1 entries have no options — the new handler would return
  // `options: undefined` and the popup crashes on `options.channels.length`.
  'commlink:list': 2,
  'patchnotes:list': 1,
  // v2: PledgeShip gained a `size` field for the Size filter group.
  // Old v1 cache entries have no `size` → filter shows everyone as
  // "unknown size". Bump wipes them cleanly.
  'pledge:shipList': 2,
  // v3: PledgeShipDetail gained per-SKU native-currency pricing plus
  // the user's pricing context (currencyCode/symbol/exponent). Older
  // entries (v1 or v2) don't have `price`/`currencyCode` → Editions
  // would render with missing prices until refresh. Bump wipes.
  'pledge:shipDetail': 3,
  'pledge:shipSlugByUrl': 1,
  'pledge:cart': 1,
  'pledge:browse': 1,
  'pledge:ccuInit': 1,
  'pledge:ccuTargets': 1,
  // v2: owned flag source switched from hangar HTML scrape to CCU
  // catalogue (server-authoritative). Old v1 entries may have the wrong
  // owned set on the cached payload — wipe once so the new algorithm
  // runs fresh.
  // v3: bundle expansion — owning Constellation Phoenix / Phoenix
  // Emerald now also marks the bundled Lynx + P-72 Archimedes as
  // owned. Old caches don't have those flags set.
  'ships:list': 3,
  // v2: 1.4.x shipped a poll-side cache write that only seeded `contacts`
  // and dropped `incoming`/`outgoing` — the popup module read those as
  // undefined and crashed on .length. Bump invalidates broken entries.
  'contacts:list': 2,
  'orgs:list': 1,
  'orgs:invitations': 1,
  'orgs:applications': 1,
  'orgs:search': 1,
  'orgs:members': 1,
  'dashboard:summary': 1,
  'buyback:list': 1,
  // v2: referral sub-object gained a `campaignId` field + the fetcher
  // switched from HTML scraping to a GraphQL batch (same shape fields,
  // but the scrape returned zeros so stored entries are unreliable).
  'stats:summary': 2,
  // v2: snapshot gained `gameplay` + `tutorial` strips; v1 entries
  // would render the old single-trending layout with two empty
  // strips on the new UI. Bump to invalidate on first boot.
  'communityHub:home': 2,
  'communityHub:live': 1,
  'communityHub:events': 1,
  'communityHub:posts': 1,
  'galactapedia:list:v2': 1,
  'galactapedia:search:v2': 1,
  // v2: GalactapediaCategory gained a `thumbnailUrl` field. Old v1 entries
  // have no URL → UI renders the placeholder icon for every category
  // until the next refresh. Bump wipes them on first boot.
  'galactapedia:categories': 2,
  'galactapedia:tags': 1,
  'galactapedia:index:v2': 1,
  'galactapedia:article': 1,
  'galactapedia:home': 1,
  'progress-tracker:v2': 1,
  'roadmap:data': 1,
  // v2: SpectrumThread gained isPinned + authorIsStaff for the new
  // pin badge + CIG gold tint in the threadCard renderer.
  // v3: SpectrumThread gained votesCount + repliesCount + viewsCount
  // so the threadCard footer can show post engagement at a glance.
  // v4: SpectrumThread gained mediaPreviewUrl for inline thumbnails.
  // v5: source switched from fetchHighlightedThreads (forum API,
  // top-level threads only) to fetchDevTrackerPosts (HTML scrape of
  // /community/devtracker — includes CIG replies + all categories).
  // The id field now carries the reply id, the URL ends with /<replyId>.
  'spectrum:threads': 5,
  'spectrum:trending': 4,
  'spectrum:notifications': 1,
  'spectrum:lobbies': 1,
  // v2: every message gained `authorIsStaff` for the CIG gold tint.
  // v3: messages gained content_state segments (rich-text rendering).
  // v4: messages gained authorBadges so org icons appear inline.
  // v5: messages gained `reactions` so the per-message react chips +
  // picker render correctly from cache hits.
  // v6: badge `icon` URLs are now absolutified (Spectrum returns
  // relative `/media/...` paths that 404 in the popup origin); old
  // entries hold the broken relative URLs.
  'spectrum:lobbyMessages': 6,
  'spectrum:communities': 1,
  'spectrum:bookmarks': 1,
  'spectrum:emojis': 1,
  // v2: content_blocks normalizer was unwrapping wrong (ignored the
  // {type:'text', data:{blocks}} wrapper layer), so cached entries
  // had empty/wrong content. v3: SpectrumThreadReply gained a
  // recursive `replies` field for inline-embedded children — old
  // entries don't have it and the expand-replies UI would render
  // empty children for already-cached threads. v4: every reply +
  // OP gained `authorIsStaff` so the gold-tint rendering kicks in
  // for CIG posts. v5: SpectrumContentBlock gained `segments` so
  // inline styles + links + mentions render as rich text. v6:
  // detail + replies gained votesCount + reactions so the
  // engagement chips render properly. v7: detail + replies gained
  // authorBadges so org icons appear next to author name. v8: detail
  // + replies + reactions gained user-state flags (`hasVoted` and
  // `userReacted`) so the vote/react buttons can render their pressed
  // state from cache hits. v9: detail gained `notificationSubscription`
  // for the per-thread bell toggle. v10: badge `icon` URLs now
  // absolutified — old entries hold broken `/media/...` relative paths.
  'spectrum:threadDetail': 10,
  // v2: groups + threads cache keys gained the communityId prefix in
  // Phase 3 so SC and org communities can coexist in the cache without
  // colliding. v1 entries (no community prefix) become orphans on
  // first boot — fine, they expire on their own LIVE/ACCOUNT TTL.
  // v3 (groups only): the org-community channels were silently empty
  // because we only called group/list and assumed embedded channels.
  // v4: ditched the v2 fallback entirely — identify carries org
  // forum data when called from an authenticated session, and v2
  // returned empty in the extension's auth context. Bumped to
  // invalidate the still-empty entries from v3.
  // v5: channels now carry `notificationSubscription` so the bell
  // toggle on the channel header can render the right pressed state
  // straight from cache.
  'spectrum:forumGroups': 5,
  // v3: forum threads list got the same isPinned + authorIsStaff bump.
  // v4: forum threads list gained votesCount/repliesCount/viewsCount.
  // v5: forum threads list gained mediaPreviewUrl for inline thumbnails.
  // v6: forum threads list gained hasVoted (the user's upvote state)
  // for the inline vote button on each thread card.
  'spectrum:forumThreads': 6,
  'status:summary': 1,
};
const CACHE_NAMESPACE_VERSION_PREFIX = 'cache:__v:';
// Pre-migration singleton key (extension-version-based wipe). Kept in the
// code only so the new migration can clean it up on first run — it is no
// longer written.
const LEGACY_CACHE_VERSION_KEY = 'cache:__version';
// TTLs are grouped by how fast the underlying data changes. A manual refresh
// button on every module bypasses these — long TTLs don't trap stale data,
// they just avoid re-fetching when the user was fine with the current view.
//
//   LIVE        — minute-to-minute: DMs, notifications, live streams,
//                 community hub feed. Stay aggressive here so the popup
//                 reflects reality within a couple of minutes.
//   CONTENT     — CIG-published feeds (Comm-Link, Patch Notes). Cadenced
//                 weekly in practice, but the "is there a new post" answer
//                 is the primary reason people open the popup, so keep
//                 moderate (10 min).
//   ACCOUNT     — per-user state that changes on the user's own action
//                 (ships in hangar, buy-back, orgs, contacts). Unlikely to
//                 change unprompted between popup opens, long TTL is safe.
//   REFERENCE   — data that refreshes on patch cycles or never (public ship
//                 matrix fallback, Galactapedia categories + tags). Safe for
//                 a week.
//   EVERGREEN   — essentially static, expensive to recompute. The
//                 Galactapedia A-Z index crawls ~15 sequential GraphQL
//                 pages — cache for a month, rely on the manual refresh
//                 button for the rare update.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const LIVE_TTL = 2 * MIN;
const CONTENT_TTL = 10 * MIN;
const ACCOUNT_TTL = 30 * MIN;
const REFERENCE_TTL = 7 * DAY;
const EVERGREEN_TTL = 30 * DAY;

const TTL = {
  // LIVE — changes minute-to-minute, keep short
  spectrumNotifs: LIVE_TTL,
  communityHub: LIVE_TTL,
  // Status is even shorter — when RSI goes down the user wants the popup to
  // stop pretending everything is fine within a minute or two, not hold a
  // 2-minute cache hit from before the outage.
  status: 90 * 1000,

  // ACCOUNT — per-user state, 30-min TTL so repeat popup opens in a session
  // are a pure cache hit. Sign-in/out flip via chrome.cookies.onChanged
  // wipes these synchronously; a manual refresh on the module forces a
  // fresh fetch even before the TTL.
  identity: ACCOUNT_TTL,
  dashboard: ACCOUNT_TTL,
  spectrum: ACCOUNT_TTL, // DM lobbies + highlighted threads (the counts are LIVE)
  ships: ACCOUNT_TTL,
  contacts: ACCOUNT_TTL,
  buyback: ACCOUNT_TTL,
  orgs: ACCOUNT_TTL,
  orgsSearch: CONTENT_TTL, // public search, content-like churn
  orgsMembers: ACCOUNT_TTL,

  // CONTENT — CIG feeds, moderate TTL
  commlink: CONTENT_TTL,
  patchnotes: CONTENT_TTL,
  // Pledge catalogue = ~90 ships with prices + images. Prices/availability
  // change when CIG opens/closes concept sales, so we pick a content TTL
  // (10 min) over a full reference TTL — long enough for repeated popup
  // opens to be cache hits, short enough that Monday's flash sale surfaces
  // within a few minutes.
  pledge: CONTENT_TTL,
  // CCU catalogue carries per-user `owned` flags → tied to auth state.
  // Cache 30 min; the cookies.onChanged listener wipes it on sign-in/out
  // so a flip resolves within the next popup open.
  ccuInit: ACCOUNT_TTL,
  // Cart is volatile — the user can add/remove items from other tabs or
  // via external checkout. 60 s is a sweet spot: tab switches inside the
  // popup feel instant, but a recent RSI-side change surfaces quickly.
  cart: 60 * 1000,
  // CCU target resolver per fromId. Prices/availability are more volatile
  // than the base catalogue (CIG runs flash-discount CCU sales), so pick
  // a shorter TTL.
  ccuTargets: CONTENT_TTL,
  roadmap: REFERENCE_TTL, // raw roadmap payload shared by Roadmap + Progress Tracker
  progressTracker: REFERENCE_TTL, // weekly-ish roadmap delta
  stats: ACCOUNT_TTL, // crowdfund + referral — crowdfund is content but the referral half is account-scoped

  // REFERENCE — infrequent changes. Galactapedia article data is curated
  // by CIG's writing team, turnover is on patch cadence; a week between
  // automatic refreshes is plenty.
  galactapedia: REFERENCE_TTL,
  // Home page featured content rotates daily-ish via CIG curation, so
  // a shorter TTL than the article data — long enough to make tab
  // switches instant within a session, short enough to pick up new
  // featured picks on the next popup open.
  galactapediaHome: CONTENT_TTL,

  // EVERGREEN — expensive to refresh, cache aggressively.
  // The A-Z Index pulls every article in the catalogue (~5-15 sequential
  // GraphQL requests). A month between auto-refreshes is deliberate — new
  // entries are rare enough that the manual refresh button covers the gap,
  // and we'd rather pay the cost once a month than nag the server repeatedly.
  galactapediaIndex: EVERGREEN_TTL,
};

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Enumerate every top-level key in chrome.storage.local without reading the
// values. Chrome 130+ exposes `getKeys()` natively; on older versions we fall
// back to the expensive `get(null)` which pulls every stored payload into
// memory (the Galactapedia index alone is ~1 MB). The fallback is only paid
// when the native API is missing.
async function listStorageKeys(): Promise<string[]> {
  const api = chrome.storage.local as chrome.storage.LocalStorageArea & {
    getKeys?: () => Promise<string[]>;
  };
  if (typeof api.getKeys === 'function') return api.getKeys();
  const all = await chrome.storage.local.get(null);
  return Object.keys(all);
}

// Generic in-flight deduplication for cache-miss paths. If two callers request
// the same key concurrently (e.g. popup.html opened in tab mode + the popup
// simultaneously, or a user spamming Refresh), they share one Promise instead
// of firing two RSI requests. Distinct from the memo in auth.ts: that one has
// a 15 s TTL and covers identify specifically; this one is instant-only and
// covers arbitrary handler keys.
const inFlight = new Map<string, Promise<unknown>>();
function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = (async () => {
    try {
      return await fn();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

async function cacheGet<T>(key: string): Promise<T | null> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + key);
  const entry = res[CACHE_PREFIX + key] as CacheEntry<T> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    await chrome.storage.local.remove(CACHE_PREFIX + key);
    return null;
  }
  return entry.value;
}

async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  const entry: CacheEntry<T> = { value, expiresAt: Date.now() + ttlMs };
  await chrome.storage.local.set({ [CACHE_PREFIX + key]: entry });
}

/** Schema-validated cache read.
 *
 *  Catches the class of bugs where two cache writers for the same key
 *  emit different shapes — historically v1.4.0's collectContactsPendingIds
 *  seeded `{contacts, fetchedAt}` while handleContactsList persisted
 *  `{contacts, incoming, outgoing, fetchedAt}`, so a hot-cache hit after
 *  a poll tick crashed the popup on `incoming.length` (1.4.3 fix). With
 *  this helper, that path would have returned null instead — the cache
 *  miss triggers a clean refetch, the popup never sees the malformed
 *  shape.
 *
 *  When the schema rejects the value, we silently evict the broken entry
 *  and return null — caller treats it as a cache miss. Logged at debug
 *  so a flood doesn't pollute the user's diagnostics dump but the signal
 *  is still there for incident triage.
 */
async function cacheGetValidated<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + key);
  const entry = res[CACHE_PREFIX + key] as CacheEntry<unknown> | undefined;
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    await chrome.storage.local.remove(CACHE_PREFIX + key);
    return null;
  }
  const parsed = schema.safeParse(entry.value);
  if (!parsed.success) {
    log.debug(
      'cache',
      `evicting ${key} — schema mismatch: ${parsed.error.issues.map((i) => i.path.join('.') || '<root>').join(', ')}`,
    );
    await chrome.storage.local.remove(CACHE_PREFIX + key);
    return null;
  }
  return parsed.data;
}

/** Top-level shape contracts for the multi-field caches most likely to
 *  crash the popup if a writer misses a field. Each schema declares the
 *  required keys at the top level only — array elements / nested shapes
 *  use `z.unknown()` so we don't pay deep-validation cost on every read
 *  and don't reject valid-but-enriched payloads.
 *
 *  Add a new entry here when introducing a multi-field cache that
 *  multiple writers can populate (poll path + popup handler is the
 *  canonical risk pattern). Single-entity caches like
 *  `{lobbies, fetchedAt}` don't need this — there's only one shape and
 *  one writer.
 *
 *  Reader sites pass the schema to `cacheGetValidated`; on schema
 *  mismatch the entry gets evicted + a clean cache miss returned, so
 *  the next refetch lands a correct shape. */
const CACHE_SCHEMAS = {
  'contacts:list': z
    .object({
      contacts: z.array(z.unknown()),
      incoming: z.array(z.unknown()),
      outgoing: z.array(z.unknown()),
      fetchedAt: z.number(),
    })
    .passthrough(),
  'commlink:list': z
    .object({
      articles: z.array(z.unknown()),
      options: z.unknown(),
      fetchedAt: z.number(),
    })
    .passthrough(),
  'ships:list': z
    .object({
      ships: z.array(z.unknown()),
      loanerIds: z.array(z.unknown()),
      ownedCount: z.number(),
      notFound: z.array(z.unknown()),
      rawHangarNames: z.array(z.unknown()),
      fetchedAt: z.number(),
    })
    .passthrough(),
  'stats:summary': z
    .object({
      crowdfund: z.unknown(),
      // referral can be null when the user is signed out; tolerate.
      referral: z.unknown(),
      buyBackTokens: z.unknown(),
      fetchedAt: z.number(),
    })
    .passthrough(),
} as const;

/** Stale-while-revalidate cache read. Always returns the stored value
 *  if it exists, regardless of TTL — but flags whether it has already
 *  expired so the caller can decide whether to kick a background
 *  refresh. Returns null only when the key isn't in storage at all.
 *
 *  The caller is responsible for the revalidation: typically wrap a
 *  refetch in `dedupe(key, …)` so a popup open + a concurrent poll
 *  don't fire two parallel re-fetches of the same key. Stale entries
 *  are NOT auto-evicted by this helper — they stay around until the
 *  caller's revalidation overwrites them, so subsequent stale-OK
 *  reads get the previous value rather than a forced cache miss.
 *
 *  Use this on long-TTL modules (Roadmap 7d, Galactapedia 7-30d,
 *  Comm-Link / Patch Notes 10min) where instant render beats absolute
 *  freshness. Avoid on volatile / auth-tied caches (Cart 60s, Identity)
 *  where serving a stale value can mislead the user. */
async function cacheGetWithStale<T>(
  key: string,
): Promise<{ value: T; isStale: boolean } | null> {
  const res = await chrome.storage.local.get(CACHE_PREFIX + key);
  const entry = res[CACHE_PREFIX + key] as CacheEntry<T> | undefined;
  if (!entry) return null;
  return { value: entry.value, isStale: entry.expiresAt < Date.now() };
}

async function runCacheMigration(): Promise<void> {
  const versionKeys = Object.keys(CACHE_NAMESPACE_VERSIONS).map(
    (ns) => CACHE_NAMESPACE_VERSION_PREFIX + ns,
  );
  const [stored, allKeys] = await Promise.all([
    chrome.storage.local.get(versionKeys),
    listStorageKeys(),
  ]);

  const toWipe: string[] = [];
  const versionUpdates: Record<string, { version: number }> = {};
  const wipedNamespaces: string[] = [];

  for (const [ns, declared] of Object.entries(CACHE_NAMESPACE_VERSIONS)) {
    const vKey = CACHE_NAMESPACE_VERSION_PREFIX + ns;
    const storedVersion = (stored[vKey] as { version?: number } | undefined)?.version;
    if (storedVersion === declared) continue;

    // Either a fresh install / post-legacy upgrade (no stored version) or a
    // real schema bump. Wipe keys under this namespace and promote the
    // version marker.
    const fullPrefix = CACHE_PREFIX + ns;
    for (const k of allKeys) {
      if (k === fullPrefix || k.startsWith(fullPrefix + ':')) toWipe.push(k);
    }
    versionUpdates[vKey] = { version: declared };
    wipedNamespaces.push(ns);
  }

  // Evict the legacy singleton version key from the pre-namespace-versioning
  // scheme — it has no value under the new model.
  if (allKeys.includes(LEGACY_CACHE_VERSION_KEY)) toWipe.push(LEGACY_CACHE_VERSION_KEY);

  if (toWipe.length > 0) {
    log.info(
      'cache',
      `migrating ${toWipe.length} entries across ${wipedNamespaces.length} namespace(s): ${wipedNamespaces.join(', ') || '(cleanup only)'}`,
    );
    await chrome.storage.local.remove(toWipe);
  }
  if (Object.keys(versionUpdates).length > 0) {
    await chrome.storage.local.set(versionUpdates);
  }
}

// Proactively delete cache: entries whose `expiresAt` is already in the
// past. cacheGet drops them lazily on read, but never-read keys (e.g. a
// commlink page the user paginated to once last week) accumulate disk
// space indefinitely. This pass runs once at boot, in chunks of 100 keys
// to avoid a giant chrome.storage.local.get() that would pull every
// payload (incl. the ~1 MB Galactapedia index) into memory at once.
//
// Cheap on a clean install (zero keys) and ~one read+remove batch on a
// long-lived install. Logs at debug — not interesting to non-devs.
async function pruneExpiredCacheEntries(): Promise<void> {
  const allKeys = await listStorageKeys();
  const cacheKeys = allKeys.filter((k) => k.startsWith(CACHE_PREFIX));
  if (cacheKeys.length === 0) return;
  const now = Date.now();
  const expired: string[] = [];
  const CHUNK = 100;
  for (let i = 0; i < cacheKeys.length; i += CHUNK) {
    const slice = cacheKeys.slice(i, i + CHUNK);
    const got = await chrome.storage.local.get(slice);
    for (const [key, value] of Object.entries(got)) {
      const v = value as { expiresAt?: number } | undefined;
      if (v && typeof v.expiresAt === 'number' && v.expiresAt < now) {
        expired.push(key);
      }
    }
  }
  if (expired.length > 0) {
    await chrome.storage.local.remove(expired);
    log.debug('cache', `pruned ${expired.length} expired entries`);
  }
}

// --- handlers -------------------------------------------------------------

async function handleIdentity(force: boolean) {
  const key = 'auth:identity';
  if (!force) {
    const cached = await cacheGet<{ identity: Rsi.RsiIdentity | null; fetchedAt: number }>(key);
    if (cached) {
      // Self-heal against cookie ↔ cache drift. The cookie listener
      // wipes this entry on sign-in / sign-out, but its
      // wipeAuthDependentCache() is async — if the popup opens within a
      // few ms of the cookie change (typical on a fresh install where
      // the user signs in then immediately opens the extension), the
      // storage read lands before the wipe completes and we paint a
      // stale "signed out" state for the rest of TTL.identity (30 min)
      // even though a valid Rsi-Token cookie is sitting right there.
      // Symptom: the Sign-In prompt that won't go away, exactly the
      // failure mode that broke the Edge cert review on 1.3.x.
      //
      // readRsiToken() has a 5 s in-memory memo so this stays cheap on
      // hot paths; the chrome.cookies.get() it falls back to costs <1 ms.
      // We only second-guess the "signed out" direction — a stale
      // "signed in" cache eventually corrects when the user actually
      // tries something that hits the API.
      if (cached.identity === null) {
        const tokenNow = await Rsi.readRsiToken();
        if (tokenNow) {
          // Drift detected — fall through to a fresh fetch.
        } else {
          return {
            identity: cached.identity,
            signedIn: false,
            fetchedAt: cached.fetchedAt,
            fromCache: true,
          };
        }
      } else {
        return {
          identity: cached.identity,
          signedIn: true,
          fetchedAt: cached.fetchedAt,
          fromCache: true,
        };
      }
    }
  }
  return dedupe(key, async () => {
    // force=true means the caller asked to bypass our own 5-min cache, so it
    // should also bypass the short in-memory identify memo in auth.ts — otherwise
    // a manual refresh within 15 s of the previous identify would silently serve
    // the stale payload.
    const identity = await Rsi.identifyRsi({ forceFresh: force });
    const fetchedAt = Date.now();
    await cacheSet(key, { identity, fetchedAt }, TTL.identity);
    return { identity, signedIn: identity !== null, fetchedAt, fromCache: false };
  });
}

async function handleCommLinkList(
  message: Extract<RsiMessage, { type: 'commlink.list' }>,
) {
  const force = message.force ?? false;
  const params: Rsi.CommLinkSearchParams = {
    page: message.page,
    channel: message.channel,
    series: message.series,
    type: message.articleType,
    text: message.text,
    sort: message.sort,
  };
  // Cache key includes every non-default filter so each combination is
  // memoized independently. Empty filters serialize to an empty segment;
  // `sort` is normalized to its RSI default ('publish_new') because
  // omitting it vs sending the explicit default produces identical server
  // responses but would have generated two different cache keys — the
  // popup persists `sort = 'publish_new'` but prefetchAll sends undefined,
  // so without this normalization the default view was never a cache hit.
  const keyParts = [
    params.page ?? 1,
    params.channel ?? '',
    params.series ?? '',
    params.type ?? '',
    (params.text ?? '').toLowerCase(),
    params.sort ?? 'publish_new',
  ];
  const key = `commlink:list:${keyParts.join(':')}`;
  if (!force) {
    const cached = await cacheGetValidated(key, CACHE_SCHEMAS['commlink:list']);
    if (cached) {
      return {
        page: params.page ?? 1,
        articles: cached.articles as Rsi.CommLinkArticle[],
        options: cached.options as Rsi.CommLinkFormOptions,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      };
    }
  }
  return dedupe(key, async () => {
    const url = Rsi.buildCommLinkUrl(params);
    const response = await fetchWithTimeout(url, {
      credentials: 'omit',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) {
      throw new Error(`RSI returned ${response.status} for comm-link ${url}`);
    }
    const html = await response.text();
    const { articles, options } = Rsi.parseCommLinkListing(html);
    const fetchedAt = Date.now();
    await cacheSet(key, { articles, options, fetchedAt }, TTL.commlink);
    return {
      page: params.page ?? 1,
      articles,
      options,
      fetchedAt,
      fromCache: false,
    };
  });
}

async function handleShipsList(force: boolean) {
  const token = await Rsi.readRsiToken();
  const signedIn = Boolean(token);

  // The ship matrix is public. We always return it so the user can browse ships
  // even when signed out. Owned flags and loaner info are only layered in when
  // we have a valid session cookie to read the hangar.
  const key = signedIn ? 'ships:list' : 'ships:list:public';
  if (!force) {
    // Same shape used by both ships:list (signed-in) and ships:list:public
    // (anonymous). Schema-validated read covers either key — five required
    // arrays + ownedCount, lots of opportunity to crash the grid renderer
    // if a writer ever drops one.
    const cached = await cacheGetValidated(key, CACHE_SCHEMAS['ships:list']);
    if (cached) {
      return {
        ships: cached.ships as Rsi.Ship[],
        loanerIds: cached.loanerIds as number[],
        ownedCount: cached.ownedCount,
        notFound: cached.notFound as string[],
        rawHangarNames: cached.rawHangarNames as string[],
        fetchedAt: cached.fetchedAt,
        signedIn,
        fromCache: true,
      };
    }
  }

  if (!signedIn) {
    // Public-only path: ship matrix + name catalog. No hangar, no owned flags.
    const [matrix, nameCatalog] = await Promise.all([
      Rsi.fetchShipMatrix(),
      Promise.resolve(SHIP_NAME_CATALOG.slice()),
    ]);
    const bundle = Rsi.mergeHangarIntoMatrix({
      matrix,
      hangarNames: [],
      nameCatalog,
      loanerTable: {},
    });
    const fetchedAt = Date.now();
    const payload = { ...bundle, rawHangarNames: [], fetchedAt };
    await cacheSet(key, payload, TTL.ships);
    return { ...payload, signedIn: false, fromCache: false };
  }

  try {
    // CCU-authoritative owned list is the primary source of truth now: CIG
    // tells us exactly which ships the user owns (by id) via the same
    // `pledge.ccuInit` query the Pledge Store + CCU tab already use. The
    // hangar HTML scrape is still fetched in parallel, but demoted to
    // count-only — it tells us "how many" of each owned ship. This makes
    // the module robust to RSI markup changes (the hangar HTML has been
    // re-skinned twice this year) and eliminates the fuzzy name matching
    // path for the `owned` bit.
    //
    // Hangar is wrapped in catch so a 401 / markup breakage doesn't take
    // down the whole module; CCU alone gives us a usable view (counts
    // default to 1 per owned ship). Same goes for CCU: if that query
    // fails, we fall back to the legacy hangar-based owned detection.
    const [matrix, hangarResult, nameCatalog, loanerTable, ccuResult] = await Promise.all([
      Rsi.fetchShipMatrix(),
      Rsi.fetchHangar().then(
        (names) => ({ ok: true as const, names }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      Promise.resolve(SHIP_NAME_CATALOG.slice()),
      Promise.resolve({ ...LOANERS }),
      handleCcuInit(false).then(
        (res) => ({ ok: true as const, res }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    ]);

    const hangarNames = hangarResult.ok ? hangarResult.names : [];
    const ccuOwnedIds = ccuResult.ok
      ? new Set(ccuResult.res.catalogue.ships.filter((s) => s.owned).map((s) => s.id))
      : undefined;

    // Only treat as "not signed in" when BOTH sources of owned data fail
    // with auth errors. One signal alone (e.g. hangar 401 while CCU is
    // fine) just means we use the working one.
    const hangarAuthFail =
      !hangarResult.ok && hangarResult.err instanceof Rsi.RsiNotAuthenticatedError;
    const ccuAuthFail =
      !ccuResult.ok || (ccuResult.ok && ccuResult.res.catalogue.isAnonymous);
    if (hangarAuthFail && ccuAuthFail) {
      throw new Rsi.RsiNotAuthenticatedError();
    }

    const bundle = Rsi.mergeHangarIntoMatrix({
      matrix,
      hangarNames,
      nameCatalog,
      loanerTable,
      bundleTable: BUNDLES,
      ccuOwnedIds,
    });

    const fetchedAt = Date.now();
    const payload = { ...bundle, rawHangarNames: hangarNames, fetchedAt };
    await cacheSet(key, payload, TTL.ships);

    return { ...payload, signedIn: true, fromCache: false };
  } catch (e) {
    // If hangar fetch blows up because the cookie is stale, fall back to the
    // public matrix instead of failing the whole module.
    if (e instanceof Rsi.RsiNotAuthenticatedError) {
      const [matrix, nameCatalog] = await Promise.all([
        Rsi.fetchShipMatrix(),
        Promise.resolve(SHIP_NAME_CATALOG.slice()),
      ]);
      const bundle = Rsi.mergeHangarIntoMatrix({
        matrix,
        hangarNames: [],
        nameCatalog,
        loanerTable: {},
      });
      const fetchedAt = Date.now();
      const payload = { ...bundle, rawHangarNames: [], fetchedAt };
      await cacheSet('ships:list:public', payload, TTL.ships);
      return { ...payload, signedIn: false, fromCache: false };
    }
    throw e;
  }
}

async function handleContactsList(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      contacts: [],
      incoming: [],
      outgoing: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'contacts:list';
  if (!force) {
    // Schema-validated read — defends against the partial-shape crash
    // we hit in 1.4.x (poll-side writer initially seeded only `contacts`,
    // missing `incoming`/`outgoing`; popup module crashed on .length of
    // undefined). If a future writer regresses, the schema rejects the
    // shape and we return a clean cache miss instead of propagating the
    // bad value.
    const cached = await cacheGetValidated(key, CACHE_SCHEMAS['contacts:list']);
    if (cached) {
      return {
        contacts: cached.contacts as Rsi.Contact[],
        incoming: cached.incoming as Rsi.ContactRequest[],
        outgoing: cached.outgoing as Rsi.ContactRequest[],
        fetchedAt: cached.fetchedAt,
        signedIn: true,
        fromCache: true,
      };
    }
  }
  return dedupe(key, async () => {
    const bundle = await Rsi.fetchContactsBundle();
    const fetchedAt = Date.now();
    await cacheSet(key, { ...bundle, fetchedAt }, TTL.contacts);
    return { ...bundle, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleContactsSearch(query: string) {
  const token = await Rsi.readRsiToken();
  if (!token) return { hits: [] };
  const hits = await Rsi.searchMembers(query);
  return { hits };
}

// Two-step resolver used by the Orgs module (member rows it scrapes from
// HTML only carry the nickname, not the numeric member id the friend-
// request endpoint needs). Goes through the same autocomplete endpoint
// the Contacts search box uses, then matches case-insensitively — RSI
// handles aren't case-sensitive so "DeusMaximus" must equal "deusmaximus".
async function handleContactsSendByNickname(nickname: string) {
  const normalized = nickname.trim();
  if (!normalized) return { sent: false, reason: 'not_found' as const };
  const hits = await Rsi.searchMembers(normalized);
  const needle = normalized.toLowerCase();
  const exact = hits.find((h) => h.nickname.toLowerCase() === needle);
  if (!exact) return { sent: false, reason: 'not_found' as const };
  await Rsi.sendFriendRequest(exact.id);
  return { sent: true };
}

// Sync LIVE → PTU. Sequential with a small inter-request delay —
// the friend-request and autocomplete endpoints are throttled per-IP
// (ErrThrottleLimit fires after a handful of rapid requests), so
// burning concurrency only burns quota without improving wall-clock.
// Reported by @DeusMaximus in #43 with run-2 numbers showing 64
// throttled requests bucketed as ERROR. 300 ms keeps a 100-friend
// list under a minute on the 5-10% of users who actually have that
// many missing PTU contacts.
const PTU_SYNC_DELAY_MS = 300;
// One retry on ErrThrottleLimit with a longer backoff than the base
// delay so we step out of whatever burst window the server is in.
const PTU_SYNC_RETRY_BACKOFF_MS = 1500;

/** Inner workhorse for the LIVE → PTU sync. Designed to be shared by
 *  the legacy one-shot message handler (returns the final result) and
 *  the streaming port handler (calls `emit` for each lifecycle event
 *  + checks `cancel.cancelled` between adds for early termination).
 *
 *  The caller is responsible for delivering events / honouring the
 *  cancel signal. This function just runs the algorithm and threads
 *  the hooks through. */
type SyncEmitter = (event: ContactsSyncToPtuStreamEvent) => void;
type SyncCancelToken = { cancelled: boolean };

async function runContactsSyncToPtu(
  emit: SyncEmitter,
  cancel: SyncCancelToken,
): Promise<ContactsSyncToPtuResponsePayload> {
  // Step 0 — check both sessions up front so the UI can direct the
  // user to the right sign-in page instead of surfacing a generic
  // "not authenticated" error.
  const liveToken = await Rsi.readRsiToken();
  const ptuToken = await Rsi.readPtuToken();
  const signedIn = { live: liveToken !== null, ptu: ptuToken !== null };
  if (!signedIn.live || !signedIn.ptu) return { signedIn };

  // Step 1 — read both friend lists + PTU pending.
  const [liveBundle, ptuBundle] = await Promise.all([
    Rsi.fetchContactsBundle(),
    Rsi.fetchPtuContactsBundle(),
  ]);
  // Lowercased lookup sets: RSI handles are case-insensitive, so match
  // on `lowercased(nickname)` to avoid missing an already-added friend
  // just because the display capitalisation differs.
  const ptuFriends = new Set(ptuBundle.contacts.map((c) => c.nickname.toLowerCase()));
  const ptuOutgoing = new Set(
    ptuBundle.outgoing.map((r) => r.nickname.toLowerCase()),
  );

  // Step 2 — classify each LIVE friend.
  type Pending = {
    nickname: string;
    displayName: string;
    avatar: string;
  };
  const entries: ContactsSyncToPtuEntry[] = [];
  const toAdd: Pending[] = [];
  let alreadyFriendCount = 0;
  let alreadyPendingCount = 0;
  for (const f of liveBundle.contacts) {
    const nick = f.nickname.toLowerCase();
    const base = {
      nickname: f.nickname,
      displayName: f.displayname || f.nickname,
      avatar: f.avatar || '',
    };
    if (ptuFriends.has(nick)) {
      const e: ContactsSyncToPtuEntry = { ...base, status: 'alreadyFriend' };
      entries.push(e);
      emit({ type: 'entry', entry: e });
      alreadyFriendCount += 1;
    } else if (ptuOutgoing.has(nick)) {
      const e: ContactsSyncToPtuEntry = { ...base, status: 'alreadyPending' };
      entries.push(e);
      emit({ type: 'entry', entry: e });
      alreadyPendingCount += 1;
    } else {
      toAdd.push(base);
    }
  }

  emit({
    type: 'started',
    total: toAdd.length,
    alreadyFriendCount,
    alreadyPendingCount,
  });

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Step 3 — for each LIVE friend missing on PTU, autocomplete the
  // nickname on PTU to resolve its member id, then fire the friend
  // request. Branch on the response code so transient throttles get
  // retried, already-pending requests get bucketed as alreadyPending
  // (not ERROR), and only genuine failures surface as errors.
  async function attempt(p: Pending): Promise<ContactsSyncToPtuEntry> {
    const hits = await Rsi.searchPtuMembers(p.nickname);
    const needle = p.nickname.toLowerCase();
    const exact = hits.find((h) => h.nickname.toLowerCase() === needle);
    if (!exact) return { ...p, status: 'notFound' };
    await Rsi.sendPtuFriendRequest(exact.id);
    return { ...p, status: 'added' };
  }

  function classifyError(p: Pending, e: unknown): ContactsSyncToPtuEntry {
    if (e instanceof Rsi.RsiSpectrumActionError) {
      // Server already has an outgoing request for this member — count
      // it as alreadyPending (the pre-classification missed it because
      // the incoming `outgoing[]` was empty due to the r.members[]
      // shape on PTU; #43 root cause #4).
      if (e.code === 'ErrExistingPendingFriendRequest') {
        return { ...p, status: 'alreadyPending' };
      }
      return { ...p, status: 'error', error: `${e.code}: ${e.message}` };
    }
    return { ...p, status: 'error', error: (e as Error).message ?? 'unknown' };
  }

  async function addOne(p: Pending): Promise<ContactsSyncToPtuEntry> {
    try {
      return await attempt(p);
    } catch (e) {
      // One retry on per-IP throttle. The endpoint is happy to take the
      // same request again after we step out of the burst window.
      if (e instanceof Rsi.RsiSpectrumActionError && e.code === 'ErrThrottleLimit') {
        await sleep(PTU_SYNC_RETRY_BACKOFF_MS);
        try {
          return await attempt(p);
        } catch (e2) {
          return classifyError(p, e2);
        }
      }
      return classifyError(p, e);
    }
  }

  // Sequential — each call waits PTU_SYNC_DELAY_MS after the previous
  // one (skipped on the first iteration). Drops worst-case throttle
  // hits to near zero on a single user's normal-sized friend list.
  for (let i = 0; i < toAdd.length; i++) {
    // Cancel-check between iterations. We don't abort an in-flight
    // RSI request — that would orphan a pending friend-request the
    // server might still create — but we stop starting new ones.
    if (cancel.cancelled) break;
    if (i > 0) await sleep(PTU_SYNC_DELAY_MS);
    const p = toAdd[i]!;
    emit({
      type: 'progress',
      current: i + 1,
      total: toAdd.length,
      nickname: p.nickname,
    });
    const entry = await addOne(p);
    entries.push(entry);
    emit({ type: 'entry', entry });
  }

  // Step 4 — counts for the UI summary card. Sort entries by status →
  // display name so the log reads "added, pending, already, notFound,
  // error" in a stable order.
  const statusOrder: Record<ContactsSyncToPtuEntry['status'], number> = {
    added: 0,
    alreadyPending: 1,
    alreadyFriend: 2,
    notFound: 3,
    error: 4,
  };
  entries.sort((a, b) => {
    const order = statusOrder[a.status] - statusOrder[b.status];
    return order !== 0 ? order : a.displayName.localeCompare(b.displayName);
  });
  const counts = {
    added: entries.filter((e) => e.status === 'added').length,
    alreadyFriend: entries.filter((e) => e.status === 'alreadyFriend').length,
    alreadyPending: entries.filter((e) => e.status === 'alreadyPending').length,
    notFound: entries.filter((e) => e.status === 'notFound').length,
    error: entries.filter((e) => e.status === 'error').length,
  };
  return { signedIn, entries, counts };
}

// Legacy message-based handler — kept for backward compat in case any
// caller still uses it. Calls runContactsSyncToPtu with a no-op emitter
// and a never-cancel token, returns just the final summary.
async function handleContactsSyncToPtu(): Promise<ContactsSyncToPtuResponsePayload> {
  return runContactsSyncToPtu(
    () => {},
    { cancelled: false },
  );
}

// Streaming port handler — wired via chrome.runtime.onConnect at boot.
// Pushes events to the popup as they happen so the UI can render a
// live progress indicator + per-entry log instead of the old "spinner
// for 30 s then everything appears at once" experience.
async function handleContactsSyncToPtuStream(port: chrome.runtime.Port): Promise<void> {
  const cancel: SyncCancelToken = { cancelled: false };
  const partialEntries: ContactsSyncToPtuEntry[] = [];

  // Popup → BG: only one valid command (cancel). A popup close also
  // disconnects the port, which we treat as cancel below.
  port.onMessage.addListener((msg: unknown) => {
    const m = msg as ContactsSyncToPtuStreamCommand;
    if (m && m.type === 'cancel') cancel.cancelled = true;
  });
  port.onDisconnect.addListener(() => {
    cancel.cancelled = true;
  });

  function safePost(event: ContactsSyncToPtuStreamEvent): void {
    try {
      port.postMessage(event);
    } catch (e) {
      // postMessage throws "Attempt to postMessage on disconnected port"
      // when the popup closed mid-stream. That's expected — drop the
      // event silently. The cancel handler above already flipped the
      // flag from onDisconnect, so the loop will exit on its next check.
      log.debug('contacts-sync', 'port post failed (likely disconnected)', e);
    }
  }

  function emit(event: ContactsSyncToPtuStreamEvent): void {
    // Track entries locally so a cancel can include the partials.
    if (event.type === 'entry') partialEntries.push(event.entry);
    safePost(event);
  }

  try {
    const result = await runContactsSyncToPtu(emit, cancel);
    if (cancel.cancelled) {
      safePost({ type: 'cancelled', partialEntries });
    } else {
      safePost({ type: 'complete', result });
    }
  } catch (e) {
    safePost({ type: 'error', message: e instanceof Error ? e.message : String(e) });
  } finally {
    try {
      port.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

async function handleContactsAction(
  action: 'accept' | 'decline' | 'cancel' | 'send' | 'remove',
  id: number,
) {
  switch (action) {
    case 'accept':
      await Rsi.acceptFriendRequest(id);
      break;
    case 'decline':
      await Rsi.declineFriendRequest(id);
      break;
    case 'cancel':
      await Rsi.cancelFriendRequest(id);
      break;
    case 'send':
      await Rsi.sendFriendRequest(id);
      break;
    case 'remove':
      await Rsi.removeFriend(id);
      break;
  }
  // Invalidate the cached contacts bundle so the next list call picks up the change.
  await chrome.storage.local.remove(CACHE_PREFIX + 'contacts:list');
  return { ok: true as const };
}

async function handleOrgsList(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      orgs: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'orgs:list';
  if (!force) {
    const cached = await cacheGet<{ orgs: Rsi.MyOrg[]; fetchedAt: number }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    const orgs = await Rsi.fetchMyOrgs();
    const fetchedAt = Date.now();
    await cacheSet(key, { orgs, fetchedAt }, TTL.orgs);
    return { orgs, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

// Shared handler shape for Invitations + Applications — both scrape sister
// HTML pages with the same layout, so the only per-handler difference is
// the RSI path + cache key.
async function handleOrgsSection(
  fetcher: () => Promise<Rsi.MyOrg[]>,
  key: string,
  force: boolean,
) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return { orgs: [], signedIn: false, fetchedAt: Date.now(), fromCache: false };
  }
  if (!force) {
    const cached = await cacheGet<{ orgs: Rsi.MyOrg[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const orgs = await fetcher();
    const fetchedAt = Date.now();
    await cacheSet(key, { orgs, fetchedAt }, TTL.orgs);
    return { orgs, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

function handleOrgsInvitations(force: boolean) {
  return handleOrgsSection(Rsi.fetchOrgInvitations, 'orgs:invitations', force);
}

function handleOrgsApplications(force: boolean) {
  return handleOrgsSection(Rsi.fetchOrgApplications, 'orgs:applications', force);
}

async function handleOrgsSearch(message: Extract<RsiMessage, { type: 'orgs.search' }>) {
  const force = message.force ?? false;
  const search = (message.search ?? '').trim();
  const page = message.page ?? 1;
  const pagesize = message.pagesize ?? 12;
  const arr = (xs: string[] | undefined) => [...(xs ?? [])].sort();
  const filters = {
    activity: arr(message.activity),
    language: arr(message.language),
    model: arr(message.model),
    size: arr(message.size),
    commitment: arr(message.commitment),
    roleplay: arr(message.roleplay),
    recruiting: arr(message.recruiting),
  };
  const key = `orgs:search:${JSON.stringify({ search, page, pagesize, ...filters })}`;

  if (!force) {
    const cached = await cacheGet<{
      orgs: Rsi.PublicOrg[];
      totalRows: number;
      page: number;
      fetchedAt: number;
    }>(key);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const result = await Rsi.searchPublicOrgs({ search, page, pagesize, ...filters });
  const fetchedAt = Date.now();
  const payload = { orgs: result.orgs, totalRows: result.totalRows, page: result.page, fetchedAt };
  await cacheSet(key, payload, TTL.orgsSearch);
  return { ...payload, fromCache: false };
}

async function handleOrgMembers(message: Extract<RsiMessage, { type: 'orgs.members' }>) {
  const sid = message.sid.toUpperCase();
  const force = message.force ?? false;
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      sid,
      members: [],
      totalRows: 0,
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = `orgs:members:${sid}`;
  if (!force) {
    const cached = await cacheGet<{
      sid: string;
      members: Rsi.OrgMember[];
      totalRows: number;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  const { members, totalRows } = await Rsi.fetchOrgMembers(token, sid);
  const fetchedAt = Date.now();
  const payload = { sid, members, totalRows, fetchedAt };
  await cacheSet(key, payload, TTL.orgsMembers);
  return { ...payload, signedIn: true, fromCache: false };
}

async function handleDashboardSummary(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      summary: null,
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'dashboard:summary';
  if (!force) {
    const cached = await cacheGet<{ summary: Rsi.DashboardSummary | null; fetchedAt: number }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    const summary = await Rsi.fetchDashboardSummary();
    const fetchedAt = Date.now();
    await cacheSet(key, { summary, fetchedAt }, TTL.dashboard);
    return { summary, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handlePatchNotes(page: number, force: boolean) {
  const key = `patchnotes:list:${page}`;
  if (!force) {
    const cached = await cacheGet<{ notes: Rsi.PatchNote[]; fetchedAt: number }>(key);
    if (cached) {
      return { page, notes: cached.notes, fetchedAt: cached.fetchedAt, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    const notes = await Rsi.fetchPatchNotes(page);
    const fetchedAt = Date.now();
    await cacheSet(key, { notes, fetchedAt }, TTL.patchnotes);
    return { page, notes, fetchedAt, fromCache: false };
  });
}

async function handleBuyBackList(page: number, force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      pledges: [],
      hasNextPage: false,
      page,
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = `buyback:list:${page}`;
  if (!force) {
    const cached = await cacheGet<{
      pledges: Rsi.BuyBackPledge[];
      hasNextPage: boolean;
      page: number;
      fetchedAt: number;
    }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    const result = await Rsi.fetchBuyBackPage(page);
    const fetchedAt = Date.now();
    const payload = {
      pledges: result.pledges,
      hasNextPage: result.hasNextPage,
      page: result.page,
      fetchedAt,
    };
    await cacheSet(key, payload, TTL.buyback);
    return { ...payload, signedIn: true as const, fromCache: false };
  });
}

async function handleStatsSummary(force: boolean) {
  const key = 'stats:summary';
  const token = await Rsi.readRsiToken();

  if (!force) {
    const cached = await cacheGetValidated(key, CACHE_SCHEMAS['stats:summary']);
    if (cached) {
      return {
        crowdfund: cached.crowdfund as Rsi.CrowdfundStats,
        referral: cached.referral as Rsi.ReferralStats | null,
        buyBackTokens: cached.buyBackTokens as number | null,
        fetchedAt: cached.fetchedAt,
        signedIn: token !== null,
        fromCache: true,
      };
    }
  }

  return dedupe(key, async () => {
    const crowdfundP = Rsi.fetchCrowdfundStats().catch(() => ({ fans: 0, funds: 0 }));
    const referralP = token
      ? Rsi.fetchReferralStats().catch(() => null)
      : Promise.resolve(null);
    const buyBackP: Promise<number | null> = token
      ? fetchWithTimeout(`${RSI_BASE_URL}/account/buy-back-pledges`, {
          method: 'GET',
          credentials: 'include',
          headers: { Accept: 'text/html,application/xhtml+xml' },
        })
          .then((r) => (r.ok ? r.text() : ''))
          .then((html) => (html ? Rsi.parseBuyBackTokenCount(html) : null))
          .catch((e: unknown) => {
            log.warn('stats.buyback', 'token count fetch failed', e);
            return null;
          })
      : Promise.resolve(null);

    const [crowdfund, referral, buyBackTokens] = await Promise.all([
      crowdfundP,
      referralP,
      buyBackP,
    ]);

    const fetchedAt = Date.now();
    const payload = { crowdfund, referral, buyBackTokens, fetchedAt };
    await cacheSet(key, payload, TTL.stats);
    return { ...payload, signedIn: token !== null, fromCache: false };
  });
}

async function handleSpectrumNotifications(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      notifications: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:notifications';
  if (!force) {
    const cached = await cacheGet<{
      notifications: Rsi.SpectrumNotification[];
      fetchedAt: number;
    }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    const notifications = await Rsi.fetchSpectrumNotifications();
    const fetchedAt = Date.now();
    await cacheSet(key, { notifications, fetchedAt }, TTL.spectrumNotifs);
    return { notifications, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleCommunityHub(
  tab: Rsi.CommunityHubTab,
  filters: Rsi.CommunityHubPostFilters,
  force: boolean,
) {
  if (tab === 'home') {
    const key = 'communityHub:home';
    if (!force) {
      const cached = await cacheGet<{
        live: Rsi.CommunityHubLivePost[];
        followed: Rsi.CommunityHubLivePost[];
        trending: Rsi.CommunityHubPost[];
        gameplay: Rsi.CommunityHubPost[];
        tutorial: Rsi.CommunityHubPost[];
        fetchedAt: number;
      }>(key);
      if (cached) return { tab, ...cached, fromCache: true } as const;
    }
    const { live, followed, trending, gameplay, tutorial } = await Rsi.fetchCommunityHubHome();
    const fetchedAt = Date.now();
    await cacheSet(
      key,
      { live, followed, trending, gameplay, tutorial, fetchedAt },
      TTL.communityHub,
    );
    return {
      tab,
      live,
      followed,
      trending,
      gameplay,
      tutorial,
      fetchedAt,
      fromCache: false,
    } as const;
  }

  if (tab === 'live') {
    const key = 'communityHub:live';
    if (!force) {
      const cached = await cacheGet<{
        live: Rsi.CommunityHubLivePost[];
        followed: Rsi.CommunityHubLivePost[];
        fetchedAt: number;
      }>(key);
      if (cached) return { tab, ...cached, fromCache: true } as const;
    }
    const { live, followed } = await Rsi.fetchCommunityHubLive();
    const fetchedAt = Date.now();
    await cacheSet(key, { live, followed, fetchedAt }, TTL.communityHub);
    return { tab, live, followed, fetchedAt, fromCache: false } as const;
  }

  if (tab === 'events') {
    const key = 'communityHub:events';
    if (!force) {
      const cached = await cacheGet<{
        upcoming: Rsi.CommunityHubEvent[];
        past: Rsi.CommunityHubEvent[];
        fetchedAt: number;
      }>(key);
      if (cached) return { tab, ...cached, fromCache: true } as const;
    }
    const { upcoming, past } = await Rsi.fetchCommunityHubEvents();
    const fetchedAt = Date.now();
    await cacheSet(key, { upcoming, past, fetchedAt }, TTL.communityHub);
    return { tab, upcoming, past, fetchedAt, fromCache: false } as const;
  }

  // Discover / gameplay / tutorial — cache key includes filters so each combo
  // is memoized independently.
  const sort = filters.sort ?? 'newest';
  const types = [...(filters.types ?? [])].sort().join(',');
  const tags = [...(filters.tags ?? [])].sort().join(',');
  const key = `communityHub:posts:${tab}:${sort}:${types}:${tags}`;
  if (!force) {
    const cached = await cacheGet<{ posts: Rsi.CommunityHubPost[]; fetchedAt: number }>(key);
    if (cached) return { tab, ...cached, filters, fromCache: true } as const;
  }
  const { posts } = await Rsi.fetchCommunityHubPosts(tab, filters);
  const fetchedAt = Date.now();
  await cacheSet(key, { posts, fetchedAt }, TTL.communityHub);
  return { tab, posts, filters, fetchedAt, fromCache: false } as const;
}

async function handleGalactapedia(
  first: number,
  skip: number,
  search: string,
  force: boolean,
) {
  const trimmed = search.trim();

  // Search queries: delegate to the cached full index. The GraphQL
  // `title.matches` filter 500s on the server, and paging the whole catalog
  // once and filtering locally is both faster (on a cache hit) and always
  // works. The index cache is maintained by handleGalactapediaIndex.
  //
  // Cache keys bumped to :v2 in lockstep with the Article schema gaining
  // a `tags` field — stale v1 entries would be missing it.
  if (trimmed) {
    const key = `galactapedia:search:v2:${first}:${skip}:${trimmed.toLowerCase()}`;
    if (!force) {
      const cached = await cacheGet<{ articles: Rsi.GalactapediaArticle[]; fetchedAt: number }>(key);
      if (cached) {
        return { ...cached, first, skip, search: trimmed, fromCache: true };
      }
    }
    // Never force the index crawl from here — it's 5-15 sequential requests
    // and users expect the Articles-tab refresh to be cheap. The Index tab's
    // own refresh button is where a full re-crawl belongs.
    const index = await handleGalactapediaIndex(false);
    const matches = Rsi.filterArticlesByTitle(index.articles, trimmed);
    const page = matches.slice(skip, skip + first);
    const fetchedAt = Date.now();
    await cacheSet(key, { articles: page, fetchedAt }, TTL.galactapedia);
    return { articles: page, first, skip, search: trimmed, fetchedAt, fromCache: false };
  }

  const key = `galactapedia:list:v2:${first}:${skip}`;
  if (!force) {
    const cached = await cacheGet<{ articles: Rsi.GalactapediaArticle[]; fetchedAt: number }>(key);
    if (cached) {
      return { ...cached, first, skip, search: null, fromCache: true };
    }
  }
  const articles = await Rsi.fetchGalactapediaArticles(first, skip);
  const fetchedAt = Date.now();
  await cacheSet(key, { articles, fetchedAt }, TTL.galactapedia);
  return { articles, first, skip, search: null, fetchedAt, fromCache: false };
}

async function handleGalactapediaHome(force: boolean) {
  // Cache ~1h. CIG rotates home-page featured content daily-ish so a
  // fresh-per-hour snapshot is close enough to current without
  // hammering the server on every popup open.
  const key = 'galactapedia:home';
  if (!force) {
    const cached = await cacheGet<{
      home: Rsi.GalactapediaHomepage;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const home = await Rsi.fetchGalactapediaHomepage();
    const fetchedAt = Date.now();
    await cacheSet(key, { home, fetchedAt }, TTL.galactapediaHome);
    return { home, fetchedAt, fromCache: false };
  });
}

async function handleGalactapediaRandom(
  message: Extract<RsiMessage, { type: 'galactapedia.random' }>,
) {
  // Intentionally uncached — each click should return a different pick.
  const article = await Rsi.fetchRandomGalactapediaArticle(message.totalCount);
  return { article };
}

async function handleGalactapediaArticle(id: string, force: boolean) {
  // Per-article cache. Galactapedia articles change very rarely (lore is
  // semi-frozen once published) so we reuse the long `galactapedia` TTL —
  // users who want the latest can hit the refresh button. The cache is
  // keyed by id, not slug, because the slug can change if CIG corrects a
  // typo while the id stays stable.
  const key = `galactapedia:article:${id}`;
  if (!force) {
    const cached = await cacheGet<{
      article: Rsi.GalactapediaArticleFull | null;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const article = await Rsi.fetchGalactapediaArticle(id);
    const fetchedAt = Date.now();
    await cacheSet(key, { article, fetchedAt }, TTL.galactapedia);
    return { article, fetchedAt, fromCache: false };
  });
}

async function handleGalactapediaCategories(force: boolean) {
  const key = 'galactapedia:categories';
  if (!force) {
    const cached = await cacheGet<{
      categories: Rsi.GalactapediaCategory[];
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  const categories = await Rsi.fetchGalactapediaCategories();
  const fetchedAt = Date.now();
  await cacheSet(key, { categories, fetchedAt }, TTL.galactapedia);
  return { categories, fetchedAt, fromCache: false };
}

async function handleGalactapediaTags(force: boolean) {
  const key = 'galactapedia:tags';
  if (!force) {
    const cached = await cacheGet<{
      tags: Rsi.GalactapediaTag[];
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  const tags = await Rsi.fetchGalactapediaTags();
  const fetchedAt = Date.now();
  await cacheSet(key, { tags, fetchedAt }, TTL.galactapedia);
  return { tags, fetchedAt, fromCache: false };
}

// Key bumped to v2 when `tags` were added to each Article. Older cache
// entries don't have that field, so letting them serve would break the
// per-tag count logic (`a.tags` undefined). Bumping discards them cleanly
// — the index will re-fetch on first use and populate the new shape.
const GALACTAPEDIA_INDEX_KEY = 'galactapedia:index:v2';

async function handleGalactapediaIndex(force: boolean) {
  // Stale-while-revalidate: the A-Z index costs 5-15 sequential GraphQL
  // pages to rebuild from scratch. A 30-day stale entry is dramatically
  // better than a multi-second wait at popup open time after the TTL
  // flips. The actual content drift in 30 days is minimal (a handful of
  // new articles) — far less harm than the latency of a synchronous
  // fetch every monthly boundary.
  async function refetch() {
    const articles = await Rsi.fetchGalactapediaIndex();
    const fetchedAt = Date.now();
    await cacheSet(GALACTAPEDIA_INDEX_KEY, { articles, fetchedAt }, TTL.galactapediaIndex);
    return { articles, fetchedAt };
  }

  if (!force) {
    const cached = await cacheGetWithStale<{
      articles: Rsi.GalactapediaArticle[];
      fetchedAt: number;
    }>(GALACTAPEDIA_INDEX_KEY);
    if (cached) {
      if (cached.isStale) {
        void dedupe(GALACTAPEDIA_INDEX_KEY, refetch).catch((e: unknown) =>
          log.warn('galactapedia', 'index revalidate failed', e),
        );
      }
      return { ...cached.value, fromCache: true, isStale: cached.isStale };
    }
  }
  return dedupe(GALACTAPEDIA_INDEX_KEY, async () => {
    const fresh = await refetch();
    return { ...fresh, fromCache: false, isStale: false };
  });
}

async function handleGalactapediaIndexCached() {
  const cached = await cacheGet<{
    articles: Rsi.GalactapediaArticle[];
    fetchedAt: number;
  }>(GALACTAPEDIA_INDEX_KEY);
  return {
    articles: cached?.articles ?? null,
    fetchedAt: cached?.fetchedAt ?? null,
  };
}

async function handleGalactapediaIndexPage(skip: number) {
  // Streaming path: one page, no caching. The popup stitches pages together
  // and hands us the aggregate via `galactapedia.indexCommit` when done.
  const { articles, hasMore } = await Rsi.fetchGalactapediaIndexPage(skip);
  return { articles, skip, hasMore };
}

async function handleGalactapediaIndexCommit(articles: Rsi.GalactapediaArticle[]) {
  const fetchedAt = Date.now();
  await cacheSet(
    GALACTAPEDIA_INDEX_KEY,
    { articles, fetchedAt },
    TTL.galactapediaIndex,
  );
  await chrome.storage.local.set({
    [GALACTAPEDIA_INDEX_BOOTSTRAP_KEY]: { at: fetchedAt } satisfies BootstrapMarker,
  });
  return { fetchedAt };
}

// Bootstrap marker (no TTL). Once written, subsequent popup opens skip the
// one-shot crawl in prefetchAll — even if the index cache later expires and
// is wiped, we rely on the user's next visit of the Galactapedia module
// (or a manual refresh) to re-populate it. This avoids silently paying
// ~15 GraphQL requests on every popup open after 30 days.
//
// Lives under CACHE_PREFIX so a "Clear cache" button wipe resets it — the
// user expects a full cold start in that case.
const GALACTAPEDIA_INDEX_BOOTSTRAP_KEY = 'cache:galactapedia:index:bootstrap';
type BootstrapMarker = { at: number };

async function handleGalactapediaIndexBootstrap() {
  const res = await chrome.storage.local.get(GALACTAPEDIA_INDEX_BOOTSTRAP_KEY);
  if (res[GALACTAPEDIA_INDEX_BOOTSTRAP_KEY]) return { crawled: false };

  // Never crawled. Run the full index via the same dedupe key as the
  // regular index handler so a user that opens the Galactapedia module in
  // parallel with this boot-time call doesn't kick a second crawl.
  try {
    const articles = await dedupe(GALACTAPEDIA_INDEX_KEY, () => Rsi.fetchGalactapediaIndex());
    const fetchedAt = Date.now();
    await cacheSet(
      GALACTAPEDIA_INDEX_KEY,
      { articles, fetchedAt },
      TTL.galactapediaIndex,
    );
    await chrome.storage.local.set({
      [GALACTAPEDIA_INDEX_BOOTSTRAP_KEY]: { at: fetchedAt } satisfies BootstrapMarker,
    });
    return { crawled: true };
  } catch (e) {
    log.warn('galactapedia', 'index bootstrap crawl failed', e);
    return { crawled: false };
  }
}

async function handleProgressTracker(force: boolean) {
  // The RSI cards REST API doesn't expose team assignments (GraphQL-only,
  // with operation whitelisting). We instead derive a "progress by category"
  // view from the roadmap data already served by our backend: non-released
  // releases → their cards → grouped by category (Core Tech, Ships, etc.).
  // Key bumped to :v2 when the shape changed from teams-based to
  // category-based. Old entries don't have a `groups` field — serving
  // them would leave the component with groups = undefined.
  const key = 'progress-tracker:v2';
  if (!force) {
    const cached = await cacheGet<{
      groups: Array<{ id: number; name: string; cards: Array<{ id: number; name: string; status: string; releaseName: string }> }>;
      totalCards: number;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }

  // Reuse the shared roadmap cache. The Roadmap module also consumes the
  // same raw payload — routing both through `handleRoadmapData` collapses
  // two backend requests into one, and when prefetchAll warms it, both
  // modules hit the cache on their first mount.
  const { data } = await handleRoadmapData(false);
  const catMap = new Map<number, string>(
    (data.categories ?? []).map((c) => [c.id, c.name]),
  );

  // Collect active (non-released) cards and group by category. Use
  // the status-string check rather than the numeric `released` field
  // because RSI lies on the latter for some patches — see the
  // `isReleasedRelease` helper for the full story.
  const byCategory = new Map<number, { id: number; name: string; status: string; releaseName: string }[]>();
  for (const release of data.releases ?? []) {
    if (Rsi.isReleasedRelease(release)) continue;
    for (const card of release.cards ?? []) {
      if (!byCategory.has(card.category_id)) byCategory.set(card.category_id, []);
      byCategory.get(card.category_id)!.push({
        id: card.id,
        name: card.name,
        status: card.status,
        releaseName: release.name,
      });
    }
  }

  const groups = [...byCategory.entries()]
    .map(([catId, cards]) => ({
      id: catId,
      name: catMap.get(catId) ?? `Category ${catId}`,
      cards: cards.slice().sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const totalCards = groups.reduce((n, g) => n + g.cards.length, 0);
  const fetchedAt = Date.now();
  const payload = { groups, totalCards, fetchedAt };
  await cacheSet(key, payload, TTL.progressTracker);
  return { ...payload, fromCache: false };
}

async function handleRoadmapData(force: boolean) {
  // v3 hits the RSI roadmap endpoint directly. The old v2 backend wrapped
  // the same payload and added a `meta` envelope we still return for UI
  // compatibility, but now it's synthesized from the RSI response.
  //
  // Uses stale-while-revalidate: roadmap snapshots change weekly-ish at
  // most so a stale 7-day-old cache is fine to render *now* while we
  // fetch fresh in the background. The user gets instant content on
  // every popup open instead of waiting on a multi-second roadmap
  // fetch every Sunday after the TTL flipped.
  const key = 'roadmap:data';

  async function refetch() {
    const { data, snapshotTs, fetchedAt } = await Rsi.fetchRsiRoadmap();
    const meta: Schemas.Backend.RoadmapMeta = {
      board_id: 1,
      fetched_at: Math.floor(fetchedAt / 1000),
      snapshot_ts: snapshotTs,
      cached: false,
    };
    const payload = { data, meta, fetchedAt };
    await cacheSet(key, payload, TTL.roadmap);
    return payload;
  }

  if (!force) {
    const cached = await cacheGetWithStale<{
      data: Schemas.Backend.RoadmapPayload;
      meta: Schemas.Backend.RoadmapMeta;
      fetchedAt: number;
    }>(key);
    if (cached) {
      if (cached.isStale) {
        // Fire-and-forget revalidation. Dedupe protects against the
        // popup-mount + background-poll concurrent-stale-read pile-up
        // — both callers see the same in-flight refetch instead of
        // two parallel hits to RSI's roadmap endpoint.
        void dedupe(key, refetch).catch((e: unknown) =>
          log.warn('roadmap', 'background revalidate failed', e),
        );
      }
      return { ...cached.value, fromCache: true, isStale: cached.isStale };
    }
  }
  // Cold cache (or force=true) — block on the fetch.
  return dedupe(key, async () => {
    const payload = await refetch();
    return { ...payload, fromCache: false, isStale: false };
  });
}

async function handlePledgeShipList(
  message: Extract<RsiMessage, { type: 'pledge.shipList' }>,
) {
  const onlyOnSale = message.onlyOnSale ?? true;
  const force = message.force ?? false;
  // Key separates on-sale and full-catalogue views so the UI can toggle
  // without cross-contaminating cached payloads.
  const key = `pledge:shipList:${onlyOnSale ? 'onsale' : 'all'}`;
  if (!force) {
    const cached = await cacheGet<{
      ships: Rsi.PledgeShip[];
      manufacturers: Rsi.PledgeManufacturer[];
      totalCount: number;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const { ships, manufacturers, totalCount } = await Rsi.fetchPledgeShipList({
      onlyOnSale,
    });
    const fetchedAt = Date.now();
    const payload = { ships, manufacturers, totalCount, fetchedAt };
    await cacheSet(key, payload, TTL.pledge);
    return { ...payload, fromCache: false };
  });
}

async function handlePledgeShipDetail(
  message: Extract<RsiMessage, { type: 'pledge.shipDetail' }>,
) {
  // Resolve slug first when only name was given. The slug lookup uses the
  // cached pledge ship list via handlePledgeShipList — no extra request
  // unless the list itself has expired. This is the hot path for the
  // Ships module and CCU catalogue, which both only know display names.
  let slug = message.slug?.trim() ?? null;
  if (!slug && (message.name || message.url)) {
    // Tier 1: look up in the on-sale pledge list (already cached, zero
    // latency). The "full catalogue" mode is server-side broken — CIG's
    // resolver 500s on `{filters: {}, all: true}` — so we restrict to
    // actively-sold ships here. Covers the overwhelming majority of
    // owned-ship lookups.
    const list = await handlePledgeShipList({ type: 'pledge.shipList' });
    slug = Rsi.resolvePledgeSlugByName(message.name ?? '', list.ships, { url: message.url });

    // Tier 2: scrape the slug out of the ship's public detail page.
    // Catches concept-sale/retired ships (Cyclone, Greycat ROC, etc.)
    // that aren't in the on-sale list but still have a working detail
    // page on RSI. One HTTP fetch per miss — the result is cached under
    // a URL-keyed entry so subsequent clicks on the same ship reuse it
    // and skip the scrape entirely.
    if (!slug && message.url) {
      const urlKey = `pledge:shipSlugByUrl:${message.url}`;
      const cached = await cacheGet<{ slug: string }>(urlKey);
      if (cached?.slug) {
        slug = cached.slug;
      } else {
        slug = await Rsi.fetchPledgeSlugFromShipUrl(message.url);
        if (slug) await cacheSet(urlKey, { slug }, TTL.pledge);
      }
    }
  }
  if (!slug) {
    return { detail: null, slug: null, fetchedAt: Date.now(), fromCache: false };
  }

  const key = `pledge:shipDetail:${slug}`;
  const force = message.force ?? false;
  if (!force) {
    const cached = await cacheGet<{
      detail: Rsi.PledgeShipDetail | null;
      slug: string;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const detail = await Rsi.fetchPledgeShipDetail(slug!);
    const fetchedAt = Date.now();
    const payload = { detail, slug: slug!, fetchedAt };
    await cacheSet(key, payload, TTL.pledge);
    return { ...payload, fromCache: false };
  });
}

async function handlePledgeBrowse(
  message: Extract<RsiMessage, { type: 'pledge.browse' }>,
) {
  const { categoryId } = message;
  const tagIdentifiers = (message.tagIdentifiers ?? []).slice().sort();
  const force = message.force ?? false;
  // Cache key includes the normalized tag list so armor/clothing/
  // equipment filter selections each keep their own cached result.
  const tagKey = tagIdentifiers.length > 0 ? `:${tagIdentifiers.join(',')}` : '';
  const key = `pledge:browse:${categoryId}${tagKey}`;
  if (!force) {
    const cached = await cacheGet<{
      categoryId: Rsi.StoreCategoryId;
      result: Rsi.StoreBrowseResult;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const result = await Rsi.fetchStoreBrowse(categoryId, tagIdentifiers);
    const fetchedAt = Date.now();
    const payload = { categoryId, result, fetchedAt };
    await cacheSet(key, payload, TTL.pledge);
    return { ...payload, fromCache: false };
  });
}

// --- CSRF priming via open RSI tabs --------------------------------------
//
// The CCU GraphQL endpoint requires an `x-csrf-token` header whose value is
// the per-session token RSI embeds in a `<meta name="csrf-token">` tag on
// rendered HTML pages. In theory the shared `fetchRsiCsrfToken` scrapes
// the tag from one of a handful of known pages, but RSI has been migrating
// pages to SPA-only rendering — the extension's server-side fetch of
// `/en/pledge` and friends often gets the pre-hydration shell without the
// meta tag, and the scrape returns null. Result: the extension sends no
// `x-csrf-token` header and the server answers every batch op with
// `{ message: "Token not set" }`.
//
// Reliable alternative: if the user has any `robertsspaceindustries.com`
// tab open, the SPA has already populated `document.head` with the real
// meta tag. We use `chrome.scripting.executeScript` to read it from that
// live DOM and seed the shared cache before making the CCU call. Needs
// the `scripting` + `tabs` permissions (granted in the manifest).
//
// Fallback order: scripting → (shared) HTML scrape of candidate pages.
// When both fail we still fire the request (the shared retry-on-error
// path will re-invalidate and try once more) so a reload of a RSI tab
// in parallel can recover in the same session.

async function primeCsrfFromOpenTabs(): Promise<boolean> {
  if (Rsi.getCachedCsrfToken()) return true;

  // Permission sanity checks — throw clear messages here rather than let
  // chrome.scripting blow up with a generic TypeError when the user
  // hasn't granted the newly-added `scripting`/`tabs` permissions (they
  // require a full extension reload after a manifest change).
  if (!chrome.tabs?.query) {
    log.warn('csrf', 'chrome.tabs unavailable — reload the extension to pick up the new permissions');
    return false;
  }
  if (!chrome.scripting?.executeScript) {
    log.warn('csrf', 'chrome.scripting unavailable — reload the extension to pick up the new permissions');
    return false;
  }

  let tabs: chrome.tabs.Tab[] = [];
  try {
    // Broader match pattern so `www.`, alt TLDs, or stray http fall in
    // too (none in practice, but cheap insurance against CIG changing
    // the canonical host).
    tabs = await chrome.tabs.query({ url: '*://*.robertsspaceindustries.com/*' });
  } catch (e) {
    log.warn('csrf', 'tabs.query failed', e);
    return false;
  }

  if (tabs.length === 0) {
    log.info('csrf', 'no open robertsspaceindustries.com tab — open one and retry');
    return false;
  }
  log.info('csrf', `scanning ${tabs.length} open RSI tab(s) for csrf meta`);

  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const meta = document.querySelector('meta[name="csrf-token"]');
          return meta ? meta.getAttribute('content') : null;
        },
      });
      const token = result?.result;
      if (typeof token === 'string' && token.length > 0) {
        Rsi.setCsrfToken(token);
        log.info('csrf', `primed from tab ${tab.id} (${tab.url})`);
        return true;
      }
      log.debug('csrf', `tab ${tab.id} had no meta tag`);
    } catch (e) {
      // chrome-internal pages, closed tabs, restricted URLs all throw
      // here. Continue to the next tab rather than giving up.
      log.debug('csrf', `scripting failed on tab ${tab.id}`, e);
    }
  }
  log.info('csrf', 'no tab yielded a csrf token');
  return false;
}

/**
 * Wrap a CCU GraphQL call with CSRF priming + one retry on "Token not
 * set" errors. Sequence:
 *   1. Prime via `chrome.scripting` on any open RSI tab (fast, real token)
 *   2. Run the op — the shared layer falls back to HTML scrape if the
 *      scripting priming didn't yield a token
 *   3. On "Token not set" thrown error: invalidate, re-prime, retry once
 * If the retry also fails (e.g. no RSI tab open AND HTML scrape still
 * returns null), the original error bubbles up so the UI surfaces it.
 */
async function withCsrfRetry<T>(op: () => Promise<T>): Promise<T> {
  await primeCsrfFromOpenTabs();
  try {
    return await op();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/token not set/i.test(msg)) throw e;
    // "Token not set" can mean CSRF *or* the upgrade session bootstrap
    // went stale (server rotated the context). Invalidate both so the
    // retry re-runs the full dance (setAuthToken + setContextToken +
    // fresh CSRF read).
    Rsi.invalidateCsrfToken();
    Rsi.invalidateCcuSession();
    // Re-prime via scripting. If it fails (no RSI tab open, or the
    // script injection got rejected), retrying `op()` would just burn
    // cycles hitting the server with the exact same missing state.
    // Surface the original error instead so the UI can tell the user
    // to open a RSI tab.
    const primed = await primeCsrfFromOpenTabs();
    if (!primed) throw e;
    return op();
  }
}

async function handleCcuInit(force: boolean) {
  const key = 'pledge:ccuInit';
  if (!force) {
    const cached = await cacheGet<{ catalogue: Rsi.CcuCatalogue; fetchedAt: number }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const catalogue = await withCsrfRetry(() => Rsi.fetchCcuInit());
    const fetchedAt = Date.now();
    const payload = { catalogue, fetchedAt };
    await cacheSet(key, payload, TTL.ccuInit);
    return { ...payload, fromCache: false };
  });
}

async function handleCcuTargets(
  message: Extract<RsiMessage, { type: 'pledge.ccuTargets' }>,
) {
  const { fromId } = message;
  const force = message.force ?? false;
  const key = `pledge:ccuTargets:${fromId ?? 'all'}`;
  if (!force) {
    const cached = await cacheGet<{
      fromId: number | null;
      result: Rsi.CcuTargetsResult;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const result = await withCsrfRetry(() => Rsi.fetchCcuTargets(fromId));
    const fetchedAt = Date.now();
    const payload = { fromId, result, fetchedAt };
    await cacheSet(key, payload, TTL.ccuTargets);
    return { ...payload, fromCache: false };
  });
}

async function handleCcuAddToCart(
  message: Extract<RsiMessage, { type: 'pledge.ccuAddToCart' }>,
): Promise<{ ok: true }> {
  // Deliberately uncached + undeduped: this is a user-initiated mutation,
  // not a fetch. Two rapid clicks should legitimately add two line items
  // (mirrors the real site), and a second attempt after a failure must
  // re-run the full two-step dance with a fresh JWT (the one from the
  // previous attempt has a 30-second exp).
  await withCsrfRetry(() => Rsi.addCcuToCart(message.fromShipId, message.toSkuId));
  // The cart cache now lies — the new line item is in the server cart
  // but not in whatever we fetched before. Drop the cached entry so the
  // next Cart tab open or Refresh fires a fresh GetMiniCartWidgetQuery.
  await chrome.storage.local.remove(`${CACHE_PREFIX}pledge:cart`);
  return { ok: true };
}

async function handlePledgeAddToCart(
  message: Extract<RsiMessage, { type: 'pledge.addToCart' }>,
): Promise<{ ok: true }> {
  // Generic store add-to-cart (non-CCU). Same CSRF retry pattern as the
  // CCU variant — stale token / missing scripting priming surfaces as a
  // "Token not set" error on the first call, and `withCsrfRetry` does
  // one re-prime + retry. Cart cache is dropped on success so the Cart
  // tab / badge reflect the new item immediately.
  await withCsrfRetry(() => Rsi.addSkusToCart([{ skuId: message.skuId, qty: message.qty }]));
  await chrome.storage.local.remove(`${CACHE_PREFIX}pledge:cart`);
  return { ok: true };
}

async function handlePledgeRemoveFromCart(
  message: Extract<RsiMessage, { type: 'pledge.removeFromCart' }>,
): Promise<{ ok: true }> {
  await withCsrfRetry(() => Rsi.removeCartItem(message.skuId, message.identifier));
  await chrome.storage.local.remove(`${CACHE_PREFIX}pledge:cart`);
  return { ok: true };
}

async function handlePledgeClearCart(): Promise<{ ok: true }> {
  await withCsrfRetry(() => Rsi.clearCart());
  await chrome.storage.local.remove(`${CACHE_PREFIX}pledge:cart`);
  return { ok: true };
}

async function handlePledgeCart(
  message: Extract<RsiMessage, { type: 'pledge.cart' }>,
) {
  // Short TTL: the cart changes whenever the user adds, removes, or
  // checks out — either from our UI or from the RSI site in another
  // tab. 60 s is long enough to make tab switches feel instant while
  // staying close to whatever's currently on the server.
  const key = 'pledge:cart';
  const force = message.force ?? false;
  if (!force) {
    const cached = await cacheGet<{ cart: Rsi.PledgeCart; fetchedAt: number }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const cart = await Rsi.fetchPledgeCart();
    const fetchedAt = Date.now();
    const payload = { cart, fetchedAt };
    await cacheSet(key, payload, TTL.cart);
    return { ...payload, fromCache: false };
  });
}

async function handleStatusSummary(force: boolean) {
  const key = 'status:summary';
  if (!force) {
    const cached = await cacheGet<{
      summary: Rsi.RsiStatusSummary;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const summary = await Rsi.fetchRsiStatus();
    const fetchedAt = Date.now();
    const payload = { summary, fetchedAt };
    await cacheSet(key, payload, TTL.status);
    return { ...payload, fromCache: false };
  });
}

async function handleCacheClear(prefix?: string) {
  // Wipe cache entries — either everything under the cache prefix, or
  // only entries under a specific namespace (`prefix`). User preferences
  // in localStorage (popup:*) and notify state (notify:state) sit outside
  // CACHE_PREFIX and always survive. Namespace version markers (cache:__v:*)
  // are kept so the migration doesn't immediately re-fire on the next
  // handler call.
  const allKeys = await listStorageKeys();
  const target = prefix ? `${CACHE_PREFIX}${prefix}` : CACHE_PREFIX;
  const keys = allKeys.filter((k) => {
    if (!k.startsWith(target)) return false;
    if (k.startsWith(CACHE_NAMESPACE_VERSION_PREFIX)) return false;
    return true;
  });
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
    log.info('cache', `manual clear wiped ${keys.length} entries${prefix ? ` under ${prefix}` : ''}`);
  }
  return { cleared: keys.length };
}

// Namespaces that opted into the schema-validated read path (see
// CACHE_SCHEMAS). Surfaced in the diagnostics UI so the user can tell
// at a glance which caches will detect a shape mismatch vs which still
// fall through to a raw cache read.
const VALIDATED_NAMESPACES: ReadonlySet<string> = new Set(
  Object.keys(CACHE_SCHEMAS).map((k) => k.split(':')[0]!),
);

// Namespaces wired up to stale-while-revalidate (cacheGetWithStale) —
// expired entries get served instantly while the BG re-fetches in the
// background. Hardcoded here so the UI badge stays in sync; if you add
// SWR to a new handler, register its top-level namespace prefix below.
const SWR_NAMESPACES: ReadonlySet<string> = new Set([
  'roadmap',
  'galactapedia', // covers galactapedia:index:v2 (the costly A-Z crawl)
]);

async function handleCacheStats() {
  // Group cache entries by their top-level namespace (the segment between
  // `cache:` and the first `:`), counting entries and approximating size
  // via `JSON.stringify(value).length`. Not exact bytes — chrome.storage
  // uses its own serialization — but close enough to drive a "where is
  // my quota going" UI.
  //
  // Per-namespace timestamps come from two distinct sources:
  //   - oldestFetchedAt / newestFetchedAt — the writer's `value.fetchedAt`
  //     when present (most handlers set it). Tells the user when the
  //     freshest / staleest entry in this namespace was last fetched.
  //   - nextExpiresAt — the soonest entry.expiresAt across the bucket.
  //     Tells the user when the next TTL flip will hit (= when the next
  //     popup open might block on a refetch, or when SWR will kick in).
  const all = await chrome.storage.local.get(null);
  type Bucket = {
    entries: number;
    sizeBytes: number;
    oldestFetchedAt: number | null;
    newestFetchedAt: number | null;
    nextExpiresAt: number | null;
  };
  const buckets = new Map<string, Bucket>();
  let totalEntries = 0;
  let totalSize = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    if (key.startsWith(CACHE_NAMESPACE_VERSION_PREFIX)) continue;
    const withoutPrefix = key.slice(CACHE_PREFIX.length);
    const ns = withoutPrefix.split(':')[0] ?? 'other';
    const size = JSON.stringify(value).length;
    const b = buckets.get(ns) ?? {
      entries: 0,
      sizeBytes: 0,
      oldestFetchedAt: null,
      newestFetchedAt: null,
      nextExpiresAt: null,
    };
    b.entries += 1;
    b.sizeBytes += size;
    // Pull timestamps from the entry envelope — every cache write goes
    // through cacheSet so `expiresAt` is always present. `fetchedAt`
    // depends on the caller (most module handlers set it explicitly).
    const entry = value as { value?: { fetchedAt?: unknown }; expiresAt?: unknown } | null;
    if (entry?.expiresAt && typeof entry.expiresAt === 'number') {
      if (b.nextExpiresAt === null || entry.expiresAt < b.nextExpiresAt) {
        b.nextExpiresAt = entry.expiresAt;
      }
    }
    const fetchedAt = entry?.value?.fetchedAt;
    if (typeof fetchedAt === 'number') {
      if (b.oldestFetchedAt === null || fetchedAt < b.oldestFetchedAt) {
        b.oldestFetchedAt = fetchedAt;
      }
      if (b.newestFetchedAt === null || fetchedAt > b.newestFetchedAt) {
        b.newestFetchedAt = fetchedAt;
      }
    }
    buckets.set(ns, b);
    totalEntries += 1;
    totalSize += size;
  }
  const namespaces = [...buckets.entries()]
    .map(([prefix, v]) => ({
      prefix,
      ...v,
      validated: VALIDATED_NAMESPACES.has(prefix),
      swr: SWR_NAMESPACES.has(prefix),
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);

  // Storage quota: chrome.storage.local default is 5 MB without the
  // `unlimitedStorage` permission. We don't ask for that permission
  // (it would trigger AMO re-review). Surface usage so the user can
  // see how close they are to the cap.
  const QUOTA_BYTES = (chrome.storage.local as { QUOTA_BYTES?: number }).QUOTA_BYTES ?? 5_242_880;
  const usedBytes = await chrome.storage.local
    .getBytesInUse(null)
    .catch(() => totalSize); // FF MV2 sometimes fails on this; fall back to estimate

  return {
    total: { entries: totalEntries, sizeBytes: totalSize },
    namespaces,
    storage: { usedBytes, quotaBytes: QUOTA_BYTES },
  };
}

/** Per-entry detail for one namespace. Powers the expandable row in
 *  Settings → Performance → Cache so the user can see exactly which
 *  cache keys exist, when each was fetched, when each expires, and
 *  how big each is. Bounded result to avoid huge payloads when a
 *  namespace has hundreds of entries (e.g. pledge:shipDetail after
 *  a long browsing session). */
async function handleCacheEntries(namespace: string) {
  const all = await chrome.storage.local.get(null);
  const fullPrefix = `${CACHE_PREFIX}${namespace}`;
  type EntryDetail = {
    key: string;
    sizeBytes: number;
    fetchedAt: number | null;
    expiresAt: number | null;
    isExpired: boolean;
  };
  const out: EntryDetail[] = [];
  const now = Date.now();
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(fullPrefix)) continue;
    if (k.startsWith(CACHE_NAMESPACE_VERSION_PREFIX)) continue;
    // Match `<prefix>` exactly OR `<prefix>:<rest>` so `commlink` doesn't
    // accidentally pull `commlinkXyz`-style siblings (none exist today
    // but the guard is cheap).
    if (k !== fullPrefix && !k.startsWith(`${fullPrefix}:`)) continue;
    const entry = v as
      | { value?: { fetchedAt?: unknown }; expiresAt?: unknown }
      | null;
    const expiresAt = typeof entry?.expiresAt === 'number' ? entry.expiresAt : null;
    const fetchedAt =
      typeof entry?.value?.fetchedAt === 'number' ? entry.value.fetchedAt : null;
    out.push({
      key: k.slice(CACHE_PREFIX.length),
      sizeBytes: JSON.stringify(v).length,
      fetchedAt,
      expiresAt,
      isExpired: expiresAt !== null && expiresAt < now,
    });
  }
  // Sort by size desc — biggest entries first (typically the most
  // useful to see when investigating "why is my cache so big").
  out.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { namespace, entries: out };
}

async function handleSettingsSessionStatus() {
  // Snapshot of every auth-related credential/token the extension holds.
  // Used to diagnose "CCU won't load" / "ships not showing" issues at
  // a glance — you can see if the Rsi-Token cookie is there, whether the
  // CSRF meta was scraped, and whether the CCU bootstrap has run.
  const token = await Rsi.readRsiToken();
  const identity = await (async () => {
    try {
      return await handleIdentity(false);
    } catch {
      return null;
    }
  })();
  return {
    signedIn: identity?.signedIn ?? false,
    handle: identity?.identity?.handle ?? null,
    rsiTokenPresent: token !== null,
    csrfTokenPresent: Rsi.getCachedCsrfToken() !== null,
    ccuSessionPrimed: Rsi.isCcuSessionPrimed(),
  };
}

async function handleSettingsLogs() {
  // Shallow copy of the in-memory ring buffer (shared/log.ts). We
  // deliberately drop the `data` field on the wire — it can hold arbitrary
  // objects including circular references, and the UI just renders the
  // scope/message lines.
  return {
    entries: log.snapshot().map((e) => ({
      time: e.time,
      level: e.level,
      scope: e.scope,
      message: e.message,
    })),
  };
}

async function handleSettingsPermissions() {
  const perms = await chrome.permissions.getAll();
  return {
    permissions: (perms.permissions ?? []).slice().sort(),
    origins: (perms.origins ?? []).slice().sort(),
  };
}

// In-memory last-prefetch stats. Lives for the SW lifetime (not persisted
// — these are ephemeral debugging aids, not telemetry). Resets to null
// when the SW restarts.
let lastPrefetch: {
  lastRunAt: number;
  durationMs: number;
  requestCount: number;
  rejectedCount: number;
} | null = null;

function handleSettingsPrefetchStats() {
  return {
    lastRunAt: lastPrefetch?.lastRunAt ?? null,
    durationMs: lastPrefetch?.durationMs ?? null,
    requestCount: lastPrefetch?.requestCount ?? null,
    rejectedCount: lastPrefetch?.rejectedCount ?? null,
  };
}

function handleSettingsRecordPrefetch(
  message: Extract<RsiMessage, { type: 'settings.recordPrefetch' }>,
) {
  lastPrefetch = {
    lastRunAt: Date.now(),
    durationMs: message.durationMs,
    requestCount: message.requestCount,
    rejectedCount: message.rejectedCount,
  };
  return { ok: true as const };
}

async function handleSettingsRefreshAll(): Promise<{ cleared: number; pollOk: boolean }> {
  // Hard reset triggered from Settings → Diagnostics → "Refresh all
  // modules now". Three steps in order:
  //
  //   1. Wipe every cache: entry. Reuses handleCacheClear so the
  //      namespace-version markers (`cache:__v:*`) survive — without
  //      that, the next module call would re-fire the migration logic
  //      pointlessly.
  //   2. Reset the per-module exponential backoff. A degraded module
  //      gets a fresh chance instead of staying skipped until its
  //      backoff window expires (could be up to an hour).
  //   3. Trigger an immediate full-scope poll. Refills the badge counts
  //      and seeds the freshly-emptied caches in one round trip via
  //      the cache-write side effects in collectSpectrumIds /
  //      collectContactsPendingIds.
  //
  // The popup typically does a window.location.reload() right after
  // calling this so every Svelte module re-mounts against the empty
  // cache (instead of holding onto its in-memory $state).
  const { cleared } = await handleCacheClear();

  const prev = await notifyStateGet();
  const next: Notify.NotifyState = {
    ...prev,
    backoffs: {},
    skippedReason: null,
  };
  await notifyStateSet(next);

  let pollOk = true;
  try {
    await pollNotifications('all');
  } catch (e) {
    log.warn('settings', 'refreshAll: poll after clear failed', e);
    pollOk = false;
  }
  return { cleared, pollOk };
}

async function handleSettingsPrimeCcu(): Promise<{ ok: boolean; error: string | null }> {
  // Force the full upgrade-session bootstrap without having to click the
  // Upgrades tab. Useful for the Settings "Prime CCU now" button, which
  // lets the user verify CSRF scraping + session init work on-demand
  // rather than discovering later that the CCU tab is broken.
  try {
    Rsi.invalidateCsrfToken();
    Rsi.invalidateCcuSession();
    const primed = await primeCsrfFromOpenTabs();
    if (!primed) {
      return {
        ok: false,
        error: 'No open robertsspaceindustries.com tab found. Open one and retry.',
      };
    }
    await Rsi.primeCcuSession();
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function handleSpectrumLobbies(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      lobbies: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:lobbies';
  if (!force) {
    const cached = await cacheGet<{ lobbies: Rsi.SpectrumLobby[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const lobbies = await Rsi.fetchSpectrumLobbies();
    const fetchedAt = Date.now();
    await cacheSet(key, { lobbies, fetchedAt }, TTL.spectrumNotifs);
    return { lobbies, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumMarkRead() {
  const token = await Rsi.readRsiToken();
  if (token) {
    try {
      await Rsi.markSpectrumNotificationsRead(token);
    } catch (e) {
      // Non-fatal: the local badge clear still happens from the popup side.
      log.warn('spectrum', 'markSpectrumNotificationsRead failed', e);
    }
    await chrome.storage.local.remove(CACHE_PREFIX + 'spectrum:notifications');
  }
  return { ok: true as const };
}

async function handleSpectrumThreads(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      threads: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:threads';
  if (!force) {
    const cached = await cacheGet<{ threads: Rsi.SpectrumThread[]; fetchedAt: number }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
    }
  }
  return dedupe(key, async () => {
    // DevTracker now scrapes RSI's /community/devtracker page (same source
    // the desktop site renders) — covers Patch Notes, Focus Testing,
    // Feedback, Announcements, Ask The Devs, plus CIG replies inside
    // community threads. The previous fetchHighlightedThreads only
    // covered top-level threads in groups 1+2 with highlight_role_id===2,
    // which missed everything except outright announcements (#45).
    const threads = await Rsi.fetchDevTrackerPosts();
    const fetchedAt = Date.now();
    await cacheSet(key, { threads, fetchedAt }, TTL.spectrum);
    return { threads, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumTrending(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      threads: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:trending';
  if (!force) {
    const cached = await cacheGet<{ threads: Rsi.SpectrumThread[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const threads = await Rsi.fetchTrendingThreads(token);
    const fetchedAt = Date.now();
    await cacheSet(key, { threads, fetchedAt }, TTL.spectrum);
    return { threads, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

// --- Forums tab (Phase 2) -------------------------------------------------
//
// The Forums tab fetches the full forum_channel_groups structure (all
// groups, all channels — not just the Official+Concierge subset that
// DevTracker covers) and lets users drill into a single channel for its
// thread list. The groups list comes from identify, so it's fast and
// can sit on a longer TTL than threads. Threads cache per (channel, sort)
// combo so switching sort buckets doesn't fight a single cached entry.

async function handleSpectrumEmojis(message: { communityId?: number; force?: boolean }) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return { emojis: [], fetchedAt: Date.now(), fromCache: false } as const;
  }
  const communityId = message.communityId ?? 1;
  const key = `spectrum:emojis:${communityId}`;
  if (!message.force) {
    const cached = await cacheGet<{ emojis: Rsi.SpectrumEmoji[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, fromCache: true } as const;
  }
  return dedupe(key, async () => {
    const emojis = await Rsi.fetchSpectrumCommunityEmojis(token, communityId);
    const fetchedAt = Date.now();
    // Reference TTL — community emojis change extremely rarely (admins
    // upload a few per year). 7 days keeps the popup from re-fetching
    // every session for no real change.
    await cacheSet(key, { emojis, fetchedAt }, REFERENCE_TTL);
    return { emojis, fetchedAt, fromCache: false } as const;
  });
}

async function handleSpectrumSearch(message: { text: string; communityId?: number }) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return { hits: [], signedIn: false, fetchedAt: Date.now() } as const;
  }
  // Search results aren't cached — every query is unique and the cost
  // is small, so the freshness/space trade-off favours always going to
  // the network. The server enforces a throttle limit per IP, which
  // we surface as an error in the UI.
  const hits = await Rsi.fetchSpectrumContentSearch(token, {
    text: message.text,
    communityId: message.communityId,
  });
  return { hits, signedIn: true as const, fetchedAt: Date.now() };
}

async function handleSpectrumLobbyMessages(message: {
  lobbyId: number;
  before?: number;
  after?: number;
  size?: number;
  force?: boolean;
}) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      messages: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  // Cursor-less calls are the common case — only those hit the cache.
  // Cursored calls (paginating upward) always go to the network so we
  // don't return stale pages.
  const cacheable = message.before == null && message.after == null;
  const key = `spectrum:lobbyMessages:${message.lobbyId}`;
  if (cacheable && !message.force) {
    const cached = await cacheGet<{ messages: Rsi.SpectrumMessage[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const messages = await Rsi.fetchSpectrumLobbyMessages(token, message.lobbyId, {
      before: message.before,
      after: message.after,
      size: message.size,
    });
    const fetchedAt = Date.now();
    if (cacheable) {
      // 2-min LIVE TTL — chat changes minute-to-minute. Manual refresh
      // forces a re-fetch via {force:true}.
      await cacheSet(key, { messages, fetchedAt }, TTL.spectrumNotifs);
    }
    return { messages, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumThreadDetail(message: {
  slug: string;
  sort?: 'votes' | 'time_created';
  force?: boolean;
}) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      thread: null,
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const sort = message.sort ?? 'votes';
  const key = `spectrum:threadDetail:${message.slug}:${sort}`;
  if (!message.force) {
    const cached = await cacheGet<{ thread: Rsi.SpectrumThreadDetail | null; fetchedAt: number }>(
      key,
    );
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const thread = await Rsi.fetchSpectrumThreadDetail(token, message.slug, { sort });
    const fetchedAt = Date.now();
    // 30-min TTL — same as forum threads. A user re-opening the same
    // thread within their session shouldn't re-pay; long enough that
    // typical popup tab-flipping is a hit, short enough that a real
    // refresh shows new replies.
    await cacheSet(key, { thread, fetchedAt }, TTL.spectrum);
    return { thread, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumBookmarks(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      bookmarks: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:bookmarks';
  if (!force) {
    const cached = await cacheGet<{ bookmarks: Rsi.SpectrumBookmark[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const bookmarks = await Rsi.fetchSpectrumBookmarks(token);
    const fetchedAt = Date.now();
    // Bookmarks are user-curated and rarely change — same 30-min TTL
    // as the rest of the per-user Spectrum data. Mutations
    // (handleSpectrumBookmarkRemove) write the fresh list straight
    // back so the cache stays warm without a follow-up fetch.
    await cacheSet(key, { bookmarks, fetchedAt }, TTL.spectrum);
    return { bookmarks, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

/** Spectrum's v2 mutations require an X-CSRF-TOKEN header — without
 *  it the server returns ErrNotAuthenticated even when the session
 *  cookie + x-rsi-token header are valid (reads tolerate the missing
 *  CSRF, writes don't). The shared CCU code path already had a
 *  primer that scrapes the meta tag from any open RSI tab; we reuse
 *  it here. If no RSI tab is open (or scripting is denied), the
 *  shared HTML scrape fallback runs as a second chance. */
async function getSpectrumCsrfToken(): Promise<string | undefined> {
  await primeCsrfFromOpenTabs();
  const cached = Rsi.getCachedCsrfToken();
  if (cached) return cached;
  // Last resort — the shared layer's HTML scrape against a handful of
  // known pages.
  const scraped = await Rsi.fetchRsiCsrfToken();
  return scraped ?? undefined;
}

async function handleSpectrumBookmarkAdd(message: {
  entityId: number;
  entityType: string;
}) {
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  await Rsi.addSpectrumBookmark(token, {
    entityId: message.entityId,
    entityType: message.entityType,
  });
  // Refresh + reprime cache so the popup paints the new state without
  // a separate roundtrip — same pattern as bookmarkRemove.
  const bookmarks = await Rsi.fetchSpectrumBookmarks(token);
  await cacheSet('spectrum:bookmarks', { bookmarks, fetchedAt: Date.now() }, TTL.spectrum);
  return { bookmarks };
}

async function handleSpectrumBookmarkRemove(message: {
  entityId: number;
  entityType: string;
}) {
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  await Rsi.removeSpectrumBookmark(token, {
    entityId: message.entityId,
    entityType: message.entityType,
  });
  // Refetch the list so the popup can paint the new state without a
  // follow-up message round trip. Re-prime the cache while we're at it.
  const bookmarks = await Rsi.fetchSpectrumBookmarks(token);
  await cacheSet('spectrum:bookmarks', { bookmarks, fetchedAt: Date.now() }, TTL.spectrum);
  return { bookmarks };
}

// Per-notification mutations. The popup builds three flavors of id:
//   - `<numeric>`        — native server notification (forum reply, vote, etc.)
//   - `private-<n>-…`    — synthetic, derived from private_lobbies in identify
//   - `friend-<n>-…`     — synthetic, derived from friend_requests in identify
// Only the native flavor has a /notification/read or /remove counterpart on
// the server; the synthetics already roll up server-side state from other
// places in the identify payload, so the local optimistic update is enough.
function isSyntheticNotificationId(id: string): boolean {
  return id.startsWith('private-') || id.startsWith('friend-');
}

async function handleSpectrumNotifMarkRead(message: { notificationId: string }) {
  if (isSyntheticNotificationId(message.notificationId)) {
    // Nothing to POST — just evict the cache so the next identify-driven
    // fetch repaints the read flag if the underlying state has actually
    // changed.
    await chrome.storage.local.remove(CACHE_PREFIX + 'spectrum:notifications');
    return { ok: true as const };
  }
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  const csrfToken = await getSpectrumCsrfToken();
  await Rsi.markSpectrumNotificationRead(token, {
    notificationId: message.notificationId,
    csrfToken,
  });
  await chrome.storage.local.remove(CACHE_PREFIX + 'spectrum:notifications');
  return { ok: true as const };
}

// Vote/react mutations don't return the new state — the server response is
// just `{success:1, code:'OK', data:true}`. To paint the new vote count
// (and the user's voted/reacted flags) we'd have to refetch the thread
// detail. We don't bother in BG: we evict the thread-detail + channel
// thread-list caches, and the popup applies an optimistic local delta
// that's already correct in the typical case. Next time the user navigates
// to the thread, the cache miss triggers a fresh fetch and any drift
// (e.g. a count that ticked from someone else's vote in parallel) gets
// reconciled.
async function evictSpectrumThreadCaches(): Promise<void> {
  const allKeys = await listStorageKeys();
  const targets = allKeys.filter(
    (k) =>
      k.startsWith(`${CACHE_PREFIX}spectrum:threadDetail:`) ||
      k.startsWith(`${CACHE_PREFIX}spectrum:forumThreads:`),
  );
  if (targets.length > 0) await chrome.storage.local.remove(targets);
}

async function handleSpectrumVote(message: {
  entityType: 'forum_thread' | 'forum_thread_reply';
  entityId: number;
  action: 'add' | 'remove';
}) {
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  await Rsi.voteSpectrumEntity(token, {
    entityType: message.entityType,
    entityId: message.entityId,
    action: message.action,
  });
  await evictSpectrumThreadCaches();
  return { ok: true as const };
}

async function handleSpectrumSubscribe(message: {
  entityType: 'forum_thread' | 'forum_channel' | 'message_lobby';
  entityId: number;
  level: 'all' | 'disabled' | 'mentions' | 'highlights';
}) {
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  await Rsi.subscribeSpectrumEntity(token, {
    entityType: message.entityType,
    entityId: message.entityId,
    type: message.level,
  });
  // Channel-level subscriptions live in the identify payload, which our
  // forum-groups cache mirrors. Thread-level lives in threadDetail.
  // Evict whichever cache the mutated entity lives in so the next read
  // re-syncs against the server.
  if (message.entityType === 'forum_channel') {
    const allKeys = await listStorageKeys();
    const targets = allKeys.filter((k) =>
      k.startsWith(`${CACHE_PREFIX}spectrum:forumGroups:`),
    );
    if (targets.length > 0) await chrome.storage.local.remove(targets);
    // identify itself is the source of truth — reset its cache too so
    // the next auth.identity sees the new subscription level.
    await Rsi.invalidateIdentifyCache();
  } else if (message.entityType === 'forum_thread') {
    await evictSpectrumThreadCaches();
  }
  return { ok: true as const };
}

async function handleSpectrumReact(message: {
  entityType: 'forum_thread' | 'forum_thread_reply' | 'message';
  entityId: number;
  reactionType: string;
  action: 'add' | 'remove';
}) {
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  await Rsi.reactSpectrumEntity(token, {
    entityType: message.entityType,
    entityId: message.entityId,
    reactionType: message.reactionType,
    action: message.action,
  });
  // Forum reactions live on threads/replies → evict thread caches.
  // DM-message reactions live in the lobby messages cache → evict
  // lobbyMessages instead. Clearing both is harmless on misclassify.
  if (message.entityType === 'message') {
    const allKeys = await listStorageKeys();
    const targets = allKeys.filter((k) =>
      k.startsWith(`${CACHE_PREFIX}spectrum:lobbyMessages:`),
    );
    if (targets.length > 0) await chrome.storage.local.remove(targets);
  } else {
    await evictSpectrumThreadCaches();
  }
  return { ok: true as const };
}

async function handleSpectrumNotifRemove(message: { notificationId: string }) {
  if (isSyntheticNotificationId(message.notificationId)) {
    await chrome.storage.local.remove(CACHE_PREFIX + 'spectrum:notifications');
    return { ok: true as const };
  }
  const token = await Rsi.readRsiToken();
  if (!token) throw new Error('not signed in');
  const csrfToken = await getSpectrumCsrfToken();
  await Rsi.removeSpectrumNotification(token, {
    notificationId: message.notificationId,
    csrfToken,
  });
  await chrome.storage.local.remove(CACHE_PREFIX + 'spectrum:notifications');
  return { ok: true as const };
}

async function handleSpectrumCommunities(force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      communities: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = 'spectrum:communities';
  if (!force) {
    const cached = await cacheGet<{ communities: Rsi.SpectrumCommunity[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    const communities = await Rsi.fetchSpectrumCommunities(token);
    const fetchedAt = Date.now();
    // Joined-org membership rarely changes between popup opens — same
    // 30-min TTL as the per-community forum structure.
    await cacheSet(key, { communities, fetchedAt }, TTL.spectrum);
    return { communities, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumForumGroups(communityId: number, force: boolean) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      groups: [],
      communityId,
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const key = `spectrum:forumGroups:${communityId}`;
  if (!force) {
    const cached = await cacheGet<{ groups: Rsi.SpectrumForumGroup[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, communityId, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    // Identify carries the forum tree for every community the user
    // belongs to (SC + joined orgs). No need for v2/forum/channel/list
    // — that endpoint returned empty for orgs in the extension's auth
    // context anyway. The fetcher throws a clear error if the community
    // isn't in identify, which the popup surfaces inline.
    const groups = await Rsi.fetchSpectrumForumGroups(communityId);
    const fetchedAt = Date.now();
    await cacheSet(key, { groups, fetchedAt }, TTL.spectrum);
    return { groups, communityId, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

async function handleSpectrumForumThreads(message: {
  communityId: number;
  channelId: number;
  sort?: Rsi.SpectrumSort;
  force?: boolean;
}) {
  const token = await Rsi.readRsiToken();
  if (!token) {
    return {
      threads: [],
      signedIn: false,
      fetchedAt: Date.now(),
      fromCache: false,
    };
  }
  const sort = message.sort ?? 'hot';
  const key = `spectrum:forumThreads:${message.communityId}:${message.channelId}:${sort}`;
  if (!message.force) {
    const cached = await cacheGet<{ threads: Rsi.SpectrumThread[]; fetchedAt: number }>(key);
    if (cached) return { ...cached, signedIn: true, fromCache: true };
  }
  return dedupe(key, async () => {
    // Look up the channel by id from the cached forumGroups for this
    // community (warming the cache first if it's missing). The
    // SpectrumChannel ↦ thread-URL mapping needs both the channel
    // slug and the community slug, neither of which is in the threads
    // response itself.
    const groupsCache = await cacheGet<{ groups: Rsi.SpectrumForumGroup[]; fetchedAt: number }>(
      `spectrum:forumGroups:${message.communityId}`,
    );
    const groups: Rsi.SpectrumForumGroup[] = groupsCache
      ? groupsCache.groups
      : (await handleSpectrumForumGroups(message.communityId, false)).groups;
    let channel: Rsi.SpectrumChannel | undefined;
    for (const g of groups) {
      const found = g.channels.find((c) => c.id === message.channelId);
      if (found) {
        channel = {
          id: found.id,
          name: found.name,
          slug: found.slug,
          color: found.color,
          communitySlug: found.communitySlug,
        };
        break;
      }
    }
    if (!channel) {
      throw new Error(
        `channel ${message.channelId} not found in community ${message.communityId}`,
      );
    }
    const threads = await Rsi.fetchSpectrumForumChannelThreads(token, channel, { sort });
    const fetchedAt = Date.now();
    await cacheSet(key, { threads, fetchedAt }, TTL.spectrum);
    return { threads, signedIn: true as const, fetchedAt, fromCache: false };
  });
}

// --- Notification polling -------------------------------------------------
//
// Two alarms run on separate cadences, split by how fast each module's data
// actually changes:
//
//   FAST  (10 min)  spectrum, contacts, comm-link
//     Spectrum notifs/DMs turn over minute-to-minute; contacts flips on
//     incoming friend requests; Comm-Link publishes a few times a day at
//     peak. A 10-min window keeps the badge honest.
//
//   SLOW  (60 min)  patch-notes, roadmap, release-notes
//     CIG cuts patch notes weekly, updates the roadmap about the same.
//     Extension release notes change only on my own release cycle. A 60-min
//     window is more than enough here and drops 5/6 of their HTTP volume.
//
// Before: one alarm fired 6 collectors every 10 min = 36 collectors/hr.
// After:  3 collectors × 6 fast ticks + 3 collectors × 1 slow tick = 21/hr.
//
// On each tick we diff the current id set against the user's per-module
// `notify:seen:<m>` fingerprint. The unread totals drive the icon badge and
// the sidebar dots.

const FAST_POLL_ALARM = 'rsi-companion-poll';
const SLOW_POLL_ALARM = 'rsi-companion-poll-slow';
const FAST_POLL_MINUTES = 10;
const SLOW_POLL_MINUTES = 60;
const FAST_MODULES: readonly Notify.NotifyModule[] = ['spectrum', 'contacts', 'comm-link'];
const SLOW_MODULES: readonly Notify.NotifyModule[] = ['patch-notes', 'roadmap', 'release-notes'];
const NOTIFY_SEEN_PREFIX = 'notify:seen:';
const NOTIFY_STATE_KEY = 'notify:state';
const NOTIFY_MIGRATION_KEY = 'notify:migration';
// Bump when the diff fingerprint semantics change so stale state is reset.
// v2: raised MAX_SEEN_IDS (roadmap snapshot can exceed 500 cards; the old cap
// truncated the seen set and every poll surfaced re-seen cards as "new").
// v3: added 'contacts' and 'release-notes' modules — baseline their seen set
// so first poll after upgrade doesn't flash counts on everything.
// v4: state shape: lastError: string | null → lastErrors: per-module record.
// Old singleton error would break on read under the new type.
const NOTIFY_MIGRATION_VERSION = 4;
const MAX_SEEN_IDS = 5000;

type SeenFingerprint = { ids: string[] };

async function seenGet(module: Notify.NotifyModule): Promise<Set<string> | null> {
  const key = NOTIFY_SEEN_PREFIX + module;
  const res = await chrome.storage.local.get(key);
  const entry = res[key] as SeenFingerprint | undefined;
  if (!entry) return null;
  return new Set(entry.ids);
}

async function seenSet(module: Notify.NotifyModule, ids: Iterable<string>): Promise<void> {
  const key = NOTIFY_SEEN_PREFIX + module;
  const arr = Array.from(ids).slice(-MAX_SEEN_IDS);
  await chrome.storage.local.set({ [key]: { ids: arr } satisfies SeenFingerprint });
}

async function notifyStateGet(): Promise<Notify.NotifyState> {
  const res = await chrome.storage.local.get(NOTIFY_STATE_KEY);
  const stored = res[NOTIFY_STATE_KEY] as Notify.NotifyState | undefined;
  return (
    stored ?? {
      signedIn: false,
      counts: { ...Notify.EMPTY_COUNTS },
      lastPolledAt: null,
      lastErrors: {},
    }
  );
}

async function notifyStateSet(state: Notify.NotifyState): Promise<void> {
  await chrome.storage.local.set({ [NOTIFY_STATE_KEY]: state });
  await updateBadge(state);
}

async function updateBadge(state: Notify.NotifyState): Promise<void> {
  const total = Notify.totalUnread(state.counts);
  // MV3 Chromium and Firefox MV3 expose the toolbar API as
  // `chrome.action`; Firefox MV2 (our actual Firefox build target —
  // WXT defaults Firefox to MV2) uses `chrome.browserAction` instead.
  // The two APIs are otherwise compatible at the call sites we use
  // (setBadgeText / setBadgeBackgroundColor accept identical {text}
  // / {color} payloads). Pick whichever is defined at runtime.
  // Reported by @ravensrook on GH #30, Firefox 149 / Windows: every
  // notification poll surfaced `TypeError: can't access property
  // "setBadgeText", n is undefined` because chrome.action is
  // undefined on MV2. Caught by the try/catch below, but still
  // costs us the badge entirely on Firefox.
  const action =
    chrome.action ??
    (chrome as unknown as { browserAction?: typeof chrome.action })
      .browserAction;
  if (!action) {
    log.debug('badge', 'no toolbar action API available on this browser');
    return;
  }
  try {
    if (total > 0) {
      await action.setBadgeText({ text: total > 99 ? '99+' : String(total) });
      await action.setBadgeBackgroundColor({ color: '#22c55e' });
    } else {
      await action.setBadgeText({ text: '' });
    }
  } catch (e) {
    // The action API can be briefly unavailable during extension reloads or
    // when the window is closing. We swallow and just log — the next poll
    // tick repaints the badge anyway.
    log.debug('badge', 'setBadgeText failed', e);
  }
}

// Side-effect cache writes from the poll path. The poll already pays the
// network cost to fetch fresh data — landing it directly in the popup's
// module cache means the next popup open serves a hot cache from <10 min
// ago instead of forcing a duplicate fetch on cache miss. Module shape has
// to match what the popup handler writes for this to work; for shape-
// mismatched feeds (spectrum:threads / commlink / patchnotes / roadmap)
// the poll falls back to invalidating the cache so the popup refetches
// fresh on next open. Both halves wired together = "poll discovers new
// content → popup sees it instantly without a roundtrip" instead of the
// previous "poll bumps badge but popup data still stale for ~30 min".
async function writeSpectrumLobbiesCache(lobbies: Rsi.SpectrumLobby[]): Promise<void> {
  await cacheSet(
    'spectrum:lobbies',
    { lobbies, fetchedAt: Date.now() },
    TTL.spectrumNotifs,
  );
}

async function writeSpectrumNotificationsCache(
  notifications: Rsi.SpectrumNotification[],
): Promise<void> {
  await cacheSet(
    'spectrum:notifications',
    { notifications, fetchedAt: Date.now() },
    TTL.spectrumNotifs,
  );
}

async function writeContactsListCache(bundle: Rsi.ContactsBundle): Promise<void> {
  // Match the full shape handleContactsList writes — `contacts` PLUS
  // `incoming` and `outgoing` request lists. The popup's Contacts module
  // reads all three and crashes with "Cannot read properties of
  // undefined" on `.length` if we only seed the contacts array. Bug
  // shipped in 1.4.0; fixed here.
  await cacheSet(
    'contacts:list',
    {
      contacts: bundle.contacts,
      incoming: bundle.incoming,
      outgoing: bundle.outgoing,
      fetchedAt: Date.now(),
    },
    TTL.contacts,
  );
}

async function collectSpectrumIds(token: string): Promise<string[]> {
  // Spectrum's unread badge covers three distinct feeds. We return one prefixed
  // id set that merges them, so the diff-against-seen machinery treats "new
  // DevTracker post", "new DM", and "new notification" equivalently:
  //
  //   thread-<id>                — highlighted (DevTracker) forum thread
  //   dm-<lobbyId>-<lastMsgTs>   — DM lobby with unread messages. The timestamp
  //                                is part of the id so successive new messages
  //                                in the same lobby each count as a new item
  //                                (a static lobby-only id would be wedged in
  //                                `seen` after the user once opened Spectrum
  //                                and never tick again for that lobby).
  //   notif-<id>                 — unread native notification (thread replies,
  //                                votes, friend requests, etc). Server owns
  //                                the read flag so the id can stay stable.
  //
  // Each feed is wrapped in its own try/catch: if the DMs fetch transiently
  // 500s we still want the DevTracker count to update. Failing the whole
  // collector would zero the badge for the session.
  //
  // RsiNotAuthenticatedError gets a special path: the rsi_token cookie is
  // present (so pollNotifications didn't short-circuit) but the server has
  // already invalidated the session. All three feeds will fail the same way,
  // so we bail on the first hit instead of logging three warnings per tick.
  // The next auth.identity tick will flip signedIn=false and pollNotifications
  // will then take the empty-counts shortcut.
  const out: string[] = [];

  const guard = (e: unknown, label: string): boolean => {
    if (e instanceof Rsi.RsiNotAuthenticatedError) return true;
    log.warn('notify', `collectSpectrumIds: ${label} failed`, e);
    return false;
  };

  try {
    const threads = await Rsi.fetchHighlightedThreads(token);
    for (const t of threads) out.push(`thread-${t.id}`);
  } catch (e) {
    if (guard(e, 'highlighted threads')) return out;
  }

  try {
    const lobbies = await Rsi.fetchSpectrumLobbies();
    for (const l of lobbies) {
      if (l.newMessages > 0) out.push(`dm-${l.id}-${l.lastMessageAt}`);
    }
    // Land the poll-fetched data straight in the popup's cache so a fresh
    // popup open serves it without a duplicate roundtrip. Same shape the
    // popup handler writes — see writeSpectrumLobbiesCache above.
    await writeSpectrumLobbiesCache(lobbies);
  } catch (e) {
    if (guard(e, 'lobbies')) return out;
  }

  try {
    const notifs = await Rsi.fetchSpectrumNotifications();
    for (const n of notifs) {
      if (n.read) continue;
      // Skip the synthetic "private-new-message" entries — we already cover
      // DMs above with a timestamp-qualified id. Double-counting would inflate
      // the badge by one per unread lobby.
      if (n.type === 'private-new-message') continue;
      out.push(`notif-${n.id}`);
    }
    await writeSpectrumNotificationsCache(notifs);
  } catch (e) {
    if (guard(e, 'notifications')) return out;
  }

  return out;
}

async function collectCommLinkIds(): Promise<string[]> {
  const url = Rsi.buildCommLinkUrl({ page: 1 });
  const response = await fetchWithTimeout(url, {
    credentials: 'omit',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`comm-link poll returned ${response.status}`);
  const html = await response.text();
  return Rsi.parseCommLinkListing(html).articles.map((a) => a.href);
}

async function collectPatchNotesIds(): Promise<string[]> {
  const notes = await Rsi.fetchPatchNotes(1);
  return notes.map((n) => n.href);
}

async function collectRoadmapIds(): Promise<string[]> {
  const snap = await collectRoadmapSnapshot();
  return Object.keys(snap);
}

async function collectContactsPendingIds(): Promise<string[]> {
  const bundle = await Rsi.fetchContactsBundle();
  // Same data the Contacts module renders — drop it in the cache here so
  // opening Contacts after a poll doesn't cost an extra roundtrip. The
  // full bundle (contacts + incoming + outgoing) goes in; partial seeding
  // would crash the module on .length reads of the missing fields.
  await writeContactsListCache(bundle);
  return bundle.incoming.map((r) => String(r.id));
}

async function collectReleaseNoteIds(): Promise<string[]> {
  // Release notes ship bundled with the extension (no server round-trip).
  // Each release has a static version string — that's what the notify
  // system keys off to mark "seen". This list updates when the user
  // installs a new extension build.
  return RELEASE_NOTES.map((r) => r.version);
}

// Short keys (r/c/n) keep the persisted object compact — a few hundred cards
// × release-id + category-id + name would blow past storage.local quota if
// serialized with long field names.
type RoadmapSnapshotEntry = { r: number; c: number; n: string };
type RoadmapSnapshotMap = Record<string, RoadmapSnapshotEntry>;
const ROADMAP_SNAPSHOT_KEY = 'notify:snapshot:roadmap';

async function collectRoadmapSnapshot(): Promise<RoadmapSnapshotMap> {
  const res = await Rsi.fetchRsiRoadmap();
  const out: RoadmapSnapshotMap = {};
  for (const release of res.data.releases ?? []) {
    for (const card of release.cards ?? []) {
      out[String(card.id)] = {
        r: release.id,
        c: card.category_id,
        n: card.name,
      };
    }
  }
  return out;
}

async function roadmapSnapshotGet(): Promise<RoadmapSnapshotMap | null> {
  const res = await chrome.storage.local.get(ROADMAP_SNAPSHOT_KEY);
  const entry = res[ROADMAP_SNAPSHOT_KEY] as RoadmapSnapshotMap | undefined;
  return entry ?? null;
}

async function roadmapSnapshotSet(snapshot: RoadmapSnapshotMap): Promise<void> {
  await chrome.storage.local.set({ [ROADMAP_SNAPSHOT_KEY]: snapshot });
}

/**
 * Diff a current fingerprint against lastSeen.
 * First run (no lastSeen): initialize lastSeen = current, return 0 new.
 * Subsequent runs: new = current \ lastSeen.
 */
async function diffModule(
  module: Notify.NotifyModule,
  fetcher: () => Promise<string[]>,
): Promise<number> {
  const current = await fetcher();
  const seen = await seenGet(module);
  if (seen === null) {
    await seenSet(module, current);
    return 0;
  }
  let unread = 0;
  for (const id of current) if (!seen.has(id)) unread++;
  return unread;
}

type PollScope = 'fast' | 'slow' | 'all';

function modulesForScope(scope: PollScope): ReadonlySet<Notify.NotifyModule> {
  if (scope === 'fast') return new Set(FAST_MODULES);
  if (scope === 'slow') return new Set(SLOW_MODULES);
  return new Set<Notify.NotifyModule>([...FAST_MODULES, ...SLOW_MODULES]);
}

// --- Status-feed circuit breaker ---------------------------------------
//
// RSI publishes the platform health at /index.json on the status host.
// Three systems are reported (Platform / Persistent Universe / Arena
// Commander). We only care about Platform — that's what hosts the API
// + Spectrum + Pledge Store + Community Hub etc. When Platform is
// `down` or `maintenance`, polling is guaranteed to fail; skipping the
// whole tick saves the user's network + RSI's infra.
//
// Reads the existing status:summary cache first (popup users keep it
// fresh on a 90 s TTL). If the cache is stale (> POLL_GATE_FRESH_MS old)
// or missing, we fetch a single status-feed JSON before deciding —
// cheaper than firing 6 collectors that will all fail.
const POLL_GATE_FRESH_MS = 10 * MIN;
type PlatformGate = { skip: boolean; reason: string };

async function readPlatformGate(): Promise<PlatformGate> {
  let summary: Rsi.RsiStatusSummary | null = null;
  const cached = await cacheGet<{ summary: Rsi.RsiStatusSummary; fetchedAt: number }>(
    'status:summary',
  );
  if (cached && Date.now() - cached.fetchedAt < POLL_GATE_FRESH_MS) {
    summary = cached.summary;
  } else {
    // Cache too stale (or absent — first boot, or popup never opened).
    // Fetch fresh and refresh the cache while we're at it; popup users
    // reading from this cache will benefit.
    try {
      summary = await Rsi.fetchRsiStatus();
      await cacheSet('status:summary', { summary, fetchedAt: Date.now() }, TTL.status);
    } catch (e) {
      // Status feed itself unreachable — could be a wider RSI outage or
      // just our network. Don't block the poll; let the per-module
      // backoff handle persistent failure.
      log.debug('notify', 'status feed unreachable; falling through to normal poll', e);
      return { skip: false, reason: '' };
    }
  }
  if (!summary) return { skip: false, reason: '' };
  // Match by name — RSI's feed currently lists "Platform" but we don't
  // want to break if they rename it slightly. Fall back to the worst
  // overall level if no Platform system is found.
  const platform =
    summary.systems.find((s) => /platform/i.test(s.name)) ??
    summary.systems.reduce<typeof summary.systems[number] | null>((worst, s) => {
      if (!worst) return s;
      const SEV = { operational: 0, notice: 1, maintenance: 2, disrupted: 3, down: 4 } as const;
      return SEV[s.level] > SEV[worst.level] ? s : worst;
    }, null);
  if (!platform) return { skip: false, reason: '' };
  if (platform.level === 'down') {
    return { skip: true, reason: `RSI Platform reported down (${platform.name})` };
  }
  if (platform.level === 'maintenance') {
    return { skip: true, reason: `RSI Platform under maintenance (${platform.name})` };
  }
  // 'operational' / 'notice' / 'disrupted' — proceed. Disrupted is partial
  // impact and individual modules might still succeed.
  return { skip: false, reason: '' };
}

// --- Per-module exponential backoff ------------------------------------
//
// After a collector fails, that module gets a `nextRetryAt` timestamp
// based on how many consecutive failures it's racked up. Schedule:
//   1st fail → retry in 10 min  (next tick anyway)
//   2nd fail → retry in 20 min  (skip 1 fast tick)
//   3rd fail → retry in 40 min  (skip ~3 fast ticks)
//   4th+    → retry in 60 min  (cap)
// First success resets streak + nextRetryAt to 0. The whole struct
// persists in NotifyState so the BG SW can sleep + wake without losing
// the schedule.
const POLL_BACKOFF_BASE_MS = 10 * MIN;
const POLL_BACKOFF_CAP_MS = 60 * MIN;

function computeBackoffDelay(streak: number): number {
  // 2^(streak-1): 1, 2, 4, 8, … capped.
  const factor = Math.min(2 ** Math.max(0, streak - 1), POLL_BACKOFF_CAP_MS / POLL_BACKOFF_BASE_MS);
  return Math.min(POLL_BACKOFF_BASE_MS * factor, POLL_BACKOFF_CAP_MS);
}

// Cache prefixes a poll-detected "new content" event should evict in the
// popup's module cache so the next popup open refetches fresh. Counterpart
// to the side-effect cache writes in collectSpectrumIds /
// collectContactsPendingIds: those cover the keys whose shape exactly
// matches the popup handler's payload; this list covers everything else
// (different fetcher source, paginated/filtered keys, etc.).
//
// Each entry is a list of cache key prefixes. Empty list means the
// collector already wrote the cache itself (no invalidation needed).
const INVALIDATE_ON_NEW_PREFIXES: Record<Notify.NotifyModule, string[]> = {
  // collectSpectrumIds wrote `spectrum:lobbies` and `spectrum:notifications`
  // directly. The threads + trending feeds have a different source post-
  // 1.3.7 (scrape of /community/devtracker, not the highlightedThreads
  // fetch the poll uses) so they need invalidation instead. Bookmarks /
  // forumThreads / threadDetail aren't poll-driven but a fresh DM signal
  // implies the user might be checking Spectrum overall — leaving them
  // intact since they're keyed by user action, not by feed activity.
  spectrum: ['spectrum:threads', 'spectrum:trending'],
  contacts: [], // collectContactsPendingIds wrote contacts:list directly
  'comm-link': ['commlink:list:'],
  'patch-notes': ['patchnotes:list:'],
  roadmap: ['roadmap:data', 'progress-tracker:v2'],
  'release-notes': [], // bundled JSON, no cache layer
};

async function invalidateCacheForNewItems(module: Notify.NotifyModule): Promise<void> {
  const prefixes = INVALIDATE_ON_NEW_PREFIXES[module];
  if (!prefixes || prefixes.length === 0) return;
  const allKeys = await listStorageKeys();
  const targets: string[] = [];
  for (const k of allKeys) {
    if (!k.startsWith(CACHE_PREFIX)) continue;
    const bare = k.slice(CACHE_PREFIX.length);
    for (const p of prefixes) {
      if (bare === p || bare.startsWith(p)) {
        targets.push(k);
        break;
      }
    }
  }
  if (targets.length > 0) await chrome.storage.local.remove(targets);
}

async function pollNotifications(scope: PollScope = 'all'): Promise<Notify.NotifyState> {
  // Scope-specific dedup key so a fast tick doesn't steal a slow tick's work.
  // Concurrent same-scope calls still share one Promise.
  return dedupe(`notify:poll:${scope}`, async () => {
    const prev = await notifyStateGet();
    const token = await Rsi.readRsiToken();
    if (!token) {
      // Signed-out path stays scope-agnostic: clear every badge. Otherwise a
      // slow-only tick after sign-out would leave fast-module counts stale.
      const next: Notify.NotifyState = {
        signedIn: false,
        counts: { ...Notify.EMPTY_COUNTS },
        lastPolledAt: Date.now(),
        lastErrors: {},
        backoffs: {},
        skippedReason: null,
      };
      await notifyStateSet(next);
      return next;
    }

    // Layer 1: status circuit breaker. RSI's own status feed says we're
    // wasting our time, skip the whole tick.
    const gate = await readPlatformGate();
    if (gate.skip) {
      log.info('notify', `poll skipped: ${gate.reason}`);
      const next: Notify.NotifyState = {
        ...prev,
        signedIn: true,
        lastPolledAt: Date.now(),
        skippedReason: gate.reason,
      };
      await notifyStateSet(next);
      return next;
    }

    const counts: Notify.NotifyCounts = { ...prev.counts };
    // Carry over errors only for modules NOT in scope — an in-scope module's
    // success or failure replaces its prior entry so stale errors don't linger
    // after a transient failure recovers.
    const lastErrors: Notify.NotifyErrors = { ...prev.lastErrors };
    const backoffs: Notify.NotifyBackoffs = { ...(prev.backoffs ?? {}) };
    const modules = modulesForScope(scope);
    const now = Date.now();

    const tasks: Array<Promise<void>> = [];
    const run = (m: Notify.NotifyModule, collector: () => Promise<string[]>): void => {
      if (!modules.has(m)) return;
      // Layer 2: per-module exponential backoff. If this module is in
      // its cooldown window from a prior failure, skip — keep prior
      // counts and errors intact so the badge / UI don't flicker.
      const bo = backoffs[m];
      if (bo && bo.nextRetryAt > now) {
        log.debug(
          'notify',
          `${m} in backoff (streak=${bo.failStreak}, ${Math.round((bo.nextRetryAt - now) / 1000)}s remaining)`,
        );
        return;
      }
      // Clear any prior error for this module — we either succeed (stays clear)
      // or fail and set a fresh one.
      delete lastErrors[m];
      tasks.push(
        diffModule(m, collector)
          .then((n) => {
            counts[m] = n;
            // Reset backoff on success.
            if (backoffs[m]) backoffs[m] = { failStreak: 0, nextRetryAt: 0 };
            // When the diff surfaced new items, evict the popup's module
            // cache for keys whose shape we couldn't write directly from
            // the collector (different fetcher, different filters, …).
            // Next popup open then sees a cache miss and refetches the
            // fresh data, instead of painting stale content for the rest
            // of TTL.identity / TTL.spectrum.
            if (n > 0) {
              void invalidateCacheForNewItems(m).catch((err) =>
                log.warn('notify', `cache invalidation for ${m} failed`, err),
              );
            }
          })
          .catch((e: unknown) => {
            lastErrors[m] = e instanceof Error ? e.message : String(e);
            const prevStreak = backoffs[m]?.failStreak ?? 0;
            const nextStreak = prevStreak + 1;
            backoffs[m] = {
              failStreak: nextStreak,
              nextRetryAt: Date.now() + computeBackoffDelay(nextStreak),
            };
          }),
      );
    };

    run('spectrum', () => collectSpectrumIds(token));
    run('comm-link', collectCommLinkIds);
    run('patch-notes', collectPatchNotesIds);
    run('roadmap', collectRoadmapIds);
    run('contacts', collectContactsPendingIds);
    run('release-notes', collectReleaseNoteIds);

    await Promise.all(tasks);

    const next: Notify.NotifyState = {
      signedIn: true,
      counts,
      lastPolledAt: Date.now(),
      lastErrors,
      backoffs,
      skippedReason: null,
    };
    await notifyStateSet(next);
    return next;
  });
}

async function handleRoadmapSnapshot(): Promise<{
  snapshot: Record<string, { releaseId: number; categoryId: number; name: string }> | null;
}> {
  const raw = await roadmapSnapshotGet();
  if (!raw) return { snapshot: null };
  const out: Record<string, { releaseId: number; categoryId: number; name: string }> = {};
  for (const [id, e] of Object.entries(raw)) {
    out[id] = { releaseId: e.r, categoryId: e.c, name: e.n };
  }
  return { snapshot: out };
}

async function handleRoadmapSnapshotCommit(
  message: Extract<RsiMessage, { type: 'roadmap.snapshot.commit' }>,
): Promise<{ ok: true }> {
  // Compact and persist the UI-supplied snapshot so we don't round-trip the
  // full roadmap fetch again just to record what's now been seen.
  const compact: RoadmapSnapshotMap = {};
  for (const [id, e] of Object.entries(message.snapshot)) {
    compact[id] = { r: e.releaseId, c: e.categoryId, n: e.name };
  }
  await roadmapSnapshotSet(compact);
  await seenSet('roadmap', Object.keys(compact));

  // Clear the roadmap badge count since the user has now seen the current state.
  const prev = await notifyStateGet();
  if (prev.counts.roadmap !== 0) {
    const next: Notify.NotifyState = {
      ...prev,
      counts: { ...prev.counts, roadmap: 0 },
    };
    await notifyStateSet(next);
  }
  return { ok: true };
}

async function handleNotifyMarkSeen(module: Notify.NotifyModule): Promise<Notify.NotifyState> {
  const prev = await notifyStateGet();
  // Snapshot the current set of ids for this module into `seen`. We fetch fresh
  // so that anything visible right now in the module counts as "read", not just
  // what happened to be on the last poll.
  try {
    if (module === 'spectrum') {
      const token = await Rsi.readRsiToken();
      if (token) await seenSet('spectrum', await collectSpectrumIds(token));
    } else if (module === 'comm-link') {
      await seenSet('comm-link', await collectCommLinkIds());
    } else if (module === 'patch-notes') {
      await seenSet('patch-notes', await collectPatchNotesIds());
    } else if (module === 'roadmap') {
      const snap = await collectRoadmapSnapshot();
      await seenSet('roadmap', Object.keys(snap));
      await roadmapSnapshotSet(snap);
    } else if (module === 'contacts') {
      await seenSet('contacts', await collectContactsPendingIds());
    } else if (module === 'release-notes') {
      await seenSet('release-notes', await collectReleaseNoteIds());
    }
  } catch (e) {
    // If refresh fails, we still clear the count so the user isn't stuck.
    // Logging (not throwing) lets the zero-count still land.
    log.warn('notify', `markSeen refresh failed for ${module}`, e);
  }
  const counts: Notify.NotifyCounts = { ...prev.counts, [module]: 0 };
  const next: Notify.NotifyState = { ...prev, counts };
  await notifyStateSet(next);
  return next;
}

async function ensurePollAlarms(): Promise<void> {
  const [fast, slow] = await Promise.all([
    chrome.alarms.get(FAST_POLL_ALARM),
    chrome.alarms.get(SLOW_POLL_ALARM),
  ]);
  const work: Array<Promise<chrome.alarms.Alarm | void>> = [];
  if (!fast) {
    work.push(
      chrome.alarms.create(FAST_POLL_ALARM, {
        periodInMinutes: FAST_POLL_MINUTES,
        delayInMinutes: 0.5,
      }),
    );
  }
  if (!slow) {
    // Stagger the first slow tick past the fast one so they don't fight for
    // service-worker wake quota on boot. Subsequent ticks drift freely.
    work.push(
      chrome.alarms.create(SLOW_POLL_ALARM, {
        periodInMinutes: SLOW_POLL_MINUTES,
        delayInMinutes: 2,
      }),
    );
  }
  await Promise.all(work);
}

async function runNotifyMigration(): Promise<void> {
  const res = await chrome.storage.local.get(NOTIFY_MIGRATION_KEY);
  const stored = (res[NOTIFY_MIGRATION_KEY] as { version?: number } | undefined)?.version ?? 0;
  if (stored >= NOTIFY_MIGRATION_VERSION) return;

  // Clear every notify:seen:* key so the next poll treats current content as
  // the baseline (init path in diffModule) and the user doesn't see a flood of
  // false "new" items carried over from the buggy fingerprint.
  const keys = await listStorageKeys();
  const stale = keys.filter((k) => k.startsWith(NOTIFY_SEEN_PREFIX));
  if (stale.length > 0) await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({
    [NOTIFY_MIGRATION_KEY]: { version: NOTIFY_MIGRATION_VERSION },
    [NOTIFY_STATE_KEY]: {
      signedIn: false,
      counts: { ...Notify.EMPTY_COUNTS },
      lastPolledAt: null,
      lastErrors: {},
    } satisfies Notify.NotifyState,
  });
}

async function handleMessage(message: RsiMessage): Promise<RsiMessageResult<RsiMessage>> {
  try {
    switch (message.type) {
      case 'auth.identity':
        return { ok: true, data: await handleIdentity(message.force ?? false) };
      case 'commlink.list':
        return { ok: true, data: await handleCommLinkList(message) };
      case 'ships.list':
        return { ok: true, data: await handleShipsList(message.force ?? false) };
      case 'contacts.list':
        return { ok: true, data: await handleContactsList(message.force ?? false) };
      case 'contacts.search':
        return { ok: true, data: await handleContactsSearch(message.query) };
      case 'contacts.action':
        return { ok: true, data: await handleContactsAction(message.action, message.id) };
      case 'contacts.sendByNickname':
        return { ok: true, data: await handleContactsSendByNickname(message.nickname) };
      case 'contacts.syncToPtu':
        return { ok: true, data: await handleContactsSyncToPtu() };
      case 'orgs.myList':
        return { ok: true, data: await handleOrgsList(message.force ?? false) };
      case 'orgs.invitations':
        return { ok: true, data: await handleOrgsInvitations(message.force ?? false) };
      case 'orgs.applications':
        return { ok: true, data: await handleOrgsApplications(message.force ?? false) };
      case 'orgs.search':
        return { ok: true, data: await handleOrgsSearch(message) };
      case 'orgs.members':
        return { ok: true, data: await handleOrgMembers(message) };
      case 'spectrum.threads':
        return { ok: true, data: await handleSpectrumThreads(message.force ?? false) };
      case 'spectrum.trending':
        return { ok: true, data: await handleSpectrumTrending(message.force ?? false) };
      case 'spectrum.notifications':
        return { ok: true, data: await handleSpectrumNotifications(message.force ?? false) };
      case 'spectrum.markRead':
        return { ok: true, data: await handleSpectrumMarkRead() };
      case 'spectrum.notifMarkRead':
        return {
          ok: true,
          data: await handleSpectrumNotifMarkRead({ notificationId: message.notificationId }),
        };
      case 'spectrum.notifRemove':
        return {
          ok: true,
          data: await handleSpectrumNotifRemove({ notificationId: message.notificationId }),
        };
      case 'spectrum.vote':
        return {
          ok: true,
          data: await handleSpectrumVote({
            entityType: message.entityType,
            entityId: message.entityId,
            action: message.action,
          }),
        };
      case 'spectrum.react':
        return {
          ok: true,
          data: await handleSpectrumReact({
            entityType: message.entityType,
            entityId: message.entityId,
            reactionType: message.reactionType,
            action: message.action,
          }),
        };
      case 'spectrum.subscribe':
        return {
          ok: true,
          data: await handleSpectrumSubscribe({
            entityType: message.entityType,
            entityId: message.entityId,
            level: message.level,
          }),
        };
      case 'spectrum.lobbies':
        return { ok: true, data: await handleSpectrumLobbies(message.force ?? false) };
      case 'spectrum.lobbyMessages':
        return {
          ok: true,
          data: await handleSpectrumLobbyMessages({
            lobbyId: message.lobbyId,
            before: message.before,
            after: message.after,
            size: message.size,
            force: message.force ?? false,
          }),
        };
      case 'spectrum.search':
        return {
          ok: true,
          data: await handleSpectrumSearch({
            text: message.text,
            communityId: message.communityId,
          }),
        };
      case 'spectrum.emojis':
        return {
          ok: true,
          data: await handleSpectrumEmojis({
            communityId: message.communityId,
            force: message.force ?? false,
          }),
        };
      case 'spectrum.communities':
        return { ok: true, data: await handleSpectrumCommunities(message.force ?? false) };
      case 'spectrum.bookmarks':
        return { ok: true, data: await handleSpectrumBookmarks(message.force ?? false) };
      case 'spectrum.threadDetail':
        return {
          ok: true,
          data: await handleSpectrumThreadDetail({
            slug: message.slug,
            sort: message.sort,
            force: message.force ?? false,
          }),
        };
      case 'spectrum.bookmarkAdd':
        return {
          ok: true,
          data: await handleSpectrumBookmarkAdd({
            entityId: message.entityId,
            entityType: message.entityType,
          }),
        };
      case 'spectrum.bookmarkRemove':
        return {
          ok: true,
          data: await handleSpectrumBookmarkRemove({
            entityId: message.entityId,
            entityType: message.entityType,
          }),
        };
      case 'spectrum.forumGroups':
        return {
          ok: true,
          data: await handleSpectrumForumGroups(
            message.communityId ?? 1,
            message.force ?? false,
          ),
        };
      case 'spectrum.forumThreads':
        return {
          ok: true,
          data: await handleSpectrumForumThreads({
            communityId: message.communityId ?? 1,
            channelId: message.channelId,
            sort: message.sort,
            force: message.force ?? false,
          }),
        };
      case 'dashboard.summary':
        return { ok: true, data: await handleDashboardSummary(message.force ?? false) };
      case 'buyback.list':
        return { ok: true, data: await handleBuyBackList(message.page, message.force ?? false) };
      case 'patchnotes.list':
        return { ok: true, data: await handlePatchNotes(message.page, message.force ?? false) };
      case 'pledge.shipList':
        return { ok: true, data: await handlePledgeShipList(message) };
      case 'pledge.shipDetail':
        return { ok: true, data: await handlePledgeShipDetail(message) };
      case 'pledge.browse':
        return { ok: true, data: await handlePledgeBrowse(message) };
      case 'pledge.ccuInit':
        return { ok: true, data: await handleCcuInit(message.force ?? false) };
      case 'pledge.ccuTargets':
        return { ok: true, data: await handleCcuTargets(message) };
      case 'pledge.ccuAddToCart':
        return { ok: true, data: await handleCcuAddToCart(message) };
      case 'pledge.addToCart':
        return { ok: true, data: await handlePledgeAddToCart(message) };
      case 'pledge.removeFromCart':
        return { ok: true, data: await handlePledgeRemoveFromCart(message) };
      case 'pledge.clearCart':
        return { ok: true, data: await handlePledgeClearCart() };
      case 'pledge.cart':
        return { ok: true, data: await handlePledgeCart(message) };
      case 'stats.summary':
        return { ok: true, data: await handleStatsSummary(message.force ?? false) };
      case 'roadmap.data':
        return { ok: true, data: await handleRoadmapData(message.force ?? false) };
      case 'roadmap.snapshot':
        return { ok: true, data: await handleRoadmapSnapshot() };
      case 'roadmap.snapshot.commit':
        return { ok: true, data: await handleRoadmapSnapshotCommit(message) };
      case 'communityHub.list':
        return {
          ok: true,
          data: await handleCommunityHub(
            message.tab ?? 'live',
            {
              sort: message.sort,
              types: message.types,
              tags: message.tags,
            },
            message.force ?? false,
          ),
        };
      case 'galactapedia.list':
        return {
          ok: true,
          data: await handleGalactapedia(
            message.first ?? 30,
            message.skip ?? 0,
            message.search ?? '',
            message.force ?? false,
          ),
        };
      case 'galactapedia.article':
        return {
          ok: true,
          data: await handleGalactapediaArticle(message.id, message.force ?? false),
        };
      case 'galactapedia.home':
        return {
          ok: true,
          data: await handleGalactapediaHome(message.force ?? false),
        };
      case 'galactapedia.random':
        return {
          ok: true,
          data: await handleGalactapediaRandom(message),
        };
      case 'galactapedia.categories':
        return {
          ok: true,
          data: await handleGalactapediaCategories(message.force ?? false),
        };
      case 'galactapedia.tags':
        return {
          ok: true,
          data: await handleGalactapediaTags(message.force ?? false),
        };
      case 'galactapedia.index':
        return {
          ok: true,
          data: await handleGalactapediaIndex(message.force ?? false),
        };
      case 'galactapedia.indexCached':
        return { ok: true, data: await handleGalactapediaIndexCached() };
      case 'galactapedia.indexPage':
        return {
          ok: true,
          data: await handleGalactapediaIndexPage(message.skip),
        };
      case 'galactapedia.indexCommit':
        return {
          ok: true,
          data: await handleGalactapediaIndexCommit(message.articles),
        };
      case 'galactapedia.indexBootstrap':
        return { ok: true, data: await handleGalactapediaIndexBootstrap() };
      case 'progressTracker.list':
        return { ok: true, data: await handleProgressTracker(message.force ?? false) };
      case 'cache.clear':
        return { ok: true, data: await handleCacheClear(message.prefix) };
      case 'cache.stats':
        return { ok: true, data: await handleCacheStats() };
      case 'cache.entries':
        return { ok: true, data: await handleCacheEntries(message.namespace) };
      case 'settings.sessionStatus':
        return { ok: true, data: await handleSettingsSessionStatus() };
      case 'settings.logs':
        return { ok: true, data: await handleSettingsLogs() };
      case 'settings.permissions':
        return { ok: true, data: await handleSettingsPermissions() };
      case 'settings.prefetchStats':
        return { ok: true, data: handleSettingsPrefetchStats() };
      case 'settings.recordPrefetch':
        return { ok: true, data: handleSettingsRecordPrefetch(message) };
      case 'settings.primeCcu':
        return { ok: true, data: await handleSettingsPrimeCcu() };
      case 'settings.refreshAll':
        return { ok: true, data: await handleSettingsRefreshAll() };
      case 'status.summary':
        return { ok: true, data: await handleStatusSummary(message.force ?? false) };
      case 'notify.state':
        return { ok: true, data: await notifyStateGet() };
      case 'notify.markSeen':
        return { ok: true, data: await handleNotifyMarkSeen(message.module) };
      case 'notify.poll':
        return { ok: true, data: await pollNotifications() };
      default: {
        const exhaustive: never = message;
        return {
          ok: false,
          error: `Unknown message: ${JSON.stringify(exhaustive)}`,
        };
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const signedIn = e instanceof Rsi.RsiNotAuthenticatedError ? false : undefined;
    return { ok: false, error, signedIn };
  }
}

// Keys whose cached values depend on the RSI session. When the Rsi-Token
// cookie is set, changed, or removed (user signs in or out), every entry for
// one of these prefixes is wiped so the next fetch sees the new auth state.
// The `auth:identity` key is singular; the rest can have multiple variants
// (e.g. `ships:list:public`, `orgs:members:SID`), hence prefix matching.
const AUTH_DEPENDENT_CACHE_PREFIXES = [
  'auth:identity',
  'ships:list',
  'contacts:list',
  'orgs:list',
  'orgs:invitations',
  'orgs:applications',
  'orgs:members:',
  // CCU owned-flag is user-specific; ccuTargets' route list depends on
  // what the user has in their hangar too. Wipe both on sign-in/out.
  'pledge:ccuInit',
  'pledge:ccuTargets:',
  // Cart is per-account — signing in or out flips it completely (empty
  // or someone else's previous guest cart). Must drop with the auth flip.
  'pledge:cart',
  'dashboard:summary',
  'buyback:list:',
  'stats:summary',
  'spectrum:notifications',
  'spectrum:threads',
  'spectrum:trending',
  'spectrum:lobbies',
];

async function wipeAuthDependentCache(): Promise<void> {
  const allKeys = await listStorageKeys();
  const keys = allKeys.filter((k) => {
    if (!k.startsWith(CACHE_PREFIX)) return false;
    const bare = k.slice(CACHE_PREFIX.length);
    return AUTH_DEPENDENT_CACHE_PREFIXES.some((p) =>
      p.endsWith(':') ? bare.startsWith(p) : bare === p,
    );
  });
  if (keys.length > 0) await chrome.storage.local.remove(keys);
}

export default defineBackground(() => {
  // Long-lived port for the Sync LIVE → PTU streaming handler. Lets
  // the popup render progress live instead of waiting on a 30-second
  // sendMessage. See packages/shared/src/contacts-sync-stream.ts.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === CONTACTS_SYNC_TO_PTU_PORT) {
      void handleContactsSyncToPtuStream(port);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      sendResponse({ ok: false, error: 'Invalid message' });
      return false;
    }
    const msgType = (message as { type: string }).type;
    // Defensive catch: handleMessage has its own try/catch around the
    // switch but anything that escapes it (a synchronous throw before
    // the try-block is set up, an unhandled rejection in dedupe(),
    // a chrome.* API throwing on Firefox MV2 we missed) would leave
    // the message channel open until the popup gives up — that's the
    // "No response from background worker" we kept seeing on FF.
    let responded = false;
    const respond = (res: unknown) => {
      if (responded) return;
      responded = true;
      try {
        sendResponse(res);
      } catch (e) {
        // sendResponse can throw on Firefox MV2 if the channel was
        // already closed (e.g. popup unmounted before we resolved).
        // Nothing we can do at that point — surface in BG logs only.
        log.warn('msg', `sendResponse for ${msgType} failed`, e);
      }
    };
    handleMessage(message as RsiMessage)
      .then(respond)
      .catch((e) => {
        const error = e instanceof Error ? e.message : String(e);
        log.error('msg', `${msgType} threw before/after handleMessage`, e);
        respond({ ok: false, error });
      });
    return true;
  });

  // When the RSI session cookie flips (sign-in, sign-out, or rotation), drop
  // every auth-dependent cache entry so the popup sees fresh state on its next
  // open instead of serving stale `signedIn: false` (or vice versa) until the
  // per-module TTL expires. We also kick a notifications poll so the badge
  // updates right away.
  chrome.cookies.onChanged.addListener((change) => {
    if (change.cookie.name !== RSI_COOKIE_LIVE) return;
    // Exact-match the RSI domain. Using `.includes()` would also fire for
    // any attacker-controlled hostname that happened to contain the string
    // (e.g. `evilrobertsspaceindustries.com` or `robertsspaceindustries.com.evil.tld`).
    // Chrome's cookie domain field is either `robertsspaceindustries.com`
    // or `.robertsspaceindustries.com` for a cookie scoped to the apex +
    // subdomains, so we accept both of those shapes and anything that ends
    // in the dotted parent.
    const domain = change.cookie.domain;
    const isRsiDomain =
      domain === 'robertsspaceindustries.com' ||
      domain === '.robertsspaceindustries.com' ||
      domain.endsWith('.robertsspaceindustries.com');
    if (!isRsiDomain) return;
    // Drop in-memory caches synchronously so the next identify/token read hits
    // the server with the new cookie state. The identify memo (15 s TTL) and
    // the token memo (5 s TTL) would otherwise keep serving pre-change values
    // for up to their respective TTLs.
    Rsi.invalidateIdentifyCache();
    Rsi.invalidateTokenCache();
    Rsi.invalidateCsrfToken();
    Rsi.invalidateCcuSession();
    wipeAuthDependentCache()
      .then(() => pollNotifications().catch((e: unknown) => log.warn('cookies', 'poll after wipe failed', e)))
      .catch((e: unknown) => log.warn('cookies', 'wipeAuthDependentCache failed', e));
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === FAST_POLL_ALARM) {
      pollNotifications('fast').catch((e: unknown) =>
        log.warn('alarm', 'fast poll failed', e),
      );
    } else if (alarm.name === SLOW_POLL_ALARM) {
      pollNotifications('slow').catch((e: unknown) =>
        log.warn('alarm', 'slow poll failed', e),
      );
    }
  });

  // Boot flow shared between fresh install, browser restart, and SW wake.
  // Any failure is logged — silent `.catch(() => {})` previously made
  // broken migrations invisible until the user reported downstream bugs.
  const boot = () =>
    Promise.all([
      runNotifyMigration().catch((e: unknown) => log.warn('migration', 'notify migration failed', e)),
      runCacheMigration().catch((e: unknown) => log.warn('migration', 'cache migration failed', e)),
      // Boot-time hygiene — drops cache: entries whose TTL already
      // expired before the SW woke up. Lazy expiry in cacheGet covers
      // re-read keys but a paginated/abandoned key (commlink page 7
      // the user visited once last week) never gets re-read and
      // accumulates disk space forever. Cheap on first run.
      pruneExpiredCacheEntries().catch((e: unknown) => log.warn('cache', 'prune failed', e)),
    ]).finally(() => {
      ensurePollAlarms().catch((e: unknown) => log.warn('boot', 'ensurePollAlarms failed', e));
    });

  chrome.runtime.onStartup.addListener(() => {
    void boot().then(() =>
      pollNotifications().catch((e: unknown) => log.warn('boot.startup', 'poll failed', e)),
    );
  });
  chrome.runtime.onInstalled.addListener(() => {
    void boot().then(() =>
      pollNotifications().catch((e: unknown) => log.warn('boot.installed', 'poll failed', e)),
    );
  });

  // On SW wake: make sure alarm + badge reflect stored state, even if events fired before listeners attached.
  void boot().then(() =>
    notifyStateGet()
      .then((s) => updateBadge(s))
      .catch((e: unknown) => log.warn('boot.wake', 'badge update failed', e)),
  );
});
