// Typed message protocol between the popup UI and the background service worker.
// The background owns all RSI fetches + cache. The popup only sends requests.

import type { BuyBackPledge } from './rsi/buyback.js';
import type {
  CommLinkArticle,
  CommLinkFormOptions,
  CommLinkSearchParams,
  CommLinkSort,
} from './rsi/commlink.js';
import type {
  CommunityHubEvent,
  CommunityHubLivePost,
  CommunityHubPost,
  CommunityHubPostFilters,
  CommunityHubSort,
  CommunityHubTab,
  CommunityHubType,
} from './rsi/community-hub.js';
import type {
  GalactapediaArticle,
  GalactapediaArticleFull,
  GalactapediaCategory,
  GalactapediaHomepage,
  GalactapediaTag,
} from './rsi/galactapedia.js';
import type { Contact, ContactRequest, MemberHit } from './rsi/contacts.js';
import type { PatchNote } from './rsi/patch-notes.js';
import type {
  CcuCatalogue,
  CcuTargetsResult,
  PledgeCart,
  PledgeManufacturer,
  PledgeShip,
  PledgeShipDetail,
  StoreBrowseResult,
  StoreCategoryId,
} from './rsi/pledge.js';
import type { DashboardSummary } from './rsi/dashboard.js';
import type { MyOrg, OrgMember, PublicOrg, PublicOrgSearchParams } from './rsi/orgs.js';
import type { RsiIdentity } from './rsi/auth.js';
import type { Ship } from './rsi/ships.js';
import type {
  SpectrumBookmark,
  SpectrumCommunity,
  SpectrumEmoji,
  SpectrumForumGroup,
  SpectrumLobby,
  SpectrumMessage,
  SpectrumNotification,
  SpectrumSearchHit,
  SpectrumSort,
  SpectrumThread,
  SpectrumThreadDetail,
} from './rsi/spectrum.js';
import type { CrowdfundStats, ReferralStats } from './rsi/stats.js';
import type { RsiStatusSummary } from './rsi/status.js';
import type { NotifyModule, NotifyState } from './notify.js';

