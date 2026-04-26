// Spectrum threads — POST /api/spectrum/forum/channel/threads?page=1&sort=hot
// Uses the identify() community list to know which channels to fan out over.
// Requires x-rsi-token AND x-tavern-id headers for authenticated user context.

import { z } from 'zod';
import { RSI_BASE_URL } from '../constants.js';
import { fetchWithTimeout } from '../net.js';
import { assertRsiOk, identifyFull, RsiNotAuthenticatedError, type IdentifyData } from './auth.js';

const RawVotes = z
  .object({
    count: z.coerce.number().int().default(0),
    voted: z.coerce.number().int().default(0),
  })
  .passthrough();

const RawThread = z.object({
  id: z.coerce.number().int(),
  slug: z.string(),
  subject: z.string().default(''),
  time_created: z.coerce.number().int().default(0),
  channel_id: z.coerce.number().int().default(0),
  is_new: z.boolean().default(false),
  is_pinned: z.boolean().default(false),
  highlight_role_id: z.coerce.number().int().nullable().optional(),
  votes: RawVotes.nullable().optional(),
  replies_count: z.coerce.number().int().default(0),
  views_count: z.coerce.number().int().default(0),
  member: z
    .object({
      nickname: z.string().default(''),
      displayname: z.string().nullable().optional(),
      avatar: z.string().nullable().optional(),
      isGM: z.boolean().default(false),
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
  /** True when the post author is CIG staff (member.isGM). Drives
   *  the gold tint Spectrum's site uses for staff posts. */
  authorIsStaff: boolean;
  isNew: boolean;
  isPinned: boolean;
  votesCount: number;
  repliesCount: number;
  viewsCount: number;
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

/** Forum channel groups for any community the user has access to —
 *  identify returns the full forum_channel_groups tree for SC AND
 *  every joined org (when called from an authenticated session;
 *  anonymous identify returns only SC). No extra HTTP call: identify
 *  is fired for every other Spectrum tab anyway and the response is
 *  cached at the chrome.cookies layer. */
export async function fetchSpectrumForumGroups(
  communityId: number = 1,
): Promise<SpectrumForumGroup[]> {
  const data = await identifyFull();
  if (!data) throw new RsiNotAuthenticatedError();
  const community = (data.communities ?? []).find((c) => c.id === communityId);
  if (!community) {
    // Either the user isn't actually a member, or this org's structure
    // didn't ride along on identify (rare — usually means the user
    // joined it on Spectrum after their last identify cache hit).
    throw new Error(
      `community ${communityId} not present in identify (rejoin on Spectrum and refresh, or this org's forum is private)`,
    );
  }
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
      authorIsStaff: !!t.member?.isGM,
      isNew: t.is_new,
      isPinned: t.is_pinned,
      votesCount: t.votes?.count ?? 0,
      repliesCount: t.replies_count,
      viewsCount: t.views_count,
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

const RawInlineStyleRange = z.object({
  offset: z.coerce.number().int().default(0),
  length: z.coerce.number().int().default(0),
  style: z.string().default(''),
});

const RawEntityRange = z.object({
  offset: z.coerce.number().int().default(0),
  length: z.coerce.number().int().default(0),
  key: z.coerce.number().int().default(0),
});

const RawDraftBlock = z
  .object({
    key: z.string().default(''),
    text: z.string().default(''),
    type: z.string().default('unstyled'),
    depth: z.coerce.number().int().default(0),
    inlineStyleRanges: z.array(RawInlineStyleRange).default([]),
    entityRanges: z.array(RawEntityRange).default([]),
  })
  .passthrough();

const RawEntity = z
  .object({
    type: z.string().default(''),
    mutability: z.string().default('').optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

const RawEntityMap = z.preprocess(
  // entityMap can come back as either {} (object keyed by string id),
  // [] (empty array), or null. Normalise the empty/array cases to {}.
  (v) => {
    if (!v) return {};
    if (Array.isArray(v)) return {};
    return v;
  },
  z.record(z.string(), RawEntity).default({}),
);

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
    /** Spectrum's "is Game Master" flag — true for CIG staff. The
     *  server tints messages from these members with a gold accent
     *  on the official site; we mirror that. */
    isGM: z.boolean().default(false),
  })
  .passthrough();

// Self-referential — every reply can carry up to ~5 child replies
// inline (deeper nesting is paginated via forum/thread/reply/childrens
// which we don't expose yet). The output shape (after parsing) has
// concrete numbers thanks to .default(0); the input shape allows the
// fields to be missing. z.lazy() handles the recursion.
type RawThreadReplyOutput = {
  id: number;
  thread_id: number;
  time_created: number;
  time_modified: number;
  member?: z.infer<typeof RawThreadMember> | null;
  content_blocks: z.infer<typeof RawContentWrapper>[];
  replies_count: number;
  is_erased: boolean;
  votes?: z.infer<typeof RawVotes> | null;
  reactions?: ReadonlyArray<{ type?: string; count?: number }>;
  replies: RawThreadReplyOutput[];
};
type RawThreadReplyInput = {
  id: number | string;
  thread_id?: number | string;
  time_created?: number | string;
  time_modified?: number | string;
  member?: z.input<typeof RawThreadMember> | null;
  content_blocks?: z.input<typeof RawContentWrapper>[];
  replies_count?: number | string;
  is_erased?: boolean;
  votes?: z.input<typeof RawVotes> | null;
  reactions?: ReadonlyArray<{ type?: string; count?: number | string }>;
  replies?: RawThreadReplyInput[];
  [k: string]: unknown;
};
const RawReactionEntry = z
  .object({
    type: z.string().default(''),
    count: z.coerce.number().int().default(0),
  })
  .passthrough();

const RawThreadReply: z.ZodType<RawThreadReplyOutput, z.ZodTypeDef, RawThreadReplyInput> = z.lazy(
  () =>
    z
      .object({
        id: z.coerce.number().int(),
        thread_id: z.coerce.number().int().default(0),
        time_created: z.coerce.number().int().default(0),
        time_modified: z.coerce.number().int().default(0),
        member: RawThreadMember.nullable().optional(),
        content_blocks: z.array(RawContentWrapper).default([]),
        replies_count: z.coerce.number().int().default(0),
        is_erased: z.boolean().default(false),
        votes: RawVotes.nullable().optional(),
        reactions: z.array(RawReactionEntry).default([]),
        replies: z.array(RawThreadReply).default([]),
      })
      .passthrough(),
);

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
    votes: RawVotes.nullable().optional(),
    reactions: z.array(RawReactionEntry).default([]),
    replies: z.array(RawThreadReply).default([]),
  })
  .passthrough();

const ThreadDetailResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: RawThreadDetail.nullable().optional(),
});

export type SpectrumSegmentKind = 'plain' | 'link' | 'mention';

export interface SpectrumContentSegment {
  kind: SpectrumSegmentKind;
  text: string;
  /** DraftJS inline styles applied to this segment.
   *  Common values: 'BOLD' | 'ITALIC' | 'CODE' | 'STRIKETHROUGH'. */
  styles: string[];
  /** Set when kind === 'link'. */
  url?: string;
  /** Set when kind === 'mention'. */
  mentionNickname?: string;
}

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
  /** Computed segments for text-type blocks — preserves inline styles
   *  (BOLD / ITALIC / CODE / STRIKETHROUGH), link URLs, and mention
   *  nicknames so the UI can render rich text instead of stripping to
   *  plain. Undefined for non-text blocks (image / unknown). */
  segments?: SpectrumContentSegment[];
}

