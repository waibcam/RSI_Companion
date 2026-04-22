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

export type SpectrumSort = 'hot' | 'trending' | 'new';

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
