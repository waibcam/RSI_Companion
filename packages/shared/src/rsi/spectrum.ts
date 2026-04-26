// Spectrum threads — POST /api/spectrum/forum/channel/threads?page=1&sort=hot
// Uses the identify() community list to know which channels to fan out over.
// Requires x-rsi-token AND x-tavern-id headers for authenticated user context.

import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiOk, identifyFull, RsiNotAuthenticatedError, type IdentifyData } from './auth.js';

const RawThread = z.object({
  id: z.coerce.number().int(),
  slug: z.string(),
  subject: z.string().default(''),
  time_created: z.coerce.number().int().default(0),
  channel_id: z.coerce.number().int().default(0),
  is_new: z.boolean().default(false),
  highlight_role_id: z.coerce.number().int().nullable().optional(),
  member: z
    .object({
      nickname: z.string().default(''),
      displayname: z.string().nullable().optional(),
      avatar: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const ThreadsResponse = z.object({
  success: z.number().int(),
  data: z
    .object({
      threads: z.array(RawThread).default([]),
    })
    .nullable()
    .optional(),
});

export interface SpectrumChannel {
  id: number;
  name: string;
  color: string;
  slug: string;
  communitySlug: string;
}

export interface SpectrumThread {
  id: number;
  slug: string;
  subject: string;
  timeCreated: number;
  channel: SpectrumChannel;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  isNew: boolean;
  url: string;
}

export interface FetchThreadsResult {
  threads: SpectrumThread[];
}

export async function fetchSpectrumChannels(): Promise<SpectrumChannel[]> {
  const data = await identifyFull();
  if (!data) return [];
  return extractSpectrumChannels(data);
}

function extractSpectrumChannels(data: IdentifyData): SpectrumChannel[] {
  const community = (data.communities ?? []).find((c) => c.id === 1);
  if (!community) return [];

  const wanted = community.forum_channel_groups.filter((g) => g.id === 1 || g.id === 2);
  const out: SpectrumChannel[] = [];
  for (const group of wanted) {
    for (const ch of group.channels) {
      out.push({
        id: ch.id,
        name: ch.name,
        color: ch.color,
        slug: ch.slug,
        communitySlug: community.slug,
      });
    }
  }
  return out;
}

// --- Forum browsing (Phase 2) ------------------------------------------
//
// The DevTracker / Trending tabs were always a curated subset of the SC
// forum: highlighted-only and limited to the Official + Concierge groups
// (the only two `extractSpectrumChannels` returns). For the Forums tab
// we expose the full structure — every group, every channel — so users
// can browse the way they do on robertsspaceindustries.com/spectrum.

export interface SpectrumForumChannelInfo extends SpectrumChannel {
  description: string;
  threadsCount: number;
  groupId: number;
  groupName: string;
}

export interface SpectrumForumGroup {
  id: number;
  name: string;
  channels: SpectrumForumChannelInfo[];
}

/** All forum channel groups for the Star Citizen community, with their
 *  channels expanded inline. The shape is read straight from
 *  `auth/identify.communities[0].forum_channel_groups` — no extra HTTP
 *  call, since identify is called for every other Spectrum tab anyway
 *  and its response is cached at the chrome.cookies layer.
 *
 *  For org communities (Phase 3), use `fetchSpectrumOrgForumGroups`
 *  with the org's community id — those don't ride along on identify
 *  and need a dedicated `v2/forum/channel/group/list` call. */
export async function fetchSpectrumForumGroups(): Promise<SpectrumForumGroup[]> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();
  const community = (data.communities ?? []).find((c) => c.id === 1);
  if (!community) return [];
  return community.forum_channel_groups.map((g) => ({
    id: g.id,
    name: g.name,
    channels: g.channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      slug: ch.slug,
      color: ch.color,
      communitySlug: community.slug,
      description: ch.description ?? '',
      threadsCount: ch.threads_count ?? 0,
      groupId: g.id,
      groupName: g.name,
    })),
  }));
}

// --- Org communities + their forums (Phase 3) -----------------------------
//
// auth/identify only returns the SC community's forum structure. For the
// user's joined orgs (e.g. COLTRANS, THUNDERBSC), Spectrum exposes:
//   POST /api/spectrum/v2/community/list           — list of joined orgs
//   POST /api/spectrum/v2/forum/channel/group/list — per-community structure
// Both confirmed live via the Spectrum bundle source map. The first one
// was probed live and works; the second was console-probed unauthenticated
// and returned ErrPermissionDenied, but should work fine from the
// extension's authenticated background context.

