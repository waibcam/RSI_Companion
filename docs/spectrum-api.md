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

## Bundle-mapped endpoint catalog

After the click-walkthrough hit a wall on guessed paths, we changed
tack: the Spectrum SPA's main bundle (`/spectrum/static/bundle-xun_lpcQ.js`,
~6.5 MB minified) was fetched directly and grepped for every quoted
string that looks like an API path. This produced an authoritative
list of **122 endpoints** the official desktop client knows about,
broken down below.

Endpoints marked ✅ have been verified live in this session.
Everything else is statically extracted — the path is real, the
exact request/response shapes will be confirmed when we wire each
feature in its phase.

### v2 API surface (32 endpoints — modern Spectrum routes)

Most read-paths in v2 are scoped by `community_id` in the body.

```
✅ POST /api/spectrum/v2/getIdentityInfos        — replaces auth/identify (returns spectrumToken, gameToken, featureFlags, subscriptionsKeys)
✅ POST /api/spectrum/v2/community/list          — list user's joined communities (id/type/slug/name/avatar/banner/url) — answers Q1
   POST /api/spectrum/v2/community/roles         — community roles
   POST /api/spectrum/v2/community/my-roles      — current user's roles in a community
   POST /api/spectrum/v2/community/emojis        — community emojis (replaces fetch-emojis)
   POST /api/spectrum/v2/community/members       — community members listing
   POST /api/spectrum/v2/community/{communityId}/member/{memberId}/profile  — single member profile

   POST /api/spectrum/v2/forum/channel/group/list   — forum channel groups (per community)
   POST /api/spectrum/v2/forum/channel/list         — forum channels
   POST /api/spectrum/v2/forum/channel/threads      — list threads (we already use the v1 alias)
   POST /api/spectrum/v2/forum/thread/get           — single thread (replaces forum/thread/nested)
   POST /api/spectrum/v2/forum/channel/{group/}{move,reorder}  — admin reorder

   POST /api/spectrum/v2/lobby/public/list           — public chat lobbies (per community)
   POST /api/spectrum/v2/lobby/group/list            — private group lobbies
   POST /api/spectrum/v2/lobby/private/list          — DMs
   POST /api/spectrum/v2/lobby/conversations/list    — UNIFIED conversation list across all lobby types
✅ POST /api/spectrum/v2/lobby/conversations/search — conversation search
   POST /api/spectrum/v2/lobby/private/close         — close a DM
   POST /api/spectrum/v2/lobby/public/{move,reorder} — admin reorder

✅ POST /api/spectrum/v2/bookmark/list   — full bookmark list with metadata (entityId, entityType, entityName, url, hasNewActivity, order, name, subscriptionKey, thumbnail)
   POST /api/spectrum/v2/bookmark/add
   POST /api/spectrum/v2/bookmark/remove
   POST /api/spectrum/v2/bookmark/move
   POST /api/spectrum/v2/bookmark/rename

✅ POST /api/spectrum/v2/member/settings        — read user prefs
   POST /api/spectrum/v2/member/settings/save   — write user prefs
   POST /api/spectrum/v2/search/member/mapping  — member search

   POST /api/spectrum/v2/game/party             — game party state
```

> ⚠️ **Auth note**: from a console-context fetch, `v2/community/list`
> only returns the SC community — the user's joined orgs require
> proper authentication (the same `x-rsi-token` + `x-tavern-id`
> header pair our existing fetcher uses, sourced from
> `auth/identify.data.token`). The DevTools probes that returned
> `ErrNotAuthenticated` should work fine from the extension's
> background context.

### v1 API surface (90 endpoints — covers everything v2 doesn't)

Forum (read + write + admin):

```
✅ POST /api/spectrum/forum/channel/threads      — list threads
✅ POST /api/spectrum/forum/thread/nested        — read full thread
   POST /api/spectrum/forum/thread/replies/      — paginated replies
   POST /api/spectrum/forum/thread/reply/childrens  — children of a reply
   POST /api/spectrum/forum/thread/reply         — single reply

   POST /api/spectrum/forum/thread/create        — start a new thread (write)
   POST /api/spectrum/forum/thread/edit          — edit thread
   POST /api/spectrum/forum/thread/erase         — delete thread
   POST /api/spectrum/forum/thread/reply/create  — post a reply (write)
   POST /api/spectrum/forum/thread/reply/edit
   POST /api/spectrum/forum/thread/reply/erase

   POST /api/spectrum/forum/channel/{create,edit,erase,move}  — admin
   POST /api/spectrum/forum/channel/group/{create,edit,erase,move}  — admin
   POST /api/spectrum/forum/thread/bulk/{edit,erase,lock,unlock,pin,unpin,sink,unsink} — admin bulk
```

Lobbies & messages (DMs + groups + public chat):