export interface SpectrumThreadReply {
  id: number;
  threadId: number;
  timeCreated: number;
  timeModified: number;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  /** True for CIG staff posts (member.isGM). Drives the gold tint
   *  Spectrum's site uses to make staff replies visually distinct. */
  authorIsStaff: boolean;
  contentBlocks: SpectrumContentBlock[];
  votesCount: number;
  reactions: SpectrumReaction[];
  /** Total number of nested replies according to the server. May
   *  be larger than `replies.length` — the API embeds at most ~5
   *  children per parent and the rest live behind
   *  forum/thread/reply/childrens (TBD). */
  repliesCount: number;
  isErased: boolean;
  /** Inline-embedded children. Recurses to whatever depth the
   *  server returned. */
  replies: SpectrumThreadReply[];
}

export interface SpectrumReaction {
  type: string; // ':picardpalm:' shortcode form
  count: number;
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
  authorIsStaff: boolean;
  votesCount: number;
  reactions: SpectrumReaction[];
  contentBlocks: SpectrumContentBlock[];
  repliesCount: number;
  viewsCount: number;
  /** First 25 top-level replies (the rest live behind
   *  forum/thread/reply/childrens — out of scope for the MVP read view). */
  replies: SpectrumThreadReply[];
}

/** Compute styled/linked/mentioned segments from a single DraftJS
 *  block. Walk the text once, picking up the active inline styles
 *  and any entity that covers each character offset. The boundary
 *  set is built from every range start + end so we slice the string
 *  in O(n log n) instead of O(n²). */
