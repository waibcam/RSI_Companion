# Spectrum API — reverse-engineered cartography

This is the Phase 0 deliverable for the Spectrum module roadmap (see
"Roadmap" at the bottom of this file). It maps every endpoint we'd
touch to build a deeper Spectrum integration than the four-tab feed
shipping in v1.2.x.

Captured live in 2026-04-26 against `robertsspaceindustries.com` v7.111.0,
authenticated session, via a `window.fetch`/`XMLHttpRequest` interceptor
running in DevTools while clicking through the official UI.

> **Status of each endpoint** is marked with one of:
> - ✅ confirmed live with sample payloads recorded in this doc
> - 🟡 referenced in identify response but not directly probed
> - 🔍 expected to exist (analogous to confirmed ones) but not yet observed
> - ❓ guessed; probe paths returned the SPA HTML fallback (404 in disguise)

## TL;DR

- Spectrum is a **REST API**, not GraphQL. All endpoints live under
  `/api/spectrum/<area>/<action>` and are POST with a JSON body. Responses
  use the `{success, code, msg, data}` envelope familiar from the rest of
  the RSI platform.
- The single `auth/identify` call is the **master payload** — it returns
  the user's communities (with their channels and forum-channel-groups),
  bookmarks, DMs, group lobbies, friends, notifications, settings, and
  auth tokens in one round trip.
- Each lobby, thread, forum channel, and broadcast has a
  `subscription_key` field. These almost certainly feed a websocket
  pubsub layer for real-time updates; we haven't probed that yet (no
  WS frames captured by `performance.getEntries()` during the click
  walkthrough — needs a Network → WS tab pass).
- Forum channels and chat lobbies share a uniform shape and use a
  unified `message/history` endpoint regardless of public/private/DM —
  the data model is more consistent than the UI implies.

---

## Auth

Every authenticated endpoint expects:

- `credentials: include` (the `Rsi-Account-Auth` cookie carries the
  primary session — it's HttpOnly, the JS layer doesn't read it).
- `Content-Type: application/json` even when the body is `{}`.
- `x-rsi-token` and `x-tavern-id` headers — both populated from
  `auth/identify.data.token`. Our existing fetcher already does this
  and it's the only header pair Spectrum actually checks.
- A direct `fetch('/api/spectrum/...')` from the DevTools console
  works as long as it has the cookie; the SPA's auth headers aren't
  strictly required (we observed 200 OK responses without them).

Endpoints that are unknown to the server return a 200 with the SPA
shell HTML (`<!DOCTYPE html><html>...Spectrum v7.111.0...</html>`).
A JSON body starting with `{"success":` confirms a real endpoint.

---

## `auth/identify` — the master payload

POST `/api/spectrum/auth/identify` with `{}`.

The response shape is the spine of the entire client. Top-level keys
in `data`:

| Key                                  | Type     | Notes                                             |
| ------------------------------------ | -------- | ------------------------------------------------- |
| `member`                             | object   | Current user (id, displayname, nickname, avatar, badges, …) |
| `token`                              | string   | x-rsi-token / x-tavern-id value                   |
| `gameToken`                          | string   | Used for in-game integration; ignore for now      |
| `playerId`                           | string?  | In-game character id when currently playing      |
| `roles`                              | object   | Map of `roleId → community` (global + per-community) |
| `communities`                        | array    | Joined communities — see below                    |
| `bookmarks`                          | array    | `{entity, type, name}` per bookmarked thread     |
| `private_lobbies`                    | array?   | DMs (we already use this)                         |
| `group_lobbies`                      | array?   | Private group chats                               |
| `party_lobby`                        | object?  | Current group-play party                          |
| `notifications`                      | array    | Recent native notifications (we already use this) |
| `notifications_unread`               | number   | Unread count                                      |
| `blocklist`                          | array?   | Blocked users                                     |
| `friend_requests`                    | array?   | Incoming pending requests (we already use this)  |
| `invites`                            | array?   | Pending lobby/group invites                       |
| `friends`                            | array?   | Confirmed friends                                 |
| `guide_requests` / `active_guide_sessions` | array? | Mentor program — out of scope for our use cases |
| `broadcast_message_subscription_key` | string   | WS topic for broadcast messages                   |
| `settings`                           | object   | User prefs (theme, presence_status, notification toggles, sort prefs) |
| `config`                             | object   | Server-side permissions schema                    |
| `gs, pf, nn, nh, nf`                 | bool     | Feature flags (gameservices, push, etc.)          |

### `communities[i]` shape

```ts
{
  id: string;              // numeric, e.g. "1" for the SC community
  type: string;            // "public" | "private" (orgs)
  slug: string;            // "SC" | "COLTRANS" | …
  name: string;            // "Star Citizen" | display name
  avatar: string;          // CDN URL
  banner: string;          // CDN URL (community header art)
  roles: object;           // role-membership for the current user
  lobbies: object;         // map keyed by lobby_id (NOT an array)
  forum_channel_groups: object; // map keyed by group_id (NOT an array)
}
```