export interface SpectrumCommunity {
  id: number;
  slug: string;
  name: string;
  avatar: string;
  banner: string;
  type: string;
}

const RawCommunityListEntry = z
  .object({
    id: z.coerce.number().int(),
    slug: z.string(),
    name: z.string().default(''),
    type: z.string().default(''),
    avatar: z
      .string()
      .nullable()
      .default('')
      .transform((v) => v ?? ''),
    banner: z
      .string()
      .nullable()
      .default('')
      .transform((v) => v ?? ''),
  })
  .passthrough();

const CommunityListResponse = z.object({
  success: z.number().int(),
  data: z.array(RawCommunityListEntry).nullable().optional(),
});

/** List the user's joined Spectrum communities (SC + every org they
 *  belong to). Drives the community switcher on the Forums tab. */
export async function fetchSpectrumCommunities(token: string): Promise<SpectrumCommunity[]> {
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/v2/community/list`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: '{}',
  });
  assertRsiOk(response, 'v2/community/list');
  const raw = (await response.json()) as unknown;
  const parsed = CommunityListResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) return [];
  return (parsed.data.data ?? []).map((c) => ({
    id: c.id,
    slug: c.slug,
    name: c.name,
    type: c.type,
    avatar: c.avatar,
    banner: c.banner,
  }));
}

// v2 forum group + channel responses are SEPARATE: the group/list
// endpoint returns only {id, name} per group (NOT the channels), and a
// second call to channel/list returns the channels with a `group_id`
// pointing back to their group. Our first attempt at this assumed the
// identify-style embedded shape (groups carry their own channels) and
// silently returned empty channels arrays for every org — see the
// regression Kamille reported on COLTRANS. The fix is to fan out the
// two calls in parallel and join client-side.

const RawV2GroupOnly = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().default(''),
  })
  .passthrough();

const RawV2Channel = z
  .object({
    id: z.coerce.number().int(),
    name: z.string().default(''),
    slug: z.string().default(''),
    color: z
      .string()
      .nullable()
      .default('')
      .transform((v) => v ?? ''),
    description: z
      .string()
      .nullable()
      .default('')
      .transform((v) => v ?? ''),
    threads_count: z.coerce.number().int().default(0),
    /** Set on the channel/list response so we can match channels back
     *  to their owning group. */
    group_id: z.coerce.number().int().default(0),
  })
  .passthrough();

const V2ForumChannelGroupListResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: z.array(RawV2GroupOnly).nullable().optional(),
});

const V2ForumChannelListResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: z.array(RawV2Channel).nullable().optional(),
});

/** Forum channel groups for an arbitrary community (orgs or SC). For
 *  the SC community (id=1) the caller should prefer
 *  `fetchSpectrumForumGroups` since identify already carries the data
 *  and we save a round trip.
 *
 *  Two parallel HTTP calls under the hood — one for groups, one for
 *  channels. Wall-clock cost is one round trip; the extra request is
 *  free if the v2 backend pipelines them like a normal HTTP/2 client
 *  expects. The join key is `channel.group_id`. */
export async function fetchSpectrumOrgForumGroups(
  token: string,
  community: { id: number; slug: string },
): Promise<SpectrumForumGroup[]> {
  const headers = {
    'Content-Type': 'application/json',
    'x-rsi-token': token,
    'x-tavern-id': token,
  };
  const body = JSON.stringify({ community_id: String(community.id) });
  const [groupsR, channelsR] = await Promise.all([
    fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/v2/forum/channel/group/list`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
    }),
    fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/v2/forum/channel/list`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
    }),
  ]);
  assertRsiOk(groupsR, 'v2/forum/channel/group/list');
  assertRsiOk(channelsR, 'v2/forum/channel/list');

  const rawG = (await groupsR.json()) as unknown;
  const parsedG = V2ForumChannelGroupListResponse.safeParse(rawG);
  if (!parsedG.success) {
    throw new Error(`v2/forum/channel/group/list: unexpected shape (${parsedG.error.message})`);
  }
  if (parsedG.data.success !== 1) {
    // Org communities sometimes restrict forum access to members with a
    // specific role; surface that explicitly so the UI can render an
    // appropriate empty state instead of a generic error.
    throw new Error(`v2/forum/channel/group/list returned ${parsedG.data.code ?? 'unknown'}`);
  }

  const rawC = (await channelsR.json()) as unknown;
  const parsedC = V2ForumChannelListResponse.safeParse(rawC);
  if (!parsedC.success) {
    throw new Error(`v2/forum/channel/list: unexpected shape (${parsedC.error.message})`);
  }
  if (parsedC.data.success !== 1) {
    throw new Error(`v2/forum/channel/list returned ${parsedC.data.code ?? 'unknown'}`);
  }

  const channelsByGroup = new Map<number, z.infer<typeof RawV2Channel>[]>();
  for (const ch of parsedC.data.data ?? []) {
    const arr = channelsByGroup.get(ch.group_id) ?? [];
    arr.push(ch);
    channelsByGroup.set(ch.group_id, arr);
  }

  return (parsedG.data.data ?? []).map((g) => ({
    id: g.id,
    name: g.name,
    channels: (channelsByGroup.get(g.id) ?? []).map((ch) => ({
      id: ch.id,
      name: ch.name,
      slug: ch.slug,
      color: ch.color,
      communitySlug: community.slug,
      description: ch.description,
      threadsCount: ch.threads_count,
      groupId: g.id,
      groupName: g.name,
    })),
  }));
}

/** Threads in a single forum channel — same `forum/channel/threads`
 *  endpoint we use for DevTracker, but with `highlightedOnly: false`
 *  so community-driven threads come through. The caller passes the
 *  resolved channel (id + slug + colour + community slug) so this
 *  function works the same for SC channels and org-community
 *  channels alike. */
export async function fetchSpectrumForumChannelThreads(
  token: string,
  channel: SpectrumChannel,
  options: FetchChannelThreadsOptions = {},
): Promise<SpectrumThread[]> {
  return fetchChannelThreads(token, channel, { highlightedOnly: false, ...options });
}

// Sort options accepted by /forum/channel/threads. Only 'hot' is exercised
// by the DevTracker/Trending tabs, but the Forums tab (Phase 2) lets users
// pick any of these — RSI's desktop SPA uses the same set.
export type SpectrumSort = 'hot' | 'top' | 'new' | 'last_activity' | 'trending';

export interface FetchChannelThreadsOptions {
  sort?: SpectrumSort;
  /** When true, keep only highlight_role_id == 2 (CIG-tagged) threads. */
  highlightedOnly?: boolean;
}

export async function fetchChannelThreads(
  token: string,
  channel: SpectrumChannel,
  options: FetchChannelThreadsOptions = {},
): Promise<SpectrumThread[]> {
  const sort = options.sort ?? 'hot';
  const highlightedOnly = options.highlightedOnly ?? true;

  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/forum/channel/threads`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify({
      channel_id: String(channel.id),
      page: 1,
      sort,
    }),
  });
  assertRsiOk(response, 'channel/threads');
  const raw = (await response.json()) as unknown;
  const parsed = ThreadsResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) return [];

  const out: SpectrumThread[] = [];
  for (const t of parsed.data.data?.threads ?? []) {
    if (highlightedOnly && Number(t.highlight_role_id ?? 0) !== 2) continue;
    out.push({
      id: t.id,
      slug: t.slug,
      subject: t.subject,
      timeCreated: t.time_created,
      channel,
      authorNickname: t.member?.nickname ?? '',
      authorDisplayName: t.member?.displayname ?? t.member?.nickname ?? '',
      authorAvatar: t.member?.avatar ?? null,
      isNew: t.is_new,
      url: `${RSI_BASE_URL}/spectrum/community/${channel.communitySlug}/forum/${channel.id}/thread/${t.slug}`,
    });
  }
  return out;
}