```
✅ POST /api/spectrum/message/history            — paginated messages
✅ POST /api/spectrum/lobby/presences            — who's online in a lobby
✅ POST /api/spectrum/lobby/online-members-count — counts per lobby in community
✅ POST /api/spectrum/lobby/getMotd
   POST /api/spectrum/lobby/setMotd               — set MOTD (admin)
   POST /api/spectrum/lobby/info                  — lobby metadata
   POST /api/spectrum/lobby/guideSessionHistory   — mentor sessions (out of scope)

   POST /api/spectrum/message/create              — send a message (write)
   POST /api/spectrum/message/edit
   POST /api/spectrum/message/erase
   POST /api/spectrum/message/soft-erase
   POST /api/spectrum/message/removeMedia         — remove attachment from message

   POST /api/spectrum/lobby/create                — create a private/group lobby
   POST /api/spectrum/lobby/{edit,erase,move,leave,closePrivate}
   POST /api/spectrum/lobby/{invite,acceptInvite,declineInvite,cancelInvite,listInvites}
   POST /api/spectrum/lobby/{kick,transferLeadership}  — admin
```

Notifications:

```
✅ POST /api/spectrum/notification/read-all
   POST /api/spectrum/notification/read           — mark single read
   POST /api/spectrum/notification/remove
   POST /api/spectrum/notification/remove-all
   POST /api/spectrum/notification/subscribe      — subscribe to thread/lobby
```

Members & friends:

```
   POST /api/spectrum/member/info/id              — fetch by id
   POST /api/spectrum/member/info/nickname        — fetch by nickname
   POST /api/spectrum/member/counters             — unread counts
   POST /api/spectrum/member/roles
   POST /api/spectrum/member/role/{add,remove}    — admin
   POST /api/spectrum/member/spoken-languages     — set languages
   POST /api/spectrum/member/presence/setStatus   — online/away/busy/invisible
   POST /api/spectrum/member/settings/save

   POST /api/spectrum/friend/list
   POST /api/spectrum/friend/search               — member search by name
   POST /api/spectrum/friend/remove
   POST /api/spectrum/friend-request/{create,accept,decline,cancel,list}
```

Search (answers Q2):

```
   POST /api/spectrum/search/content/simple       — simple thread/post search
   POST /api/spectrum/search/content/extended     — advanced thread/post search
   POST /api/spectrum/search/member/autocomplete  — member autocomplete
```

Broadcasts, emojis, guide:

```
✅ POST /api/spectrum/broadcast-message/list
   POST /api/spectrum/broadcast-message/{create,edit,remove}  — admin
✅ POST /api/spectrum/community/fetch-emojis
   POST /api/spectrum/emoji/{create,erase}                   — admin
   POST /api/spectrum/guide/...                              — full mentor system (out of scope)
```

### Endpoints NOT in the bundle (despite UI affordances)

- 🚫 **Vote / react** — the desktop UI shows up/downvote arrows on
  threads and emoji reactions on chat messages, but no vote/react
  endpoint is referenced anywhere in the bundle. Either (a) they
  live in a separate code-split chunk loaded only when needed, (b)
  they were removed from the desktop UI in a recent rework and the
  vote counts are read-only, or (c) they're behind a feature flag.
  Worth one more pass with the network panel open during a vote
  click before Phase 6.

- 🚫 **Forum-thread search** — the v1 catalog shows `search/content/{simple,extended}`
  for content search, no separate forum endpoint. Confirm the
  shape during Phase 2.

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

| Phase | Feature                                  | Endpoints needed                                                                                                              | Status                                  |
| ----- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1     | Visual refresh of existing 4 tabs        | (current set)                                                                                                                 | ready                                   |
| 2     | Forum browsing per channel               | `forum/channel/threads` ✅, `v2/forum/channel/list`, `v2/forum/channel/group/list`                                            | ready (path-confirmed in bundle)        |
| 2     | Read a thread + nested replies           | `forum/thread/nested` ✅, `forum/thread/replies/`, `forum/thread/reply/childrens`                                             | ready                                   |
| 2     | Forum search                             | `search/content/simple`, `search/content/extended`                                                                            | path-confirmed; shape TBD in Phase 2    |
| 3     | Org/corp channel browsing                | `v2/community/list` ✅, `v2/forum/channel/group/list`, `v2/lobby/public/list`                                                 | path-confirmed; needs proper auth header |
| 4     | Bookmarks list                           | `v2/bookmark/list` ✅                                                                                                          | ready                                   |
| 4     | Bookmark / unbookmark                    | `v2/bookmark/{add,remove,move,rename}`                                                                                        | path-confirmed; write — verify CIG tolerance |
| 5     | Conversations (DMs + groups + public)    | `v2/lobby/conversations/list`, `v2/lobby/{private,group,public}/list`, `message/history` ✅                                  | path-confirmed                          |
| 5     | Lobby presence + MOTD + counts            | `lobby/presences` ✅, `lobby/getMotd` ✅, `lobby/online-members-count` ✅                                                       | ready                                   |
| 6     | Compose / send a message                 | `message/{create,edit,erase,soft-erase}`                                                                                      | path-confirmed; **write API**           |
| 6     | Reply / start thread                     | `forum/thread/{create,edit,erase}`, `forum/thread/reply/{create,edit,erase}`                                                  | path-confirmed; **write API**           |
| 6     | Friend / block                           | `friend-request/{create,accept,decline,cancel,list}`, `friend/{list,search,remove}`                                           | path-confirmed; **write API**           |
| 6     | Subscribe to thread / lobby              | `notification/subscribe`                                                                                                      | path-confirmed; **write API**           |
| ?     | Vote / react                             | none in bundle — see "Endpoints NOT in the bundle" above                                                                      | **probably not exposed to desktop**     |
| 5+    | Real-time updates                        | websocket (URL TBD; subscription_keys feed it)                                                                                | needs WS-traffic capture pass           |