function computeBlockSegments(
  block: z.infer<typeof RawDraftBlock>,
  entityMap: Record<string, z.infer<typeof RawEntity>>,
): SpectrumContentSegment[] {
  const text = block.text;
  if (!text) return [];

  // Boundary offsets: the start + end of every inline-style and
  // entity range, plus 0 and text.length.
  const boundaries = new Set<number>([0, text.length]);
  for (const r of block.inlineStyleRanges) {
    boundaries.add(r.offset);
    boundaries.add(r.offset + r.length);
  }
  for (const r of block.entityRanges) {
    boundaries.add(r.offset);
    boundaries.add(r.offset + r.length);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);

  const out: SpectrumContentSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    if (start >= end) continue;

    // Active inline styles at [start, end).
    const styles = new Set<string>();
    for (const r of block.inlineStyleRanges) {
      if (r.style && r.offset <= start && r.offset + r.length >= end) {
        styles.add(r.style);
      }
    }
    // Active entity (assume entities don't overlap; take the first match).
    let entity: z.infer<typeof RawEntity> | undefined;
    for (const r of block.entityRanges) {
      if (r.offset <= start && r.offset + r.length >= end) {
        const e = entityMap[String(r.key)];
        if (e) {
          entity = e;
          break;
        }
      }
    }

    const segText = text.slice(start, end);
    if (entity?.type === 'LINK') {
      const url = (entity.data as { url?: string } | undefined)?.url ?? '';
      out.push({ kind: 'link', text: segText, styles: [...styles], url });
    } else if (entity?.type === 'MENTION') {
      const nickname =
        (entity.data as { member?: { nickname?: string }; nickname?: string } | undefined)?.member
          ?.nickname ??
        (entity.data as { nickname?: string } | undefined)?.nickname ??
        '';
      out.push({ kind: 'mention', text: segText, styles: [...styles], mentionNickname: nickname });
    } else {
      out.push({ kind: 'plain', text: segText, styles: [...styles] });
    }
  }
  return out;
}

