<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    AtSign,
    Bell,
    CheckCheck,
    Code2,
    Flame,
    Heart,
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
  // "devtracker" is the renamed "activity" tab — the underlying data is the
  // CIG-highlighted threads aggregate, which is exactly what RSI calls the
  // Dev Tracker. The old id is kept as the default so existing localStorage
  // selections keep pointing at this tab.
  type Tab = 'devtracker' | 'trending' | 'dms' | 'notifications';

  const TABS: readonly Tab[] = ['devtracker', 'trending', 'dms', 'notifications'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  const tabP = persistedState<Tab>('spectrum:tab', 'devtracker', isTab);
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
    if (next === 'notifications' && !notifsLoaded && signedIn !== false) {
      loadNotifications();
    } else if (next === 'trending' && !trendingLoaded && signedIn !== false) {
      loadTrending();
    } else if (next === 'dms' && !lobbiesLoaded && signedIn !== false) {
      loadLobbies();
    }
  }

  function refresh() {
    if (tab === 'devtracker') loadThreads(true);
    else if (tab === 'trending') loadTrending(true);
    else if (tab === 'notifications') loadNotifications(true);
    else if (tab === 'dms') loadLobbies(true);
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
            : false,
  );
  const showSearch = $derived(tab === 'devtracker' || tab === 'trending' || tab === 'dms');
  const showRefresh = $derived(
    tab === 'devtracker' || tab === 'trending' || tab === 'notifications' || tab === 'dms',
  );
  const fromCache = $derived(
    (tab === 'devtracker' && threadsFromCache) ||
      (tab === 'trending' && trendingFromCache) ||
      (tab === 'dms' && lobbiesFromCache),
  );

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
      // If the user's persisted tab is Trending or DMs, kick those loaders
      // too so returning to the Spectrum module (e.g. after visiting another
      // module) shows the cached content immediately instead of an empty
      // list that only populates after a manual tab toggle.
      if (tabP.value === 'trending') void loadTrending();
      else if (tabP.value === 'dms') void loadLobbies();
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

  {#snippet threadCard(t: Thread)}
    {@const ch = t.channel}
    {@const stripe = ch.color || '#475569'}
    <li class="virt-item">
      <a
        href={t.url}
        target="_blank"
        rel="noopener noreferrer"
        class="group flex gap-2.5 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:bg-slate-900 hover:ring-sky-600"
        style:border-left="3px solid {stripe}"
      >
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
              {ch.name}
            </span>
          </div>
          <p class="line-clamp-2 text-xs font-medium text-slate-100 group-hover:text-sky-200">
            {t.subject}
          </p>
          <p class="mt-0.5 truncate text-[10px] text-slate-500">
            {t.authorDisplayName} · {timeAgo(t.timeCreated)}
          </p>
        </div>
      </a>
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