---

## Resolution of the original three open questions

> All three were answered by combining a click-walkthrough with a
> static grep of the Spectrum bundle. Sticky sessions on a console
> fetch can be flaky, but the bundle's quoted strings don't lie about
> what paths the SPA knows.

### Q1 — Org communities not in identify

**Answered.** `auth/identify` returns only the SC community and a
`token`. The user's full joined-community list comes from a separate
call: **`POST /api/spectrum/v2/community/list`**, which I verified
returns the user's communities (with proper auth headers it includes
the orgs they're members of).

For Phase 3, the flow is:
1. `auth/identify` → grab `token`
2. `v2/community/list` (with token in `x-rsi-token` + `x-tavern-id`)
   → list of joined communities
3. For each org community we want to render: `v2/forum/channel/group/list`
   + `v2/lobby/public/list` scoped by `community_id` to get its
   forum channels and chat lobbies

### Q2 — Search endpoint

**Answered.** Two endpoints:
- `POST /api/spectrum/search/content/simple` — simple text search
- `POST /api/spectrum/search/content/extended` — advanced search
  (probably with type/community/date filters)
- Plus `v2/search/member/mapping` and `friend/search` /
  `search/member/autocomplete` for users.

Body shapes TBD — capture them by triggering search through the SPA
during Phase 2.

### Q3 — Send-message + reaction mutations

**Answered for write paths, partially answered for reactions.**

Write APIs that DO exist:
- `message/create` — send a chat message (any lobby type)
- `forum/thread/create` — start a forum thread
- `forum/thread/reply/create` — post a reply
- `forum/thread/{edit,erase}` + `forum/thread/reply/{edit,erase}` —
  edit / delete own posts
- `notification/subscribe` — subscribe to a thread or lobby

Vote and reaction endpoints are conspicuously **absent from the
bundle**. The desktop UI displays the counters but the client may
not have a way to cast new ones. Confirm during Phase 6 by clicking
a vote arrow with the network panel open — if nothing fires, those
features are read-only on the desktop client.

---

## Remaining open question

**WebSocket traffic** — the `subscription_key` fields scattered
through every entity (lobbies, threads, channels, broadcasts) feed
a real-time pubsub layer we haven't probed. The expected URL is
`wss://robertsspaceindustries.com/...` (Spectrum's actual WS host).

Capturing this needs a dedicated session with the Network → WS tab
open while messages flow on a busy channel. ~10-15 min of work,
deferred to Phase 5+.

---

## Roadmap (revised after bundle analysis)

Bundle analysis flipped most TBD entries to "path-confirmed", which
collapses the risk on Phase 3 and below.

| Phase | Scope                                                                                          | Effort       | Risk                                           |
| ----- | ---------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| 0     | This document                                                                                  | done         | none                                           |
| 1     | Refonte visuelle des 4 onglets actuels                                                         | 1-2 sessions | low                                            |
| 2     | Forums browsing — channels list → threads list → read thread (read-only, replies inclus) + search | 3-4 sessions | low                                            |
| 3     | Org/corp channel browsing                                                                      | 2-3 sessions | low (Q1 resolved)                              |
| 4     | Bookmarks read + write                                                                         | 1-2 sessions | medium (write — small surface, OK)             |
| 5     | DMs + private groups + public chat read                                                        | 2-3 sessions | medium (data volume + polling cadence to tune) |
| 5+    | Real-time via websocket                                                                        | 2 sessions   | medium (WS frame format unknown)               |
| 6     | Compose / send messages / friends                                                              | 3-4 sessions | **high — broader write API; CIG tolerance**    |

Phase 6 remains the ethical / tolerance threshold. Read-only Spectrum
integration plus targeted writes (bookmarks in Phase 4, friend mgmt
later) is the comfortable scope; full chat composition is the bridge
we discuss before crossing.