function normalizeContentBlocks(
  wrappers: ReadonlyArray<z.infer<typeof RawContentWrapper>>,
): SpectrumContentBlock[] {
  const out: SpectrumContentBlock[] = [];
  for (const w of wrappers) {
    if (w.type === 'text') {
      // text wrapper: data is { blocks: DraftJS[], entityMap? }.
      // Each DraftJS block becomes a top-level SpectrumContentBlock
      // with computed segments preserving inline styles + entities.
      const parsed = z
        .object({
          blocks: z.array(RawDraftBlock).default([]),
          entityMap: RawEntityMap,
        })
        .passthrough()
        .safeParse(w.data);
      if (parsed.success) {
        const entityMap = parsed.data.entityMap;
        for (const b of parsed.data.blocks) {
          out.push({
            type: b.type,
            text: b.text,
            depth: b.depth,
            segments: computeBlockSegments(b, entityMap),
          });
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
    /** True for CIG staff (member.isGM === true) — mirrors the
     *  gold tint Spectrum's website uses on staff posts. */
    isStaff: !!m?.isGM,
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
    authorIsStaff: author.isStaff,
    contentBlocks: normalizeContentBlocks(t.content_blocks),
    repliesCount: t.replies_count,
    viewsCount: t.views_count,
    votesCount: t.votes?.count ?? 0,
    reactions: t.reactions.map((r) => ({ type: r.type, count: r.count })),
    replies: t.replies.map(normalizeReply),
  };
}

function normalizeReply(r: RawThreadReplyOutput): SpectrumThreadReply {
  const ra = normalizeThreadMember(r.member);
  return {
    id: r.id,
    threadId: r.thread_id,
    timeCreated: r.time_created,
    timeModified: r.time_modified,
    authorNickname: ra.nickname,
    authorDisplayName: ra.displayName,
    authorAvatar: ra.avatar,
    authorIsStaff: ra.isStaff,
    contentBlocks: normalizeContentBlocks(r.content_blocks),
    repliesCount: r.replies_count,
    isErased: r.is_erased,
    votesCount: r.votes?.count ?? 0,
    reactions: (r.reactions ?? [])
      .filter((x): x is { type: string; count: number } => !!x.type)
      .map((x) => ({ type: x.type, count: x.count })),
    replies: (r.replies ?? []).map(normalizeReply),
  };
}

// --- Forum search (Phase 2d) --------------------------------------------
//
// `search/content/simple` runs an Elasticsearch query across forum
// thread OPs (and, presumably, replies + messages — but the live probe
// only returned `tavern_forum_thread_op` hits for typical queries, so
// the MVP focuses on threads). Body shape:
//
//   { text, type: 'all', community_id?: string }
//
// Only `type: 'all'` is accepted by the live API right now (other
// values like 'thread' / 'lobby' fail validation). The response is the
// raw Elasticsearch envelope: data.hits.hits[] with _index + _id +
// _score + _source carrying body, subject, channel_id, thread_id,
// member_id, votes, etc.

const RawSearchHit = z
  .object({
    _index: z.string().default(''),
    _id: z.string().default(''),
    _score: z.coerce.number().default(0),
    _source: z
      .object({
        body: z.string().default(''),
        subject: z.string().default(''),
        time_created: z.coerce.number().int().default(0),
        community_id: z.coerce.number().int().default(0),
        channel_id: z.coerce.number().int().default(0),
        thread_id: z.coerce.number().int().default(0),
        member_id: z.coerce.number().int().default(0),
        highlight_role_id: z.coerce.number().int().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const SearchResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: z
    .object({
      hits: z
        .object({
          hits: z.array(RawSearchHit).default([]),
          total: z
            .union([
              z.number(),
              z.object({ value: z.number().default(0) }).passthrough(),
            ])
            .nullable()
            .optional(),
        })
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
});

export interface SpectrumSearchHit {
  /** "thread" for forum thread OPs, "reply" for thread replies,
   *  "message" for chat — derived from the underlying _index name. */
  kind: 'thread' | 'reply' | 'message' | 'unknown';
  id: string;
  score: number;
  /** OP body for threads, content for replies/messages. */
  body: string;
  /** Thread subject (only meaningful for kind === 'thread'). */
  subject: string;
  timeCreated: number;
  communityId: number;
  channelId: number;
  threadId: number;
  authorId: number;
  isCigHighlighted: boolean;
}

function classifyHitKind(index: string): SpectrumSearchHit['kind'] {
  if (index.includes('forum_thread_op')) return 'thread';
  if (index.includes('forum_reply') || index.includes('forum_thread_reply')) return 'reply';
  if (index.includes('message')) return 'message';
  return 'unknown';
}

export async function fetchSpectrumContentSearch(
  token: string,
  args: { text: string; communityId?: number },
): Promise<SpectrumSearchHit[]> {
  const trimmed = args.text.trim();
  if (!trimmed) return [];
  const body: Record<string, unknown> = { text: trimmed, type: 'all' };
  if (args.communityId) body.community_id = String(args.communityId);
  const response = await spectrumPost(token, '/api/spectrum/search/content/simple', body);
  assertRsiOk(response, 'search/content/simple');
  const raw = (await response.json()) as unknown;
  const parsed = SearchResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`search/content/simple: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.success !== 1) {
    throw new Error(`search/content/simple returned ${parsed.data.code ?? 'unknown'}`);
  }
  return (parsed.data.data?.hits?.hits ?? []).map((h) => {
    const s = h._source;
    return {
      kind: classifyHitKind(h._index),
      id: h._id,
      score: h._score,
      body: s?.body ?? '',
      subject: s?.subject ?? '',
      timeCreated: s?.time_created ?? 0,
      communityId: s?.community_id ?? 0,
      channelId: s?.channel_id ?? 0,
      threadId: s?.thread_id ?? 0,
      authorId: s?.member_id ?? 0,
      isCigHighlighted: Number(s?.highlight_role_id ?? 0) === 2,
    };
  });
}

// --- Lobby messages (Phase 5) -------------------------------------------
//
// `message/history` returns paginated chat for any lobby (DM, private
// group, or public chat) — the data shape doesn't change per type.
// Body: { lobby_id, timeframe: 'before' | 'after', message_id, size }.
// Each message carries `content_state: { blocks: [DraftJS], entityMap }` —
// note the SHAPE DIFFERS from forum-thread content_blocks: messages
// inline DraftJS directly, no wrapper layer. Attachments come via
// `media_id` instead, which we surface as a placeholder for now.

const RawMessageMember = z
  .object({
    id: z.coerce.number().int().default(0),
    nickname: z.string().default(''),
    displayname: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    isGM: z.boolean().default(false),
  })
  .passthrough();

const RawMessageContentState = z
  .object({
    blocks: z.array(RawDraftBlock).default([]),
  })
  .passthrough();

const RawMessage = z
  .object({
    id: z.coerce.number().int(),
    lobby_id: z.coerce.number().int().default(0),
    member_id: z.coerce.number().int().default(0),
    time_created: z.coerce.number().int().default(0),
    time_modified: z.coerce.number().int().default(0),
    content_state: RawMessageContentState.nullable().optional(),
    media_id: z.string().default(''),
    highlight_role_id: z.coerce.number().int().nullable().optional(),
    member: RawMessageMember.nullable().optional(),
  })
  .passthrough();

const MessageHistoryResponse = z.object({
  success: z.number().int(),
  code: z.string().nullable().optional(),
  data: z
    .object({
      messages: z.array(RawMessage).default([]),
    })
    .nullable()
    .optional(),
});

export interface SpectrumMessage {
  id: number;
  lobbyId: number;
  timeCreated: number;
  timeModified: number;
  authorId: number;
  authorNickname: string;
  authorDisplayName: string;
  authorAvatar: string | null;
  /** True for CIG staff posts (member.isGM). Drives the gold tint
   *  Spectrum's site uses to make staff messages visually distinct. */
  authorIsStaff: boolean;
  contentBlocks: SpectrumContentBlock[];
  /** Empty when no attachment. The current MVP renders a placeholder
   *  for non-empty values; resolving the actual upload URL needs an
   *  extra call we haven't wired yet. */
  mediaId: string;
  /** Server-side staff highlight (admins, mods); the desktop UI tints
   *  these messages. */
  isHighlighted: boolean;
}

/** Page of messages in a lobby. The API returns messages
 *  newest-first; we keep that order so the renderer can flip to the
 *  desired chat-app orientation (oldest-at-top, scroll-to-bottom)
 *  once we add it. */
export async function fetchSpectrumLobbyMessages(
  token: string,
  lobbyId: number,
  options: { before?: number; after?: number; size?: number } = {},
): Promise<SpectrumMessage[]> {
  const size = options.size ?? 50;
  const timeframe = options.after ? ('after' as const) : ('before' as const);
  const message_id = options.after ?? options.before ?? null;
  const response = await spectrumPost(token, '/api/spectrum/message/history', {
    lobby_id: String(lobbyId),
    timeframe,
    message_id: message_id == null ? null : String(message_id),
    size,
  });
  assertRsiOk(response, 'message/history');
  const raw = (await response.json()) as unknown;
  const parsed = MessageHistoryResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`message/history: unexpected shape (${parsed.error.message})`);
  }
  if (parsed.data.success !== 1) {
    throw new Error(`message/history returned ${parsed.data.code ?? 'unknown'}`);
  }
  return (parsed.data.data?.messages ?? []).map((m) => {
    const author = normalizeThreadMember(m.member);
    // content_state.blocks is a flat DraftJS array — pass it through
    // as a synthetic single-text wrapper so we reuse the same
    // normalizer thread content goes through.
    const contentBlocks = m.content_state
      ? normalizeContentBlocks([{ type: 'text', data: m.content_state }])
      : [];
    if (m.media_id) {
      contentBlocks.push({ type: 'unknown', text: 'attachment', depth: 0 });
    }
    return {
      id: m.id,
      lobbyId: m.lobby_id,
      timeCreated: m.time_created,
      timeModified: m.time_modified,
      authorId: m.member_id,
      authorNickname: author.nickname,
      authorDisplayName: author.displayName,
      authorAvatar: author.avatar,
      authorIsStaff: author.isStaff,
      contentBlocks,
      mediaId: m.media_id,
      isHighlighted: Number(m.highlight_role_id ?? 0) > 0,
    };
  });
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

function spectrumPost(
  token: string,
  path: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return fetchWithTimeout(`${RSI_BASE_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'x-rsi-token': token,
      'x-tavern-id': token,
      ...extraHeaders,
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
  args: { entityId: number; entityType: string; name?: string; csrfToken?: string },
): Promise<void> {
  // Body uses snake_case keys (entity_id / entity_type) — confirmed by
  // grepping the SPA bundle for the actual addBookmark wire format.
  // Earlier camelCase attempts (entityId/entityType) silently authenticated
  // but failed validation, returning ErrNotAuthenticated.
  const response = await spectrumPost(
    token,
    '/api/spectrum/v2/bookmark/add',
    {
      entity_id: String(args.entityId),
      entity_type: args.entityType,
      ...(args.name ? { name: args.name } : {}),
    },
    args.csrfToken ? { 'X-CSRF-TOKEN': args.csrfToken } : {},
  );
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
  args: { entityId: number; entityType: string; csrfToken?: string },
): Promise<void> {
  const response = await spectrumPost(
    token,
    '/api/spectrum/v2/bookmark/remove',
    {
      entity_id: String(args.entityId),
      entity_type: args.entityType,
    },
    args.csrfToken ? { 'X-CSRF-TOKEN': args.csrfToken } : {},
  );
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