export async function fetchHighlightedThreads(token: string): Promise<SpectrumThread[]> {
  const data = await identifyFull();
  // Stale Rsi-Token cookie: the identify call succeeded transport-wise but
  // returned no active identity. Surface this as an auth error so the popup
  // shows the sign-in prompt instead of an empty list with `signedIn: true`.
  if (!data) throw new RsiNotAuthenticatedError();
  const channels = extractSpectrumChannels(data);
  const results = await Promise.all(channels.map((ch) => fetchChannelThreads(token, ch)));
  const flat = results.flat();
  return flat.sort((a, b) => b.timeCreated - a.timeCreated);
}

// "Trending" = the same channels Activity covers, but we drop the CIG-highlight
// filter so community-driven hot threads surface. Server-side `sort=trending`
// returns empty for most channels, so we use `sort=hot` which always populates.
export async function fetchTrendingThreads(token: string): Promise<SpectrumThread[]> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();
  const channels = extractSpectrumChannels(data);
  const results = await Promise.all(
    channels.map((ch) =>
      fetchChannelThreads(token, ch, { sort: 'hot', highlightedOnly: false }),
    ),
  );
  const flat = results.flat();
  // Keep at most 40 overall so the tab stays snappy.
  return flat.sort((a, b) => b.timeCreated - a.timeCreated).slice(0, 40);
}