⚠️ **Both `lobbies` and `forum_channel_groups` are objects keyed by
numeric ID, not arrays**. Iteration must use `Object.values()`. Only
the SC community appears in `communities` for our reference user even
though they're a member of two orgs — meaning **org-community channels
need a separate fetch path** (likely the org's slug from the user's
profile, then a community fetch). TBD; see "Open questions" below.

### `lobbies[lobbyId]` shape (chat channel)

```ts
{
  id: string;
  community_id: string;
  type: 'public' | 'private' | 'message-lobby' | 'group';
  name: string;            // "general", "becoming-a-citizen"
  description: string;
  color: string;            // hex without "#": "63A3E6"
  icon: string | null;
  online_members_count: number;
  permissions: object;
  subscription_key: string; // "community:1:message_lobby:22066:fee1b8b…"
  time_created: number;     // unix seconds
  // user-specific read state:
  latest: any | null;
  last_message: any | null;
  last_read: any | null;
  new_messages: number | null;
  blocked_recipients: array | null;
  active_guide_session: any | null;
  leader_id: string | null;
  members: any | null;
}
```

### `forum_channel_groups[groupId]` shape

```ts
{
  id: string;
  community_id: string;
  order: number;
  name: string;            // "Official", "Concierge", "Star Citizen"
  channels: array;          // forum channels in this group
}
```

### `forum_channel_groups[groupId].channels[i]` shape

```ts
{
  id: string;
  community_id: string;
  group_id: string;
  order: number;
  name: string;            // "Announcements"
  description: string;
  color: string;            // hex without "#"
  sort_filter: string;      // default sort
  label_required: boolean;  // some channels force a label on new threads
  threads_count: number;
  labels: array;            // available label tags for this channel
  subscription_key: string;
  permissions: object;
  notification_subscription: string; // user's current sub level
}
```

---

## Forum endpoints

### ✅ `forum/channel/threads` — list threads in a channel

POST `/api/spectrum/forum/channel/threads`

```json
{ "channel_id": "1", "page": 1, "sort": "hot", "label_id": null }
```

Response: `data.threads[]` with the same shape as `auth/identify`'s
forum thread data: `id, slug, subject, time_created, time_modified,
type, is_pinned, is_locked, is_erased, tracked_post_role_id,
highlight_role_id, member, replies_count, views_count, latest,
votes, reactions`, etc.

We already use this for DevTracker + Trending. Sort options observed:
`hot`, `top`, `new`, `last_activity`. Label filtering via `label_id`
(see `forum_channel_groups[].channels[].labels` for the IDs).

### ✅ `forum/thread/nested` — full thread + nested reply tree

POST `/api/spectrum/forum/thread/nested`

```json
{ "slug": "alpha-4-8-promote-your-organization", "sort": "votes", "target_reply_id": null }
```

Response `data` is a single thread object:

```ts
{
  id, time_created, time_modified, channel_id, label_id, type, slug,
  subject, is_locked, is_pinned, is_sinked, is_erased, is_reply_nesting_disabled,
  tracked_post_role_id, highlight_role_id,
  content_reply_id,           // OP body lives in this reply
  community_id,
  member,                     // author
  content_blocks: [...],      // structured content (DraftJS-style)
  replies_count, views_count,
  latest, latest_activity,
  votes, reactions,
  tracked_replies_references, children_replies_references,
  notification_subscription, subscription_key,
  nested_replies_ids: [string],  // FLAT list of every reply id in this thread
  replies: [Reply],              // first 25 top-level replies
  aspect: 'full' | 'summary',
}
```

Each `Reply` has roughly the same shape but scoped:

```ts
{
  id, thread_id, time_created, time_modified,
  member,                       // author
  content_blocks: [...],
  replies: [Reply],             // direct children (paginated)
  replies_count, children_replies_references, parent_reply_reference,
  votes, reactions, read,
  tracked_replies_references,
  is_erased, erased_by,
}
```

Sort options observed: `votes`, `time_created`. Pass a `target_reply_id`
to focus the response around a specific reply (useful for deep-linking
into long threads).

---

## Chat / lobby endpoints

The same set of endpoints serves **DMs**, **group lobbies**, and
**public chat channels**. The only difference is the lobby type
(`type: dm | group | public`) and which permissions apply.

### ✅ `message/history` — paginated messages

POST `/api/spectrum/message/history`

```json
{ "lobby_id": "5371439", "timeframe": "before", "message_id": null, "size": 50 }
```

Response: `data.messages[]`, each:

