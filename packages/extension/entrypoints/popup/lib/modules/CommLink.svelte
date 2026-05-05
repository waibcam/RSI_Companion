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
  import { createPagedList } from '../paged-list.svelte';

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

  /** Svelte action: fully load + decode the image on a SINGLE `<img>`
   *  element, kept hidden under a skeleton until decode resolves.
   *
   *  History of attempts at this — in case anyone tries to "simplify"
   *  by going back to one of the earlier shapes:
   *
   *  1. inline `style="opacity: 0"` + onload — broken because parent
   *     re-renders re-applied the static style after onload flipped
   *     it. Also `load` fires post-download but pre-decode, so the
   *     reveal happened during the decode and showed partial paints.
   *  2. off-DOM probe (`new Image()`) preload via `decode()`, then
   *     mount a `<div>` with background-image — broken because the
   *     `<div>` triggers a SEPARATE fetch + decode chain (HTTP cache
   *     hits, decode cache doesn't transfer). The probe's decode
   *     work was discarded; the mount-time decode could still paint
   *     partial scanlines. Especially visible on COLD CDN entries
   *     (older Comm-Links) where the second fetch is slow enough
   *     for the partial-decode to be perceptible.
   *
   *  Current approach: one `<img>` element from creation through
   *  display. Set its src, wait for `decode()` (single fetch +
   *  single decode on this exact element), then reveal via opacity.
   *  No double-fetch, no parent-rerender race. Reported by
   *  @!DakotaVosselman & maintainer 2026-05-04. */
  function loadAfterDecode(node: HTMLImageElement, src: string) {
    let currentSrc = src;
    node.style.opacity = '0';
    node.style.transition = 'opacity 200ms ease';

    const apply = (url: string): void => {
      if (!url) return;
      // Setting src starts the fetch (browser handles HTTP caching).
      // decode() resolves only when the image is fully fetched AND
      // fully decoded — never during partial decode, which is the
      // exact window we need to hide.
      node.src = url;
      const onResolved = (): void => {
        // Guard against late resolution after the action's been
        // updated to a new URL — we don't want to reveal an obsolete
        // image.
        if (currentSrc === url) node.style.opacity = '1';
      };
      node.decode().then(onResolved).catch(onResolved);
    };

    apply(src);

    return {
      update(newSrc: string): void {
        if (newSrc !== currentSrc) {
          currentSrc = newSrc;
          node.style.opacity = '0';
          apply(newSrc);
        }
      },
    };
  }

  // Pending (edit-buffer) copies of the filters so the user can tweak multiple
  // controls before hitting Apply. Committed filters drive the fetch and the
  // persisted values; the pending copies drive the form inputs.
  let pendingChannel = $state(channelP.value);
  let pendingSeries = $state(seriesP.value);
  let pendingType = $state(typeP.value);
  let pendingSort = $state<Sort>(sortP.value);
  let pendingText = $state('');

  let options = $state<FormOptions>({ channels: [], series: [], types: [], sorts: [] });
  let filterOpen = $state(false);

  // Whether any server-side filter is active. Used by the "clear" button
  // and to badge the filter trigger.
  const hasActiveFilter = $derived(
    channelP.value !== '' ||
      seriesP.value !== '' ||
      typeP.value !== '' ||
      text !== '' ||
      sortP.value !== 'publish_new',
  );

  // Paged list — same helper that powers Patch Notes / Buy-Back /
  // Galactapedia. The fetcher closure reads the current filter state
  // off the persisted refs so changing a filter + calling
  // `list.refresh()` automatically picks up the new query.
  const list = createPagedList<Article>({
    keyOf: (a) => a.href,
    fetchPage: async (page, force) => {
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
      // Options always reflect the server's latest list — handy if CIG
      // adds a new series; users see it without an extension update.
      // Guard against stale cache entries from pre-options builds
      // where the field is absent.
      if (res.options && res.options.channels.length > 0) options = res.options;
      return { items: res.articles, fromCache: res.fromCache };
    },
  });

  function refresh() {
    void list.refresh();
  }

  function applyPending() {
    // Bail early if a fetch is already in flight. Without this guard the
    // second rapid click would reset items mid-load, flashing
    // an empty list before the in-progress loadPage(1) settles.
    if (list.loading) return;
    channelP.value = pendingChannel;
    seriesP.value = pendingSeries;
    typeP.value = pendingType;
    sortP.value = pendingSort;
    text = pendingText;
    filterOpen = false;
    void list.refresh();
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

  // Snapshot the unread count BEFORE markSeen clears it. The badge on the
  // sidebar goes to 0 the moment the user opens the module, but the user still
  // wants to know *which* articles are the new ones. The list is newest-first,
  // so we tag the top N cards with a subtle "NEW" ribbon for this session.
  // Only meaningful when no filter is applied — filtered views don't map to
  // what the notify poll saw as "unread".
  const unreadAtOpen = notifyState.state.counts['comm-link'];
  const showNewRibbon = $derived(!hasActiveFilter);

  void list.loadPage(1);
  notifyState.markSeen('comm-link');
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Comm-Link" loading={list.loading} fromCache={list.fromCache} onRefresh={refresh} refreshLabel="Refresh">
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
          disabled={list.loading}
        >
          Apply
        </button>
      </div>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3" use:list.attach>
    {#if list.error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load Comm-Link</p>
          <p class="mt-1 break-all text-rose-300/80">{list.error}</p>
        </div>
      </div>
    {:else if list.loading && list.items.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else}
      <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
        {#each list.items as a, i (a.href)}
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
                <!-- The skeleton sits ABOVE the <img> as a positioned
                     overlay. The <img> starts at opacity:0 (set by the
                     loadAfterDecode action) and fades in once decode()
                     resolves. While opacity:0, the skeleton's
                     animate-pulse is what the user sees — once the
                     <img> opacity goes to 1, the skeleton is hidden
                     behind the now-fully-decoded image. -->
                <div class="relative aspect-[16/9] overflow-hidden bg-slate-950">
                  <div class="absolute inset-0 animate-pulse bg-slate-800/40"></div>
                  <img
                    use:loadAfterDecode={a.image}
                    alt=""
                    class="relative size-full object-cover transition group-hover:scale-105"
                  />
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

      {#if list.items.length === 0 && !list.loading}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No articles match the current filters.
        </p>
      {/if}

      {#if list.items.length > 0}
        <div class="mt-4 flex h-10 items-center justify-center text-xs text-slate-500">
          {#if list.loading}
            <Loader2 class="size-4 animate-spin" />
          {:else if !list.hasMore}
            <span class="italic">No more articles.</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