export interface IdentityRequest {
  type: 'auth.identity';
  /** If true, bypass cache. */
  force?: boolean;
}
export interface IdentityResponse {
  identity: RsiIdentity | null;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface CommLinkRequest {
  type: 'commlink.list';
  page: number;
  /** Channel filter slug (e.g. "transmission"). Empty / undefined = all. */
  channel?: string;
  /** Series filter slug (e.g. "inside"). Empty / undefined = all. */
  series?: string;
  /** Type filter ("post" | "slideshow" | "video" | "poll"). Empty = all. */
  articleType?: string;
  /** Free text search. */
  text?: string;
  /** Sort order. Defaults to 'publish_new'. */
  sort?: CommLinkSort;
  force?: boolean;
}
export interface CommLinkResponsePayload {
  page: number;
  articles: CommLinkArticle[];
  /** Dropdown options scraped from the same page. The UI uses these to
   *  populate the filter form without hardcoding slugs that RSI can rename. */
  options: CommLinkFormOptions;
  fetchedAt: number;
  fromCache: boolean;
}

export interface ShipsRequest {
  type: 'ships.list';
  force?: boolean;
}
export interface ShipsResponsePayload {
  ships: Ship[];
  loanerIds: number[];
  ownedCount: number;
  notFound: string[];
  /** Every ship-like name the hangar scraper extracted on this run,
   *  before matching against the ship matrix. Used by the "Copy
   *  hangar dump" button to produce a shareable debug snapshot —
   *  lets maintainers see what RSI actually returned without asking
   *  the user to type each row by hand. Empty when the user isn't
   *  signed in (no hangar to scrape). */
  rawHangarNames: string[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface ContactsRequest {
  type: 'contacts.list';
  force?: boolean;
}
export interface ContactsResponsePayload {
  contacts: Contact[];
  incoming: ContactRequest[];
  outgoing: ContactRequest[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface ContactsSearchRequest {
  type: 'contacts.search';
  query: string;
}
export interface ContactsSearchResponsePayload {
  hits: MemberHit[];
}

export interface ContactsActionRequest {
  type: 'contacts.action';
  action: 'accept' | 'decline' | 'cancel' | 'send' | 'remove';
  /** request_id for accept/decline/cancel; member_id for send/remove. */
  id: number;
}
export interface ContactsActionResponsePayload {
  ok: true;
}

/** Send a contact request to an RSI handle when only the nickname is
 *  known — the Orgs module scrapes member rows from HTML which doesn't
 *  expose the numeric member id that the friend-request endpoint
 *  needs. The background handler does a two-step resolve:
 *    1. `searchMembers(nickname)` → MemberHit[]
 *    2. exact-match on nickname (case-insensitive) → MemberHit.id
 *    3. `sendFriendRequest(id)`
 *  Returns `sent: false` with a reason when the lookup doesn't find a
 *  match (very rare — member hidden their profile since the scrape,
 *  typo in the nickname) so the UI can surface a useful error. */
export interface ContactsSendByNicknameRequest {
  type: 'contacts.sendByNickname';
  nickname: string;
}
export interface ContactsSendByNicknameResponsePayload {
  sent: boolean;
  /** Present when `sent: false`. */
  reason?: 'not_found';
}

/** Mirror the signed-in LIVE friend list onto the PTU account by
 *  sending friend-requests for anyone missing on PTU. The handler does
 *  the whole diff + fan-out in one call:
 *    1. Read LIVE friends (from the cached identify).
 *    2. Fetch PTU friends + pending requests fresh.
 *    3. For each LIVE friend absent from PTU (and not already pending):
 *         a. PTU member autocomplete on the nickname.
 *         b. If an exact-match hit exists, send a PTU friend-request.
 *    4. Return a per-row summary so the popup can render a log + totals.
 *  `signedIn` short-circuits the two common failure modes (no LIVE
 *  cookie → live: false, no PTU cookie → ptu: false) so the UI can
 *  direct the user to sign in on the right site before retrying. */
export interface ContactsSyncToPtuRequest {
  type: 'contacts.syncToPtu';
}
export interface ContactsSyncToPtuEntry {
  nickname: string;
  displayName: string;
  avatar: string;
  status: 'added' | 'alreadyFriend' | 'alreadyPending' | 'notFound' | 'error';
  /** Present when status is 'error' — short explanation for the log row. */
  error?: string;
}
export interface ContactsSyncToPtuResponsePayload {
  signedIn: { live: boolean; ptu: boolean };
  /** Absent when either side is not signed in. */
  entries?: ContactsSyncToPtuEntry[];
  counts?: {
    added: number;
    alreadyFriend: number;
    alreadyPending: number;
    notFound: number;
    error: number;
  };
}

export interface OrgsRequest {
  type: 'orgs.myList';
  force?: boolean;
}
export interface OrgsResponsePayload {
  orgs: MyOrg[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface OrgsInvitationsRequest {
  type: 'orgs.invitations';
  force?: boolean;
}
export interface OrgsInvitationsResponsePayload {
  orgs: MyOrg[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface OrgsApplicationsRequest {
  type: 'orgs.applications';
  force?: boolean;
}
export interface OrgsApplicationsResponsePayload {
  orgs: MyOrg[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface OrgsSearchRequest extends PublicOrgSearchParams {
  type: 'orgs.search';
  force?: boolean;
}
export interface OrgsSearchResponsePayload {
  orgs: PublicOrg[];
  totalRows: number;
  page: number;
  fetchedAt: number;
  fromCache: boolean;
}

export interface OrgMembersRequest {
  type: 'orgs.members';
  sid: string;
  force?: boolean;
}
export interface OrgMembersResponsePayload {
  sid: string;
  members: OrgMember[];
  totalRows: number;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumRequest {
  type: 'spectrum.threads';
  force?: boolean;
}
export interface SpectrumResponsePayload {
  threads: SpectrumThread[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumTrendingRequest {
  type: 'spectrum.trending';
  force?: boolean;
}
export interface SpectrumTrendingResponsePayload {
  threads: SpectrumThread[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumNotificationsRequest {
  type: 'spectrum.notifications';
  force?: boolean;
}
export interface SpectrumNotificationsResponsePayload {
  notifications: SpectrumNotification[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumMarkReadRequest {
  type: 'spectrum.markRead';
}
export interface SpectrumMarkReadResponsePayload {
  ok: true;
}

export interface SpectrumNotifMarkReadRequest {
  type: 'spectrum.notifMarkRead';
  /** Native server notification id. Synthetic client-side ids
   *  (`private-…`, `friend-…`) are rejected up-front by the BG handler. */
  notificationId: string;
}
export interface SpectrumNotifMarkReadResponsePayload {
  ok: true;
}

export interface SpectrumNotifRemoveRequest {
  type: 'spectrum.notifRemove';
  notificationId: string;
}
export interface SpectrumNotifRemoveResponsePayload {
  ok: true;
}

export interface SpectrumVoteRequest {
  type: 'spectrum.vote';
  entityType: 'forum_thread' | 'forum_thread_reply';
  entityId: number;
  action: 'add' | 'remove';
}
export interface SpectrumVoteResponsePayload {
  ok: true;
}

export interface SpectrumReactRequest {
  type: 'spectrum.react';
  /** `message` covers DM/chat reactions; the two forum types cover
   *  thread-level + reply-level forum reactions. */
  entityType: 'forum_thread' | 'forum_thread_reply' | 'message';
  entityId: number;
  /** Shortcode form, e.g. ':+1:' or ':heart:'. */
  reactionType: string;
  action: 'add' | 'remove';
}
export interface SpectrumReactResponsePayload {
  ok: true;
}

export interface SpectrumSubscribeRequest {
  type: 'spectrum.subscribe';
  entityType: 'forum_thread' | 'forum_channel' | 'message_lobby';
  entityId: number;
  /** 'all' = watch every new post; 'disabled' = no notifications.
   *  Legacy threads can also accept 'mentions' / 'highlights' but the
   *  desktop UI only exposes all/disabled. */
  level: 'all' | 'disabled' | 'mentions' | 'highlights';
}
export interface SpectrumSubscribeResponsePayload {
  ok: true;
}

export interface SpectrumLobbiesRequest {
  type: 'spectrum.lobbies';
  force?: boolean;
}
export interface SpectrumLobbiesResponsePayload {
  lobbies: SpectrumLobby[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumCommunitiesRequest {
  type: 'spectrum.communities';
  force?: boolean;
}
export interface SpectrumCommunitiesResponsePayload {
  communities: SpectrumCommunity[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumForumGroupsRequest {
  type: 'spectrum.forumGroups';
  /** SC (id=1) by default. Pass any joined org community id to browse
   *  its forum tree instead. */
  communityId?: number;
  force?: boolean;
}
export interface SpectrumForumGroupsResponsePayload {
  groups: SpectrumForumGroup[];
  communityId: number;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumEmojisRequest {
  type: 'spectrum.emojis';
  communityId?: number;
  force?: boolean;
}
export interface SpectrumEmojisResponsePayload {
  emojis: SpectrumEmoji[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumSearchRequest {
  type: 'spectrum.search';
  text: string;
  /** Defaults to SC (1) when omitted. */
  communityId?: number;
}
export interface SpectrumSearchResponsePayload {
  hits: SpectrumSearchHit[];
  signedIn: boolean;
  fetchedAt: number;
}

export interface SpectrumLobbyMessagesRequest {
  type: 'spectrum.lobbyMessages';
  lobbyId: number;
  /** Optional cursor — fetch messages older than this id (for paging
   *  upward) or newer than this id (for fresh-poll). MVP UI doesn't
   *  page, so callers usually omit both. */
  before?: number;
  after?: number;
  size?: number;
  force?: boolean;
}
export interface SpectrumLobbyMessagesResponsePayload {
  messages: SpectrumMessage[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumBookmarksRequest {
  type: 'spectrum.bookmarks';
  force?: boolean;
}
export interface SpectrumBookmarksResponsePayload {
  bookmarks: SpectrumBookmark[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumBookmarkAddRequest {
  type: 'spectrum.bookmarkAdd';
  entityId: number;
  /** Spectrum entity tag — `forum_thread` for OPs, `forum_channel` for
   *  whole channels, `message_lobby` for DMs (when we surface that). */
  entityType: string;
}
export interface SpectrumBookmarkAddResponsePayload {
  /** Refreshed list — saves the popup a follow-up fetch. */
  bookmarks: SpectrumBookmark[];
}

export interface SpectrumBookmarkRemoveRequest {
  type: 'spectrum.bookmarkRemove';
  entityId: number;
  entityType: string;
}
export interface SpectrumBookmarkRemoveResponsePayload {
  /** Refreshed list — saves the popup a follow-up fetch. */
  bookmarks: SpectrumBookmark[];
}

export interface SpectrumThreadDetailRequest {
  type: 'spectrum.threadDetail';
  slug: string;
  /** 'votes' (default — matches the Spectrum desktop default) or
   *  'time_created' for chronological. */
  sort?: 'votes' | 'time_created';
  force?: boolean;
}
export interface SpectrumThreadDetailResponsePayload {
  thread: SpectrumThreadDetail | null;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface SpectrumForumThreadsRequest {
  type: 'spectrum.forumThreads';
  /** SC by default; required for org channels so the background can
   *  look up the channel slug + community slug to build thread URLs. */
  communityId?: number;
  channelId: number;
  /** Defaults to 'hot' to match the desktop SPA's default sort. */
  sort?: SpectrumSort;
  force?: boolean;
}
export interface SpectrumForumThreadsResponsePayload {
  threads: SpectrumThread[];
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface DashboardRequest {
  type: 'dashboard.summary';
  force?: boolean;
}
export interface DashboardResponsePayload {
  summary: DashboardSummary | null;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface BuyBackRequest {
  type: 'buyback.list';
  page: number;
  force?: boolean;
}
export interface BuyBackResponsePayload {
  pledges: BuyBackPledge[];
  hasNextPage: boolean;
  page: number;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface PatchNotesRequest {
  type: 'patchnotes.list';
  page: number;
  force?: boolean;
}
export interface PatchNotesResponsePayload {
  page: number;
  notes: PatchNote[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface PledgeShipListRequest {
  type: 'pledge.shipList';
  /** When false, include non-purchasable SKUs (limited editions, closed
   *  concept sales). Defaults to true = only actively-purchasable ships. */
  onlyOnSale?: boolean;
  force?: boolean;
}
export interface PledgeShipListResponsePayload {
  ships: PledgeShip[];
  manufacturers: PledgeManufacturer[];
  totalCount: number;
  fetchedAt: number;
  fromCache: boolean;
}

/** Full ship detail (spec sheet, body, components, variants). Fires when
 *  the user opens the inline ship reader. Can be called by either slug
 *  (DatoCMS, already known in PledgeStore) or by name (Ships matrix /
 *  CCU catalogue only know the display name — the handler looks the
 *  slug up against the cached pledge ship list). */
export interface PledgeShipDetailRequest {
  type: 'pledge.shipDetail';
  /** Prefer this — no lookup needed. */
  slug?: string;
  /** Fallback for callers that don't have the slug (Ship Matrix, CCU). */
  name?: string;
  /** Secondary lookup hint. RSI's ship-matrix URL (`/pledge/ships/<brand>/<ship>`)
   *  matches byte-for-byte between the matrix REST and the pledge GraphQL
   *  list, so URL comparison resolves ships whose display names drift
   *  between the two sources (e.g. "Sabre Comet" in matrix vs "Comet"
   *  in pledge). Supply alongside `name` for the most robust lookup. */
  url?: string;
  force?: boolean;
}
export interface PledgeShipDetailResponsePayload {
  detail: PledgeShipDetail | null;
  /** Echoed slug that was used for the fetch — useful when the caller
   *  passed `name` and wants to remember the resolved slug. */
  slug: string | null;
  fetchedAt: number;
  fromCache: boolean;
}

/** Generic pledge-store browse query for one category (Ship Packs, Game
 *  Packages, Paints, Gear, Merchandise, Add-Ons, Event Tickets, Gift
 *  Cards, UEC). The Ships category is served by pledge.shipList because
 *  its GraphQL response shape is richer.
 *
 *  `tagIdentifiers` narrows to sub-filters within a category (e.g. Gear
 *  → armor / clothing / equipment; Paints → standard / premium /
 *  limited-time). The cache key includes these so each combination is
 *  memoized independently. */
export interface PledgeBrowseRequest {
  type: 'pledge.browse';
  categoryId: StoreCategoryId;
  tagIdentifiers?: string[];
  force?: boolean;
}
export interface PledgeBrowseResponsePayload {
  categoryId: StoreCategoryId;
  result: StoreBrowseResult;
  fetchedAt: number;
  fromCache: boolean;
}

/** CCU catalogue (full ship list + server-side owned flags). Fire once per
 *  session; the backend caches 30 min and wipes on sign-in/out via the
 *  auth-dependent cache prefix. */
export interface PledgeCcuInitRequest {
  type: 'pledge.ccuInit';
  force?: boolean;
}
export interface PledgeCcuInitResponsePayload {
  catalogue: CcuCatalogue;
  fetchedAt: number;
  fromCache: boolean;
}

/** CCU target resolver — given a source ship id, return the ids that are
 *  reachable as upgrade targets plus their real `upgradePrice`. */
export interface PledgeCcuTargetsRequest {
  type: 'pledge.ccuTargets';
  /** Source ship id. Pass null to fetch the unrestricted catalogue. */
  fromId: number | null;
  force?: boolean;
}
export interface PledgeCcuTargetsResponsePayload {
  fromId: number | null;
  result: CcuTargetsResult;
  fetchedAt: number;
  fromCache: boolean;
}

/** Remove a single line item from the cart. The (`skuId`, `identifier`)
 *  pair uniquely targets a line — CCU line items share a skuId across
 *  "same target from different source ships" rows and need the
 *  identifier to disambiguate. Plain items pass an empty string. */
export interface PledgeRemoveFromCartRequest {
  type: 'pledge.removeFromCart';
  skuId: string;
  identifier: string;
}
export interface PledgeRemoveFromCartResponsePayload {
  ok: true;
}

/** Nuke the whole cart. Destructive; the UI confirms before calling. */
export interface PledgeClearCartRequest {
  type: 'pledge.clearCart';
}
export interface PledgeClearCartResponsePayload {
  ok: true;
}

/** Read the current pledge-store cart (items, totals, currency). Volatile
 *  — the cart changes on add-to-cart + on external checkouts — so we
 *  cache for a minute at most. The user-side Refresh button forces a
 *  fresh fetch. */
export interface PledgeCartRequest {
  type: 'pledge.cart';
  force?: boolean;
}
export interface PledgeCartResponsePayload {
  cart: PledgeCart;
  fetchedAt: number;
  fromCache: boolean;
}

/** Add a non-CCU store item to the user's pledge cart — paints, gear,
 *  game packages, merch, add-ons, tickets, gift cards, UEC, or a
 *  specific ship SKU. Uses the `AddCartMultiItemMutation` on /graphql
 *  (different endpoint / shape from the CCU add flow).
 *
 *  For ships specifically the caller is responsible for picking which
 *  SKU variant to add (Standalone vs Warbond vs LTI etc.) — the
 *  ShipReader's "Editions" section exposes these and calls this message
 *  per SKU. */
export interface PledgeAddToCartRequest {
  type: 'pledge.addToCart';
  skuId: string;
  qty: number;
}
export interface PledgeAddToCartResponsePayload {
  ok: true;
}

/** Add a CCU line item (from ship → target sku) to the user's pledge cart.
 *
 *  Uncached, side-effectful — unlike the other pledge.* messages this one
 *  mutates server state (commits a line item to the user's real cart) and
 *  is fired on user click, not prefetch. Callers gate the button on
 *  `authState.signedIn` so anonymous users never see it. */
export interface PledgeCcuAddToCartRequest {
  type: 'pledge.ccuAddToCart';
  /** Source ship id — same value as `filterShips`' `fromId`. */
  fromShipId: number;
  /** Destination **SKU** id (from `filterShips.to.ships[].skus[].id`). */
  toSkuId: number;
}
export interface PledgeCcuAddToCartResponsePayload {
  /** Always true when the handler resolves — errors reject the promise
   *  so the popup can show the message via the standard error banner. */
  ok: true;
}

export interface StatsSummaryRequest {
  type: 'stats.summary';
  force?: boolean;
}
export interface StatsSummaryResponse {
  crowdfund: CrowdfundStats;
  referral: ReferralStats | null;
  buyBackTokens: number | null;
  signedIn: boolean;
  fetchedAt: number;
  fromCache: boolean;
}

export interface RoadmapSnapshotEntry {
  /** Last-seen release id for this card. */
  releaseId: number;
  /** Last-seen category id. */
  categoryId: number;
  /** Last-seen display name (used when the card is removed). */
  name: string;
}
export interface RoadmapSnapshotRequest {
  type: 'roadmap.snapshot';
}
export interface RoadmapSnapshotResponse {
  /** null on first ever run — no diff baseline yet. */
  snapshot: Record<string, RoadmapSnapshotEntry> | null;
}

/** Commit the UI's currently-viewed roadmap as the new "last seen" baseline.
 *  Sent after the popup has rendered the diff badges — any subsequent visit
 *  compares against this promoted snapshot. */
export interface RoadmapSnapshotCommitRequest {
  type: 'roadmap.snapshot.commit';
  snapshot: Record<string, RoadmapSnapshotEntry>;
}
export interface RoadmapSnapshotCommitResponse {
  ok: true;
}

export interface CommunityHubRequest {
  type: 'communityHub.list';
  /** Defaults to 'live' for backwards compat. */
  tab?: CommunityHubTab;
  sort?: CommunityHubSort;
  types?: CommunityHubType[];
  tags?: string[];
  force?: boolean;
}
export interface CommunityHubHomePayload {
  tab: 'home';
  live: CommunityHubLivePost[];
  followed: CommunityHubLivePost[];
  trending: CommunityHubPost[];
  gameplay: CommunityHubPost[];
  tutorial: CommunityHubPost[];
  fetchedAt: number;
  fromCache: boolean;
}
export interface CommunityHubLivePayload {
  tab: 'live';
  live: CommunityHubLivePost[];
  followed: CommunityHubLivePost[];
  fetchedAt: number;
  fromCache: boolean;
}
export interface CommunityHubPostsPayload {
  tab: 'discover' | 'gameplay' | 'tutorial';
  posts: CommunityHubPost[];
  filters: CommunityHubPostFilters;
  fetchedAt: number;
  fromCache: boolean;
}
export interface CommunityHubEventsPayload {
  tab: 'events';
  upcoming: CommunityHubEvent[];
  past: CommunityHubEvent[];
  fetchedAt: number;
  fromCache: boolean;
}
export type CommunityHubResponsePayload =
  | CommunityHubHomePayload
  | CommunityHubLivePayload
  | CommunityHubPostsPayload
  | CommunityHubEventsPayload;

export interface GalactapediaRequest {
  type: 'galactapedia.list';
  first?: number;
  skip?: number;
  /** When set, runs a server-side title search instead of a paginated listing. */
  search?: string;
  force?: boolean;
}
export interface GalactapediaResponsePayload {
  articles: GalactapediaArticle[];
  first: number;
  skip: number;
  /** Echoed back so the UI knows the articles are search results, not a page. */
  search: string | null;
  fetchedAt: number;
  fromCache: boolean;
}

/** Galactapedia home page: featured article + "in the news" + 4 featured
 *  categories + total article count. Cached ~1h (CIG rotates featured
 *  content daily-ish). */
export interface GalactapediaHomeRequest {
  type: 'galactapedia.home';
  force?: boolean;
}
export interface GalactapediaHomeResponsePayload {
  home: GalactapediaHomepage;
  fetchedAt: number;
  fromCache: boolean;
}

/** Random article pick for the "Random article" button. Server-side
 *  `skip` in [0, totalCount). Intentionally uncached — that's the whole
 *  point. */
export interface GalactapediaRandomRequest {
  type: 'galactapedia.random';
  /** Upper bound for the random skip. Pass the last-known `articleCount`
   *  from the home payload. */
  totalCount: number;
}
export interface GalactapediaRandomResponsePayload {
  article: GalactapediaArticle | null;
}

/** Single article fetched for inline reading (body, related, etc.). Cached
 *  aggressively — articles change very rarely. */
export interface GalactapediaArticleRequest {
  type: 'galactapedia.article';
  /** Short id prefix (the `<id>` part of `/galactapedia/article/<id>-<slug>`). */
  id: string;
  force?: boolean;
}
export interface GalactapediaArticleResponsePayload {
  article: GalactapediaArticleFull | null;
  fetchedAt: number;
  fromCache: boolean;
}

export interface GalactapediaCategoriesRequest {
  type: 'galactapedia.categories';
  force?: boolean;
}
export interface GalactapediaCategoriesResponsePayload {
  categories: GalactapediaCategory[];
  fetchedAt: number;
  fromCache: boolean;
}

export interface GalactapediaTagsRequest {
  type: 'galactapedia.tags';
  force?: boolean;
}
export interface GalactapediaTagsResponsePayload {
  tags: GalactapediaTag[];
  fetchedAt: number;
  fromCache: boolean;
}

/** Full A-Z index. Expensive (multiple GraphQL pages), long-cached in the
 *  background so the popup pays the cost at most every few days.
 *  Used by the background's notify poll (it wants the final aggregate).
 *  The popup prefers the streaming variants below. */
export interface GalactapediaIndexRequest {
  type: 'galactapedia.index';
  force?: boolean;
}
export interface GalactapediaIndexResponsePayload {
  articles: GalactapediaArticle[];
  fetchedAt: number;
  fromCache: boolean;
  /** True when the cache was past its TTL but served anyway under
   *  stale-while-revalidate. The popup may show a subtle "refreshing"
   *  hint while the BG refetch lands; the next read will return fresh
   *  data with isStale=false. */
  isStale?: boolean;
}

/** Cache-only read of the A-Z index. Never triggers a crawl — used by the
 *  popup to decide whether to stream (null) or display instantly (hit). */
export interface GalactapediaIndexCachedRequest {
  type: 'galactapedia.indexCached';
}
export interface GalactapediaIndexCachedResponsePayload {
  articles: GalactapediaArticle[] | null;
  fetchedAt: number | null;
}

/** Fetch one page of the A-Z index. Popup drives the loop so it can render
 *  each page as it arrives. */
export interface GalactapediaIndexPageRequest {
  type: 'galactapedia.indexPage';
  skip: number;
}
export interface GalactapediaIndexPageResponsePayload {
  articles: GalactapediaArticle[];
  skip: number;
  hasMore: boolean;
}

/** Commit the full aggregate to the cache once the popup finishes streaming.
 *  The next popup open reads it via `indexCached` for an instant render. */
export interface GalactapediaIndexCommitRequest {
  type: 'galactapedia.indexCommit';
  articles: GalactapediaArticle[];
}
export interface GalactapediaIndexCommitResponsePayload {
  fetchedAt: number;
}

/** Fire-once first-boot crawl for the A-Z index. Triggers the full
 *  ~15-page GraphQL pagination iff no bootstrap flag is set yet — after
 *  the first successful crawl, subsequent popup opens see the flag and
 *  do nothing (even when the index cache itself has expired, we rely on
 *  the user's next module visit to refresh). */
export interface GalactapediaIndexBootstrapRequest {
  type: 'galactapedia.indexBootstrap';
}
export interface GalactapediaIndexBootstrapResponsePayload {
  crawled: boolean;
}

/** Raw roadmap payload + meta, as served by the v3 backend. Cached so the
 *  Roadmap and Progress Tracker modules share one HTTP call instead of
 *  each fetching the same backend endpoint independently. */
export interface RoadmapDataRequest {
  type: 'roadmap.data';
  force?: boolean;
}
export interface RoadmapDataResponsePayload {
  data: import('./schemas/backend.js').RoadmapPayload;
  meta: import('./schemas/backend.js').RoadmapMeta;
  fetchedAt: number;
  fromCache: boolean;
  /** True when the cache was past its TTL but served anyway under
   *  stale-while-revalidate. */
  isStale?: boolean;
}

export interface ProgressTrackerRequest {
  type: 'progressTracker.list';
  force?: boolean;
}

/** One card in the active-work list. */
export interface ProgressTrackerCard {
  id: number;
  name: string;
  status: string;
  releaseName: string;
}

/** Active cards grouped by roadmap category (Core Tech, Ships, Gameplay…). */
export interface ProgressTrackerGroup {
  id: number;
  name: string;
  cards: ProgressTrackerCard[];
}

export interface ProgressTrackerResponsePayload {
  groups: ProgressTrackerGroup[];
  totalCards: number;
  fetchedAt: number;
  fromCache: boolean;
}

/** Drop cache entries. When `prefix` is given, only entries whose key
 *  starts with `cache:<prefix>` are cleared — useful for per-namespace
 *  "reload just this module" buttons in the Settings UI. Without prefix,
 *  wipes everything. Preserves notify state and user preferences — only
 *  the data fetched from RSI/backend is touched. */
export interface CacheClearRequest {
  type: 'cache.clear';
  /** e.g. 'pledge', 'galactapedia', 'spectrum'. Omit for full wipe. */
  prefix?: string;
}
export interface CacheClearResponsePayload {
  cleared: number;
}

/** Per-namespace entry-count and byte-size breakdown of the cache. The
 *  Settings module renders this as a table so the user can see where
 *  their storage quota is going and clear selectively. Sizes are a
 *  rough `JSON.stringify(value).length` sum — good enough for UI display,
 *  not exact bytes. */
export interface CacheStatsRequest {
  type: 'cache.stats';
}
export interface CacheStatsResponsePayload {
  total: { entries: number; sizeBytes: number };
  namespaces: Array<{
    prefix: string;
    entries: number;
    sizeBytes: number;
    /** Soonest entry.expiresAt across the bucket — when does the next
     *  TTL flip happen for this namespace. */
    nextExpiresAt: number | null;
    /** Oldest writer-set fetchedAt across the bucket. */
    oldestFetchedAt: number | null;
    /** Newest writer-set fetchedAt across the bucket. */
    newestFetchedAt: number | null;
    /** True when this namespace's reads are validated against a Zod
     *  schema (cacheGetValidated). */
    validated: boolean;
    /** True when this namespace's reads opt into stale-while-revalidate
     *  (cacheGetWithStale). */
    swr: boolean;
  }>;
  /** chrome.storage.local usage. Default quota is 5 MB without the
   *  `unlimitedStorage` permission (not requested). */
  storage: {
    usedBytes: number;
    quotaBytes: number;
  };
}

/** Per-entry detail for one cache namespace — powers the expandable row
 *  in Settings → Performance → Cache. Lazy-loaded when the user clicks
 *  to expand a row, not bundled with the namespace summary. */
export interface CacheEntriesRequest {
  type: 'cache.entries';
  /** Top-level namespace prefix (the segment between `cache:` and the
   *  first `:`, e.g. `commlink`, `pledge`, `spectrum`). */
  namespace: string;
}
export interface CacheEntriesResponsePayload {
  namespace: string;
  entries: Array<{
    /** Cache key without the `cache:` prefix. */
    key: string;
    sizeBytes: number;
    fetchedAt: number | null;
    expiresAt: number | null;
    isExpired: boolean;
  }>;
}

/** Snapshot of extension-side auth / upgrade session state. Displayed
 *  in the Settings "Sessions" panel so the user can self-diagnose
 *  "CCU won't load" issues (often just a stale CSRF cache). */
export interface SettingsSessionStatusRequest {
  type: 'settings.sessionStatus';
}
export interface SettingsSessionStatusResponsePayload {
  signedIn: boolean;
  handle: string | null;
  rsiTokenPresent: boolean;
  csrfTokenPresent: boolean;
  ccuSessionPrimed: boolean;
}

/** Recent log buffer snapshot (last 200 entries, oldest-first). Shown
 *  in the Settings "Debug" section with a copy-to-clipboard button so
 *  users can paste into bug reports. */
export interface SettingsLogsRequest {
  type: 'settings.logs';
}
export interface SettingsLogsResponsePayload {
  entries: Array<{
    time: number;
    level: 'debug' | 'info' | 'warn' | 'error';
    scope: string;
    message: string;
  }>;
}

/** Granted Chrome permissions + host permissions. Lets the user verify
 *  that the post-install permission prompt went through. */
export interface SettingsPermissionsRequest {
  type: 'settings.permissions';
}
export interface SettingsPermissionsResponsePayload {
  permissions: string[];
  origins: string[];
}

/** Last-run stats of the popup's startup prefetch (duration, how many
 *  requests hit the cache vs fired a real fetch). Updated in the
 *  background whenever the popup fires `settings.recordPrefetch`. */
export interface SettingsPrefetchStatsRequest {
  type: 'settings.prefetchStats';
}
export interface SettingsPrefetchStatsResponsePayload {
  lastRunAt: number | null;
  durationMs: number | null;
  requestCount: number | null;
  rejectedCount: number | null;
}

/** Popup → background: report the outcome of a prefetch run. */
export interface SettingsRecordPrefetchRequest {
  type: 'settings.recordPrefetch';
  durationMs: number;
  requestCount: number;
  rejectedCount: number;
}
export interface SettingsRecordPrefetchResponsePayload {
  ok: true;
}

/** Force the CCU upgrade-session bootstrap dance (CSRF scrape + setAuthToken
 *  + setContextToken). Useful from the Settings panel to test / re-prime
 *  without having to click the Upgrades tab. Reports the outcome so the
 *  UI can show a success or error message. */
export interface SettingsPrimeCcuRequest {
  type: 'settings.primeCcu';
}
export interface SettingsPrimeCcuResponsePayload {
  ok: boolean;
  error: string | null;
}

/** Manual hard reset of every module's cache + the polling backoff state.
 *  Settings → Diagnostics surfaces this as "Refresh all modules now". Wipes
 *  every cache: entry (popup state, in-flight Promises, etc. survive),
 *  resets the per-module exponential backoff so a degraded module gets a
 *  fresh chance, and triggers an immediate poll. The popup UI typically
 *  follows up with a window.location.reload() so every Svelte module
 *  re-mounts against the fresh cache. */
export interface SettingsRefreshAllRequest {
  type: 'settings.refreshAll';
}
export interface SettingsRefreshAllResponsePayload {
  /** How many cache: entries were removed. */
  cleared: number;
  /** Whether the post-clear poll completed successfully. */
  pollOk: boolean;
}

export interface StatusSummaryRequest {
  type: 'status.summary';
  force?: boolean;
}
export interface StatusSummaryResponsePayload {
  summary: RsiStatusSummary;
  fetchedAt: number;
  fromCache: boolean;
}

export interface NotifyStateRequest {
  type: 'notify.state';
}
export type NotifyStateResponse = NotifyState;

export interface NotifyMarkSeenRequest {
  type: 'notify.markSeen';
  module: NotifyModule;
}
export type NotifyMarkSeenResponse = NotifyState;

export interface NotifyPollRequest {
  type: 'notify.poll';
}
export type NotifyPollResponse = NotifyState;

export type RsiMessage =
  | IdentityRequest
  | CommLinkRequest
  | ShipsRequest
  | ContactsRequest
  | ContactsSearchRequest
  | ContactsActionRequest
  | ContactsSendByNicknameRequest
  | ContactsSyncToPtuRequest
  | OrgsRequest
  | OrgsInvitationsRequest
  | OrgsApplicationsRequest
  | OrgsSearchRequest
  | OrgMembersRequest
  | SpectrumRequest
  | SpectrumTrendingRequest
  | SpectrumNotificationsRequest
  | SpectrumMarkReadRequest
  | SpectrumNotifMarkReadRequest
  | SpectrumNotifRemoveRequest
  | SpectrumVoteRequest
  | SpectrumReactRequest
  | SpectrumSubscribeRequest
  | SpectrumLobbiesRequest
  | SpectrumLobbyMessagesRequest
  | SpectrumSearchRequest
  | SpectrumEmojisRequest
  | SpectrumCommunitiesRequest
  | SpectrumBookmarksRequest
  | SpectrumBookmarkAddRequest
  | SpectrumBookmarkRemoveRequest
  | SpectrumForumGroupsRequest
  | SpectrumForumThreadsRequest
  | SpectrumThreadDetailRequest
  | DashboardRequest
  | BuyBackRequest
  | PatchNotesRequest
  | PledgeShipListRequest
  | PledgeShipDetailRequest
  | PledgeBrowseRequest
  | PledgeCcuInitRequest
  | PledgeCcuTargetsRequest
  | PledgeCcuAddToCartRequest
  | PledgeAddToCartRequest
  | PledgeRemoveFromCartRequest
  | PledgeClearCartRequest
  | PledgeCartRequest
  | StatsSummaryRequest
  | RoadmapDataRequest
  | RoadmapSnapshotRequest
  | RoadmapSnapshotCommitRequest
  | CommunityHubRequest
  | GalactapediaRequest
  | GalactapediaHomeRequest
  | GalactapediaRandomRequest
  | GalactapediaArticleRequest
  | GalactapediaCategoriesRequest
  | GalactapediaTagsRequest
  | GalactapediaIndexRequest
  | GalactapediaIndexCachedRequest
  | GalactapediaIndexPageRequest
  | GalactapediaIndexCommitRequest
  | GalactapediaIndexBootstrapRequest
  | ProgressTrackerRequest
  | CacheClearRequest
  | CacheStatsRequest
  | CacheEntriesRequest
  | SettingsSessionStatusRequest
  | SettingsLogsRequest
  | SettingsPermissionsRequest
  | SettingsPrefetchStatsRequest
  | SettingsRecordPrefetchRequest
  | SettingsPrimeCcuRequest
  | SettingsRefreshAllRequest
  | StatusSummaryRequest
  | NotifyStateRequest
  | NotifyMarkSeenRequest
  | NotifyPollRequest;

// Flat per-type mapper. Avoids deep conditional nesting that becomes unreadable
// as new messages are added; extending this only means adding one more pair.
interface ResponseMap {
  'auth.identity': IdentityResponse;
  'commlink.list': CommLinkResponsePayload;
  'ships.list': ShipsResponsePayload;
  'contacts.list': ContactsResponsePayload;
  'contacts.search': ContactsSearchResponsePayload;
  'contacts.action': ContactsActionResponsePayload;
  'contacts.sendByNickname': ContactsSendByNicknameResponsePayload;
  'contacts.syncToPtu': ContactsSyncToPtuResponsePayload;
  'orgs.myList': OrgsResponsePayload;
  'orgs.invitations': OrgsInvitationsResponsePayload;
  'orgs.applications': OrgsApplicationsResponsePayload;
  'orgs.search': OrgsSearchResponsePayload;
  'orgs.members': OrgMembersResponsePayload;
  'spectrum.threads': SpectrumResponsePayload;
  'spectrum.trending': SpectrumTrendingResponsePayload;
  'spectrum.notifications': SpectrumNotificationsResponsePayload;
  'spectrum.markRead': SpectrumMarkReadResponsePayload;
  'spectrum.notifMarkRead': SpectrumNotifMarkReadResponsePayload;
  'spectrum.notifRemove': SpectrumNotifRemoveResponsePayload;
  'spectrum.vote': SpectrumVoteResponsePayload;
  'spectrum.react': SpectrumReactResponsePayload;
  'spectrum.subscribe': SpectrumSubscribeResponsePayload;
  'spectrum.lobbies': SpectrumLobbiesResponsePayload;
  'spectrum.lobbyMessages': SpectrumLobbyMessagesResponsePayload;
  'spectrum.search': SpectrumSearchResponsePayload;
  'spectrum.emojis': SpectrumEmojisResponsePayload;
  'spectrum.communities': SpectrumCommunitiesResponsePayload;
  'spectrum.bookmarks': SpectrumBookmarksResponsePayload;
  'spectrum.bookmarkAdd': SpectrumBookmarkAddResponsePayload;
  'spectrum.bookmarkRemove': SpectrumBookmarkRemoveResponsePayload;
  'spectrum.forumGroups': SpectrumForumGroupsResponsePayload;
  'spectrum.forumThreads': SpectrumForumThreadsResponsePayload;
  'spectrum.threadDetail': SpectrumThreadDetailResponsePayload;
  'dashboard.summary': DashboardResponsePayload;
  'buyback.list': BuyBackResponsePayload;
  'patchnotes.list': PatchNotesResponsePayload;
  'pledge.shipList': PledgeShipListResponsePayload;
  'pledge.shipDetail': PledgeShipDetailResponsePayload;
  'pledge.browse': PledgeBrowseResponsePayload;
  'pledge.ccuInit': PledgeCcuInitResponsePayload;
  'pledge.ccuTargets': PledgeCcuTargetsResponsePayload;
  'pledge.ccuAddToCart': PledgeCcuAddToCartResponsePayload;
  'pledge.addToCart': PledgeAddToCartResponsePayload;
  'pledge.removeFromCart': PledgeRemoveFromCartResponsePayload;
  'pledge.clearCart': PledgeClearCartResponsePayload;
  'pledge.cart': PledgeCartResponsePayload;
  'stats.summary': StatsSummaryResponse;
  'roadmap.data': RoadmapDataResponsePayload;
  'roadmap.snapshot': RoadmapSnapshotResponse;
  'roadmap.snapshot.commit': RoadmapSnapshotCommitResponse;
  'communityHub.list': CommunityHubResponsePayload;
  'galactapedia.list': GalactapediaResponsePayload;
  'galactapedia.home': GalactapediaHomeResponsePayload;
  'galactapedia.random': GalactapediaRandomResponsePayload;
  'galactapedia.article': GalactapediaArticleResponsePayload;
  'galactapedia.categories': GalactapediaCategoriesResponsePayload;
  'galactapedia.tags': GalactapediaTagsResponsePayload;
  'galactapedia.index': GalactapediaIndexResponsePayload;
  'galactapedia.indexCached': GalactapediaIndexCachedResponsePayload;
  'galactapedia.indexPage': GalactapediaIndexPageResponsePayload;
  'galactapedia.indexCommit': GalactapediaIndexCommitResponsePayload;
  'galactapedia.indexBootstrap': GalactapediaIndexBootstrapResponsePayload;
  'progressTracker.list': ProgressTrackerResponsePayload;
  'cache.clear': CacheClearResponsePayload;
  'cache.stats': CacheStatsResponsePayload;
  'cache.entries': CacheEntriesResponsePayload;
  'settings.sessionStatus': SettingsSessionStatusResponsePayload;
  'settings.logs': SettingsLogsResponsePayload;
  'settings.permissions': SettingsPermissionsResponsePayload;
  'settings.prefetchStats': SettingsPrefetchStatsResponsePayload;
  'settings.recordPrefetch': SettingsRecordPrefetchResponsePayload;
  'settings.primeCcu': SettingsPrimeCcuResponsePayload;
  'settings.refreshAll': SettingsRefreshAllResponsePayload;
  'status.summary': StatusSummaryResponsePayload;
  'notify.state': NotifyStateResponse;
  'notify.markSeen': NotifyMarkSeenResponse;
  'notify.poll': NotifyPollResponse;
}

export type RsiResponse<M extends RsiMessage> = M['type'] extends keyof ResponseMap
  ? ResponseMap[M['type']]
  : never;

export type RsiMessageResult<M extends RsiMessage> =
  | { ok: true; data: RsiResponse<M> }
  | { ok: false; error: string; signedIn?: boolean };

// Firefox MV2 quirk: `chrome.runtime.sendMessage(msg)` (no callback) does NOT
// reliably return a Promise on every Firefox version — Mozilla supports the
// callback signature on the `chrome.*` namespace and only guarantees a
// Promise on `browser.*`. When `await` resolves the non-Promise result, it
// settles to `undefined` immediately and the popup throws "No response from
// background worker" before the BG ever replies. Picking the
// Promise-native namespace at runtime fixes it. WXT's auto-polyfill only
// rewrites `chrome` to `browser` in the background bundle, not in the
// popup, so we polyfill ourselves here.
type RuntimeNS = Pick<typeof chrome.runtime, 'sendMessage'>;
function getRuntime(): RuntimeNS {
  const g = globalThis as unknown as {
    browser?: { runtime?: { id?: string } & RuntimeNS };
    chrome?: { runtime: RuntimeNS };
  };
  if (g.browser?.runtime?.id) return g.browser.runtime;
  return chrome.runtime;
}

export async function sendRsiMessage<M extends RsiMessage>(
  message: M,
): Promise<RsiResponse<M>> {
  const res = (await getRuntime().sendMessage(message)) as RsiMessageResult<M>;
  if (!res) throw new Error('No response from background worker');
  if (!res.ok) {
    const err = new Error(res.error) as Error & { signedIn?: boolean };
    err.signedIn = res.signedIn;
    throw err;
  }
  return res.data;
}
