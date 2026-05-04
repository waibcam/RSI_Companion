<script lang="ts">
  import { sendRsiMessage, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Filter,
    Loader2,
    MessageSquare,
    X,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { notifyState } from '../notify.svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage } from '../error';

  type Article = Rsi.CommLinkArticle;
  type FormOptions = Rsi.CommLinkFormOptions;
  type Sort = Rsi.CommLinkSort;

  // Filters persist across popup open/close — power-users that filter to, e.g.
  // "channel=transmission + series=inside + type=video" want that view restored
  // the next time they pop open the extension instead of rebuilding it.
  const channelP = persistedState<string>('commlink:channel', '');
  const seriesP = persistedState<string>('commlink:series', '');
  const typeP = persistedState<string>('commlink:type', '');
  const sortP = persistedState<Sort>('commlink:sort', 'publish_new');
  // Text is intentionally NOT persisted — text search is almost always
  // session-scoped and carrying it across popup opens would surprise the user
  // with a stale result set + empty hits on re-open.
  let text = $state('');

  // Per-URL "image is fully decoded in browser cache" tracker. We
  // preload each card's hero image via an off-DOM `new Image()`
  // object first; only once `load` fires do we add the URL to this
  // set, which mounts the visible `<img>` element below. The visible
  // img then pulls from the browser cache and decodes synchronously —
  // no partial-paint possible.
  //
  // Why preload off-DOM instead of revealing on load with opacity?
  // The previous opacity-flip approach was racy: a parent re-render
  // (filter change, query input, scroll) re-applied the static
  // `style="opacity: 0"` after the action had flipped it to 1, and
  // also `loading="lazy"` interacts badly with action timing —
  // Chrome can paint partial scanlines before the load event
  // resolves. Reported by the maintainer 2026-05-04 with screenshots
  // showing half-loaded JPEGs surviving even past load completion
  // until the user hovered (forcing a layout/repaint). Conditional
  // mount via this set side-steps every one of those failure modes.
  let imageLoaded = $state<Set<string>>(new Set());

  /** Kick off an off-DOM preload for one image URL. No-op if already
   *  in the loaded set. Adds the URL on success or on error — error
   *  paths still mount the visible img so a broken image isn't stuck
   *  forever behind the skeleton (the broken-img icon is fine; an
   *  endless skeleton is not). */
  function preloadImage(url: string): void {
    if (imageLoaded.has(url)) return;
    const probe = new Image();
    const done = (): void => {
      imageLoaded = new Set([...imageLoaded, url]);
    };
    probe.addEventListener('load', done, { once: true });
    probe.addEventListener('error', done, { once: true });
    probe.src = url;
  }

  // As the article list changes (initial load, filter changes, page
  // 2 paginate-on-scroll), kick a preload for every hero image we
  // haven't seen yet. The Set's `has` check inside `preloadImage`
  // keeps this idempotent.
  $effect(() => {
    for (const a of articles) {
      if (a.image) preloadImage(a.image);
    }
  });

  // Pending (edit-buffer) copies of the filters so the user can tweak multiple
  // controls before hitting Apply. Committed filters drive the fetch and the
  // persisted values; the pending copies drive the form inputs.
  let pendingChannel = $state(channelP.value);
  let pendingSeries = $state(seriesP.value);
  let pendingType = $state(typeP.value);
  let pendingSort = $state<Sort>(sortP.value);
  let pendingText = $state('');

  let articles = $state<Article[]>([]);
  let options = $state<FormOptions>({ channels: [], series: [], types: [], sorts: [] });
  let nextPage = $state(1);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let hasMore = $state(true);
  let filterOpen = $state(false);

  // Whether any server-side filter is active. Used by the infinite-scroll
  // sentinel (we still paginate when filtering) and by the "clear" button.
  const hasActiveFilter = $derived(
    channelP.value !== '' ||
      seriesP.value !== '' ||
      typeP.value !== '' ||
      text !== '' ||
      sortP.value !== 'publish_new',
  );

  async function loadPage(page: number, force = false) {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({
        type: 'commlink.list',
        page,
        channel: channelP.value || undefined,
        series: seriesP.value || undefined,
        articleType: typeP.value || undefined,
        text: text || undefined,
        sort: sortP.value,
        force,
      });
      if (page === 1) {
        articles = res.articles;
      } else {
        articles = [...articles, ...res.articles];
      }
      // Options always reflect the server's latest list — handy if CIG adds
      // a new series; users see it without an extension update. Guard against
      // stale cache entries from pre-options builds where the field is absent.
      if (res.options && res.options.channels.length > 0) options = res.options;
      fromCache = res.fromCache;
      nextPage = page + 1;
      if (res.articles.length === 0) hasMore = false;
      else hasMore = true;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  function refresh() {
    nextPage = 1;
    articles = [];
    hasMore = true;
    loadPage(1, true);
  }

  function applyPending() {
    // Bail early if a fetch is already in flight. Without this guard the
    // second rapid click would reset `articles = []` mid-load, flashing
    // an empty list before the in-progress loadPage(1) settles.
    if (loading) return;
    channelP.value = pendingChannel;
    seriesP.value = pendingSeries;
    typeP.value = pendingType;
    sortP.value = pendingSort;
    text = pendingText;
    articles = [];
    nextPage = 1;
    hasMore = true;
    filterOpen = false;
    loadPage(1);
  }

  function clearAll() {
    pendingChannel = '';
    pendingSeries = '';
    pendingType = '';
    pendingSort = 'publish_new';
    pendingText = '';
    applyPending();
  }

  function openFilters() {
    // Snapshot the current committed filters into the pending buffer so the
    // form opens showing what's currently applied rather than last edits.
    pendingChannel = channelP.value;
    pendingSeries = seriesP.value;
    pendingType = typeP.value;
    pendingSort = sortP.value;
    pendingText = text;
    filterOpen = true;
  }

  // Infinite-scroll: scroll-event-driven, with a "drain on load
  // complete" effect as a backup.
  //
  // Why scroll-event over IntersectionObserver? Reported by the
  // maintainer twice on 2026-05-04 — IO-based approaches kept
  // missing fires:
  //   - IO only fires on enter/exit *transitions*, not while the
  //     sentinel is steadily in view. If `loading=true` swallows the
  //     first event and the load completes WITHOUT the sentinel
  //     scrolling out of view (typical on small popup with rapid
  //     fetch), no fresh enter event is generated and the user has
  //     to scroll back-and-forth to trigger a new one.
  //   - The reactive split (sentinelInView state + drain effect) we
  //     tried first fixed that in theory but the user reported it
  //     still felt off — likely IO update-timing relative to Svelte
  //     reactivity, or the popup's nested overflow-y-auto vs
  //     `root: null` having a less-predictable interaction than
  //     reading scrollTop directly.
  //
  // Direct scroll-event check is just `scrollHeight - scrollTop -
  // clientHeight < threshold` — straightforward, no IO root /
  // rootMargin / clipping subtleties to reason about. Fires on every
  // scroll event (Chrome throttles those automatically; we don't
  // need our own throttle since the work is gated by `loading`).
  //
  // The drain effect fires loadPage AFTER each fetch completes if
  // the user is still close to the bottom — covers the case where
  // a slow first fetch finishes while the user has stopped scrolling
  // but is still near the end (no fresh scroll event would fire).
  let scrollContainer = $state<HTMLElement | null>(null);
  const NEAR_BOTTOM_PX = 600;
  function isNearBottom(): boolean {
    const el = scrollContainer;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }
  function onScroll(): void {
    if (isNearBottom() && !loading && hasMore) {
      void loadPage(nextPage);
    }
  }
  $effect(() => {
    // Drain on load-complete: when `loading` flips back to false, if
    // we're still within NEAR_BOTTOM_PX of the bottom, fire the next
    // page. Without this, a user who scrolled to the bottom and
    // stopped (no further scroll events) wouldn't get the next batch
    // after the first one arrived.
    //
    // `articles.length` is included as a dependency so this effect
    // re-runs after the new batch is rendered (DOM update changes
    // scrollHeight / clientHeight). Bare `_=articles.length` is a
    // common Svelte 5 pattern for "depend on this state without
    // reading it for logic".
    void articles.length;
    if (!loading && hasMore && isNearBottom()) {
      void loadPage(nextPage);
    }
  });

  // Snapshot the unread count BEFORE markSeen clears it. The badge on the
  // sidebar goes to 0 the moment the user opens the module, but the user still
  // wants to know *which* articles are the new ones. The list is newest-first,
  // so we tag the top N cards with a subtle "NEW" ribbon for this session.
  // Only meaningful when no filter is applied — filtered views don't map to
  // what the notify poll saw as "unread".
  const unreadAtOpen = notifyState.state.counts['comm-link'];
  const showNewRibbon = $derived(!hasActiveFilter);

  loadPage(1);
  notifyState.markSeen('comm-link');
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Comm-Link" {loading} {fromCache} onRefresh={refresh} refreshLabel="Refresh">
    {#snippet meta()}
      {#if hasActiveFilter}
        <span class="text-[10px] text-sky-400">· filtered</span>
      {/if}
    {/snippet}
    {#snippet controls()}
      <button
        type="button"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition hover:bg-slate-800 hover:text-slate-100
          {hasActiveFilter ? 'text-sky-300' : 'text-slate-400'}"
        onclick={() => (filterOpen ? (filterOpen = false) : openFilters())}
        title="Search &amp; filter"
        aria-expanded={filterOpen}
      >
        <Filter class="size-3.5" />
        <span>Filters</span>
      </button>
    {/snippet}
  </ModuleHeader>

  {#if filterOpen}
    <div class="border-b border-slate-800 bg-slate-950/60 px-3 py-2">
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label class="flex items-center gap-2 text-[11px] text-slate-400">
          <span class="w-16 shrink-0">Channel</span>
          <select
            bind:value={pendingChannel}
            class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            {#if options.channels.length === 0}
              <option value="">All</option>
            {:else}
              {#each options.channels as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            {/if}
          </select>
        </label>

        <label class="flex items-center gap-2 text-[11px] text-slate-400">
          <span class="w-16 shrink-0">Series</span>
          <select
            bind:value={pendingSeries}
            class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            {#if options.series.length === 0}
              <option value="">All</option>
            {:else}
              {#each options.series as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            {/if}
          </select>
        </label>

        <label class="flex items-center gap-2 text-[11px] text-slate-400">
          <span class="w-16 shrink-0">Type</span>
          <select
            bind:value={pendingType}
            class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            {#if options.types.length === 0}
              <option value="">All</option>
            {:else}
              {#each options.types as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            {/if}
          </select>
        </label>

        <label class="flex items-center gap-2 text-[11px] text-slate-400">
          <span class="w-16 shrink-0">Sort</span>
          <select
            bind:value={pendingSort}
            class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            {#if options.sorts.length === 0}
              <option value="publish_new">New</option>
              <option value="publish_old">Old</option>
            {:else}
              {#each options.sorts as o (o.value)}
                <option value={o.value}>{o.label}</option>
              {/each}
            {/if}
          </select>
        </label>

        <label class="flex items-center gap-2 text-[11px] text-slate-400 sm:col-span-2">
          <span class="w-16 shrink-0">Text</span>
          <input
            type="search"
            placeholder="Search title &amp; body…"
            bind:value={pendingText}
            onkeydown={(e) => { if (e.key === 'Enter') applyPending(); }}
            class="min-w-0 flex-1 rounded border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
          />
        </label>
      </div>

      <div class="mt-2 flex items-center justify-end gap-2">
        {#if hasActiveFilter}
          <button
            type="button"
            class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            onclick={clearAll}
          >
            <X class="size-3" />
            Clear
          </button>
        {/if}
        <button
          type="button"
          class="rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-[11px] text-slate-200 transition hover:bg-slate-700"
          onclick={() => (filterOpen = false)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="rounded-md bg-sky-600 px-3 py-1 text-[11px] font-semibold text-sky-50 transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          onclick={applyPending}
          disabled={loading}
        >
          Apply
        </button>
      </div>
    </div>
  {/if}

  <div
    class="flex-1 overflow-y-auto p-3"
    bind:this={scrollContainer}
    onscroll={onScroll}
  >
    {#if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load Comm-Link</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && articles.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else}
      <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
        {#each articles as a, i (a.href)}
          {@const isNew = showNewRibbon && i < unreadAtOpen}
          <li class="virt-item-lg">
            <a
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              class="group block overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-800 transition hover:ring-sky-600
                {isNew ? 'ring-sky-500/60' : ''}"
            >
              {#if a.image}
                <!-- Show a pulsing skeleton until the image is fully
                     decoded in the browser cache (tracked by
                     `imageLoaded` above via off-DOM preload). Once
                     loaded, mount the real <img> — it hits the cache
                     and renders instantly, no partial paint possible.
                     `decoding="sync"` because we KNOW the bytes are
                     in cache at this point; sync decode is a single
                     blocking call with no perceptible cost. -->
                <div class="relative aspect-[16/9] overflow-hidden bg-slate-950">
                  {#if imageLoaded.has(a.image)}
                    <img
                      src={a.image}
                      alt=""
                      decoding="sync"
                      class="size-full object-cover transition group-hover:scale-105"
                    />
                  {:else}
                    <div class="absolute inset-0 animate-pulse bg-slate-800/40"></div>
                  {/if}
                </div>
              {/if}
              <div class="p-2">
                <div class="mb-1 flex items-center gap-1.5">
                  {#if isNew}
                    <span class="rounded bg-sky-500/25 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-200">new</span>
                  {/if}
                  {#if a.type}
                    <span
                      class="rounded bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-sky-300"
                      >{a.type}</span
                    >
                  {/if}
                  <span class="text-[10px] text-slate-500">{a.timeAgo}</span>
                </div>
                <p class="line-clamp-2 text-xs font-medium text-slate-200">{a.title}</p>
                <div class="mt-1 flex items-center gap-1 text-[10px] text-slate-500">
                  <MessageSquare class="size-3" />
                  {a.comments}
                </div>
              </div>
            </a>
          </li>
        {/each}
      </ul>

      {#if articles.length === 0 && !loading}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No articles match the current filters.
        </p>
      {/if}

      {#if articles.length > 0}
        <div class="mt-4 flex h-10 items-center justify-center text-xs text-slate-500">
          {#if loading}
            <Loader2 class="size-4 animate-spin" />
          {:else if !hasMore}
            <span class="italic">No more articles.</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
