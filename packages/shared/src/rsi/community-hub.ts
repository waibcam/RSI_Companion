// Community Hub lives at /community-hub and is a Next.js app. Its SSR embeds
// needed data in a <script id="__NEXT_DATA__"> tag, so we parse that blob
// directly for the Live and Discover-style tabs.
//
// Events are not SSR'd — the /community-hub/events page ships only an
// apolloToken in pageProps and fetches its data client-side against
// /community-hub/api/v1/graphql. We reuse that token ourselves.

import { parseHTML } from 'linkedom';
import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';

// ---------- Live tab (home page) ---------------------------------------------

const Account = z
  .object({
    displayName: z.string().default(''),
    nickname: z.string().default(''),
    thumbnailUrl: z.string().nullable().optional(),
    live: z.boolean().default(false),
  })
  .passthrough();

const LivePost = z
  .object({
    __typename: z.string().default('Live'),
    uid: z.string().default(''),
    type: z.string().default('live'),
    title: z.string().default(''),
    summary: z.string().default(''),
    slug: z.string().default(''),
    thumbnailUrl: z.string().nullable().optional(),
    membershipUrl: z.string().nullable().optional(),
    viewersCount: z.coerce.number().int().default(0),
    createdAt: z.string().default(''),
    honor: z.string().nullable().optional(),
    account: Account.nullable().optional(),
  })
  .passthrough();

