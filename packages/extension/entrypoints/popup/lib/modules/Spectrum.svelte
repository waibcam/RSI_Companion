<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Bell,
    CheckCheck,
    Code2,
    Flame,
    Loader2,
    Mail,
    UserRound,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { notifyState } from '../notify.svelte';
  import { authState } from '../state.svelte';
  import { timeAgo } from '../format';
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


  function formatNotifKind(t: string): string {
    if (!t) return '';
    return t.replace(/_/g, ' ');
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
    <div class="flex overflow-x-auto border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
      <button
        type="button"
        onclick={() => switchTab('devtracker')}
        class="relative flex shrink-0 items-center gap-1 px-3 py-1.5 transition {tab === 'devtracker'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Code2 class="size-3" />
        DevTracker
        {#if tab === 'devtracker'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => switchTab('trending')}
        class="relative flex shrink-0 items-center gap-1 px-3 py-1.5 transition {tab === 'trending'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Flame class="size-3" />
        Trending
        {#if tab === 'trending'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => switchTab('dms')}
        class="relative flex shrink-0 items-center gap-1 px-3 py-1.5 transition {tab === 'dms'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Mail class="size-3" />
        DMs
        {#if unreadLobbies > 0}
          <span
            class="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300"
          >
            {unreadLobbies > 99 ? '99+' : unreadLobbies}
          </span>
        {/if}
        {#if tab === 'dms'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
      <button
        type="button"
        onclick={() => switchTab('notifications')}
        class="relative flex shrink-0 items-center gap-1 px-3 py-1.5 transition {tab === 'notifications'
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        <Bell class="size-3" />
        Notifications
        {#if unreadNotifs > 0}
          <span
            class="rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300"
          >
            {unreadNotifs > 99 ? '99+' : unreadNotifs}
          </span>
        {/if}
        {#if tab === 'notifications'}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-2">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Spectrum" />
    {:else if authState.signedIn === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if tab === 'devtracker' || tab === 'trending'}
      {@const err = tab === 'devtracker' ? threadsError : trendingError}
      {@const isLoading = tab === 'devtracker' ? threadsLoading : trendingLoading}
      {@const list = tab === 'devtracker' ? threads : trending}
      {#if err}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load Spectrum</p>
            <p class="mt-1 break-all text-rose-300/80">{err}</p>
          </div>
        </div>
      {:else if isLoading && list.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if list.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          {#if tab === 'trending'}
            <Flame class="size-8" />
            <p class="text-xs italic">Nothing trending right now.</p>
          {:else}
            <Code2 class="size-8" />
            <p class="text-xs italic">No DevTracker threads right now.</p>
          {/if}
        </div>
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each filteredThreads as t (t.id)}
            <li class="virt-item">
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-start gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
                style:border-left="3px solid {t.channel.color || '#475569'}"
              >
                <div
                  class="size-7 shrink-0 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800"
                >
                  {#if avatarUrl(t.authorAvatar)}
                    <img src={avatarUrl(t.authorAvatar)} alt="" loading="lazy" class="size-full object-cover" />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <UserRound class="size-4" />
                    </div>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs font-medium text-slate-100">
                    {#if t.isNew}
                      <span
                        class="mr-1 rounded bg-sky-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-300"
                        >new</span
                      >
                    {/if}
                    {t.subject}
                  </p>
                  <p class="mt-0.5 truncate text-[10px] text-slate-500">
                    <span style:color={t.channel.color || undefined}>{t.channel.name}</span>
                    · {t.authorDisplayName}
                    · {timeAgo(t.timeCreated)}
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>

        {#if filteredThreads.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">No threads match your filter.</p>
        {/if}
      {/if}
    {:else if tab === 'dms'}
      {#if lobbiesError}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load DMs</p>
            <p class="mt-1 break-all text-rose-300/80">{lobbiesError}</p>
          </div>
        </div>
      {:else if lobbiesLoading && lobbies.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if lobbies.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Mail class="size-8" />
          <p class="text-xs italic">No direct messages.</p>
        </div>
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each filteredLobbies as l (l.id)}
            <li class="virt-item">
              <a
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-start gap-2 rounded-md p-2 ring-1 transition hover:ring-sky-600 {l.newMessages > 0
                  ? 'bg-slate-900/80 ring-emerald-900/60'
                  : 'bg-slate-900/40 ring-slate-800'}"
              >
                <div class="size-7 shrink-0 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800">
                  {#if avatarUrl(l.lastAuthorAvatar)}
                    <img src={avatarUrl(l.lastAuthorAvatar)} alt="" loading="lazy" class="size-full object-cover" />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <UserRound class="size-4" />
                    </div>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <p class="line-clamp-1 text-xs font-medium text-slate-100">{l.name}</p>
                    {#if l.newMessages > 0}
                      <span class="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
                        {l.newMessages}
                      </span>
                    {/if}
                  </div>
                  {#if l.lastMessageText}
                    <p class="line-clamp-1 text-[11px] text-slate-400">
                      {#if l.lastAuthorDisplayName}
                        <span class="text-slate-500">{l.lastAuthorDisplayName}:</span>
                      {/if}
                      {l.lastMessageText}
                    </p>
                  {/if}
                  <p class="mt-0.5 text-[10px] text-slate-500">{timeAgo(l.lastMessageAt)}</p>
                </div>
              </a>
            </li>
          {/each}
        </ul>

        {#if filteredLobbies.length === 0}
          <p class="mt-6 text-center text-xs italic text-slate-500">No lobbies match your filter.</p>
        {/if}
      {/if}
    {:else if tab === 'notifications'}
      {#if notifsError}
        <div
          class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
        >
          <AlertTriangle class="mt-0.5 size-4 shrink-0" />
          <div>
            <p class="font-semibold">Failed to load notifications</p>
            <p class="mt-1 break-all text-rose-300/80">{notifsError}</p>
          </div>
        </div>
      {:else if notifsLoading && notifs.length === 0}
        <div class="flex h-full items-center justify-center text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if notifs.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Bell class="size-8" />
          <p class="text-xs italic">No notifications.</p>
        </div>
      {:else}
        <ul class="mx-auto flex max-w-3xl flex-col gap-1">
          {#each notifs as n (n.id)}
            {@const href = n.url ?? (n.authorNickname ? `${RSI_BASE_URL}/citizens/${n.authorNickname}` : '#')}
            <li class="virt-item">
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-start gap-2 rounded-md p-2 ring-1 transition hover:ring-sky-600 {n.read
                  ? 'bg-slate-900/40 ring-slate-800'
                  : 'bg-slate-900/80 ring-emerald-900/60'}"
              >
                <div class="size-7 shrink-0 overflow-hidden rounded-full bg-slate-950 ring-1 ring-slate-800">
                  {#if avatarUrl(n.authorAvatar)}
                    <img src={avatarUrl(n.authorAvatar)} alt="" loading="lazy" class="size-full object-cover" />
                  {:else}
                    <div class="flex size-full items-center justify-center text-slate-700">
                      <UserRound class="size-4" />
                    </div>
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs text-slate-100">
                    {#if !n.read}
                      <span class="mr-1 inline-block size-1.5 rounded-full bg-emerald-400"></span>
                    {/if}
                    {n.text}
                  </p>
                  <p class="mt-0.5 text-[10px] text-slate-500">
                    {#if n.type}
                      <span>{formatNotifKind(n.type)}</span>
                      <span> · </span>
                    {/if}
                    {timeAgo(n.timeCreated)}
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
</section>
