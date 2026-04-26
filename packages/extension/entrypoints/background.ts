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

import {
  LOANERS,
  Notify,
  RELEASE_NOTES,
  RSI_BASE_URL,
  RSI_COOKIE_LIVE,
  Rsi,
  Schemas,
  SHIP_NAME_CATALOG,
  fetchWithTimeout,
  log,
  type ContactsSyncToPtuEntry,
  type ContactsSyncToPtuResponsePayload,
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
  'ships:list': 2,
  'contacts:list': 1,
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
  'spectrum:threads': 1,
  'spectrum:trending': 1,
  'spectrum:notifications': 1,
  'spectrum:lobbies': 1,
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

// --- handlers -------------------------------------------------------------

async function handleIdentity(force: boolean) {
  const key = 'auth:identity';
  if (!force) {
    const cached = await cacheGet<{ identity: Rsi.RsiIdentity | null; fetchedAt: number }>(key);
    if (cached) {
      return {
        identity: cached.identity,
        signedIn: cached.identity !== null,
        fetchedAt: cached.fetchedAt,
        fromCache: true,
      };
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
    const cached = await cacheGet<{
      articles: Rsi.CommLinkArticle[];
      options: Rsi.CommLinkFormOptions;
      fetchedAt: number;
    }>(key);
    if (cached) {
      return {
        page: params.page ?? 1,
        articles: cached.articles,
        options: cached.options,
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
    const cached = await cacheGet<{
      ships: Rsi.Ship[];
      loanerIds: number[];
      ownedCount: number;
      notFound: string[];
      rawHangarNames: string[];
      fetchedAt: number;
    }>(key);
    if (cached) {
      return {
        ...cached,
        // Old cache entries written before rawHangarNames was added
        // lack the field. Defaulting here keeps the popup happy on
        // the first load after an update.
        rawHangarNames: cached.rawHangarNames ?? [],
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
    const cached = await cacheGet<{
      contacts: Rsi.Contact[];
      incoming: Rsi.ContactRequest[];
      outgoing: Rsi.ContactRequest[];
      fetchedAt: number;
    }>(key);
    if (cached) {
      return { ...cached, signedIn: true, fromCache: true };
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

// Sync LIVE → PTU. Fans out up to N friend requests against the PTU
// spectrum API; uses a small concurrency window to keep the wall-clock
// reasonable without DDOSing the endpoint (5 parallel searches + sends
// runs ~50 contacts in under 10s in practice).
const PTU_SYNC_CONCURRENCY = 5;

async function handleContactsSyncToPtu(): Promise<
  ContactsSyncToPtuResponsePayload
> {
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
  for (const f of liveBundle.contacts) {
    const nick = f.nickname.toLowerCase();
    const base = {
      nickname: f.nickname,
      displayName: f.displayname || f.nickname,
      avatar: f.avatar || '',
    };
    if (ptuFriends.has(nick)) {
      entries.push({ ...base, status: 'alreadyFriend' });
    } else if (ptuOutgoing.has(nick)) {
      entries.push({ ...base, status: 'alreadyPending' });
    } else {
      toAdd.push(base);
    }
  }

  // Step 3 — for each LIVE friend missing on PTU, autocomplete the
  // nickname on PTU to resolve its member id, then fire the friend
  // request. Bounded concurrency so a 100-friend list doesn't launch
  // 200 simultaneous requests.
  async function addOne(p: Pending): Promise<ContactsSyncToPtuEntry> {
    try {
      const hits = await Rsi.searchPtuMembers(p.nickname);
      const needle = p.nickname.toLowerCase();
      const exact = hits.find((h) => h.nickname.toLowerCase() === needle);
      if (!exact) return { ...p, status: 'notFound' };
      await Rsi.sendPtuFriendRequest(exact.id);
      return { ...p, status: 'added' };
    } catch (e) {
      return { ...p, status: 'error', error: (e as Error).message ?? 'unknown' };
    }
  }

  // Simple fixed-pool concurrency — pull work off a shared queue index.
  let cursor = 0;
  const workers: Promise<void>[] = [];
  const addedEntries: ContactsSyncToPtuEntry[] = [];
  for (let i = 0; i < Math.min(PTU_SYNC_CONCURRENCY, toAdd.length); i++) {
    workers.push(
      (async () => {
        while (true) {
          const next = cursor++;
          if (next >= toAdd.length) return;
          const entry = await addOne(toAdd[next]!);
          addedEntries.push(entry);
        }
      })(),
    );
  }
  await Promise.all(workers);
  entries.push(...addedEntries);

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
    const cached = await cacheGet<{
      crowdfund: Rsi.CrowdfundStats;
      referral: Rsi.ReferralStats | null;
      buyBackTokens: number | null;
      fetchedAt: number;
    }>(key);
    if (cached) {
      return { ...cached, signedIn: token !== null, fromCache: true };
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
  if (!force) {
    const cached = await cacheGet<{
      articles: Rsi.GalactapediaArticle[];
      fetchedAt: number;
    }>(GALACTAPEDIA_INDEX_KEY);
    if (cached) return { ...cached, fromCache: true };
  }
  const articles = await Rsi.fetchGalactapediaIndex();
  const fetchedAt = Date.now();
  await cacheSet(GALACTAPEDIA_INDEX_KEY, { articles, fetchedAt }, TTL.galactapediaIndex);
  return { articles, fetchedAt, fromCache: false };
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
  const key = 'roadmap:data';
  if (!force) {
    const cached = await cacheGet<{
      data: Schemas.Backend.RoadmapPayload;
      meta: Schemas.Backend.RoadmapMeta;
      fetchedAt: number;
    }>(key);
    if (cached) return { ...cached, fromCache: true };
  }
  return dedupe(key, async () => {
    const { data, snapshotTs, fetchedAt } = await Rsi.fetchRsiRoadmap();
    const meta: Schemas.Backend.RoadmapMeta = {
      board_id: 1,
      fetched_at: Math.floor(fetchedAt / 1000),
      snapshot_ts: snapshotTs,
      cached: false,
    };
    const payload = { data, meta, fetchedAt };
    await cacheSet(key, payload, TTL.roadmap);
    return { ...payload, fromCache: false };
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

async function handleCacheStats() {
  // Group cache entries by their top-level namespace (the segment between
  // `cache:` and the first `:`), counting entries and approximating size
  // via `JSON.stringify(value).length`. Not exact bytes — chrome.storage
  // uses its own serialization — but close enough to drive a "where is
  // my quota going" UI.
  const all = await chrome.storage.local.get(null);
  const buckets = new Map<string, { entries: number; sizeBytes: number }>();
  let totalEntries = 0;
  let totalSize = 0;
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(CACHE_PREFIX)) continue;
    if (key.startsWith(CACHE_NAMESPACE_VERSION_PREFIX)) continue;
    const withoutPrefix = key.slice(CACHE_PREFIX.length);
    const ns = withoutPrefix.split(':')[0] ?? 'other';
    const size = JSON.stringify(value).length;
    const b = buckets.get(ns) ?? { entries: 0, sizeBytes: 0 };
    b.entries += 1;
    b.sizeBytes += size;
    buckets.set(ns, b);
    totalEntries += 1;
    totalSize += size;
  }
  const namespaces = [...buckets.entries()]
    .map(([prefix, v]) => ({ prefix, ...v }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  return {
    total: { entries: totalEntries, sizeBytes: totalSize },
    namespaces,
  };
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
    const threads = await Rsi.fetchHighlightedThreads(token);
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
  const out: string[] = [];

  try {
    const threads = await Rsi.fetchHighlightedThreads(token);
    for (const t of threads) out.push(`thread-${t.id}`);
  } catch (e) {
    log.warn('notify', 'collectSpectrumIds: highlighted threads failed', e);
  }

  try {
    const lobbies = await Rsi.fetchSpectrumLobbies();
    for (const l of lobbies) {
      if (l.newMessages > 0) out.push(`dm-${l.id}-${l.lastMessageAt}`);
    }
  } catch (e) {
    log.warn('notify', 'collectSpectrumIds: lobbies failed', e);
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
  } catch (e) {
    log.warn('notify', 'collectSpectrumIds: notifications failed', e);
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
      };
      await notifyStateSet(next);
      return next;
    }

    const counts: Notify.NotifyCounts = { ...prev.counts };
    // Carry over errors only for modules NOT in scope — an in-scope module's
    // success or failure replaces its prior entry so stale errors don't linger
    // after a transient failure recovers.
    const lastErrors: Notify.NotifyErrors = { ...prev.lastErrors };
    const modules = modulesForScope(scope);

    const tasks: Array<Promise<void>> = [];
    const run = (m: Notify.NotifyModule, collector: () => Promise<string[]>): void => {
      if (!modules.has(m)) return;
      // Clear any prior error for this module — we either succeed (stays clear)
      // or fail and set a fresh one.
      delete lastErrors[m];
      tasks.push(
        diffModule(m, collector)
          .then((n) => {
            counts[m] = n;
          })
          .catch((e: unknown) => {
            lastErrors[m] = e instanceof Error ? e.message : String(e);
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
      case 'spectrum.lobbies':
        return { ok: true, data: await handleSpectrumLobbies(message.force ?? false) };
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
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object' || !('type' in message)) {
      sendResponse({ ok: false, error: 'Invalid message' });
      return false;
    }
    handleMessage(message as RsiMessage).then(sendResponse);
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
