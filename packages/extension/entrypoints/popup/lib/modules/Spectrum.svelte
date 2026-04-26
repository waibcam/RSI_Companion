<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ArrowLeft,
    AtSign,
    Bell,
    Bookmark,
    BookmarkX,
    CheckCheck,
    ChevronRight,
    Code2,
    FileText,
    Flame,
    Heart,
    LayoutGrid,
    Loader2,
    Mail,
    MessageCircle,
    Reply,
    UserPlus,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { notifyState } from '../notify.svelte';
  import { authState } from '../state.svelte';
  import { avatarFallback, timeAgo } from '../format';
  import { persistedState } from '../persist.svelte';
  import { extractSignedIn, errorMessage } from '../error';

  type Thread = Rsi.SpectrumThread;
  type Notification = Rsi.SpectrumNotification;
  type Lobby = Rsi.SpectrumLobby;
  type ForumGroup = Rsi.SpectrumForumGroup;
  type ForumChannelInfo = Rsi.SpectrumForumChannelInfo;
  type ForumSort = Rsi.SpectrumSort;
  type Community = Rsi.SpectrumCommunity;
  type BookmarkItem = Rsi.SpectrumBookmark;
  type ThreadDetail = Rsi.SpectrumThreadDetail;
  type ThreadReply = Rsi.SpectrumThreadReply;
  type ContentBlock = Rsi.SpectrumContentBlock;
  // "devtracker" is the renamed "activity" tab — the underlying data is the
  // CIG-highlighted threads aggregate, which is exactly what RSI calls the
  // Dev Tracker. The old id is kept as the default so existing localStorage
  // selections keep pointing at this tab.
  type Tab = 'devtracker' | 'forums' | 'bookmarks' | 'trending' | 'dms' | 'notifications';

  const TABS: readonly Tab[] = [
    'devtracker',
    'forums',
    'bookmarks',
    'trending',
    'dms',
    'notifications',
  ];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  const tabP = persistedState<Tab>('spectrum:tab', 'devtracker', isTab);

  // Forums-tab navigation state. Three persisted keys:
  //   communityId — which community's forums we're browsing (1 = SC).
  //   channelId   — active channel within that community (null = list).
  //   sort        — thread sort within the active channel.
  // Switching community resets channelId so the user lands on the org's
  // channel list, not on a phantom channel from a different community.
  const forumCommunityP = persistedState<number>(
    'spectrum:forums:communityId',
    1,
    (v): v is number => typeof v === 'number',
  );
  const forumChannelP = persistedState<number | null>(
    'spectrum:forums:channelId',
    null,
    (v): v is number | null => v === null || typeof v === 'number',
  );
  // Third drill level — when a thread slug is set, we render the
  // thread-detail view (subject + content_blocks + first 25 replies)
  // inside the Forums tab instead of jumping out to RSI.
  const forumThreadP = persistedState<string | null>(
    'spectrum:forums:threadSlug',
    null,
    (v): v is string | null => v === null || typeof v === 'string',
  );
  const FORUM_SORTS: ReadonlyArray<{ value: ForumSort; label: string }> = [
    { value: 'hot', label: 'Hot' },
    { value: 'new', label: 'New' },
    { value: 'top', label: 'Top' },
    { value: 'last_activity', label: 'Active' },
  ];
  const isForumSort = (v: unknown): v is ForumSort =>
    typeof v === 'string' && FORUM_SORTS.some((s) => s.value === v);
  const forumSortP = persistedState<ForumSort>('spectrum:forums:sort', 'hot', isForumSort);
  // Read-only alias so template references stay unchanged.
  const tab = $derived(tabP.value);

  // Per-tab visual identity. Keeping the map keyed by tab id makes it
  // trivial to extend when Phase 2/3 add Forums / Org channels / Bookmarks.
  // The 'underlineHex' column is duplicated as a hex string because the
  // unread-card left-stripe is set via `style:border-left` (an inline
  // style — Tailwind variant classes can't reach there at runtime).
  const TAB_META: Record<
    Tab,
    {
      label: string;
      icon: typeof Bell;
      textActive: string;
      underline: string;
      badgeBg: string;
      badgeText: string;
      stripeHex: string;
    }
  > = {
    devtracker: {
      label: 'DevTracker',
      icon: Code2,
      textActive: 'text-sky-300',
      underline: 'bg-sky-400',
      badgeBg: 'bg-sky-500/20',
      badgeText: 'text-sky-300',
      stripeHex: '#38bdf8',
    },
    forums: {
      label: 'Forums',
      icon: LayoutGrid,
      textActive: 'text-teal-300',
      underline: 'bg-teal-400',
      badgeBg: 'bg-teal-500/20',
      badgeText: 'text-teal-300',
      stripeHex: '#14b8a6',
    },
    bookmarks: {
      label: 'Bookmarks',
      icon: Bookmark,
      textActive: 'text-pink-300',
      underline: 'bg-pink-400',
      badgeBg: 'bg-pink-500/20',
      badgeText: 'text-pink-300',
      stripeHex: '#ec4899',
    },
    trending: {
      label: 'Trending',
      icon: Flame,
      textActive: 'text-amber-300',
      underline: 'bg-amber-400',
      badgeBg: 'bg-amber-500/20',
      badgeText: 'text-amber-300',
      stripeHex: '#fbbf24',
    },
    dms: {
      label: 'DMs',
      icon: Mail,
      textActive: 'text-emerald-300',
      underline: 'bg-emerald-400',
      badgeBg: 'bg-emerald-500/20',
      badgeText: 'text-emerald-300',
      stripeHex: '#10b981',
    },
    notifications: {
      label: 'Notifications',
      icon: Bell,
      textActive: 'text-violet-300',
      underline: 'bg-violet-400',
      badgeBg: 'bg-violet-500/20',
      badgeText: 'text-violet-300',
      stripeHex: '#8b5cf6',
    },
  };

  // Notification "kind" rendering — RSI's raw type strings (e.g.
  // "forum-thread-newReply", "private-new-message") are decent for code
  // but ugly in the UI. Map them to a friendly label + a glyph that
  // signals the kind at a glance. Unknown types fall through to a Bell.
  const NOTIF_KIND: Record<string, { label: string; icon: typeof Bell }> = {
    'forum-thread-newReply': { label: 'Reply', icon: Reply },
    'forum-thread-reply': { label: 'Reply', icon: Reply },
    'forum-thread-mention': { label: 'Mention', icon: AtSign },
    'forum-mention': { label: 'Mention', icon: AtSign },
    'forum-thread-vote': { label: 'Vote', icon: Heart },
    'forum-thread-newVote': { label: 'Vote', icon: Heart },
    'private-new-message': { label: 'DM', icon: Mail },
    'lobby-message': { label: 'Chat', icon: MessageCircle },
    'friend-new-request': { label: 'Friend request', icon: UserPlus },
    'friend-request': { label: 'Friend request', icon: UserPlus },
    'friend-accepted': { label: 'Friend accepted', icon: UserPlus },
  };
  function notifKind(type: string): { label: string; icon: typeof Bell } {
    return (
      NOTIF_KIND[type] ?? {
        label: type ? type.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Notification',
        icon: Bell,
      }
    );
  }

  let threads = $state<Thread[]>([]);
  let threadsLoading = $state(true);
  let threadsError = $state<string | null>(null);
  let threadsFromCache = $state(false);
  let signedIn = $state<boolean | null>(null);

  let trending = $state<Thread[]>([]);
  let trendingLoading = $state(false);
  let trendingError = $state<string | null>(null);
  let trendingLoaded = $state(false);
  let trendingFromCache = $state(false);

  let notifs = $state<Notification[]>([]);
  let notifsLoading = $state(false);
  let notifsError = $state<string | null>(null);
  let notifsLoaded = $state(false);

  let lobbies = $state<Lobby[]>([]);
  let lobbiesLoading = $state(false);
  let lobbiesError = $state<string | null>(null);
  let lobbiesLoaded = $state(false);
  let lobbiesFromCache = $state(false);

  // Forums tab state — `forumGroups` is the channel-list view; once
  // `forumChannelP.value` is set, `forumThreads` carries the threads in
  // that channel. The two never display at the same time. The
  // `groupsForCommunity` field tracks which community the current
  // groups array belongs to so a stale community-switch fetch can't
  // paint the wrong tree.
  let forumGroups = $state<ForumGroup[]>([]);
  let forumGroupsLoading = $state(false);
  let forumGroupsError = $state<string | null>(null);
  let forumGroupsLoaded = $state(false);
  let forumGroupsFromCache = $state(false);
  let forumGroupsForCommunity = $state<number | null>(null);

  let forumThreads = $state<Thread[]>([]);
  let forumThreadsLoading = $state(false);
  let forumThreadsError = $state<string | null>(null);
  let forumThreadsFromCache = $state(false);
  let forumThreadsForChannel = $state<number | null>(null);

  // Thread-detail state (Phase 2b). Loaded when forumThreadP.value is
  // set; the thread's full body + first 25 replies render in-popup.
  let threadDetail = $state<ThreadDetail | null>(null);
  let threadDetailLoading = $state(false);
  let threadDetailError = $state<string | null>(null);
  let threadDetailFromCache = $state(false);
  let threadDetailForSlug = $state<string | null>(null);

  // Community switcher (joined SC + orgs). Loaded lazily on first
  // Forums-tab visit so users who never open Forums don't pay for
  // the v2/community/list call.
  let communities = $state<Community[]>([]);
  let communitiesLoading = $state(false);
  let communitiesError = $state<string | null>(null);
  let communitiesLoaded = $state(false);

  // Bookmarks tab state. The `removingId` map tracks per-row
  // in-flight removals so the click button can disable just its own
  // row while the network round trip resolves.
  let bookmarks = $state<BookmarkItem[]>([]);
  let bookmarksLoading = $state(false);
  let bookmarksError = $state<string | null>(null);
  let bookmarksLoaded = $state(false);
  let bookmarksFromCache = $state(false);
  // Key shape: `${entityType}:${entityId}` — bookmarks are addressed
  // by (type, id) tuple in the API too, so this keeps the shapes
  // consistent.
  let bookmarkRemoving = $state(new Set<string>());

  let query = $state('');

  async function loadThreads(force = false) {
    threadsLoading = true;
    threadsError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.threads', force });
      threads = res.threads;
      signedIn = res.signedIn;
      threadsFromCache = res.fromCache;
    } catch (e) {
      threadsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      threadsLoading = false;
    }
  }

  async function loadTrending(force = false) {
    trendingLoading = true;
    trendingError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.trending', force });
      trending = res.threads;
      signedIn = res.signedIn;
      trendingFromCache = res.fromCache;
      trendingLoaded = true;
    } catch (e) {
      trendingError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      trendingLoading = false;
    }
  }

  async function loadNotifications(force = false) {
    notifsLoading = true;
    notifsError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.notifications', force });
      notifs = res.notifications;
      signedIn = res.signedIn;
      notifsLoaded = true;
    } catch (e) {
      notifsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      notifsLoading = false;
    }
  }

  async function loadLobbies(force = false) {
    lobbiesLoading = true;
    lobbiesError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.lobbies', force });
      lobbies = res.lobbies;
      signedIn = res.signedIn;
      lobbiesFromCache = res.fromCache;
      lobbiesLoaded = true;
    } catch (e) {
      lobbiesError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      lobbiesLoading = false;
    }
  }

  async function loadBookmarks(force = false) {
    bookmarksLoading = true;
    bookmarksError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.bookmarks', force });
      bookmarks = res.bookmarks;
      signedIn = res.signedIn;
      bookmarksFromCache = res.fromCache;
      bookmarksLoaded = true;
    } catch (e) {
      bookmarksError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      bookmarksLoading = false;
    }
  }

  async function removeBookmark(b: BookmarkItem) {
    const key = `${b.entityType}:${b.entityId}`;
    if (bookmarkRemoving.has(key)) return;
    bookmarkRemoving = new Set([...bookmarkRemoving, key]);
    try {
      const res = await sendRsiMessage({
        type: 'spectrum.bookmarkRemove',
        entityId: b.entityId,
        entityType: b.entityType,
      });
      bookmarks = res.bookmarks;
    } catch (e) {
      bookmarksError = errorMessage(e);
    } finally {
      const next = new Set(bookmarkRemoving);
      next.delete(key);
      bookmarkRemoving = next;
    }
  }

  async function loadCommunities(force = false) {
    communitiesLoading = true;
    communitiesError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.communities', force });
      communities = res.communities;
      signedIn = res.signedIn;
      communitiesLoaded = true;
    } catch (e) {
      communitiesError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      communitiesLoading = false;
    }
  }

  async function loadForumGroups(force = false) {
    const communityId = forumCommunityP.value;
    forumGroupsLoading = true;
    forumGroupsError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.forumGroups', communityId, force });
      // Stale-response guard: if the user switched communities while
      // this fetch was in flight, don't overwrite their view.
      if (forumCommunityP.value !== communityId) return;
      forumGroups = res.groups;
      forumGroupsForCommunity = communityId;
      signedIn = res.signedIn;
      forumGroupsFromCache = res.fromCache;
      forumGroupsLoaded = true;
    } catch (e) {
      if (forumCommunityP.value !== communityId) return;
      forumGroupsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      if (forumCommunityP.value === communityId) forumGroupsLoading = false;
    }
  }

  async function loadForumThreads(channelId: number, force = false) {
    const communityId = forumCommunityP.value;
    forumThreadsLoading = true;
    forumThreadsError = null;
    try {
      const res = await sendRsiMessage({
        type: 'spectrum.forumThreads',
        communityId,
        channelId,
        sort: forumSortP.value,
        force,
      });
      // Stale-response guard: if the user clicked into another channel
      // OR community while this fetch was in flight, don't overwrite
      // their view.
      if (forumChannelP.value !== channelId || forumCommunityP.value !== communityId) return;
      forumThreads = res.threads;
      forumThreadsForChannel = channelId;
      signedIn = res.signedIn;
      forumThreadsFromCache = res.fromCache;
    } catch (e) {
      if (forumChannelP.value !== channelId || forumCommunityP.value !== communityId) return;
      forumThreadsError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      if (forumChannelP.value === channelId && forumCommunityP.value === communityId) {
        forumThreadsLoading = false;
      }
    }
  }

  async function loadThreadDetail(slug: string, force = false) {
    threadDetailLoading = true;
    threadDetailError = null;
    try {
      const res = await sendRsiMessage({ type: 'spectrum.threadDetail', slug, force });
      // Stale-response guard: if user navigated away while in flight,
      // don't overwrite their view.
      if (forumThreadP.value !== slug) return;
      threadDetail = res.thread;
      threadDetailForSlug = slug;
      signedIn = res.signedIn;
      threadDetailFromCache = res.fromCache;
    } catch (e) {
      if (forumThreadP.value !== slug) return;
      threadDetailError = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      if (forumThreadP.value === slug) threadDetailLoading = false;
    }
  }

  function selectThread(t: Thread) {
    forumThreadP.value = t.slug;
    threadDetail = null;
    threadDetailForSlug = null;
    threadDetailError = null;
    loadThreadDetail(t.slug);
  }
  function backToThreadList() {
    forumThreadP.value = null;
    threadDetail = null;
    threadDetailForSlug = null;
    threadDetailError = null;
  }

  function selectCommunity(communityId: number) {
    if (forumCommunityP.value === communityId) return;
    forumCommunityP.value = communityId;
    // Reset drill state — channels and threads are per-community, so
    // the previous ids are meaningless now.
    forumChannelP.value = null;
    forumThreadP.value = null;
    forumGroups = [];
    forumGroupsForCommunity = null;
    forumGroupsError = null;
    forumThreads = [];
    forumThreadsForChannel = null;
    forumThreadsError = null;
    threadDetail = null;
    threadDetailForSlug = null;
    threadDetailError = null;
    loadForumGroups();
  }

  /** Find a single channel by id across all groups. Used by the threads
   *  view to render the channel header (name + description + colour). */
  const currentForumChannel = $derived.by<ForumChannelInfo | null>(() => {
    const id = forumChannelP.value;
    if (id == null) return null;
    for (const g of forumGroups) {
      for (const ch of g.channels) {
        if (ch.id === id) return ch;
      }
    }
    return null;
  });

  function selectForumChannel(channelId: number) {
    forumChannelP.value = channelId;
    forumThreads = [];
    forumThreadsForChannel = null;
    loadForumThreads(channelId);
  }
  function backToForumChannels() {
    forumChannelP.value = null;
    forumThreadP.value = null;
    forumThreads = [];
    forumThreadsForChannel = null;
    forumThreadsError = null;
    threadDetail = null;
    threadDetailForSlug = null;
    threadDetailError = null;
  }
  function selectForumSort(s: ForumSort) {
    if (s === forumSortP.value) return;
    forumSortP.value = s;
    if (forumChannelP.value != null) loadForumThreads(forumChannelP.value);
  }

  // Guard against double-submission: rapid clicks on "Mark all read"
  // would fire multiple POSTs to /api/spectrum/notifications/markAsRead
  // in parallel. The server is idempotent, but we still want to avoid
  // gratuitous network + keep the button visibly busy.
  let markingAllRead = $state(false);
  async function markAllRead() {
    if (markingAllRead) return;
    markingAllRead = true;
    try {
      await sendRsiMessage({ type: 'spectrum.markRead' });
      notifs = notifs.map((n) => ({ ...n, read: true }));
    } catch (e) {
      notifsError = errorMessage(e);
    } finally {
      markingAllRead = false;
    }
  }

  function switchTab(next: Tab) {
    tabP.value = next;
    if (signedIn === false) return;
    if (next === 'notifications' && !notifsLoaded) {
      loadNotifications();
    } else if (next === 'trending' && !trendingLoaded) {
      loadTrending();
    } else if (next === 'dms' && !lobbiesLoaded) {
      loadLobbies();
    } else if (next === 'bookmarks' && !bookmarksLoaded) {
      loadBookmarks();
    } else if (next === 'forums') {
      if (!communitiesLoaded) loadCommunities();
      if (!forumGroupsLoaded || forumGroupsForCommunity !== forumCommunityP.value) {
        loadForumGroups();
      }
      // Re-hydrate any drill the user was at when they last closed the
      // popup. Order: thread detail → threads list → channel list.
      const ch = forumChannelP.value;
      if (ch != null && forumThreadsForChannel !== ch) loadForumThreads(ch);
      const slug = forumThreadP.value;
      if (slug != null && threadDetailForSlug !== slug) loadThreadDetail(slug);
    }
  }

  function refresh() {
    if (tab === 'devtracker') loadThreads(true);
    else if (tab === 'trending') loadTrending(true);
    else if (tab === 'notifications') loadNotifications(true);
    else if (tab === 'dms') loadLobbies(true);
    else if (tab === 'bookmarks') loadBookmarks(true);
    else if (tab === 'forums') {
      if (forumThreadP.value != null) loadThreadDetail(forumThreadP.value, true);
      else if (forumChannelP.value != null) loadForumThreads(forumChannelP.value, true);
      else loadForumGroups(true);
    }
  }

  const filteredThreads = $derived.by<Thread[]>(() => {
    const q = query.trim().toLowerCase();
    const source = tab === 'trending' ? trending : threads;
    if (!q) return source;
    return source.filter((t) => {
      const hay = `${t.subject} ${t.channel.name} ${t.authorDisplayName}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const filteredLobbies = $derived.by<Lobby[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return lobbies;
    return lobbies.filter((l) => {
      const hay = `${l.name} ${l.lastMessageText} ${l.members.map((m) => m.displayName).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const unreadNotifs = $derived(notifs.filter((n) => !n.read).length);
  const unreadLobbies = $derived(lobbies.reduce((acc, l) => acc + (l.newMessages || 0), 0));
  const loading = $derived(
    tab === 'devtracker'
      ? threadsLoading
      : tab === 'trending'
        ? trendingLoading
        : tab === 'notifications'
          ? notifsLoading
          : tab === 'dms'
            ? lobbiesLoading
            : tab === 'bookmarks'
              ? bookmarksLoading
              : tab === 'forums'
                ? forumThreadP.value != null
                  ? threadDetailLoading
                  : forumChannelP.value != null
                    ? forumThreadsLoading
                    : forumGroupsLoading
                : false,
  );
  const showSearch = $derived(
    tab === 'devtracker' ||
      tab === 'trending' ||
      tab === 'dms' ||
      tab === 'bookmarks' ||
      (tab === 'forums' && forumChannelP.value == null && forumThreadP.value == null),
  );
  const showRefresh = $derived(
    tab === 'devtracker' ||
      tab === 'trending' ||
      tab === 'notifications' ||
      tab === 'dms' ||
      tab === 'bookmarks' ||
      tab === 'forums',
  );
  const fromCache = $derived(
    (tab === 'devtracker' && threadsFromCache) ||
      (tab === 'trending' && trendingFromCache) ||
      (tab === 'dms' && lobbiesFromCache) ||
      (tab === 'bookmarks' && bookmarksFromCache) ||
      (tab === 'forums' &&
        (forumThreadP.value != null
          ? threadDetailFromCache
          : forumChannelP.value != null
            ? forumThreadsFromCache
            : forumGroupsFromCache)),
  );

  const filteredBookmarks = $derived.by<BookmarkItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return bookmarks;
    return bookmarks.filter((b) => {
      const hay = `${b.name ?? ''} ${b.entityName} ${b.entityType}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const filteredForumChannels = $derived.by<ForumGroup[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return forumGroups;
    return forumGroups
      .map((g) => ({
        ...g,
        channels: g.channels.filter((c) => {
          const hay = `${c.name} ${c.description} ${g.name}`.toLowerCase();
          return hay.includes(q);
        }),
      }))
      .filter((g) => g.channels.length > 0);
  });

  function avatarUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    return path.startsWith('http') ? path : `${RSI_BASE_URL}${path}`;
  }

  // Don't kick off auth-required fetches until the global auth check resolves —
  // otherwise the UI flashes tabs, starts loading, then jumps to SignInPrompt
  // when the request rejects. Wait for authState.signedIn and gate on it.
  let kicked = false;
  $effect(() => {
    if (authState.signedIn === true && !kicked) {
      kicked = true;
      void loadThreads();
      // Also pre-warm notifications so the unread badge on the Notifications
      // tab appears without requiring the user to click into the tab first.
      // v2 used to do a full "refresh all modules" on startup — this is the
      // small slice of that behavior that matters for users who live in the
      // badge-count glance (not the tab itself).
      void loadNotifications();
      // If the user's persisted tab is Trending / DMs / Forums, kick
      // those loaders too so returning to the Spectrum module (e.g.
      // after visiting another module) shows the cached content
      // immediately instead of an empty list that only populates after
      // a manual tab toggle.
      if (tabP.value === 'trending') void loadTrending();
      else if (tabP.value === 'dms') void loadLobbies();
      else if (tabP.value === 'bookmarks') void loadBookmarks();
      else if (tabP.value === 'forums') {
        void loadCommunities();
        void loadForumGroups();
        if (forumChannelP.value != null) void loadForumThreads(forumChannelP.value);
        if (forumThreadP.value != null) void loadThreadDetail(forumThreadP.value);
      }
      void notifyState.markSeen('spectrum');
    } else if (authState.signedIn === false) {
      signedIn = false;
      threadsLoading = false;
    }
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader
    title="Spectrum"
    {loading}
    {fromCache}
    onRefresh={showRefresh ? refresh : undefined}
  >
    {#snippet meta()}
      {#if signedIn && tab === 'devtracker'}
        <span class="text-[10px] text-slate-500">{threads.length} highlighted</span>
      {:else if signedIn && tab === 'trending' && trendingLoaded}
        <span class="text-[10px] text-slate-500">{trending.length} trending</span>
      {:else if signedIn && tab === 'notifications' && notifsLoaded}
        <span class="text-[10px] text-slate-500">{notifs.length} total</span>
      {:else if signedIn && tab === 'dms' && lobbiesLoaded}
        <span class="text-[10px] text-slate-500">{lobbies.length} lobbies</span>
      {:else if signedIn && tab === 'bookmarks' && bookmarksLoaded}
        <span class="text-[10px] text-slate-500">{bookmarks.length} saved</span>
      {:else if signedIn && tab === 'forums' && forumGroupsLoaded}
        {@const activeCommunity = communities.find((c) => c.id === forumCommunityP.value)}
        <span class="text-[10px] text-slate-500">
          {#if activeCommunity}{activeCommunity.name} ·{' '}{/if}
          {#if forumThreadP.value != null}
            {threadDetail?.repliesCount ?? 0} replies
          {:else if forumChannelP.value != null}
            {forumThreads.length} threads
          {:else}
            {forumGroups.reduce((n, g) => n + g.channels.length, 0)} channels
          {/if}
        </span>
      {/if}
    {/snippet}
    {#snippet controls()}
      {#if showSearch}
        <input
          type="search"
          placeholder="Filter..."
          bind:value={query}
          class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else}
        <div class="flex-1"></div>
      {/if}

      {#if tab === 'devtracker'}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          onclick={() => notifyState.markSeen('spectrum')}
          title="Mark highlighted threads as read"
        >
          <CheckCheck class="size-3.5" />
        </button>
      {:else if tab === 'notifications' && unreadNotifs > 0}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          onclick={markAllRead}
          disabled={markingAllRead}
          title="Mark all notifications as read"
        >
          <CheckCheck class="size-3.5" />
        </button>
      {/if}
    {/snippet}
  </ModuleHeader>

  {#if authState.signedIn === true && signedIn !== false}
    <div class="flex overflow-x-auto border-b border-slate-800 bg-slate-950/20 px-3 text-xs [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {#each Object.entries(TAB_META) as [key, meta] (key)}
        {@const tabKey = key as Tab}
        {@const active = tab === tabKey}
        {@const Icon = meta.icon}
        {@const unread = tabKey === 'dms' ? unreadLobbies : tabKey === 'notifications' ? unreadNotifs : 0}
        <button
          type="button"
          onclick={() => switchTab(tabKey)}
          class="relative flex shrink-0 items-center gap-1 px-3 py-1.5 transition {active
            ? meta.textActive
            : 'text-slate-400 hover:text-slate-200'}"
        >
          <Icon class="size-3" />
          {meta.label}
          {#if unread > 0}
            <span
              class="rounded-full px-1.5 py-0.5 text-[9px] font-semibold {meta.badgeBg} {meta.badgeText}"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          {/if}
          {#if active}
            <span class="absolute inset-x-1 bottom-0 h-px {meta.underline}"></span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}

  <!-- ======================== Snippets =====================================
       The four tab views were near-identical 60-line blocks of Tailwind +
       avatar-with-fallback markup. Factored into snippets here so each
       tab body collapses to a single {@render call(item)}; the variant
       knobs (accent colour, kind icon, unread state) flow in as args. -->

  {#snippet errorBlock(label: string, message: string)}
    <div
      class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
    >
      <AlertTriangle class="mt-0.5 size-4 shrink-0" />
      <div>
        <p class="font-semibold">{label}</p>
        <p class="mt-1 break-all text-rose-300/80">{message}</p>
      </div>
    </div>
  {/snippet}

  {#snippet emptyState(IconCmp: typeof Bell, message: string)}
    <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
      <IconCmp class="size-8" />
      <p class="text-xs italic">{message}</p>
    </div>
  {/snippet}

  {#snippet centerSpinner()}
    <div class="flex h-full items-center justify-center text-slate-500">
      <Loader2 class="size-5 animate-spin" />
    </div>
  {/snippet}

  {#snippet avatar(
    src: string | null,
    primary: string,
    secondary: string,
    sizeClass: string,
  )}
    {#if src}
      <img
        {src}
        alt=""
        loading="lazy"
        class="{sizeClass} shrink-0 rounded-full object-cover ring-1 ring-slate-800"
      />
    {:else}
      {@const av = avatarFallback(primary, secondary)}
      <div
        class="{sizeClass} flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-xs font-semibold text-white/90 ring-1 ring-slate-800"
      >
        {av.initials}
      </div>
    {/if}
  {/snippet}

  {#snippet threadCardBody(t: Thread, stripe: string)}
    {@render avatar(avatarUrl(t.authorAvatar), t.authorDisplayName, t.authorNickname, 'size-9')}
    <div class="min-w-0 flex-1">
      <div class="mb-0.5 flex flex-wrap items-center gap-1.5">
        {#if t.isNew}
          <span class="rounded bg-sky-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-200">
            new
          </span>
        {/if}
        <span
          class="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style:background-color="{stripe}33"
          style:color={stripe}
        >
          {t.channel.name}
        </span>
      </div>
      <p class="line-clamp-2 text-xs font-medium text-slate-100 group-hover:text-sky-200">
        {t.subject}
      </p>
      <p class="mt-0.5 truncate text-[10px] text-slate-500">
        {t.authorDisplayName} · {timeAgo(t.timeCreated)}
      </p>
    </div>
  {/snippet}

  {#snippet threadCard(t: Thread, onLocalClick?: (t: Thread) => void)}
    {@const stripe = t.channel.color || '#475569'}
    {@const cls = 'group flex w-full gap-2.5 rounded-md bg-slate-900/70 p-2 text-left ring-1 ring-slate-800 transition hover:bg-slate-900 hover:ring-sky-600'}
    <li class="virt-item">
      {#if onLocalClick}
        <button
          type="button"
          onclick={() => onLocalClick(t)}
          class={cls}
          style:border-left="3px solid {stripe}"
        >
          {@render threadCardBody(t, stripe)}
        </button>
      {:else}
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          class={cls}
          style:border-left="3px solid {stripe}"
        >
          {@render threadCardBody(t, stripe)}
        </a>
      {/if}
    </li>
  {/snippet}

  {#snippet lobbyCard(l: Lobby)}
    {@const unread = l.newMessages > 0}
    <li class="virt-item">
      <a
        href={l.url}
        target="_blank"
        rel="noopener noreferrer"
        class="group flex gap-2.5 rounded-md p-2 ring-1 transition {unread
          ? 'bg-emerald-950/30 ring-emerald-900/60 hover:ring-emerald-500'
          : 'bg-slate-900/40 ring-slate-800 hover:ring-emerald-700'}"
        style:border-left="3px solid {unread ? TAB_META.dms.stripeHex : 'transparent'}"
      >
        {@render avatar(avatarUrl(l.lastAuthorAvatar), l.lastAuthorDisplayName || l.name, '', 'size-9')}
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <p class="line-clamp-1 text-xs font-medium text-slate-100">{l.name}</p>
            {#if unread}
              <span
                class="shrink-0 rounded-full bg-emerald-500/25 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-200"
              >
                {l.newMessages > 99 ? '99+' : l.newMessages}
              </span>
            {/if}
          </div>
          {#if l.lastMessageText}
            <p class="line-clamp-1 text-[11px] text-slate-400">
              {#if l.lastAuthorDisplayName}<span class="text-slate-500">{l.lastAuthorDisplayName}:</span>{' '}{/if}{l.lastMessageText}
            </p>
          {/if}
          <p class="mt-0.5 text-[10px] text-slate-500">{timeAgo(l.lastMessageAt)}</p>
        </div>
      </a>
    </li>
  {/snippet}

  {#snippet notifCard(n: Notification)}
    {@const kind = notifKind(n.type)}
    {@const KindIcon = kind.icon}
    {@const href = n.url ?? (n.authorNickname ? `${RSI_BASE_URL}/citizens/${n.authorNickname}` : '#')}
    <li class="virt-item">
      <a
        {href}
        target="_blank"
        rel="noopener noreferrer"
        class="group flex gap-2.5 rounded-md p-2 ring-1 transition {!n.read
          ? 'bg-violet-950/30 ring-violet-900/60 hover:ring-violet-500'
          : 'bg-slate-900/40 ring-slate-800 hover:ring-violet-700'}"
        style:border-left="3px solid {!n.read ? TAB_META.notifications.stripeHex : 'transparent'}"
      >
        {@render avatar(avatarUrl(n.authorAvatar), n.authorDisplayName, n.authorNickname, 'size-9')}
        <div class="min-w-0 flex-1">
          <div class="mb-0.5 flex items-center gap-1.5">
            <span
              class="flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-300"
            >
              <KindIcon class="size-2.5" />
              {kind.label}
            </span>
            {#if !n.read}
              <span class="size-1.5 rounded-full bg-violet-400" aria-label="unread"></span>
            {/if}
          </div>
          <p class="line-clamp-2 text-xs text-slate-100 group-hover:text-violet-200">{n.text}</p>
          <p class="mt-0.5 text-[10px] text-slate-500">{timeAgo(n.timeCreated)}</p>
        </div>
      </a>
    </li>
  {/snippet}

  {#snippet bookmarkCard(b: BookmarkItem)}
    {@const key = `${b.entityType}:${b.entityId}`}
    {@const removing = bookmarkRemoving.has(key)}
    {@const label = b.name ?? b.entityName}
    {@const TypeIcon =
      b.entityType === 'forum_thread'
        ? FileText
        : b.entityType === 'message_lobby'
          ? Mail
          : b.entityType === 'forum_channel'
            ? LayoutGrid
            : Bookmark}
    {@const typeLabel =
      b.entityType === 'forum_thread'
        ? 'Thread'
        : b.entityType === 'message_lobby'
          ? 'Lobby'
          : b.entityType === 'forum_channel'
            ? 'Channel'
            : b.entityType.replace(/_/g, ' ')}
    <li class="virt-item">
      <div
        class="group flex gap-2.5 rounded-md p-2 ring-1 transition {b.hasNewActivity
          ? 'bg-pink-950/25 ring-pink-900/60 hover:ring-pink-500'
          : 'bg-slate-900/40 ring-slate-800 hover:ring-pink-700'}"
        style:border-left="3px solid {b.hasNewActivity ? TAB_META.bookmarks.stripeHex : 'transparent'}"
      >
        {#if b.thumbnail}
          <img
            src={b.thumbnail}
            alt=""
            loading="lazy"
            class="size-9 shrink-0 rounded-md object-cover ring-1 ring-slate-800"
          />
        {:else}
          {@const av = avatarFallback(label, b.entityType)}
          <div
            class="flex size-9 shrink-0 items-center justify-center rounded-md bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-white/90 ring-1 ring-slate-800"
          >
            <TypeIcon class="size-4" />
          </div>
        {/if}
        <a
          href={b.url}
          target="_blank"
          rel="noopener noreferrer"
          class="min-w-0 flex-1"
        >
          <div class="mb-0.5 flex items-center gap-1.5">
            <span class="flex items-center gap-1 rounded bg-slate-800/80 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-slate-300">
              <TypeIcon class="size-2.5" />
              {typeLabel}
            </span>
            {#if b.hasNewActivity}
              <span class="size-1.5 rounded-full bg-pink-400" aria-label="new activity"></span>
            {/if}
          </div>
          <p class="line-clamp-1 text-xs font-medium text-slate-100 group-hover:text-pink-200">
            {label}
          </p>
          {#if b.name && b.entityName && b.name !== b.entityName}
            <p class="mt-0.5 truncate text-[10px] text-slate-500">{b.entityName}</p>
          {/if}
        </a>
        <button
          type="button"
          onclick={() => removeBookmark(b)}
          disabled={removing}
          class="shrink-0 rounded-md p-1 text-slate-500 transition hover:bg-rose-900/40 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-40"
          title="Remove bookmark"
          aria-label="Remove bookmark"
        >
          {#if removing}
            <Loader2 class="size-3.5 animate-spin" />
          {:else}
            <BookmarkX class="size-3.5" />
          {/if}
        </button>
      </div>
    </li>
  {/snippet}

  {#snippet communitySwitcher()}
    <div
      class="mx-auto mb-3 flex max-w-3xl gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {#each communities as c (c.id)}
        {@const active = forumCommunityP.value === c.id}
        <button
          type="button"
          onclick={() => selectCommunity(c.id)}
          class="group flex shrink-0 flex-col items-center gap-1 rounded-md p-1.5 ring-1 transition {active
            ? 'bg-teal-950/40 ring-teal-500'
            : 'bg-slate-900/50 ring-slate-800 hover:ring-teal-700'}"
          title={c.name}
        >
          {#if c.avatar}
            <img
              src={c.avatar}
              alt=""
              loading="lazy"
              class="size-8 rounded-full object-cover ring-1 ring-slate-800"
            />
          {:else}
            {@const av = avatarFallback(c.name, c.slug)}
            <div
              class="flex size-8 items-center justify-center rounded-full bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-[10px] font-semibold text-white/90 ring-1 ring-slate-800"
            >
              {av.initials}
            </div>
          {/if}
          <span
            class="line-clamp-1 max-w-[80px] text-[9px] {active
              ? 'text-teal-200'
              : 'text-slate-400 group-hover:text-slate-200'}"
          >
            {c.name}
          </span>
        </button>
      {/each}
    </div>
  {/snippet}

  {#snippet contentBlocks(blocks: ContentBlock[])}
    <!-- DraftJS-shaped block list. We render each block as the right
         HTML primitive based on its type. Inline styles + entities
         (links, mentions, embeds) ship in a follow-up — plain text
         covers ~90% of what people actually post on Spectrum. -->
    {#each blocks as b, i (i)}
      {#if !b.text.trim() && b.type !== 'atomic'}
        <!-- Skip blank lines that DraftJS uses as paragraph breaks. -->
      {:else if b.type === 'header-one' || b.type === 'header-two'}
        <p class="mt-1.5 text-xs font-semibold text-slate-100">{b.text}</p>
      {:else if b.type === 'unordered-list-item'}
        <p class="ml-3 text-[11px] text-slate-200" style:padding-left="{b.depth * 0.75}rem">
          • {b.text}
        </p>
      {:else if b.type === 'ordered-list-item'}
        <p class="ml-3 text-[11px] text-slate-200" style:padding-left="{b.depth * 0.75}rem">
          {i + 1}. {b.text}
        </p>
      {:else if b.type === 'blockquote'}
        <p class="border-l-2 border-slate-700 pl-2 text-[11px] italic text-slate-400">
          {b.text}
        </p>
      {:else if b.type === 'code-block'}
        <pre class="overflow-x-auto rounded bg-slate-950/80 p-1.5 font-mono text-[10px] text-slate-300">{b.text}</pre>
      {:else if b.type === 'atomic'}
        <p class="text-[10px] italic text-slate-500">📎 [media — open on Spectrum to view]</p>
      {:else}
        <p class="text-[11px] leading-relaxed text-slate-200">{b.text}</p>
      {/if}
    {/each}
  {/snippet}

  {#snippet threadReplyCard(r: ThreadReply)}
    <li class="rounded-md bg-slate-900/40 p-2 ring-1 ring-slate-800">
      <div class="mb-1 flex items-center gap-2">
        {@render avatar(avatarUrl(r.authorAvatar), r.authorDisplayName, r.authorNickname, 'size-7')}
        <div class="min-w-0 flex-1">
          <p class="line-clamp-1 text-[11px] font-medium text-slate-100">
            {r.authorDisplayName || r.authorNickname || 'Unknown'}
          </p>
          <p class="text-[9px] text-slate-500">{timeAgo(r.timeCreated)}</p>
        </div>
      </div>
      {#if r.isErased}
        <p class="text-[11px] italic text-slate-500">[erased]</p>
      {:else}
        <div class="flex flex-col gap-1">
          {@render contentBlocks(r.contentBlocks)}
        </div>
      {/if}
      {#if r.repliesCount > 0}
        <p class="mt-1.5 text-[9px] italic text-slate-500">
          {r.repliesCount}{' '}{r.repliesCount === 1 ? 'reply' : 'replies'} — open on Spectrum to read
        </p>
      {/if}
    </li>
  {/snippet}

  {#snippet threadDetailView()}
    {@const detail = threadDetail}
    {@const ch = currentForumChannel}
    {@const stripe = ch?.color || '#475569'}
    {@const externalUrl =
      detail && ch
        ? `${RSI_BASE_URL}/spectrum/community/${ch.communitySlug}/forum/${ch.id}/thread/${detail.slug}`
        : `${RSI_BASE_URL}/spectrum/`}
    <div class="mx-auto flex max-w-3xl flex-col gap-2">
      <!-- Header row — back arrow + channel chip + community context. -->
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={backToThreadList}
          class="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          title="Back to threads"
          aria-label="Back to threads"
        >
          <ArrowLeft class="size-4" />
        </button>
        <span
          class="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
          style:background-color="{stripe}33"
          style:color={stripe}
        >
          {ch?.name ?? 'Thread'}
        </span>
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 transition hover:text-slate-200"
        >
          Open in Spectrum
          <ChevronRight class="size-3" />
        </a>
      </div>

      {#if threadDetailError}
        {@render errorBlock('Failed to load thread', threadDetailError)}
      {:else if threadDetailLoading && !detail}
        {@render centerSpinner()}
      {:else if !detail}
        {@render emptyState(FileText, 'Thread not found.')}
      {:else}
        <!-- OP card: subject, author header, content blocks, stats. -->
        <article
          class="rounded-md bg-slate-900/70 p-3 ring-1 ring-slate-800"
          style:border-left="3px solid {stripe}"
        >
          <h2 class="text-sm font-semibold leading-tight text-slate-100">
            {#if detail.isPinned}
              <span class="mr-1 rounded bg-amber-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-200">
                pinned
              </span>
            {/if}
            {#if detail.isLocked}
              <span class="mr-1 rounded bg-rose-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-rose-200">
                locked
              </span>
            {/if}
            {#if detail.isCigHighlighted}
              <span class="mr-1 rounded bg-sky-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-200">
                cig
              </span>
            {/if}
            {detail.subject}
          </h2>
          <div class="mt-2 flex items-center gap-2">
            {@render avatar(
              avatarUrl(detail.authorAvatar),
              detail.authorDisplayName,
              detail.authorNickname,
              'size-7',
            )}
            <div class="min-w-0 flex-1">
              <p class="line-clamp-1 text-[11px] font-medium text-slate-100">
                {detail.authorDisplayName || detail.authorNickname}
              </p>
              <p class="text-[9px] text-slate-500">
                {timeAgo(detail.timeCreated)}
                {#if detail.viewsCount > 0} · {detail.viewsCount.toLocaleString()} views{/if}
              </p>
            </div>
          </div>
          <div class="mt-2 flex flex-col gap-1.5">
            {#if detail.isErased}
              <p class="text-[11px] italic text-slate-500">[erased]</p>
            {:else}
              {@render contentBlocks(detail.contentBlocks)}
            {/if}
          </div>
        </article>

        <!-- Replies — first 25 top-level replies. Deeper nesting links
             out to Spectrum (forum/thread/reply/childrens TBD). -->
        {#if detail.replies.length > 0}
          <h3 class="mt-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-teal-400">
            Replies ({detail.repliesCount.toLocaleString()})
          </h3>
          <ul class="flex flex-col gap-1">
            {#each detail.replies as r (r.id)}
              {@render threadReplyCard(r)}
            {/each}
          </ul>
          {#if detail.repliesCount > detail.replies.length}
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-1 rounded-md bg-slate-900/40 p-2 text-center text-[10px] italic text-slate-500 ring-1 ring-slate-800 transition hover:text-slate-200 hover:ring-teal-700"
            >
              {detail.repliesCount - detail.replies.length} more replies on Spectrum →
            </a>
          {/if}
        {/if}
      {/if}
    </div>
  {/snippet}

  {#snippet forumChannelCard(ch: ForumChannelInfo)}
    {@const stripe = ch.color || '#475569'}
    <li class="virt-item">
      <button
        type="button"
        onclick={() => selectForumChannel(ch.id)}
        class="group flex w-full items-start gap-2.5 rounded-md bg-slate-900/70 p-2 text-left ring-1 ring-slate-800 transition hover:bg-slate-900 hover:ring-teal-600"
        style:border-left="3px solid {stripe}"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <p class="line-clamp-1 text-xs font-medium text-slate-100 group-hover:text-teal-200">
              {ch.name}
            </p>
            <span class="shrink-0 text-[10px] text-slate-500">
              {ch.threadsCount.toLocaleString()} threads
            </span>
          </div>
          {#if ch.description}
            <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-500">{ch.description}</p>
          {/if}
        </div>
        <ChevronRight class="mt-0.5 size-3.5 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-teal-400" />
      </button>
    </li>
  {/snippet}

  <div class="flex-1 overflow-y-auto p-2">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Spectrum" />
    {:else if authState.signedIn === null}
      {@render centerSpinner()}
    {:else if tab === 'devtracker' || tab === 'trending'}
      {@const err = tab === 'devtracker' ? threadsError : trendingError}
      {@const isLoading = tab === 'devtracker' ? threadsLoading : trendingLoading}
      {@const list = tab === 'devtracker' ? threads : trending}
      {#if err}
        {@render errorBlock('Failed to load Spectrum', err)}
      {:else if isLoading && list.length === 0}
        {@render centerSpinner()}
      {:else if list.length === 0}
        {#if tab === 'trending'}
          {@render emptyState(Flame, 'Nothing trending right now.')}
        {:else}
          {@render emptyState(Code2, 'No DevTracker threads right now.')}
        {/if}
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each filteredThreads as t (t.id)}
            {@render threadCard(t)}
          {/each}
        </ul>

        {#if filteredThreads.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">No threads match your filter.</p>
        {/if}
      {/if}
    {:else if tab === 'bookmarks'}
      {#if bookmarksError}
        {@render errorBlock('Failed to load bookmarks', bookmarksError)}
      {:else if bookmarksLoading && bookmarks.length === 0}
        {@render centerSpinner()}
      {:else if bookmarks.length === 0}
        {@render emptyState(
          Bookmark,
          'No bookmarks yet — star a thread or chat lobby on Spectrum to pin it here.',
        )}
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each filteredBookmarks as b (`${b.entityType}:${b.entityId}`)}
            {@render bookmarkCard(b)}
          {/each}
        </ul>

        {#if filteredBookmarks.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">
            No bookmarks match your filter.
          </p>
        {/if}
      {/if}
    {:else if tab === 'forums'}
      <!-- Community switcher — shows up only when the user has at least
           one joined org community in addition to SC. The strip lives at
           the top of both the channel-list view and the threads view so
           switching is one click from anywhere. -->
      {#if communities.length > 1 && forumThreadP.value == null}
        {@render communitySwitcher()}
      {/if}

      {#if forumThreadP.value != null}
        <!-- Thread detail view (Phase 2b): renders the thread's
             content_blocks + first 25 replies in-popup. -->
        {@render threadDetailView()}
      {:else if forumChannelP.value == null}
        <!-- Channel list — grouped by forum_channel_groups in identify
             order (or v2/forum/channel/group/list for org communities),
             search filters across all groups. -->
        {#if forumGroupsError}
          {@render errorBlock('Failed to load forum channels', forumGroupsError)}
        {:else if forumGroupsLoading && forumGroups.length === 0}
          {@render centerSpinner()}
        {:else if forumGroups.length === 0}
          {@render emptyState(LayoutGrid, 'No forum channels available.')}
        {:else}
          <div class="mx-auto flex max-w-3xl flex-col gap-3">
            {#each filteredForumChannels as g (g.id)}
              <section>
                <h3 class="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-teal-400">
                  {g.name || `Group ${g.id}`}
                </h3>
                <ul class="flex flex-col gap-1">
                  {#each g.channels as ch (ch.id)}
                    {@render forumChannelCard(ch)}
                  {/each}
                </ul>
              </section>
            {/each}
          </div>

          {#if filteredForumChannels.length === 0}
            <p class="mt-6 text-center text-xs italic text-slate-500">
              No channels match your filter.
            </p>
          {/if}
        {/if}
      {:else}
        <!-- Threads view: header (back + channel meta) + sort selector + list. -->
        {@const ch = currentForumChannel}
        {@const stripe = ch?.color || '#475569'}
        <div class="mx-auto flex max-w-3xl flex-col gap-2">
          <div
            class="flex items-start gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800"
            style:border-left="3px solid {stripe}"
          >
            <button
              type="button"
              onclick={backToForumChannels}
              class="shrink-0 rounded-md p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
              title="Back to channels"
              aria-label="Back to channels"
            >
              <ArrowLeft class="size-4" />
            </button>
            <div class="min-w-0 flex-1">
              <p class="line-clamp-1 text-xs font-semibold text-slate-100">
                {ch?.name ?? 'Channel'}
              </p>
              {#if ch?.description}
                <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-500">{ch.description}</p>
              {/if}
            </div>
            <div class="flex shrink-0 rounded-md border border-slate-800 bg-slate-900 p-0.5 text-[10px]">
              {#each FORUM_SORTS as s (s.value)}
                <button
                  type="button"
                  onclick={() => selectForumSort(s.value)}
                  class="rounded px-1.5 py-0.5 transition
                    {forumSortP.value === s.value
                    ? 'bg-teal-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'}"
                >
                  {s.label}
                </button>
              {/each}
            </div>
          </div>

          {#if forumThreadsError}
            {@render errorBlock('Failed to load threads', forumThreadsError)}
          {:else if forumThreadsLoading && forumThreads.length === 0}
            {@render centerSpinner()}
          {:else if forumThreads.length === 0}
            {@render emptyState(LayoutGrid, 'No threads in this channel yet.')}
          {:else}
            <ul class="flex flex-col gap-1">
              {#each forumThreads as t (t.id)}
                {@render threadCard(t, selectThread)}
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    {:else if tab === 'dms'}
      {#if lobbiesError}
        {@render errorBlock('Failed to load DMs', lobbiesError)}
      {:else if lobbiesLoading && lobbies.length === 0}
        {@render centerSpinner()}
      {:else if lobbies.length === 0}
        {@render emptyState(Mail, 'No direct messages.')}
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each filteredLobbies as l (l.id)}
            {@render lobbyCard(l)}
          {/each}
        </ul>

        {#if filteredLobbies.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">No lobbies match your filter.</p>
        {/if}
      {/if}
    {:else if tab === 'notifications'}
      {#if notifsError}
        {@render errorBlock('Failed to load notifications', notifsError)}
      {:else if notifsLoading && notifs.length === 0}
        {@render centerSpinner()}
      {:else if notifs.length === 0}
        {@render emptyState(Bell, 'No notifications.')}
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each notifs as n (n.id)}
            {@render notifCard(n)}
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>
