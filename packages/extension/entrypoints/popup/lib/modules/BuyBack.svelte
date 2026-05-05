<script lang="ts">
  import { sendRsiMessage, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Archive,
    Loader2,
    Package,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { authState } from '../state.svelte';
  import { extractSignedIn } from '../error';
  import { createPagedList } from '../paged-list.svelte';

  type Pledge = Rsi.BuyBackPledge;

  // Module-local sign-in state, separate from `authState.signedIn`.
  // The buyback handler can return signedIn=false even when the
  // global auth check still says true (cookie expired mid-session,
  // CSRF re-prime needed). Flipping this immediately routes the
  // user to SignInPrompt without touching the global auth flag.
  let signedIn = $state<boolean | null>(null);
  let query = $state('');
  let hideCcu = $state(false);

  // Paged-list state. The dedup-on-append is critical here — RSI's
  // buyback paginator sometimes echoes a pledge across adjacent
  // pages when something melts/restores between fetches and the row
  // shifts the page boundary, which crashed Svelte's `{#each as p
  // (p.id)}` with `each_key_duplicate` before the dedup helper
  // landed (reported by MoBIoS [RHLD] on 2026-05-04). The helper's
  // `keyOf` does the dedup centrally now.
  const list = createPagedList<Pledge>({
    keyOf: (p) => p.id,
    fetchPage: async (page, force) => {
      try {
        const res = await sendRsiMessage({ type: 'buyback.list', page, force });
        signedIn = res.signedIn;
        return {
          items: res.pledges,
          hasNextPage: res.hasNextPage,
          fromCache: res.fromCache,
        };
      } catch (e) {
        if (extractSignedIn(e) === false) signedIn = false;
        throw e;
      }
    },
    canFetchNext: () => !query.trim(),
  });

  function refresh() {
    void list.refresh();
  }

  // Plain text search across title + remaining fields ("Last Modified",
  // "Contained"). CIG removed the price/pledge-value labels from the
  // buy-back DOM in 2025, so the old numeric operators (<N >N =N) and the
  // per-page USD total had nothing to filter on and were quietly dropping
  // every pledge whenever a number was typed. Removed rather than left
  // broken — if prices come back we can reinstate from git history.
  const filtered = $derived.by<Pledge[]>(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return list.items.filter((p) => {
      if (hideCcu && p.ccuOnly) return false;
      if (terms.length === 0) return true;
      const hay = [p.title, ...p.fields.map((f) => `${f.label} ${f.value}`)]
        .join(' ')
        .toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  });

  // Gate the fetch on the global auth state so we don't flash an empty list
  // view before switching to SignInPrompt.
  let kicked = false;
  $effect(() => {
    if (authState.signedIn === true && !kicked) {
      kicked = true;
      void list.loadPage(1);
    } else if (authState.signedIn === false) {
      signedIn = false;
    }
  });
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Buy-Back" loading={list.loading} fromCache={list.fromCache} onRefresh={refresh}>
    {#snippet meta()}
      {#if signedIn}
        <span class="text-[10px] text-slate-500">
          {filtered.length}/{list.items.length}
        </span>
      {/if}
    {/snippet}
    {#snippet controls()}
      <input
        type="search"
        placeholder="Filter…"
        bind:value={query}
        title="Match title, contents, or last-modified date"
        class="min-w-0 flex-1 max-w-56 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />

      <label class="flex items-center gap-1 text-[11px] text-slate-400" title="Hide pledges that only allow CCU/upgrades">
        <input type="checkbox" bind:checked={hideCcu} class="accent-sky-500" />
        Reclaimable only
      </label>
    {/snippet}
  </ModuleHeader>

  <div class="flex-1 overflow-y-auto p-3" use:list.attach>
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Buy-Back" />
    {:else if authState.signedIn === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if list.error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load buy-back</p>
          <p class="mt-1 break-all text-rose-300/80">{list.error}</p>
        </div>
      </div>
    {:else if list.loading && list.items.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if list.items.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
        <Archive class="size-8" />
        <p class="text-xs italic">No reclaimable pledges.</p>
      </div>
    {:else}
      <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
        {#each filtered as p (p.id)}
          <li class="virt-item-lg">
            <div
              class="group flex h-full flex-col overflow-hidden rounded-md bg-slate-900/70 ring-1 ring-slate-800 transition hover:ring-sky-600"
            >
              <div class="aspect-[16/9] overflow-hidden bg-slate-950">
                {#if p.image}
                  <img
                    src={p.image}
                    alt=""
                    loading="lazy"
                    class="size-full object-cover transition group-hover:scale-105"
                  />
                {:else}
                  <div class="flex size-full items-center justify-center text-slate-700">
                    <Package class="size-8" />
                  </div>
                {/if}
              </div>
              <div class="flex flex-1 flex-col gap-1 p-2">
                <p class="line-clamp-2 text-xs font-medium text-slate-100">{p.title}</p>
                {#if p.fields.length > 0}
                  <dl class="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
                    <!-- Key combines index + label so RSI emitting
                         two fields with the same label on a single
                         pledge can't trigger svelte/each_key_duplicate
                         the way the parent pledge list did before
                         the dedupe in loadPage(). Defensive — we've
                         never observed this in practice. -->
                    {#each p.fields as f, i (`${i}-${f.label}`)}
                      <dt class="text-slate-500">{f.label}</dt>
                      <dd class="truncate text-slate-300">{f.value}</dd>
                    {/each}
                  </dl>
                {/if}
                <div class="mt-auto pt-1">
                  {#if p.reclaimUrl}
                    <a
                      href={p.reclaimUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="inline-block rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-sky-300 transition hover:bg-sky-500/30"
                    >
                      Reclaim →
                    </a>
                  {:else if p.ccuOnly}
                    <span
                      class="inline-block rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                      title="CCU/upgrade flow only"
                    >
                      CCU only
                    </span>
                  {/if}
                </div>
              </div>
            </div>
          </li>
        {/each}
      </ul>

      {#if filtered.length === 0 && list.items.length > 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">No pledges match your filter.</p>
      {/if}

      {#if list.items.length > 0 && !query.trim()}
        <div class="mt-4 flex h-10 items-center justify-center text-xs text-slate-500">
          {#if list.loading}
            <Loader2 class="size-4 animate-spin" />
          {:else if !list.hasMore}
            <span class="italic">No more pledges.</span>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</section>
