<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type ProgressTrackerGroup } from '@rsi-companion/shared';
  import {
    ChevronDown,
    ChevronRight,
    Database,
    ExternalLink,
    Loader2,
    RefreshCw,
    LayoutGrid,
    X,
  } from 'lucide-svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage } from '../error';

  // ── state ──────────────────────────────────────────────────────────────────

  let groups = $state<ProgressTrackerGroup[]>([]);
  let totalCards = $state(0);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);

  let query = $state('');
  const statusFilterP = persistedState('progress-tracker:statusFilter', '');
  const expandedP     = persistedState<string[]>('progress-tracker:expanded', []);

  // ── derived ────────────────────────────────────────────────────────────────

  const allStatuses = $derived.by<string[]>(() => {
    const set = new Set<string>();
    for (const g of groups) for (const c of g.cards) if (c.status) set.add(c.status);
    return [...set].sort();
  });

  const expandedSet = $derived(new Set(expandedP.value));

  const filteredGroups = $derived.by<ProgressTrackerGroup[]>(() => {
    const q  = query.trim().toLowerCase();
    const sf = statusFilterP.value.toLowerCase();
    return groups
      .map((g) => ({
        ...g,
        cards: g.cards.filter((c) => {
          if (sf && c.status.toLowerCase() !== sf) return false;
          if (!q) return true;
          return (
            c.name.toLowerCase().includes(q) ||
            c.releaseName.toLowerCase().includes(q) ||
            g.name.toLowerCase().includes(q)
          );
        }),
      }))
      .filter((g) => g.cards.length > 0);
  });

  // Status badge styling
  function statusCls(status: string): string {
    const s = status.toLowerCase();
    if (s.includes('development')) return 'bg-sky-900/60 text-sky-300 border border-sky-700/50';
    if (s.includes('committed'))   return 'bg-amber-900/60 text-amber-300 border border-amber-700/50';
    return 'bg-slate-800 text-slate-400 border border-slate-700';
  }

  // ── load ───────────────────────────────────────────────────────────────────

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({ type: 'progressTracker.list', force });
      groups     = res.groups ?? [];
      totalCards = res.totalCards ?? 0;
      fromCache  = res.fromCache;
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  function toggleExpanded(name: string) {
    const s = new Set(expandedP.value);
    s.has(name) ? s.delete(name) : s.add(name);
    expandedP.value = [...s];
  }

  $effect(() => { void load(); });
</script>

<!-- header -->
<div class="flex h-full flex-col overflow-hidden">
  <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-950/60 px-3 py-1.5">
    <span class="text-[10px] uppercase tracking-wider text-slate-500">Progress Tracker</span>

    {#if !loading && groups.length > 0}
      <span class="text-[10px] text-slate-400">
        · {filteredGroups.length} {filteredGroups.length === 1 ? 'category' : 'categories'}
        · {totalCards} cards
      </span>
    {/if}

    <div class="ml-auto flex items-center gap-1.5">
      {#if fromCache}
        <!-- `title` on the wrapping span — lucide-svelte icon components
             don't forward arbitrary attributes onto the <svg>. -->
        <span title="Cached" aria-label="Cached" class="inline-flex">
          <Database class="size-3 text-slate-400" />
        </span>
      {/if}
      <button
        type="button"
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-400 transition
               hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
        disabled={loading}
        onclick={() => load(true)}
      >
        <RefreshCw class="size-3 {loading ? 'animate-spin' : ''}" />
        Refresh
      </button>
      <a
        href="{RSI_BASE_URL}/roadmap/progress-tracker/teams"
        target="_blank"
        rel="noopener noreferrer"
        class="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-400
               transition hover:bg-slate-800 hover:text-slate-100"
        title="RSI Progress Tracker"
      >
        <ExternalLink class="size-3" />
        RSI
      </a>
    </div>
  </div>

  <!-- toolbar -->
  {#if !loading && !error}
    <div class="flex flex-wrap items-center gap-2 border-b border-slate-800/60 bg-slate-950/40 px-3 py-1.5">
      <input
        type="search"
        bind:value={query}
        placeholder="Search categories or cards…"
        class="h-6 flex-1 min-w-[120px] rounded bg-slate-800 px-2 text-xs text-slate-200
               placeholder:text-slate-400 outline-none focus:ring-1 focus:ring-sky-600"
      />
      {#if allStatuses.length > 0}
        <div class="flex flex-wrap items-center gap-1">
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-[10px] transition
                   {statusFilterP.value === ''
                     ? 'bg-slate-700 text-slate-200'
                     : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'}"
            onclick={() => { statusFilterP.value = ''; }}
          >All</button>
          {#each allStatuses as s}
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-[10px] transition
                     {statusFilterP.value === s
                       ? statusCls(s)
                       : 'text-slate-500 hover:bg-slate-800 hover:text-slate-300'}"
              onclick={() => { statusFilterP.value = statusFilterP.value === s ? '' : s; }}
            >{s || '—'}</button>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  <!-- body -->
  <div class="flex-1 overflow-y-auto">
    {#if loading}
      <div class="flex h-32 items-center justify-center gap-2 text-slate-500">
        <Loader2 class="size-4 animate-spin" />
        <span class="text-sm">Loading…</span>
      </div>

    {:else if error}
      <div class="flex flex-col items-center gap-3 p-6 text-center text-sm text-red-400">
        <X class="size-5" />
        <p>{error}</p>
        <button
          type="button"
          class="rounded bg-slate-800 px-3 py-1 text-xs text-slate-300 hover:bg-slate-700"
          onclick={() => load(true)}
        >Retry</button>
      </div>

    {:else if filteredGroups.length === 0}
      <div class="flex flex-col items-center gap-2 p-8 text-slate-400">
        <LayoutGrid class="size-6" />
        <p class="text-sm">
          {query || statusFilterP.value
            ? 'No results match your filters.'
            : 'No active cards in the roadmap.'}
        </p>
      </div>

    {:else}
      <div class="divide-y divide-slate-800/60">
        {#each filteredGroups as group (group.id)}
          {@const isExpanded = expandedSet.has(String(group.id))}
          <div>
            <!-- category header -->
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-slate-800/40"
              onclick={() => toggleExpanded(String(group.id))}
            >
              {#if isExpanded}
                <ChevronDown class="size-3.5 shrink-0 text-slate-500" />
              {:else}
                <ChevronRight class="size-3.5 shrink-0 text-slate-500" />
              {/if}
              <span class="flex-1 truncate text-xs font-medium text-slate-200">
                {group.name}
              </span>
              <span class="shrink-0 text-[10px] text-slate-400">
                {group.cards.length} {group.cards.length === 1 ? 'card' : 'cards'}
              </span>
            </button>

            <!-- card list -->
            {#if isExpanded}
              <div class="border-t border-slate-800/40 bg-slate-950/30">
                {#each group.cards as card (card.id)}
                  <div class="flex items-start gap-2 border-b border-slate-800/30 px-4 py-1.5 last:border-b-0">
                    <div class="flex-1 min-w-0">
                      <p class="truncate text-xs text-slate-300">{card.name}</p>
                      <p class="truncate text-[10px] text-slate-400 mt-0.5">{card.releaseName}</p>
                    </div>
                    {#if card.status}
                      <span class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium {statusCls(card.status)}">
                        {card.status}
                      </span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
