<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import { avatarFallback, formatCompact, formatDate, timeAgo, timeUntil } from '../format';
  import {
    AlertTriangle,
    CalendarRange,
    CalendarDays,
    ChevronRight,
    CircleDot,
    Clock,
    Eye,
    Flame,
    Gamepad2,
    GraduationCap,
    Heart,
    Home,
    Loader2,
    MessageCircle,
    Sparkles,
    Tv,
    Users,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage } from '../error';

  type LivePost = Rsi.CommunityHubLivePost;
  type Post = Rsi.CommunityHubPost;
  type Event = Rsi.CommunityHubEvent;
  type Tab = Rsi.CommunityHubTab;
  type Sort = Rsi.CommunityHubSort;
  type Type = Rsi.CommunityHubType;

  const TABS: readonly Tab[] = ['home', 'live', 'discover', 'gameplay', 'tutorial', 'events'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);

  const SORTS: ReadonlyArray<{ value: Sort; label: string }> = [
    { value: 'newest', label: 'Newest' },
    { value: 'trending', label: 'Trending' },
  ];

  const TYPES: ReadonlyArray<{ value: Type; label: string }> = [
    { value: 'image', label: 'Image' },
    { value: 'video', label: 'Video' },
    { value: 'text', label: 'Text' },
    { value: 'audio', label: 'Audio' },
  ];

  // Default tab is 'home' for new users; existing users keep whatever tab
  // they last selected (the persisted-state guard now accepts 'home' too).
  const tabP = persistedState<Tab>('communityHub:tab', 'home', isTab);
  let sort = $state<Sort>('newest');
  let selectedTypes = $state<Type[]>([]);
  let live = $state<LivePost[]>([]);
  let followed = $state<LivePost[]>([]);
  let posts = $state<Post[]>([]);
  // Home-tab strips — kept separate from `posts` so a fresh Home load
  // doesn't blow away the dedicated Discover/Gameplay/Tutorial tab data.
  let trending = $state<Post[]>([]);
  let gameplay = $state<Post[]>([]);
  let tutorial = $state<Post[]>([]);
  let upcoming = $state<Event[]>([]);
  let past = $state<Event[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let query = $state('');

  const TAB_META: Record<Tab, { label: string; icon: typeof Tv; path: string }> = {
    home: { label: 'Home', icon: Home, path: '/community-hub' },
    live: { label: 'Lives', icon: Tv, path: '/community-hub' },
    discover: { label: 'Discover', icon: Sparkles, path: '/community-hub/discover' },
    gameplay: { label: 'Gameplay', icon: Gamepad2, path: '/community-hub/discover?tags=gameplay' },
    tutorial: { label: 'Tutorial', icon: GraduationCap, path: '/community-hub/discover?tags=tutorial' },
    events: { label: 'Events', icon: CalendarDays, path: '/community-hub/events' },
  };

  const showSort = $derived(
    tabP.value !== 'home' && tabP.value !== 'live' && tabP.value !== 'events',
  );
  const showTypes = $derived(tabP.value === 'discover' || tabP.value === 'gameplay' || tabP.value === 'tutorial');

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({
        type: 'communityHub.list',
        tab: tabP.value,
        sort: showSort ? sort : undefined,
        types: showTypes && selectedTypes.length > 0 ? selectedTypes : undefined,
        force,
      });
      if (res.tab === 'home') {
        live = res.live;
        followed = res.followed;
        trending = res.trending;
        gameplay = res.gameplay;
        tutorial = res.tutorial;
        posts = [];
        upcoming = [];
        past = [];
      } else if (res.tab === 'live') {
        live = res.live;
        followed = res.followed;
        trending = [];
        gameplay = [];
        tutorial = [];
        posts = [];
        upcoming = [];
        past = [];
      } else if (res.tab === 'events') {
        upcoming = res.upcoming;
        past = res.past;
        live = [];
        followed = [];
        trending = [];
        gameplay = [];
        tutorial = [];
        posts = [];
      } else {
        posts = res.posts;
        live = [];
        followed = [];
        trending = [];
        gameplay = [];
        tutorial = [];
        upcoming = [];
        past = [];
      }
      fromCache = res.fromCache;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  function selectTab(next: Tab) {
    if (next === tabP.value) return;
    tabP.value = next;
    query = '';
    selectedTypes = [];
    sort = 'newest';
    load();
  }

  function selectSort(next: Sort) {
    if (next === sort) return;
    sort = next;
    load();
  }

  function toggleType(t: Type) {
    selectedTypes = selectedTypes.includes(t)
      ? selectedTypes.filter((x) => x !== t)
      : [...selectedTypes, t];
    load();
  }

  const filteredLive = $derived.by<LivePost[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return live;
    return live.filter((p) => {
      const hay = `${p.title} ${p.summary} ${p.authorDisplayName} ${p.authorNickname}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const filteredPosts = $derived.by<Post[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return posts;
    return posts.filter((p) => {
      const hay = `${p.title} ${p.summary} ${p.authorDisplayName} ${p.authorNickname} ${p.tags.join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
  });

  const filteredUpcoming = $derived.by<Event[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return upcoming;
    return upcoming.filter((e) =>
      `${e.title} ${e.groupTitle} ${e.summary}`.toLowerCase().includes(q),
    );
  });

  const filteredPast = $derived.by<Event[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return past;
    return past.filter((e) => `${e.title} ${e.groupTitle} ${e.summary}`.toLowerCase().includes(q));
  });


  function postHref(p: Post): string {
    return p.membershipUrl || p.url || `${RSI_BASE_URL}/community-hub`;
  }

  function eventHref(e: Event): string {
    if (e.url) return e.url;
    if (e.groupSlug && e.slug) return `${RSI_BASE_URL}/community-hub/event/${e.groupSlug}/${e.slug}`;
    return `${RSI_BASE_URL}/community-hub/events`;
  }

  load();
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Community Hub" {loading} {fromCache} onRefresh={() => load(true)}>
    {#snippet meta()}
      <span class="text-[10px] text-slate-500">
        {#if tabP.value === 'home'}
          {live.length} live · {trending.length + gameplay.length + tutorial.length} posts
        {:else if tabP.value === 'live'}
          {live.length} live{followed.length > 0 ? ` · ${followed.length} followed` : ''}
        {:else if tabP.value === 'events'}
          {upcoming.length} upcoming · {past.length} past
        {:else}
          {posts.length} posts
        {/if}
      </span>
    {/snippet}
    {#snippet controls()}
      <input
        type="search"
        placeholder="Filter..."
        bind:value={query}
        class="min-w-0 flex-1 max-w-48 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />

      <a
        href="{RSI_BASE_URL}{TAB_META[tabP.value].path}"
        target="_blank"
        rel="noopener noreferrer"
        class="rounded-md px-2 py-1 text-[10px] uppercase tracking-wider text-slate-500 transition hover:text-slate-200"
      >
        Open
      </a>
    {/snippet}
  </ModuleHeader>

  <!-- Tabbar overflows horizontally on narrow popups (we have 6 tabs now;
       at 360px popup width minus the 88px sidebar that gets tight). The
       scrollbar is hidden because OS scrollbars look awful here, and the
       native overflow-snap keeps the active tab nicely aligned when the
       user lands on it via keyboard. -->
  <div
    class="flex gap-1 overflow-x-auto whitespace-nowrap border-b border-slate-800 bg-slate-950/40 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  >
    {#each Object.entries(TAB_META) as [key, meta] (key)}
      {@const Icon = meta.icon}
      {@const active = tabP.value === key}
      <button
        type="button"
        onclick={() => selectTab(key as Tab)}
        class="flex shrink-0 items-center gap-1 border-b-2 px-2.5 py-1.5 text-xs transition
          {active
            ? 'border-sky-500 text-slate-100'
            : 'border-transparent text-slate-500 hover:text-slate-300'}"
      >
        <Icon class="size-3.5" />
        {meta.label}
      </button>
    {/each}
  </div>

  {#if showSort || showTypes}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-slate-800 bg-slate-950/20 px-3 py-1.5 text-[10px]">
      {#if showSort}
        <div class="flex items-center gap-1">
          <span class="uppercase tracking-wider text-slate-500">Sort</span>
          <div class="flex rounded-md border border-slate-800 bg-slate-900 p-0.5">
            {#each SORTS as s (s.value)}
              <button
                type="button"
                onclick={() => selectSort(s.value)}
                class="rounded px-1.5 py-0.5 transition
                  {sort === s.value ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'}"
              >
                {s.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if showTypes}
        <div class="flex items-center gap-1">
          <span class="uppercase tracking-wider text-slate-500">Type</span>
          <div class="flex gap-1">
            {#each TYPES as t (t.value)}
              {@const checked = selectedTypes.includes(t.value)}
              <button
                type="button"
                onclick={() => toggleType(t.value)}
                class="rounded border px-1.5 py-0.5 transition
                  {checked
                    ? 'border-sky-600 bg-sky-600/20 text-sky-200'
                    : 'border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200'}"
              >
                {t.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load Community Hub</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if tabP.value === 'home'}
      <!-- Home tab — mirrors the four-strip layout of RSI's
           /community-hub home page (Livestreams → Trending → Gameplay →
           Tutorial). Each strip caps at 6-8 items and has a "View all"
           jump to the dedicated tab. The Followed slot above is
           user-specific (only shows when the signed-in user has any
           followed streams currently live) and uses a 2-col grid
           rather than a strip — its size is unpredictable and a strip
           with two cards looks abandoned.
      -->
      {#snippet stripHeader(
        label: string,
        subtitle: string,
        accentColor: string,
        viewAllTab: Tab,
        IconCmp: typeof Tv,
      )}
        <div class="mb-1 flex items-baseline justify-between gap-2">
          <div class="flex min-w-0 items-baseline gap-2">
            <h3
              class="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider {accentColor}"
            >
              <IconCmp class="size-3" />
              {label}
            </h3>
            {#if subtitle}
              <span class="truncate text-[9px] italic text-slate-500">{subtitle}</span>
            {/if}
          </div>
          <button
            type="button"
            onclick={() => selectTab(viewAllTab)}
            class="flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-500 transition hover:text-slate-200"
          >
            View all <ChevronRight class="size-3" />
          </button>
        </div>
      {/snippet}

      <!-- One <ul> per strip — common Tailwind soup factored once via this
           wrapper class string. Hidden vertical scrollbar but visible
           thin horizontal one so users actually realise the strip
           scrolls. -->
      {@const stripCls = 'mb-4 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-slate-700'}

      {#snippet streamCard(p: LivePost)}
        <li class="w-44 shrink-0">
          <a
            href={p.membershipUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            class="group flex flex-col overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-800 transition hover:ring-sky-600"
          >
            {#if p.thumbnailUrl}
              <div class="relative aspect-video w-full overflow-hidden bg-slate-950">
                <img
                  src={p.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover transition group-hover:scale-105"
                />
                <span class="absolute left-1 top-1 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-bold uppercase text-white">
                  Live
                </span>
                <span class="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-slate-950/80 px-1 py-0.5 text-[9px] text-slate-200">
                  <Eye class="size-2.5" />
                  {formatCompact(p.viewersCount)}
                </span>
              </div>
            {:else}
              {@const av = avatarFallback(p.authorDisplayName, p.authorNickname)}
              <div
                class="flex aspect-video w-full items-center justify-center bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-base font-semibold text-white/90"
              >
                {av.initials}
              </div>
            {/if}
            <div class="p-1.5">
              <p class="line-clamp-2 text-[11px] font-medium leading-tight text-slate-100">
                {p.title}
              </p>
              <p class="mt-0.5 truncate text-[9px] text-slate-400">{p.authorDisplayName}</p>
            </div>
          </a>
        </li>
      {/snippet}

      {#snippet postCard(p: Post)}
        <li class="w-44 shrink-0">
          <a
            href={postHref(p)}
            target="_blank"
            rel="noopener noreferrer"
            class="group flex flex-col overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-800 transition hover:ring-sky-600"
          >
            {#if p.thumbnailUrl}
              <div class="relative aspect-video w-full overflow-hidden bg-slate-950">
                <img
                  src={p.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  class="size-full object-cover transition group-hover:scale-105"
                />
                <span class="absolute left-1 top-1 rounded bg-slate-950/80 px-1 py-0.5 text-[8px] font-bold uppercase text-slate-300">
                  {p.type}
                </span>
              </div>
            {:else}
              {@const av = avatarFallback(p.authorDisplayName, p.authorNickname)}
              <div
                class="flex aspect-video w-full items-center justify-center bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-base font-semibold text-white/90"
              >
                {av.initials}
              </div>
            {/if}
            <div class="p-1.5">
              <p class="line-clamp-2 text-[11px] font-medium leading-tight text-slate-100">
                {p.title}
              </p>
              <p class="mt-0.5 truncate text-[9px] text-slate-400">{p.authorDisplayName}</p>
              <p class="mt-0.5 flex items-center gap-2 text-[9px] text-slate-500">
                <span class="flex items-center gap-0.5">
                  <Heart class="size-2.5" />
                  {p.votesCount}
                </span>
                <span class="flex items-center gap-0.5">
                  <MessageCircle class="size-2.5" />
                  {p.commentsCount}
                </span>
                <span>· {timeAgo(p.createdAt)}</span>
              </p>
            </div>
          </a>
        </li>
      {/snippet}

      {#if followed.length === 0 && live.length === 0 && trending.length === 0 && gameplay.length === 0 && tutorial.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Sparkles class="size-8" />
          <p class="text-xs italic">The Community Hub is quiet right now.</p>
        </div>
      {:else}
        {#if followed.length > 0}
          {@render stripHeader('Followed live', 'Streams from accounts you follow', 'text-sky-400', 'live', Users)}
          <ul class="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each followed as p (p.uid)}
              <li>
                <a
                  href={p.membershipUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
                >
                  {#if p.thumbnailUrl}
                    <div class="relative size-14 shrink-0 overflow-hidden rounded bg-slate-950">
                      <img
                        src={p.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        class="size-full object-cover transition group-hover:scale-105"
                      />
                      <span class="absolute left-1 top-1 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-bold uppercase text-white">
                        Live
                      </span>
                    </div>
                  {:else}
                    {@const av = avatarFallback(p.authorDisplayName, p.authorNickname)}
                    <div
                      class="flex size-14 shrink-0 items-center justify-center rounded bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-sm font-semibold text-white/90"
                    >
                      {av.initials}
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs font-medium text-slate-100">{p.title}</p>
                    <p class="mt-0.5 truncate text-[10px] text-slate-400">{p.authorDisplayName}</p>
                    <p class="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <span class="flex items-center gap-0.5">
                        <Eye class="size-3" />
                        {formatCompact(p.viewersCount)}
                      </span>
                      <span>· {timeAgo(p.createdAt)}</span>
                    </p>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        {#if live.length > 0}
          {@render stripHeader('Livestreams', 'Live now on Twitch.tv', 'text-rose-300', 'live', Tv)}
          <ul class={stripCls}>
            {#each live as p (p.uid)}
              {@render streamCard(p)}
            {/each}
          </ul>
        {/if}

        {#if trending.length > 0}
          {@render stripHeader('Trending', "See what's hot on the Hub", 'text-amber-400', 'discover', Flame)}
          <ul class={stripCls}>
            {#each trending as p (p.uid)}
              {@render postCard(p)}
            {/each}
          </ul>
        {/if}

        {#if gameplay.length > 0}
          {@render stripHeader('Gameplay', 'Show off what you can do in the game', 'text-violet-400', 'gameplay', Gamepad2)}
          <ul class={stripCls}>
            {#each gameplay as p (p.uid)}
              {@render postCard(p)}
            {/each}
          </ul>
        {/if}

        {#if tutorial.length > 0}
          {@render stripHeader('Tutorial', 'Guides, breakdowns, and helpful content', 'text-emerald-400', 'tutorial', GraduationCap)}
          <ul class={stripCls}>
            {#each tutorial as p (p.uid)}
              {@render postCard(p)}
            {/each}
          </ul>
        {/if}
      {/if}
    {:else if tabP.value === 'live'}
      {#if live.length === 0 && followed.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Tv class="size-8" />
          <p class="text-xs italic">No one is live on the Community Hub right now.</p>
        </div>
      {:else}
        {#if followed.length > 0}
          <h3 class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
            <Users class="size-3" /> Followed
          </h3>
          <ul class="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each followed as p (p.uid)}
              <li>
                <a
                  href={p.membershipUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
                >
                  {#if p.thumbnailUrl}
                    <div class="relative size-16 shrink-0 overflow-hidden rounded bg-slate-950">
                      <img
                        src={p.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        class="size-full object-cover transition group-hover:scale-105"
                      />
                      <span class="absolute left-1 top-1 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-bold uppercase text-white">
                        Live
                      </span>
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs font-medium text-slate-100">{p.title}</p>
                    <p class="mt-0.5 truncate text-[10px] text-slate-400">{p.authorDisplayName}</p>
                    <p class="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <span class="flex items-center gap-0.5">
                        <Eye class="size-3" />
                        {formatCompact(p.viewersCount)}
                      </span>
                      <span>· {timeAgo(p.createdAt)}</span>
                    </p>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        <h3 class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          <Tv class="size-3" /> Currently Live
        </h3>
        <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {#each filteredLive as p (p.uid)}
            <li>
              <a
                href={p.membershipUrl ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
              >
                {#if p.thumbnailUrl}
                  <div class="relative size-16 shrink-0 overflow-hidden rounded bg-slate-950">
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                    <span class="absolute left-1 top-1 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-bold uppercase text-white">
                      Live
                    </span>
                  </div>
                {:else}
                  {@const av = avatarFallback(p.authorDisplayName, p.authorNickname)}
                  <div
                    class="flex size-16 shrink-0 items-center justify-center rounded bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-sm font-semibold text-white/90"
                  >
                    {av.initials}
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs font-medium text-slate-100">{p.title}</p>
                  <p class="mt-0.5 truncate text-[10px] text-slate-400">{p.authorDisplayName}</p>
                  <p class="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                    <span class="flex items-center gap-0.5">
                      <Eye class="size-3" />
                      {formatCompact(p.viewersCount)}
                    </span>
                    <span>· {timeAgo(p.createdAt)}</span>
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>

        {#if filteredLive.length === 0 && live.length > 0}
          <p class="mt-4 text-center text-xs italic text-slate-500">No live streams match your filter.</p>
        {/if}
      {/if}
    {:else if tabP.value === 'events'}
      {#if upcoming.length === 0 && past.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <CalendarDays class="size-8" />
          <p class="text-xs italic">No events.</p>
        </div>
      {:else}
        {#if filteredUpcoming.length > 0}
          <h3 class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-sky-400">
            <CalendarRange class="size-3" /> Upcoming
          </h3>
          <ul class="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each filteredUpcoming as e (e.uid)}
              <li>
                <a
                  href={eventHref(e)}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
                >
                  {#if e.imageUrl}
                    <div class="relative size-16 shrink-0 overflow-hidden rounded bg-slate-950">
                      <img
                        src={e.imageUrl}
                        alt=""
                        loading="lazy"
                        class="size-full object-cover transition group-hover:scale-105"
                      />
                      {#if e.isLive}
                        <span class="absolute left-1 top-1 flex items-center gap-0.5 rounded bg-rose-600 px-1 py-0.5 text-[8px] font-bold uppercase text-white">
                          <CircleDot class="size-2" /> Live
                        </span>
                      {/if}
                    </div>
                  {:else}
                    <div class="flex size-16 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                      <CalendarDays class="size-6" />
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs font-medium text-slate-100">{e.title}</p>
                    {#if e.groupTitle && e.groupTitle !== e.title}
                      <p class="mt-0.5 truncate text-[10px] text-slate-400">{e.groupTitle}</p>
                    {/if}
                    <p class="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <Clock class="size-3" />
                      {#if e.isLive}
                        <span class="text-rose-300">Live now</span>
                      {:else}
                        <span>{timeUntil(e.startedAt) || formatDate(e.startedAt)}</span>
                      {/if}
                      {#if e.postCount > 0}
                        <span>· {e.postCount} posts</span>
                      {/if}
                    </p>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        {#if filteredPast.length > 0}
          <h3 class="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            <CalendarDays class="size-3" /> Past events
          </h3>
          <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each filteredPast as e (e.uid)}
              <li>
                <a
                  href={eventHref(e)}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
                >
                  {#if e.imageUrl}
                    <div class="size-16 shrink-0 overflow-hidden rounded bg-slate-950">
                      <img
                        src={e.imageUrl}
                        alt=""
                        loading="lazy"
                        class="size-full object-cover opacity-80 transition group-hover:scale-105 group-hover:opacity-100"
                      />
                    </div>
                  {:else}
                    <div class="flex size-16 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                      <CalendarDays class="size-6" />
                    </div>
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="line-clamp-2 text-xs font-medium text-slate-100">{e.title}</p>
                    {#if e.groupTitle && e.groupTitle !== e.title}
                      <p class="mt-0.5 truncate text-[10px] text-slate-400">{e.groupTitle}</p>
                    {/if}
                    <p class="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
                      <Clock class="size-3" />
                      <span>Ended {timeAgo(e.endedAt) || formatDate(e.endedAt)}</span>
                      {#if e.postCount > 0}
                        <span>· {e.postCount} posts</span>
                      {/if}
                    </p>
                  </div>
                </a>
              </li>
            {/each}
          </ul>
        {/if}

        {#if filteredUpcoming.length === 0 && filteredPast.length === 0}
          <p class="mt-4 text-center text-xs italic text-slate-500">No events match your filter.</p>
        {/if}
      {/if}
    {:else}
      {#if posts.length === 0}
        <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
          <Sparkles class="size-8" />
          <p class="text-xs italic">No posts.</p>
        </div>
      {:else}
        <ul class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {#each filteredPosts as p (p.uid)}
            <li>
              <a
                href={postHref(p)}
                target="_blank"
                rel="noopener noreferrer"
                class="group flex gap-2 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
              >
                {#if p.thumbnailUrl}
                  <div class="relative size-16 shrink-0 overflow-hidden rounded bg-slate-950">
                    <img
                      src={p.thumbnailUrl}
                      alt=""
                      loading="lazy"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                    <span class="absolute left-1 top-1 rounded bg-slate-950/80 px-1 py-0.5 text-[8px] font-bold uppercase text-slate-300">
                      {p.type}
                    </span>
                  </div>
                {:else}
                  {@const av = avatarFallback(p.authorDisplayName, p.authorNickname)}
                  <div
                    class="flex size-16 shrink-0 items-center justify-center rounded bg-gradient-to-br {av.gradientFrom} {av.gradientTo} text-sm font-semibold text-white/90"
                  >
                    {av.initials}
                  </div>
                {/if}
                <div class="min-w-0 flex-1">
                  <p class="line-clamp-2 text-xs font-medium text-slate-100">{p.title}</p>
                  <p class="mt-0.5 truncate text-[10px] text-slate-400">
                    {p.authorDisplayName}
                    {#if p.honor && p.honor !== 'REGULAR'}
                      <span class="ml-1 rounded bg-amber-900/60 px-1 py-0.5 text-[8px] font-bold uppercase text-amber-200">{p.honor}</span>
                    {/if}
                  </p>
                  <p class="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    <span class="flex items-center gap-0.5">
                      <Heart class="size-3" />
                      {p.votesCount}
                    </span>
                    <span class="flex items-center gap-0.5">
                      <MessageCircle class="size-3" />
                      {p.commentsCount}
                    </span>
                    <span>· {timeAgo(p.createdAt)}</span>
                  </p>
                </div>
              </a>
            </li>
          {/each}
        </ul>

        {#if filteredPosts.length === 0 && posts.length > 0}
          <p class="mt-4 text-center text-xs italic text-slate-500">No posts match your filter.</p>
        {/if}
      {/if}
    {/if}
  </div>
</section>
