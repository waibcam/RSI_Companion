// RSI session / identity helpers. The background worker owns these — they read
// the user's Rsi-Token cookie and resolve it to a handle via the spectrum
// identify API.
//
// The "token" is required as BOTH `x-rsi-token` AND `x-tavern-id` headers on
// POST API calls. For HTML pages under /account/*, Chrome forwards the cookie
// automatically as long as the extension has host_permissions + we pass
// credentials: 'include'.
//
// `identifyFull` is the single source of truth: the /api/spectrum/auth/identify
// response carries the member, friend list AND spectrum communities — so
// contacts, spectrum channels and the basic "am I signed in" question all
// resolve from the same call.

import { z } from 'zod';
import {
  RSI_BASE_URL,
  RSI_COOKIE_LIVE,
  RSI_COOKIE_PTU,
  RSI_PTU_BASE_URL,
} from '../constants.js';
import { fetchWithTimeout } from '../net.js';

export const RsiIdentity = z.object({
  id: z.number().int().nullable(),
  handle: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
});
export type RsiIdentity = z.infer<typeof RsiIdentity>;

const Friend = z.object({
  nickname: z.string().default(''),
  displayname: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
});

// Friend requests in either direction.
// `type` is 'in' (received, can accept/decline) or 'out' (sent, can cancel).
const FriendRequest = z
  .object({
    id: z.coerce.number().int(),
    type: z.string().default(''),
    status: z.string().nullable().optional(),
    time_modified: z.coerce.number().int().default(0),
    requesting_member_id: z.coerce.number().int().nullable().optional(),
    member: z
      .object({
        id: z.coerce.number().int().optional(),
        nickname: z.string().default(''),
        displayname: z.string().nullable().optional(),
        avatar: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    members: z
      .array(
        z.object({
          id: z.coerce.number().int().optional(),
          nickname: z.string().default(''),
          displayname: z.string().nullable().optional(),
          avatar: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

// Native Spectrum notification — rich structured shape with text_tokens that
// templating expands into the human-readable line. We preserve the raw
// payload via passthrough so type-specific renderers can reach any token.
const RawNotification = z
  .object({
    id: z.union([z.string(), z.number()]).transform((v) => String(v)),
    type: z.string().default(''),
    time: z.coerce.number().int().default(0),
    time_created: z.coerce.number().int().default(0),
    grouped: z.coerce.boolean().default(false),
    unread: z.union([z.boolean(), z.number(), z.string()]).optional(),
    thumbnail: z.string().nullable().optional(),
    text_tokens: z.record(z.string(), z.unknown()).nullable().optional(),
    link_tokens: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

const LobbyMember = z.object({
  id: z.coerce.number().int(),
  nickname: z.string().default(''),
  displayname: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
});

const LobbyMessage = z
  .object({
    member_id: z.coerce.number().int().nullable().optional(),
    time_created: z.coerce.number().int().default(0),
    time_modified: z.coerce.number().int().default(0),
    plaintext: z.string().default(''),
  })
  .passthrough();

const PrivateLobby = z
  .object({
    id: z.coerce.number().int(),
    // `name` is null for 1:1 DMs (RSI derives the title from the other member).
    name: z.string().nullable().optional().transform((v) => v ?? ''),
    time_modified: z.coerce.number().int().default(0),
    new_messages: z.coerce.number().int().default(0),
    members: z.array(LobbyMember).default([]),
    last_message: LobbyMessage.nullable().optional(),
  })
  .passthrough();

// RSI sometimes returns collections as an object keyed by id (e.g. `{ "1": {…} }`)
// instead of an array, and when the session is effectively empty (stale cookie,
// no active identity) it returns plain `null` for friends / friend_requests /
// private_lobbies / etc. This preprocess normalizes all three shapes to an array
// so a null field doesn't fail the whole identify parse.
const arrayOrRecord = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess(
    (v) => {
      if (v == null) return [];
      if (Array.isArray(v)) return v;
      if (typeof v === 'object') return Object.values(v as Record<string, unknown>);
      return v;
    },
    z.array(inner).default([]),
  );

const Channel = z.object({
  id: z.coerce.number().int(),
  name: z.string().default(''),
  // RSI started returning `null` for some channel colors on community
  // forum_channel_groups other than SC proper (see GH #25). Accept null
  // and coerce to '' so downstream stays with the simpler `color: string`
  // type and doesn't need null-guards all over the Spectrum module.
  color: z
    .string()
    .nullable()
    .default('')
    .transform((v) => v ?? ''),
  slug: z.string().default(''),
  // Forums-tab metadata (Phase 2). All optional in the wire format —
  // older identify responses may not include them, especially for
  // org communities that haven't been migrated to the new shape.
  description: z
    .string()
    .nullable()
    .default('')
    .transform((v) => v ?? ''),
  threads_count: z.coerce.number().int().default(0),
  // Per-channel notification level for the current user. Server
  // returns 'all' when watching, 'disabled' when off; older versions
  // can also return 'mentions' / 'highlights'. Optional because not
  // every identify shape has shipped this field for org channels.
  notification_subscription: z
    .string()
    .nullable()
    .default('disabled')
    .transform((v) => v ?? 'disabled'),
});

const ChannelGroup = z.object({
  id: z.coerce.number().int(),
  name: z.string().default(''),
  channels: arrayOrRecord(Channel),
});

const Community = z.object({
  id: z.coerce.number().int(),
  slug: z.string(),
  name: z.string().default(''),
  forum_channel_groups: arrayOrRecord(ChannelGroup),
});

const IdentifyResponse = z.object({
  success: z.number().int(),
  data: z
    .object({
      member: z
        .object({
          id: z.coerce.number().int().optional(),
          nickname: z.string(),
          displayname: z.string().nullable().optional(),
          avatar: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      friends: arrayOrRecord(Friend),
      friend_requests: arrayOrRecord(FriendRequest),
      communities: arrayOrRecord(Community),
      notifications: arrayOrRecord(RawNotification),
      private_lobbies: arrayOrRecord(PrivateLobby),
      notifications_unread: z.coerce.number().int().default(0),
    })
    .nullable()
    .optional(),
});

export type IdentifyData = NonNullable<z.infer<typeof IdentifyResponse>['data']>;

export class RsiNotAuthenticatedError extends Error {
  constructor(message = 'Not signed in to robertsspaceindustries.com') {
    super(message);
    this.name = 'RsiNotAuthenticatedError';
  }
}

// Short in-memory memo + in-flight dedup for identifyFull().
//
// A single popup open on the Spectrum tab fans out to threads/trending/notifs/
// lobbies + contacts + identity, and each of those paths historically called
// identifyFull() independently — so one popup open could fire 4-5 concurrent
// /api/spectrum/auth/identify requests, with the poll alarm adding another 3
// every 10 minutes. This memo collapses them to one HTTP call per 15 s window,
// and any concurrent callers share the in-flight Promise.
//
// The TTL is intentionally short: identify carries live state (friend requests,
// unread DMs, notifications) that users expect to be fresh. 15 s is long enough
// to cover a single popup's fan-out burst without staling the data.
//
// Invalidation: the background worker wipes this on `chrome.cookies.onChanged`
// via invalidateIdentifyCache() so sign-in/out is reflected immediately.
const IDENTIFY_MEMO_TTL_MS = 15_000;
let identifyCache: { data: IdentifyData | null; expiresAt: number } | null = null;
let identifyInFlight: Promise<IdentifyData | null> | null = null;

export function invalidateIdentifyCache(): void {
  identifyCache = null;
  identifyInFlight = null;
}

/**
 * Throws on a non-ok RSI response. 401/403 becomes `RsiNotAuthenticatedError`
 * so handler catch sites can map the error to `signedIn: false`; everything
 * else becomes a generic Error.
 *
 * Call this instead of `if (!response.ok) throw new Error(...)` for any RSI
 * endpoint that requires authentication — that way a stale Rsi-Token cookie
 * (session invalidated server-side but still present in the browser) is
 * reported as "not signed in" rather than a noisy 401 message.
 */
export function assertRsiOk(response: Response, label: string): void {
  if (response.ok) return;
  if (response.status === 401 || response.status === 403) {
    throw new RsiNotAuthenticatedError();
  }
  throw new Error(`${label} returned ${response.status}`);
}

const LOGIN_URL_PATTERN = /\/(connect|sign-?in|login)(\/|\?|#|$)/i;

/**
 * HTML pages under /account/* don't return 401 when the session is stale —
 * RSI issues a 302 to the sign-in page, which the browser fetch silently
 * follows. Call this after `assertRsiOk` on auth-required HTML endpoints to
 * detect the redirect and throw `RsiNotAuthenticatedError` accordingly.
 *
 * Checks `response.url` directly (not just `response.redirected`) because
 * the flag isn't always set depending on the redirect chain.
 */
export function assertRsiNotRedirectedToLogin(response: Response): void {
  if (LOGIN_URL_PATTERN.test(response.url)) {
    throw new RsiNotAuthenticatedError();
  }
}

/**
 * HTML signature detection for the RSI sign-in page. RSI sometimes serves
 * the login page body with a 200 at the original URL (no visible redirect).
 * Call this with the response text on auth-required HTML endpoints.
 */
export function assertRsiHtmlNotLogin(html: string): void {
  // Distinct signin-form markers: the RSI login form posts to /api/account/signin
  // and the page body has a rsi-connect / rsi-login wrapper class.
  if (/\/api\/account\/signin/i.test(html)) {
    throw new RsiNotAuthenticatedError();
  }
  if (/<body[^>]*class="[^"]*(rsi-connect|rsi-login|sign-in-page|signin-page)/i.test(html)) {
    throw new RsiNotAuthenticatedError();
  }
}

// Short memo for the Rsi-Token cookie read. Nearly every handler starts with
// readRsiToken() to gate signed-in paths, so a single popup open can easily
// fire 5+ chrome.cookies.get calls. Cookie state changes drive onChanged
// events that the background worker uses to wipe both this memo and the
// identify cache in lockstep, so a 5 s TTL is just insurance against the
// (rare) case the listener hasn't attached yet.
const TOKEN_MEMO_TTL_MS = 5_000;
let tokenCache: { value: string | null; expiresAt: number } | null = null;

export function invalidateTokenCache(): void {
  tokenCache = null;
}

// --- CSRF token ----------------------------------------------------------
//
// A handful of RSI endpoints (most notably `/pledge-store/api/upgrade/graphql`
// — the CCU upgrade graph) require an `x-csrf-token` header on top of the
// session cookie. The token is embedded as `<meta name="csrf-token">` in
// every RSI HTML page and is per-session (stable for the duration of the
// cookie's lifetime). We fetch it lazily the first time a CCU call runs
// and cache it in memory for the SW's lifetime. On a 403 the caller can
// call `invalidateCsrfToken()` to force a refresh on the next read.

// Attribute order in the `<meta>` tag isn't stable across RSI page
// templates — sometimes `name="csrf-token"` comes first, sometimes
// `content="…"` does. Two regexes cover both orderings.
const CSRF_META_REGEXES: readonly RegExp[] = [
  /<meta[^>]+?name=["']csrf-token["'][^>]+?content=["']([^"']+)["']/i,
  /<meta[^>]+?content=["']([^"']+)["'][^>]+?name=["']csrf-token["']/i,
];

// Candidate pages to scrape the CSRF meta from, in preference order.
// `/en/pledge` used to be reliable but started rendering SPA-only (no
// server-side meta) intermittently. `/account/pledges` is rock-solid
// for signed-in users (Hangar is a Rails-rendered page); `/` works
// anonymously. We try each in order until one returns a meta tag.
const CSRF_PAGES: readonly string[] = [
  '/account/pledges',
  '/en/pledge',
  '/en/account/pledges',
  '/',
];

function extractCsrf(html: string): string | null {
  for (const re of CSRF_META_REGEXES) {
    const match = re.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

let csrfToken: string | null = null;
let csrfInFlight: Promise<string | null> | null = null;

export function invalidateCsrfToken(): void {
  csrfToken = null;
  csrfInFlight = null;
}

/** Imperatively seed the CSRF token cache. Called from the background
 *  when it reads the token from an already-open RSI tab via
 *  `chrome.scripting.executeScript` — skips the HTML scrape entirely and
 *  gets the real session token the SPA is already using. Pass null to
 *  clear the cache (equivalent to invalidateCsrfToken). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
  csrfInFlight = null;
}

/** Return the currently-cached CSRF token without triggering a fetch.
 *  Useful for the background handler to avoid double-scraping when it
 *  already primed via chrome.scripting. */
export function getCachedCsrfToken(): string | null {
  return csrfToken;
}

/**
 * Fetch the current session's CSRF token from a RSI page's `<meta>` tag.
 * Tries several pages in turn — any single page can drop the tag during
 * SPA migrations, so a fallback list keeps the CCU tool working even if
 * one template stops rendering server-side. Returns null when every
 * candidate page fails to yield a token.
 */
export async function fetchRsiCsrfToken(): Promise<string | null> {
  if (csrfToken) return csrfToken;
  if (csrfInFlight) return csrfInFlight;
  csrfInFlight = (async () => {
    try {
      for (const path of CSRF_PAGES) {
        try {
          const response = await fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
            method: 'GET',
            credentials: 'include',
            headers: { Accept: 'text/html' },
          });
          if (!response.ok) continue;
          const html = await response.text();
          const token = extractCsrf(html);
          if (token) {
            csrfToken = token;
            return token;
          }
        } catch {
          // Try the next page
        }
      }
      return null;
    } finally {
      csrfInFlight = null;
    }
  })();
  return csrfInFlight;
}

export async function readRsiToken(): Promise<string | null> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now) return tokenCache.value;
  const cookie = await chrome.cookies.get({
    url: RSI_BASE_URL,
    name: RSI_COOKIE_LIVE,
  });
  const value = cookie?.value ?? null;
  tokenCache = { value, expiresAt: now + TOKEN_MEMO_TTL_MS };
  return value;
}

async function identifyFullUncached(): Promise<IdentifyData | null> {
  const token = await readRsiToken();
  if (!token) return null;

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/auth/identify`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify({}),
  });
  // Stale Rsi-Token cookie: server rejects with 401/403 — treat same as "no
  // cookie" so the caller sees `signedIn: false` rather than a raw error.
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`identify returned ${response.status}`);
  }

  const raw = (await response.json()) as unknown;
  const parsed = IdentifyResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`identify response invalid: ${parsed.error.message}`);
  }
  if (parsed.data.success !== 1) return null;
  const data = parsed.data.data ?? null;
  // success:1 with no member = stale cookie / logged-out session. RSI still
  // populates public communities but there's no identity attached — treat as
  // not signed in so callers surface `signedIn: false` consistently.
  if (!data?.member?.nickname) return null;
  return data;
}

/**
 * Cached + deduplicated /api/spectrum/auth/identify call. Returns the parsed
 * `data` object or null if the token is missing or the response indicates
 * failure.
 *
 * Pass `forceFresh: true` to bypass the in-memory memo (e.g. when the caller
 * has already decided a fresh identify is required, like a manual refresh).
 */
export async function identifyFull(
  options: { forceFresh?: boolean } = {},
): Promise<IdentifyData | null> {
  const now = Date.now();
  if (!options.forceFresh) {
    if (identifyCache && identifyCache.expiresAt > now) {
      return identifyCache.data;
    }
    if (identifyInFlight) return identifyInFlight;
  }

  const promise = (async () => {
    try {
      const data = await identifyFullUncached();
      identifyCache = { data, expiresAt: Date.now() + IDENTIFY_MEMO_TTL_MS };
      return data;
    } finally {
      identifyInFlight = null;
    }
  })();
  identifyInFlight = promise;
  return promise;
}

export async function identifyRsi(
  options: { forceFresh?: boolean } = {},
): Promise<RsiIdentity | null> {
  const data = await identifyFull(options);
  const member = data?.member;
  if (!member) return null;
  return {
    id: member.id ?? null,
    handle: member.nickname,
    displayName: member.displayname ?? member.nickname,
    avatarUrl: member.avatar ?? null,
  };
}

export async function requireToken(): Promise<string> {
  const token = await readRsiToken();
  if (!token) throw new RsiNotAuthenticatedError();
  return token;
}

// --- PTU parallel helpers -------------------------------------------------
//
// The PTU (Public Test Universe) site is a separate deployment at
// ptu.cloudimperiumgames.com with its own `Rsi-PTU-Token` cookie and
// `x-rsi-ptu-token` header. Its spectrum API mirrors the LIVE paths
// 1:1 — identify, search, friend-request/create all accept identical
// payloads. Kept as standalone functions (vs. adding an `env` param to
// readRsiToken / identifyFull / etc.) so the many LIVE call sites don't
// need to change and the PTU-only code path stays opt-in.
//
// Unlike the LIVE helpers there's no caching here — PTU contact sync
// is a rare, user-triggered action, so fetching fresh state every
// time is correct and simpler.

export async function readPtuToken(): Promise<string | null> {
  const cookie = await chrome.cookies.get({
    url: RSI_PTU_BASE_URL,
    name: RSI_COOKIE_PTU,
  });
  return cookie?.value ?? null;
}

export async function identifyPtu(): Promise<IdentifyData | null> {
  const token = await readPtuToken();
  if (!token) return null;
  const response = await fetchWithTimeout(`${RSI_PTU_BASE_URL}/api/spectrum/auth/identify`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-ptu-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify({}),
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`PTU identify returned ${response.status}`);
  }
  const raw = (await response.json()) as unknown;
  const parsed = IdentifyResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`PTU identify response invalid: ${parsed.error.message}`);
  }
  if (parsed.data.success !== 1 || !parsed.data.data) return null;
  return parsed.data.data;
}

export async function requirePtuToken(): Promise<string> {
  const token = await readPtuToken();
  if (!token) throw new RsiNotAuthenticatedError();
  return token;
}