const LiveNextData = z.object({
  props: z
    .object({
      pageProps: z
        .object({
          livePostsFromSSR: z.array(LivePost).default([]),
          followedPostsFromSSR: z.array(LivePost).default([]),
        })
        .partial()
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export interface CommunityHubLivePost {
  uid: string;
  title: string;
  summary: string;
  thumbnailUrl: string | null;
  membershipUrl: string | null;
  viewersCount: number;
  createdAt: string;
  authorDisplayName: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  authorIsLive: boolean;
  honor: string | null;
}

function normalizeLivePost(raw: z.infer<typeof LivePost>): CommunityHubLivePost {
  return {
    uid: raw.uid,
    title: raw.title,
    summary: raw.summary,
    thumbnailUrl: raw.thumbnailUrl ?? null,
    membershipUrl: raw.membershipUrl ?? null,
    viewersCount: raw.viewersCount,
    createdAt: raw.createdAt,
    authorDisplayName: raw.account?.displayName ?? '',
    authorNickname: raw.account?.nickname ?? '',
    authorAvatarUrl: raw.account?.thumbnailUrl ?? null,
    authorIsLive: raw.account?.live ?? false,
    honor: raw.honor ?? null,
  };
}

// ---------- Discover / Gameplay / Tutorial (Apollo state) --------------------

export interface CommunityHubPost {
  uid: string;
  type: string;
  title: string;
  summary: string;
  thumbnailUrl: string | null;
  membershipUrl: string | null;
  url: string;
  createdAt: string;
  votesCount: number;
  commentsCount: number;
  viewsCount: number;
  honor: string | null;
  authorDisplayName: string;
  authorNickname: string;
  authorAvatarUrl: string | null;
  tags: string[];
}

const ApolloRef = z.object({ __ref: z.string() });

const ApolloAccount = z
  .object({
    __typename: z.literal('Account').optional(),
    nickname: z.string().default(''),
    displayName: z.string().nullable().optional(),
    thumbnailUrl: z.string().nullable().optional(),
  })
  .passthrough();

const ApolloTag = z
  .object({
    __typename: z.literal('Tag').optional(),
    uid: z.string().optional(),
    label: z.string().default(''),
    slug: z.string().default(''),
  })
  .passthrough();

const ApolloPost = z
  .object({
    __typename: z.string(),
    uid: z.string(),
    type: z.string().default(''),
    title: z.string().default(''),
    slug: z.string().default(''),
    summary: z.string().default(''),
    thumbnailUrl: z.string().nullable().optional(),
    membershipUrl: z.string().nullable().optional(),
    createdAt: z.string().default(''),
    honor: z.string().nullable().optional(),
    votesCount: z.coerce.number().int().default(0),
    commentsCount: z.coerce.number().int().default(0),
    viewsCount: z.coerce.number().int().default(0),
    account: ApolloRef.nullable().optional(),
    tags: z.array(ApolloRef).default([]),
  })
  .passthrough();

function resolveRef<T>(
  state: Record<string, unknown>,
  ref: string | undefined,
  schema: z.ZodType<T>,
): T | null {
  if (!ref) return null;
  const raw = state[ref];
  if (!raw) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

interface NextData {
  props?: {
    pageProps?: {
      __APOLLO_STATE__?: Record<string, unknown>;
      apolloToken?: string;
    };
  };
}

function readNextData(html: string): NextData {
  const { document } = parseHTML(html);
  const node = document.querySelector('script#__NEXT_DATA__');
  const raw = node?.textContent ?? '';
  if (!raw) throw new Error('Community Hub: __NEXT_DATA__ missing');
  try {
    return JSON.parse(raw) as NextData;
  } catch (e) {
    throw new Error(`Community Hub: __NEXT_DATA__ invalid JSON (${(e as Error).message})`);
  }
}

function readApolloState(html: string): { state: Record<string, unknown>; rootQuery: Record<string, unknown> } {
  const parsed = readNextData(html);
  const state = parsed?.props?.pageProps?.__APOLLO_STATE__ ?? {};
  const rootQuery = (state.ROOT_QUERY as Record<string, unknown> | undefined) ?? {};
  return { state, rootQuery };
}

function extractPosts(
  state: Record<string, unknown>,
  rootQuery: Record<string, unknown>,
): CommunityHubPost[] {
  const postsKey = Object.keys(rootQuery).find((k) => k.startsWith('posts('));
  if (!postsKey) return [];
  const aggregated = rootQuery[postsKey] as { metaData?: Array<{ __ref?: string }> } | undefined;
  const refs = aggregated?.metaData ?? [];

  return refs
    .map((r) => resolveRef(state, r.__ref, ApolloPost))
    .filter((p): p is z.infer<typeof ApolloPost> => p !== null)
    .map((p) => {
      const account = resolveRef(state, p.account?.__ref, ApolloAccount);
      const tags = p.tags
        .map((t) => resolveRef(state, t.__ref, ApolloTag))
        .filter((t): t is z.infer<typeof ApolloTag> => t !== null)
        .map((t) => t.label)
        .filter(Boolean);
      const nickname = account?.nickname ?? '';
      return {
        uid: p.uid,
        type: p.type,
        title: p.title,
        summary: p.summary,
        thumbnailUrl: p.thumbnailUrl ?? null,
        membershipUrl: p.membershipUrl ?? null,
        url: nickname ? `${RSI_BASE_URL}/community-hub/user/${nickname}/post/${p.slug}` : '',
        createdAt: p.createdAt,
        votesCount: p.votesCount,
        commentsCount: p.commentsCount,
        viewsCount: p.viewsCount,
        honor: p.honor ?? null,
        authorDisplayName: account?.displayName ?? nickname,
        authorNickname: nickname,
        authorAvatarUrl: account?.thumbnailUrl ?? null,
        tags,
      };
    });
}

// ---------- Events (GraphQL) -------------------------------------------------

export interface CommunityHubEvent {
  uid: string;
  title: string;
  summary: string;
  description: string;
  slug: string;
  url: string;
  startedAt: string;
  endedAt: string;
  isLive: boolean;
  label: string;
  postCount: number;
  groupTitle: string;
  groupSlug: string;
  imageUrl: string | null;
}

const EventGroupRef = z
  .object({
    uid: z.string().default(''),
    slug: z.string().default(''),
    title: z.string().default(''),
    mandatoryShipTagging: z.boolean().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const EventMediaItem = z
  .object({
    logoSquareDesktop: z.string().nullable().optional(),
    logoSquareMobile: z.string().nullable().optional(),
    logoRectangleDesktop: z.string().nullable().optional(),
    logoRectangleMobile: z.string().nullable().optional(),
    fullsize: z.string().nullable().optional(),
    large: z.string().nullable().optional(),
    placeholder: z.string().nullable().optional(),
  })
  .passthrough();

// RSI returns `media` as an array (even when only one item is present), so
// accept both shapes defensively.
const EventMedia = z
  .union([z.array(EventMediaItem), EventMediaItem, z.null()])
  .optional()
  .transform((v) => {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  });

const RawEvent = z
  .object({
    uid: z.string().default(''),
    title: z.string().default(''),
    summary: z.string().default(''),
    description: z.string().default(''),
    slug: z.string().default(''),
    url: z.string().nullable().optional(),
    startedAt: z.string().default(''),
    endedAt: z.string().default(''),
    isLive: z.boolean().default(false),
    label: z.string().default(''),
    postCount: z.coerce.number().int().default(0),
    eventGroup: EventGroupRef,
    media: EventMedia,
  })
  .passthrough();

const EventsResponse = z.object({
  data: z
    .object({
      events: z
        .object({
          metaData: z.array(RawEvent).default([]),
          totalCount: z.coerce.number().int().default(0),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  errors: z.array(z.object({ message: z.string() }).passthrough()).nullable().optional(),
});

function normalizeEvent(raw: z.infer<typeof RawEvent>): CommunityHubEvent {
  const group = raw.eventGroup ?? undefined;
  const media = raw.media[0];
  const image =
    media?.logoRectangleDesktop ||
    media?.logoSquareDesktop ||
    media?.large ||
    media?.fullsize ||
    media?.logoRectangleMobile ||
    media?.logoSquareMobile ||
    media?.placeholder ||
    null;
  return {
    uid: raw.uid,
    title: raw.title,
    summary: raw.summary,
    description: raw.description,
    slug: raw.slug,
    url: raw.url ?? '',
    startedAt: raw.startedAt,
    endedAt: raw.endedAt,
    isLive: raw.isLive,
    label: raw.label,
    postCount: raw.postCount,
    groupTitle: group?.title ?? '',
    groupSlug: group?.slug ?? '',
    imageUrl: image,
  };
}

const GET_EVENTS_QUERY = `query getEventsInfo($EventQuery: EventQuery!) {
  events(query: $EventQuery) {
    metaData {
      uid
      title
      summary
      description
      slug
      url
      startedAt
      endedAt
      isLive
      label
      postCount
      eventGroup { uid slug title mandatoryShipTagging }
      media { fullsize large logoRectangleDesktop logoRectangleMobile logoSquareDesktop logoSquareMobile placeholder }
    }
    totalCount
  }
}`;

async function fetchApolloToken(): Promise<string> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/community-hub/events`, {
    credentials: 'include',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`community-hub events page ${response.status}`);
  const html = await response.text();
  const parsed = readNextData(html);
  const token = parsed?.props?.pageProps?.apolloToken;
  if (!token) throw new Error('Community Hub: no apolloToken on events page');
  return token;
}

async function graphqlEvents(
  token: string,
  variables: { isLive?: boolean; isAnnounced?: boolean },
): Promise<CommunityHubEvent[]> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/community-hub/api/v1/graphql`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      operationName: 'getEventsInfo',
      query: GET_EVENTS_QUERY,
      variables: { EventQuery: variables },
    }),
  });
  if (!response.ok) throw new Error(`community-hub events graphql returned ${response.status}`);
  const json = (await response.json()) as unknown;
  const parsed = EventsResponse.safeParse(json);
  if (!parsed.success) throw new Error(`community-hub events: unexpected shape (${parsed.error.message})`);
  const firstError = parsed.data.errors?.[0];
  if (firstError) {
    throw new Error(`community-hub events: ${firstError.message}`);
  }
  return (parsed.data.data?.events?.metaData ?? []).map(normalizeEvent);
}

// ---------- Public API -------------------------------------------------------

export type CommunityHubTab = 'live' | 'discover' | 'gameplay' | 'tutorial' | 'events';

export type CommunityHubSort = 'newest' | 'trending';

export type CommunityHubType = 'image' | 'video' | 'text' | 'audio';

export interface CommunityHubPostFilters {
  sort?: CommunityHubSort;
  types?: CommunityHubType[];
  tags?: string[];
}

export interface CommunityHubLiveSnapshot {
  tab: 'live';
  live: CommunityHubLivePost[];
  followed: CommunityHubLivePost[];
}

export interface CommunityHubPostsSnapshot {
  tab: 'discover' | 'gameplay' | 'tutorial';
  posts: CommunityHubPost[];
  filters: CommunityHubPostFilters;
}

export interface CommunityHubEventsSnapshot {
  tab: 'events';
  upcoming: CommunityHubEvent[];
  past: CommunityHubEvent[];
}

export type CommunityHubSnapshot =
  | CommunityHubLiveSnapshot
  | CommunityHubPostsSnapshot
  | CommunityHubEventsSnapshot;

// Only the post-grid tabs accept filters; 'live' and 'events' come from their
// own pipelines.
export type CommunityHubPostTab = Exclude<CommunityHubTab, 'live' | 'events'>;

function buildDiscoverPath(tab: CommunityHubPostTab, filters: CommunityHubPostFilters): string {
  const params = new URLSearchParams();
  if (filters.sort) params.set('sort', filters.sort);
  const allTags = [...(filters.tags ?? [])];
  if (tab === 'gameplay') allTags.push('gameplay');
  if (tab === 'tutorial') allTags.push('tutorial');
  const deduped = [...new Set(allTags.filter(Boolean))];
  if (deduped.length > 0) params.set('tags', deduped.join(','));
  if (filters.types && filters.types.length > 0) {
    params.set('types', filters.types.join(','));
  }
  const qs = params.toString();
  return qs ? `/community-hub/discover?${qs}` : '/community-hub/discover';
}

async function fetchHtml(path: string): Promise<string> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
    credentials: 'include',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!response.ok) throw new Error(`community-hub returned ${response.status}`);
  return response.text();
}

export async function fetchCommunityHubLive(): Promise<CommunityHubLiveSnapshot> {
  const html = await fetchHtml('/community-hub');
  const { document } = parseHTML(html);
  const node = document.querySelector('script#__NEXT_DATA__');
  const raw = node?.textContent ?? '';
  if (!raw) throw new Error('Community Hub: __NEXT_DATA__ missing');
  const parsed = LiveNextData.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Community Hub live: unexpected shape (${parsed.error.message})`);
  }
  const pp = parsed.data.props?.pageProps;
  return {
    tab: 'live',
    live: (pp?.livePostsFromSSR ?? []).map(normalizeLivePost),
    followed: (pp?.followedPostsFromSSR ?? []).map(normalizeLivePost),
  };
}

export async function fetchCommunityHubPosts(
  tab: CommunityHubPostTab,
  filters: CommunityHubPostFilters = {},
): Promise<CommunityHubPostsSnapshot> {
  const path = buildDiscoverPath(tab, filters);
  const html = await fetchHtml(path);
  const { state, rootQuery } = readApolloState(html);
  return { tab, posts: extractPosts(state, rootQuery), filters };
}

export async function fetchCommunityHubEvents(): Promise<CommunityHubEventsSnapshot> {
  const token = await fetchApolloToken();
  // A single query returns everything — avoid multi-query dedupe pain. We
  // then split client-side based on endedAt vs now.
  const all = await graphqlEvents(token, {});
  const now = Date.now();
  const upcomingRaw: CommunityHubEvent[] = [];
  const pastRaw: CommunityHubEvent[] = [];
  for (const e of all) {
    const ended = e.endedAt ? new Date(e.endedAt).getTime() : 0;
    if (e.isLive || !ended || ended > now) upcomingRaw.push(e);
    else pastRaw.push(e);
  }
  const upcoming = upcomingRaw.sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
  );
  const past = pastRaw.sort(
    (a, b) => new Date(b.endedAt).getTime() - new Date(a.endedAt).getTime(),
  );
  return { tab: 'events', upcoming, past };
}

// Backwards-compat helper (returns live tab).
export async function fetchCommunityHub(): Promise<CommunityHubLiveSnapshot> {
  return fetchCommunityHubLive();
}