// --- Thread reading (Phase 2b) ------------------------------------------
//
// `forum/thread/nested` returns a full thread: the thread metadata,
// the OP body (in `content_blocks`), the first 25 top-level replies
// (each with their own content_blocks), and a flat `nested_replies_ids`
// list of every reply id in the tree. The replies array includes a
// `replies` field with up to 5 children per top-level reply, but
// further nesting is paginated via `forum/thread/reply/childrens`
// (TBD when we want full nested rendering).
//
// Content blocks are TWO-level: an outer wrapper array carries
// {id, type: 'text' | 'image' | 'embed' | ..., data} and the data
// payload depends on the wrapper type:
//   text  → { blocks: [DraftJS] }     ← the actual paragraphs
//   image → [{ id, type: 'upload', data: { url, image_width, ... } }]
//   embed → ... (TBD; we surface as a placeholder until we look)
// Our normalizer flattens the wrapper layer so the UI only deals
// with one block shape. Inline styles + entities (links, mentions,
// embeds inside DraftJS) are still ignored — plain text covers
// ~90% of what people actually post.

const RawDraftBlock = z
  .object({
    key: z.string().default(''),
    text: z.string().default(''),
    type: z.string().default('unstyled'),
    depth: z.coerce.number().int().default(0),
  })
  .passthrough();