```ts
{
  id, time_created, time_modified,
  lobby_id, member_id,
  content_state: { blocks: [DraftJsBlock], entityMap: object },
  media_id: string,                  // empty when no attachment
  highlight_role_id: number | null,  // staff post highlight
  member: { id, displayname, nickname, avatar, signature, meta, isGM, presence, … },
}
```

Pagination: `timeframe: 'before' | 'after'` + `message_id` for
the cursor. `size` caps the page (50 is the SPA's default).

### ✅ `lobby/presences` — who's currently in a lobby

POST `/api/spectrum/lobby/presences`

```json
{ "lobby_id": "1" }
```

Response: `data[]` of member entries, including:

```ts
{
  id, displayname, nickname, avatar, signature,
  meta: {
    badges: [
      { name, icon, url? }   // org badges include the org URL
    ],
  },
  isGM: boolean,
  spoken_languages: [string],
  presence: { info: string | null, since: number, … },
}
```

### ✅ `lobby/online-members-count` — counts for every lobby in a community

POST `/api/spectrum/lobby/online-members-count`

```json
{ "community_id": "1" }
```

Response: `data.lobbies` — `{ [lobbyId]: number }`. Empty array
(`[]`) when the user has no permission. Useful for the sidebar
badges next to each chat channel.

### ✅ `lobby/getMotd` — channel message of the day

POST `/api/spectrum/lobby/getMotd`

```json
{ "lobby_id": "1" }
```

Response: `data.motd: { message: string, last_modified: number }`
where `message` is markdown.

### ✅ `lobby/guideSessionHistory` — past mentor sessions

POST `/api/spectrum/lobby/guideSessionHistory`

```json
{ "lobby_id": "5371439" }
```

Response: `data.sessions: []`. Mentor program — out of scope for the
extension.

### ✅ `community/fetch-emojis` — community-specific custom emojis

POST `/api/spectrum/community/fetch-emojis`

```json
{ "community_id": "1" }
```

Response: `data[]` of emoji entries with `id, short_name, name,
media_url, member` (the contributor). The SC community has hundreds;
org communities typically have 0.

### ✅ `broadcast-message/list` — community broadcasts

POST `/api/spectrum/broadcast-message/list` with `{}`.

Response: `data: []` typically. When non-empty, broadcasts are
short pinned announcements that appear at the top of the chat view.

### ✅ `notification/read-all` — clear all unread notifications

POST `/api/spectrum/notification/read-all` with `{}`.

We already use this. Returns success on dismissal.

### ✅ `v2/member/settings` — read user settings

POST `/api/spectrum/v2/member/settings` with `{}`.

Returns the same `settings` object that's embedded in `auth/identify`
(theme, presence_status, notification toggles, sort prefs). Useful
when we want to refresh settings without re-running identify.

---

## Endpoints we expect to exist but couldn't probe blind

These are visible in the SPA but couldn't be triggered from the
walkthrough above. Most likely paths to test in the implementation
phase:

- 🔍 **Send a message** — probably `message/send` or `lobby/send-message`.
  Body shape predictable: `{ lobby_id, content_state, media_id? }`.
  Capture by composing in any chat lobby.
- 🔍 **Mark thread / lobby as read** — `forum/thread/mark-read`,
  `lobby/mark-read`, or driven by setting `last_read_id` via a
  separate endpoint.
- 🔍 **Subscribe / unsubscribe to a thread** — there's a UI affordance
  ("subscribe to all replies" toggle); probably
  `forum/thread/subscribe` with `{slug, level}`.
- 🔍 **Bookmark / unbookmark** — probably `forum/thread/bookmark` or
  `bookmark/toggle`. The bookmarks list is in identify so writes are
  the missing piece.
- 🔍 **Vote on thread / reply** — there's a vote up/down arrow;
  probably `forum/thread/vote` and `forum/reply/vote`.
- 🔍 **Add reaction to message** — there are emoji reactions on chat
  messages and replies; probably `message/react` and
  `forum/reply/react`.
- 🔍 **Search** — Spectrum has a search bar on its mobile UI but not
  the desktop one we explored. Probably `forum/search` or `search`
  with `{ text, community_id, type }`.
- 🔍 **Friend request / accept / decline** — likely
  `member/friend/request`, `member/friend/accept`,
  `member/friend/decline`.
- 🔍 **Block / unblock a member** — `member/block`, `member/unblock`.

Probes against guessed paths in `notification/list`, `forum/search`,
`community/info`, `member/info`, `private-lobby/list`,
`group-lobby/list` — all returned the SPA HTML fallback. The exact
path names aren't intuitive; we'll discover them by triggering each
action through the official UI when implementing the corresponding
feature.

---

## Real-time / websockets

Every entity that updates in real time carries a `subscription_key`:

- Each lobby (chat channel / DM) — `community:1:message_lobby:22066:fee1…`
- Each forum thread — `community:1:forum_thread:544120:a803…`
- Each forum channel — also has its own key in
  `forum_channel_groups[].channels[].subscription_key`
- Global broadcasts — `broadcast_message_subscription_key` at the
  top level of identify

We did not capture WS frames during this Phase 0 pass. The next
follow-up should:

1. Open Spectrum, watch DevTools → Network → WS for the long-lived
   connection (likely `wss://robertsspaceindustries.com/spectrum-ws/…`
   or similar).
2. Watch a few seconds of traffic on a busy channel to see the frame
   format (probably `{ type, channel, payload }` JSON over WS).
3. Document the subscribe/unsubscribe message shapes.

For the extension this is **Phase 5 territory** — until we want
real-time chat, we can poll `message/history` on a 30-second cadence
when the chat tab is open and skip WS entirely.

---

## What this gives us — feature → endpoint mapping

| Phase | Feature                                  | Endpoints needed                                                   | Status |
| ----- | ---------------------------------------- | ------------------------------------------------------------------ | ------ |
| 1     | Visual refresh of existing 4 tabs        | (current set)                                                      | ready  |
| 2     | Forum browsing per channel               | `forum/channel/threads`, `forum/thread/nested`                     | ready  |
| 2     | Read a thread + nested replies           | `forum/thread/nested`                                              | ready  |
| 3     | Org/corp channel browsing                | `auth/identify` → `communities[].forum_channel_groups[].channels[]` + per-channel calls | partial — need second identify pass per joined org community |
| 4     | Bookmarks list (read-only)               | `auth/identify.bookmarks[]`                                        | ready  |
| 4     | Bookmark / unbookmark                    | 🔍 `forum/thread/bookmark` (TBD)                                   | discover via UI |
| 5     | Private groups read                      | `auth/identify.group_lobbies[]` + `message/history`                | ready  |
| 5     | Chat lobby read (public + DM + group)    | `message/history`, `lobby/presences`, `lobby/getMotd`, `lobby/online-members-count` | ready  |
| 6     | Compose / send a message                 | 🔍 `message/send` (TBD)                                            | discover via UI; **risk: write API** |
| 6     | Vote / react / subscribe                 | 🔍 several mutations TBD                                           | same risk class |
| 5+    | Real-time updates                        | websocket on `wss://robertsspaceindustries.com/...`                | needs separate WS-traffic capture pass |

---

## Open questions for the next conversation

1. **Org communities not in identify** — Kamille's badge shows
   COLTRANS membership but `communities[]` only contains SC. Either
   (a) identify only returns the user's "active" community and we
   need a per-org call to get COLTRANS' full structure, or (b) the
   user has to explicitly join a community on Spectrum (vs. just
   being an org member on the main RSI site) for it to show up.
   **Test path**: navigate to `/spectrum/community/COLTRANS` and watch
   the network — if a fresh identify-style call fires for the org
   slug, that's our answer.

2. **Search endpoint** — none of the guessed paths worked, and the
   desktop UI has no visible search bar to trigger it. **Test path**:
   open Spectrum on mobile (narrower viewport reveals a search
   affordance) or trigger via the URL `?q=hornet` to see what
   endpoint the SPA fires.

3. **Send-message + reaction mutations** — we deliberately avoided
   triggering writes during Phase 0 (would have left a real chat
   message on Kamille's account). Capture these in Phase 6 only,
   when we're actually building the compose UI and have a throwaway
   test thread to write to.

4. **WebSocket traffic** — needs its own session with the Network →
   WS tab open. Quick to do; ~10 minutes once we want real-time.

---

## Roadmap (recap from chat)

| Phase | Scope                                                                                          | Effort   | Risk |
| ----- | ---------------------------------------------------------------------------------------------- | -------- | ---- |
| 0     | This document                                                                                  | done     | none |
| 1     | Refonte visuelle des 4 onglets actuels                                                         | 1-2 sessions | low |
| 2     | Forums browsing — channels list → threads list → read thread (read-only, replies inclus)       | 3-4 sessions | low |
| 3     | Org/corp channel browsing                                                                      | 2-3 sessions | low after open question 1 |
| 4     | Bookmarks read + write                                                                         | 1-2 sessions | low |
| 5     | Private groups + public chat read                                                              | 2-3 sessions | medium (heavy data, polling cadence to tune) |
| 6     | Compose: send messages, vote, react                                                            | 3-4 sessions | **high — write API; CIG tolerance unclear** |
| 5+    | Real-time via websocket                                                                        | 2 sessions  | medium |

Phase 6 is the eth threshold. Historically CIG has tolerated
read-only scraping (RSI Companion has been around since 2020 without
a single C&D) but writes from a third-party client are a different
risk profile — to be discussed before any code lands in that phase.