const RawImageData = z
  .object({
    id: z.string().default(''),
    type: z.string().default(''),
    data: z
      .object({
        url: z.string().default(''),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const RawContentWrapper = z
  .object({
    id: z.union([z.string(), z.coerce.number()]).optional(),
    type: z.string().default('unknown'),
    // The data field is polymorphic — text wrappers carry an object
    // with `blocks`, image wrappers carry an array of image entries,
    // unknown future types may carry anything else. Pass it through
    // raw and let the normalizer dispatch.
    data: z.unknown().nullable().optional(),
  })
  .passthrough();

const RawThreadMember = z
  .object({
    id: z.coerce.number().int().default(0),
    nickname: z.string().default(''),
    displayname: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
  })
  .passthrough();

const RawThreadReply = z
  .object({
    id: z.coerce.number().int(),
    thread_id: z.coerce.number().int().default(0),
    time_created: z.coerce.number().int().default(0),
    time_modified: z.coerce.number().int().default(0),
    member: RawThreadMember.nullable().optional(),
    content_blocks: z.array(RawContentWrapper).default([]),
    replies_count: z.coerce.number().int().default(0),
    is_erased: z.boolean().default(false),
  })
  .passthrough();

const RawThreadDetail = z
  .object({
    id: z.coerce.number().int(),
    slug: z.string().default(''),
    subject: z.string().default(''),
    time_created: z.coerce.number().int().default(0),
    time_modified: z.coerce.number().int().default(0),
    channel_id: z.coerce.number().int().default(0),
    is_locked: z.boolean().default(false),
    is_pinned: z.boolean().default(false),
    is_erased: z.boolean().default(false),
    highlight_role_id: z.coerce.number().int().nullable().optional(),
    member: RawThreadMember.nullable().optional(),
    content_blocks: z.array(RawContentWrapper).default([]),
    replies_count: z.coerce.number().int().default(0),
    views_count: z.coerce.number().int().default(0),
    replies: z.array(RawThreadReply).default([]),
  })
  .passthrough();

const ThreadDetailResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: RawThreadDetail.nullable().optional(),
});

export interface SpectrumContentBlock {
  /** Mirrors the DraftJS block type for text content
   *  ('unstyled' | 'header-one' | 'header-two' | 'unordered-list-item' |
   *  'ordered-list-item' | 'blockquote' | 'code-block' | 'atomic'),
   *  plus our synthetic types for media wrappers:
   *    'image'   — `imageUrl` is set
   *    'unknown' — wrapper type we don't render yet, `text` carries
   *                a `[type]` placeholder so users see something. */
  type: string;
  text: string;
  depth: number;
  /** Set when type === 'image'. */
  imageUrl?: string;
}

export interface SpectrumThreadReply {
  id: number;
  threadId: number;
  timeCreated: number;
  timeModified: number;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  contentBlocks: SpectrumContentBlock[];
  repliesCount: number;
  isErased: boolean;
}

export interface SpectrumThreadDetail {
  id: number;
  slug: string;
  subject: string;
  timeCreated: number;
  timeModified: number;
  channelId: number;
  isLocked: boolean;
  isPinned: boolean;
  isErased: boolean;
  isCigHighlighted: boolean;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  contentBlocks: SpectrumContentBlock[];
  repliesCount: number;
  viewsCount: number;
  /** First 25 top-level replies (the rest live behind
   *  forum/thread/reply/childrens — out of scope for the MVP read view). */
  replies: SpectrumThreadReply[];
}

function normalizeContentBlocks(
  wrappers: ReadonlyArray<z.infer<typeof RawContentWrapper>>,
): SpectrumContentBlock[] {
  const out: SpectrumContentBlock[] = [];
  for (const w of wrappers) {
    if (w.type === 'text') {
      // text wrapper: data is { blocks: DraftJS[] }. Validate then
      // flatten one level — each DraftJS block becomes a top-level
      // SpectrumContentBlock the renderer can dispatch by type.
      const parsed = z
        .object({ blocks: z.array(RawDraftBlock).default([]) })
        .passthrough()
        .safeParse(w.data);
      if (parsed.success) {
        for (const b of parsed.data.blocks) {
          out.push({ type: b.type, text: b.text, depth: b.depth });
        }
      }
    } else if (w.type === 'image') {
      // image wrapper: data is an array of image entries with a
      // nested `data.url`. Push one synthetic 'image' block per URL
      // so the renderer can <img> them inline.
      const parsed = z.array(RawImageData).safeParse(w.data ?? []);
      if (parsed.success) {
        for (const img of parsed.data) {
          const url = img.data?.url;
          if (url) out.push({ type: 'image', text: '', depth: 0, imageUrl: url });
        }
      }
    } else {
      // Unknown wrapper type — surface a labelled placeholder so the
      // user knows there's content we can't render yet (and they can
      // click "Open in Spectrum" to see it).
      out.push({ type: 'unknown', text: `[${w.type}]`, depth: 0 });
    }
  }
  return out;
}

function normalizeThreadMember(m: z.infer<typeof RawThreadMember> | null | undefined) {
  return {
    nickname: m?.nickname ?? '',
    displayName: m?.displayname ?? m?.nickname ?? '',
    avatar: m?.avatar ?? null,
  };
}

export async function fetchSpectrumThreadDetail(
  token: string,
  slug: string,
  options: { sort?: 'votes' | 'time_created' } = {},
): Promise<SpectrumThreadDetail | null> {
  const sort = options.sort ?? 'votes';
  const response = await spectrumPost(token, '/api/spectrum/forum/thread/nested', {
    slug,
    sort,
    target_reply_id: null,
  });
  assertRsiOk(response, 'forum/thread/nested');
  const raw = (await response.json()) as unknown;
  const parsed = ThreadDetailResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`forum/thread/nested: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.success !== 1) {
    throw new Error(`forum/thread/nested returned ${parsed.data.code ?? 'unknown'}`);
  }
  const t = parsed.data.data;
  if (!t) return null;
  const author = normalizeThreadMember(t.member);
  return {
    id: t.id,
    slug: t.slug,
    subject: t.subject,
    timeCreated: t.time_created,
    timeModified: t.time_modified,
    channelId: t.channel_id,
    isLocked: t.is_locked,
    isPinned: t.is_pinned,
    isErased: t.is_erased,
    isCigHighlighted: Number(t.highlight_role_id ?? 0) === 2,
    authorNickname: author.nickname,
    authorDisplayName: author.displayName,
    authorAvatar: author.avatar,
    contentBlocks: normalizeContentBlocks(t.content_blocks),
    repliesCount: t.replies_count,
    viewsCount: t.views_count,
    replies: t.replies.map((r) => {
      const ra = normalizeThreadMember(r.member);
      return {
        id: r.id,
        threadId: r.thread_id,
        timeCreated: r.time_created,
        timeModified: r.time_modified,
        authorNickname: ra.nickname,
        authorDisplayName: ra.displayName,
        authorAvatar: ra.avatar,
        contentBlocks: normalizeContentBlocks(r.content_blocks),
        repliesCount: r.replies_count,
        isErased: r.is_erased,
      };
    }),
  };
}

// --- Bookmarks (Phase 4) ------------------------------------------------
//
// Spectrum lets users bookmark any entity (forum thread, chat lobby,
// occasionally a forum channel) for one-click access from the left
// sidebar. We expose the same list under a "Bookmarks" tab here +
// the remove mutation. Add-bookmark from a thread card is Phase 4b.
//
// Endpoints (v2 only, all confirmed live in spectrum-api.md):
//   POST /api/spectrum/v2/bookmark/list   → array of bookmarks
//   POST /api/spectrum/v2/bookmark/add    → { entityId, entityType, name? }
//   POST /api/spectrum/v2/bookmark/remove → { entityId, entityType }

export interface SpectrumBookmark {
  entityId: number;
  /** "forum_thread" | "message_lobby" | "forum_channel" — RSI may add
   *  others. Treat as a string and key per-icon rendering off it. */
  entityType: string;
  /** RSI's canonical name for the bookmarked entity. */
  entityName: string;
  /** User-set custom label, or `null` to fall back to entityName. */
  name: string | null;
  url: string;
  hasNewActivity: boolean;
  order: number;
  subscriptionKey: string;
  thumbnail: string | null;
}

const RawBookmark = z
  .object({
    entityId: z.coerce.number().int(),
    entityType: z.string().default(''),
    entityName: z.string().default(''),
    name: z.string().nullable().optional(),
    url: z.string().default(''),
    hasNewActivity: z.boolean().default(false),
    order: z.coerce.number().int().default(0),
    subscriptionKey: z.string().default(''),
    thumbnail: z
      .string()
      .nullable()
      .optional()
      .transform((v) => (v && v.length > 0 ? v : null)),
  })
  .passthrough();

const BookmarkListResponse = z.object({
  success: z.number().int(),
  data: z.array(RawBookmark).nullable().optional(),
});

const BookmarkMutationResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  msg: z.string().nullable().optional(),
});

function spectrumPost(token: string, path: string, body: unknown) {
  return fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify(body),
  });
}

export async function fetchSpectrumBookmarks(token: string): Promise<SpectrumBookmark[]> {
  const response = await spectrumPost(token, '/api/spectrum/v2/bookmark/list', {});
  assertRsiOk(response, 'v2/bookmark/list');
  const raw = (await response.json()) as unknown;
  const parsed = BookmarkListResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) return [];
  return (parsed.data.data ?? []).map((b) => ({
    entityId: b.entityId,
    entityType: b.entityType,
    entityName: b.entityName,
    name: b.name && b.name.length > 0 ? b.name : null,
    url: b.url,
    hasNewActivity: b.hasNewActivity,
    order: b.order,
    subscriptionKey: b.subscriptionKey,
    thumbnail: b.thumbnail,
  }));
}

export async function addSpectrumBookmark(
  token: string,
  args: { entityId: number; entityType: string; name?: string },
): Promise<void> {
  const response = await spectrumPost(token, '/api/spectrum/v2/bookmark/add', {
    entityId: String(args.entityId),
    entityType: args.entityType,
    ...(args.name ? { name: args.name } : {}),
  });
  assertRsiOk(response, 'v2/bookmark/add');
  const raw = (await response.json()) as unknown;
  const parsed = BookmarkMutationResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) {
    const code = parsed.success ? parsed.data.code : 'parse error';
    throw new Error(`bookmark/add returned ${code}`);
  }
}

export async function removeSpectrumBookmark(
  token: string,
  args: { entityId: number; entityType: string },
): Promise<void> {
  const response = await spectrumPost(token, '/api/spectrum/v2/bookmark/remove', {
    entityId: String(args.entityId),
    entityType: args.entityType,
  });
  assertRsiOk(response, 'v2/bookmark/remove');
  const raw = (await response.json()) as unknown;
  const parsed = BookmarkMutationResponse.safeParse(raw);
  if (!parsed.success || parsed.data.success !== 1) {
    const code = parsed.success ? parsed.data.code : 'parse error';
    throw new Error(`bookmark/remove returned ${code}`);
  }
}

// --- Notifications ------------------------------------------------------
//
// RSI's /api/spectrum/notification/search returns HTML (login page) for
// extension contexts — it requires full browser session state we can't
// replicate. BUT the normal /api/spectrum/auth/identify response already
// carries:
//   - data.notifications           (native templated notifications)
//   - data.private_lobbies         (DM state — we synthesize notifs for unread)
//   - data.friend_requests         (friend request notifs)
//   - data.notifications_unread    (server-side unread count)
// So we aggregate notifications locally from identify — the same trick the
// legacy extension used. See functions.js `update_notification` in legacy.

export interface SpectrumNotification {
  id: string;
  type: string;
  timeCreated: number;
  read: boolean;
  text: string;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  url: string | null;
}

function str(v: unknown): string {
  return v == null ? '' : String(v);
}

// Renders a notification's text_tokens into a human-readable line, based on
// its `type`. Derived from the legacy extension's message templates.
function renderNotificationText(
  type: string,
  grouped: boolean,
  tok: Record<string, unknown> | null | undefined,
): string {
  const t = tok ?? {};
  const key = grouped ? `${type}.grouped` : type;
  const displayname = str(t.displayname ?? t.member_displayname);
  const plaintext = str(t.plaintext);
  const subject = str(t.forum_thread_subject);
  const channelName = str(t.forum_channel_name);
  const count = str(
    t.threads_count ?? t.members_count ?? t.votes_count ?? t.replies_count ?? '',
  );

  switch (key) {
    case 'friend-new-request':
      return plaintext
        ? `Friend request from ${displayname}: "${plaintext}"`
        : `Friend request from ${displayname}`;
    case 'private-new-message':
      return plaintext
        ? `Message from ${displayname}: "${plaintext}"`
        : `Message from ${displayname}`;
    case 'forum-channel-new-thread':
      return subject && channelName
        ? `New thread "${subject}" in ${channelName}`
        : `New thread in ${channelName}`;
    case 'forum-channel-new-thread.grouped':
      return `${count} new thread${Number(count) > 1 ? 's' : ''} in ${channelName}`;
    case 'forum-thread-reply-owner':
      return `${displayname} replied to your thread "${subject}"`;
    case 'forum-thread-reply-owner.grouped':
      return `${count} replies to your thread "${subject}"`;
    case 'forum-thread-reply':
      return `${displayname} replied in "${subject}"`;
    case 'forum-thread-reply.grouped':
      return `${count} new replies in "${subject}"`;
    case 'forum-thread-reply-personal':
      return `${displayname} replied to you in "${subject}"`;
    case 'forum-thread-reply-personal.grouped':
      return `${count} new replies to you in "${subject}"`;
    case 'forum-thread-reply-quote-personal':
      return `${displayname} quoted you in "${subject}"`;
    case 'forum-thread-vote-owner':
      return `${count} new vote for your thread "${subject}"`;
    case 'forum-thread-vote-owner.grouped':
      return `${count} votes for your thread "${subject}"`;
    case 'forum-thread-reply-vote-personal':
      return `${count} new vote for your reply in "${subject}"`;
    case 'forum-thread-reply-vote-personal.grouped':
      return `${count} votes for your reply in "${subject}"`;
    case 'community-update-rename':
      return `Organization "${str(t.old_name)}" has been renamed to "${str(t.new_name)}"`;
    default:
      // Unknown type — fall back to any plaintext or displayname hint.
      if (plaintext) return plaintext;
      if (displayname && subject) return `${displayname} · ${subject}`;
      if (subject) return subject;
      if (displayname) return displayname;
      return type.replace(/[_.-]/g, ' ');
  }
}

function buildNotificationUrl(
  link: Record<string, unknown> | null | undefined,
): string | null {
  if (!link) return null;
  const pathSpec = str(link.link_path);
  if (!pathSpec) return null;

  // link_path is a dotted recipe, e.g. "community.channel.thread.reply".
  const segments = pathSpec.split('.');
  let url = `${RSI_BASE_URL}/spectrum`;
  let recognised = false;
  for (const seg of segments) {
    switch (seg) {
      case 'community':
        url += `/community/${str(link.community_slug) || 'SC'}`;
        recognised = true;
        break;
      case 'channel':
        url += `/forum/${str(link.channel_id)}`;
        recognised = true;
        break;
      case 'thread':
        url += `/thread/${str(link.thread_slug)}`;
        recognised = true;
        break;
      case 'reply':
        if (link.reply_id) url += `/${str(link.reply_id)}`;
        break;
      case 'lobby':
        url += `/lobby/${str(link.lobby_id)}`;
        recognised = true;
        break;
      case 'private':
      case 'messages':
        url += `/messages/member/${str(link.member_id)}`;
        recognised = true;
        break;
      default:
        break;
    }
  }
  return recognised ? url : null;
}

export interface SpectrumLobbyMember {
  id: number;
  nickname: string;
  displayName: string;
  avatar: string | null;
}

export interface SpectrumLobby {
  id: number;
  name: string;
  timeModified: number;
  newMessages: number;
  lastMessageText: string;
  lastMessageAt: number;
  lastAuthorId: number | null;
  lastAuthorDisplayName: string;
  lastAuthorAvatar: string | null;
  members: SpectrumLobbyMember[];
  url: string;
}

/** Aggregate the identify response's notifications + friend requests + unread
 *  DM lobbies into a single UI-ready notification feed. */
export async function fetchSpectrumNotifications(): Promise<SpectrumNotification[]> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();

  const myId = data.member?.id ?? 0;
  const out: SpectrumNotification[] = [];

  // 1) Native templated notifications.
  for (const n of data.notifications ?? []) {
    const ts = n.time || n.time_created;
    const unread = n.unread === true || n.unread === 1 || n.unread === '1';
    out.push({
      id: String(n.id),
      type: n.type,
      timeCreated: ts,
      read: !unread,
      text: renderNotificationText(n.type, n.grouped, n.text_tokens),
      authorNickname: '',
      authorDisplayName: str(n.text_tokens?.displayname ?? n.text_tokens?.member_displayname),
      authorAvatar: n.thumbnail ?? null,
      url: buildNotificationUrl(n.link_tokens),
    });
  }

  // 2) Unread private lobbies — one synthetic notif each.
  for (const lobby of data.private_lobbies ?? []) {
    const last = lobby.last_message;
    if (!lobby.new_messages || !last) continue;
    if (last.member_id === myId) continue;
    const sender = lobby.members.find((m) => m.id === last.member_id);
    if (!sender) continue;
    out.push({
      id: `private-${lobby.id}-new-message`,
      type: 'private-new-message',
      timeCreated: last.time_modified || last.time_created || lobby.time_modified,
      read: false,
      text: `Message from ${sender.displayname ?? sender.nickname}: "${last.plaintext}"`,
      authorNickname: sender.nickname,
      authorDisplayName: sender.displayname ?? sender.nickname,
      authorAvatar: sender.avatar ?? null,
      url: `${RSI_BASE_URL}/spectrum/community/SC/lobby/${lobby.id}`,
    });
  }

  // 3) Incoming friend requests — one notif each.
  for (const fr of data.friend_requests ?? []) {
    if (fr.type === 'out') continue;
    const requester = fr.requesting_member_id;
    if (requester === myId) continue;
    const sender =
      (fr.members ?? []).find((m) => m.id !== myId) ?? fr.member ?? null;
    if (!sender) continue;
    const displayName = sender.displayname ?? sender.nickname;
    out.push({
      id: `friend-${fr.id}-new-request`,
      type: 'friend-new-request',
      timeCreated: fr.time_modified || 0,
      read: false,
      text: fr.status
        ? `Friend request from ${displayName}: "${fr.status}"`
        : `Friend request from ${displayName}`,
      authorNickname: sender.nickname,
      authorDisplayName: displayName,
      authorAvatar: sender.avatar ?? null,
      url: `${RSI_BASE_URL}/citizens/${sender.nickname}`,
    });
  }

  // Newest first.
  out.sort((a, b) => b.timeCreated - a.timeCreated);
  return out;
}

export async function fetchSpectrumLobbies(): Promise<SpectrumLobby[]> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();

  const myId = data.member?.id ?? 0;
  const out: SpectrumLobby[] = [];
  for (const lobby of data.private_lobbies ?? []) {
    const others = lobby.members.filter((m) => m.id !== myId);
    const displayName = lobby.name
      ? lobby.name
      : others.map((m) => m.displayname ?? m.nickname).join(', ') || 'Unnamed lobby';

    const last = lobby.last_message;
    const sender = last ? lobby.members.find((m) => m.id === last.member_id) : null;
    out.push({
      id: lobby.id,
      name: displayName,
      timeModified: lobby.time_modified,
      newMessages: lobby.new_messages,
      lastMessageText: last?.plaintext ?? '',
      lastMessageAt: last?.time_modified ?? last?.time_created ?? lobby.time_modified,
      lastAuthorId: last?.member_id ?? null,
      lastAuthorDisplayName: sender
        ? (sender.displayname ?? sender.nickname)
        : '',
      lastAuthorAvatar: sender?.avatar ?? null,
      members: lobby.members.map((m) => ({
        id: m.id,
        nickname: m.nickname,
        displayName: m.displayname ?? m.nickname,
        avatar: m.avatar ?? null,
      })),
      url: `${RSI_BASE_URL}/spectrum/community/SC/lobby/${lobby.id}`,
    });
  }

  out.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  return out;
}

export async function markSpectrumNotificationsRead(token: string): Promise<void> {
  // Legacy endpoint is `/read-all` — the `/mark-all-read` variant I tried earlier
  // returns HTML. Source: legacy RSI Companion functions.js SpectrumReadAllNotifications.
  const response = await fetchWithTimeout(`${RSI_BASE_URL}/api/spectrum/notification/read-all`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
    },
    body: JSON.stringify({}),
  });
  assertRsiOk(response, 'notification/read-all');
}
