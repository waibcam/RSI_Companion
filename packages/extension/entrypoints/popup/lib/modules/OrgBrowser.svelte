<script lang="ts">
  import { sendRsiMessage, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Building2,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    Database,
    Loader2,
    RefreshCw,
    Search,
    Users,
    X,
  } from 'lucide-svelte';
  import { errorMessage } from '../error';

  type Org = Rsi.PublicOrg;

  // The RSI directory hard-codes a server-side page size that ignores our
  // `pagesize` value, but we still send the same constant so cache keys stay
  // stable across calls.
  const PAGE_SIZE = 12;

  type Option = { value: string; label: string };

  let query = $state('');
  let pendingQuery = $state('');
  let language = $state<string>('');
  let size = $state<string>('');
  let model = $state<string>('');
  let commitment = $state<string>('');
  let roleplay = $state<string>('');
  let recruiting = $state<string>('');
  let activities = $state<Set<string>>(new Set());
  let filtersOpen = $state(false);

  let page = $state(1);
  let orgs = $state<Org[]>([]);
  let totalRows = $state(0);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let fromCache = $state(false);

  // Filter values match the RSI org-listing form codes. See the form source at
  // /en/community/orgs/listing?openPanel=1.
  const LANGUAGES: Option[] = [
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'French' },
    { value: 'de', label: 'German' },
    { value: 'es', label: 'Spanish' },
    { value: 'it', label: 'Italian' },
    { value: 'pt', label: 'Portuguese' },
    { value: 'ru', label: 'Russian' },
    { value: 'pl', label: 'Polish' },
    { value: 'nl', label: 'Dutch' },
    { value: 'sv', label: 'Swedish' },
    { value: 'no', label: 'Norwegian' },
    { value: 'da', label: 'Danish' },
    { value: 'fi', label: 'Finnish' },
    { value: 'cs', label: 'Czech' },
    { value: 'hu', label: 'Hungarian' },
    { value: 'ro', label: 'Romanian' },
    { value: 'tr', label: 'Turkish' },
    { value: 'ar', label: 'Arabic' },
    { value: 'he', label: 'Hebrew' },
    { value: 'zh', label: 'Chinese' },
    { value: 'ja', label: 'Japanese' },
    { value: 'ko', label: 'Korean' },
    { value: 'th', label: 'Thai' },
    { value: 'vi', label: 'Vietnamese' },
  ];
  const SIZES: Option[] = [
    { value: 'small', label: 'Small' },
    { value: 'medium', label: 'Medium' },
    { value: 'large', label: 'Large' },
  ];
  const MODELS: Option[] = [
    { value: 'generic', label: 'Organization' },
    { value: 'corp', label: 'Corporation' },
    { value: 'pmc', label: 'PMC' },
    { value: 'faith', label: 'Faith' },
    { value: 'syndicate', label: 'Syndicate' },
    { value: 'club', label: 'Club' },
  ];
  const COMMITMENTS: Option[] = [
    { value: 'CA', label: 'Casual' },
    { value: 'RE', label: 'Regular' },
    { value: 'HA', label: 'Hardcore' },
  ];
  const YES_NO: Option[] = [
    { value: '', label: 'Any' },
    { value: '1', label: 'Yes' },
    { value: '0', label: 'No' },
  ];
  // Activity IDs come from the listing form — numeric, as strings.
  const ACTIVITIES: Option[] = [
    { value: '1', label: 'Transport' },
    { value: '2', label: 'Smuggling' },
    { value: '3', label: 'Scouting' },
    { value: '4', label: 'Resources' },
    { value: '5', label: 'Infiltration' },
    { value: '6', label: 'Freelancing' },
    { value: '7', label: 'Engineering' },
    { value: '8', label: 'Security' },
    { value: '9', label: 'Bounty Hunting' },
    { value: '10', label: 'Piracy' },
    { value: '11', label: 'Trading' },
    { value: '12', label: 'Exploration' },
    { value: '13', label: 'Social' },
    { value: '14', label: 'Medical' },
  ];

  const activeFilterCount = $derived(
    (language ? 1 : 0) +
      (size ? 1 : 0) +
      (model ? 1 : 0) +
      (commitment ? 1 : 0) +
      (roleplay ? 1 : 0) +
      (recruiting ? 1 : 0) +
      activities.size,
  );

  async function load(force = false) {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({
        type: 'orgs.search',
        search: query,
        page,
        pagesize: PAGE_SIZE,
        activity: [...activities],
        language: language ? [language] : [],
        model: model ? [model] : [],
        size: size ? [size] : [],
        commitment: commitment ? [commitment] : [],
        roleplay: roleplay ? [roleplay] : [],
        recruiting: recruiting ? [recruiting] : [],
        force,
      });
      orgs = res.orgs;
      totalRows = res.totalRows;
      fromCache = res.fromCache;
    } catch (e) {
      error = errorMessage(e);
      orgs = [];
    } finally {
      loading = false;
    }
  }

  function submitSearch(e: SubmitEvent) {
    e.preventDefault();
    query = pendingQuery.trim();
    page = 1;
    load();
  }

  function applyFilters() {
    page = 1;
    load();
  }

  function toggleActivity(id: string) {
    const next = new Set(activities);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    activities = next;
    applyFilters();
  }

  function resetFilters() {
    language = '';
    size = '';
    model = '';
    commitment = '';
    roleplay = '';
    recruiting = '';
    activities = new Set();
    applyFilters();
  }

  function gotoPage(p: number) {
    if (p < 1 || loading) return;
    page = p;
    load();
  }

  function refresh() {
    load(true);
  }

  // The first card on the next page tells us whether more results exist.
  // We don't trust totalRows for hasMore — empirically it's the global org
  // count, not the filtered count.
  const hasMore = $derived(orgs.length >= PAGE_SIZE);

  load();
</script>

<section class="flex h-full flex-col overflow-hidden">
  <div
    class="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-4 py-2"
  >
    <h2 class="text-sm font-semibold text-slate-200">Org Browser</h2>
    {#if fromCache}
      <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Database class="size-3" />
        cached
      </span>
    {/if}

    <form class="flex min-w-0 flex-1 items-center gap-1" onsubmit={submitSearch}>
      <div class="relative min-w-0 flex-1">
        <Search
          class="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-500"
        />
        <input
          type="search"
          placeholder="Search orgs by name or SID..."
          bind:value={pendingQuery}
          class="w-full min-w-0 rounded-md border border-slate-800 bg-slate-900 py-1 pl-7 pr-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      </div>
    </form>

    <button
      type="button"
      class="flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-xs text-slate-300 transition hover:border-sky-600 hover:text-sky-300"
      class:border-sky-600={filtersOpen || activeFilterCount > 0}
      class:text-sky-300={filtersOpen || activeFilterCount > 0}
      onclick={() => (filtersOpen = !filtersOpen)}
    >
      Filters
      {#if activeFilterCount > 0}
        <span
          class="rounded-full bg-sky-500/20 px-1.5 text-[10px] font-semibold text-sky-300"
          >{activeFilterCount}</span
        >
      {/if}
      {#if filtersOpen}
        <ChevronUp class="size-3.5" />
      {:else}
        <ChevronDown class="size-3.5" />
      {/if}
    </button>

    <button
      type="button"
      class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
      disabled={loading}
      onclick={refresh}
      title="Refresh"
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  </div>

  {#if filtersOpen}
    <div
      class="flex flex-col gap-2 border-b border-slate-800 bg-slate-950/30 px-4 py-2 text-[11px] text-slate-400"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {@render filterSelect('Language', LANGUAGES, language, (v) => {
          language = v;
          applyFilters();
        })}
        {@render filterSelect('Size', SIZES, size, (v) => {
          size = v;
          applyFilters();
        })}
        {@render filterSelect('Archetype', MODELS, model, (v) => {
          model = v;
          applyFilters();
        })}
        {@render filterSelect('Commitment', COMMITMENTS, commitment, (v) => {
          commitment = v;
          applyFilters();
        })}
        {@render filterSelect('Role play', YES_NO, roleplay, (v) => {
          roleplay = v;
          applyFilters();
        }, false)}
        {@render filterSelect('Recruiting', YES_NO, recruiting, (v) => {
          recruiting = v;
          applyFilters();
        }, false)}

        {#if activeFilterCount > 0}
          <button
            type="button"
            onclick={resetFilters}
            class="ml-auto flex items-center gap-1 rounded-md border border-slate-800 px-2 py-0.5 text-[11px] text-slate-400 transition hover:border-rose-600 hover:text-rose-300"
          >
            <X class="size-3" />
            Reset
          </button>
        {/if}
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-slate-500">Activities:</span>
        {#each ACTIVITIES as act (act.value)}
          {@const on = activities.has(act.value)}
          <button
            type="button"
            onclick={() => toggleActivity(act.value)}
            class="rounded-full px-2 py-0.5 text-[10px] transition
              {on
              ? 'bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40'
              : 'bg-slate-800/60 text-slate-400 hover:bg-slate-800 hover:text-slate-100'}"
          >
            {act.label}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load organizations</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && orgs.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if orgs.length === 0}
      <p class="mt-6 text-center text-xs italic text-slate-500">
        No organizations match your search.
      </p>
    {:else}
      <ul class="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3 3xl:grid-cols-4 4xl:grid-cols-5">
        {#each orgs as o (o.sid)}
          <li class="virt-item-lg">
            <a
              href={o.url}
              target="_blank"
              rel="noopener noreferrer"
              class="flex h-full gap-3 rounded-md bg-slate-900/70 p-2 ring-1 ring-slate-800 transition hover:ring-sky-600"
            >
              <div
                class="size-14 shrink-0 overflow-hidden rounded bg-slate-950 ring-1 ring-slate-800"
              >
                {#if o.logo}
                  <img src={o.logo} alt="" loading="lazy" class="size-full object-cover" />
                {:else}
                  <div class="flex size-full items-center justify-center text-slate-700">
                    <Building2 class="size-7" />
                  </div>
                {/if}
              </div>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium text-slate-100">{o.name}</p>
                <p class="truncate text-[11px] text-slate-500">
                  <span class="font-mono text-slate-400">{o.sid}</span>
                  {#if o.archetype}· {o.archetype}{/if}
                  {#if o.language}· {o.language}{/if}
                </p>
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-slate-500">
                  <span class="flex items-center gap-1">
                    <Users class="size-3" />
                    {o.memberCount}
                  </span>
                  {#if o.commitment}
                    <span
                      class="rounded bg-slate-800 px-1 py-0.5 uppercase tracking-wider text-slate-400"
                      >{o.commitment}</span
                    >
                  {/if}
                  {#if o.recruiting}
                    <span
                      class="rounded bg-emerald-500/15 px-1 py-0.5 uppercase tracking-wider text-emerald-300"
                      >Recruiting</span
                    >
                  {/if}
                  {#if o.roleplay}
                    <span
                      class="rounded bg-sky-500/15 px-1 py-0.5 uppercase tracking-wider text-sky-300"
                      >RP</span
                    >
                  {/if}
                </div>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#if !error && (orgs.length > 0 || page > 1)}
    <div
      class="flex items-center justify-between gap-2 border-t border-slate-800 bg-slate-950/40 px-4 py-1.5 text-[11px] text-slate-400"
    >
      <span>
        Page {page}
        {#if totalRows > 0}
          · {totalRows.toLocaleString()} orgs total
        {/if}
      </span>
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
          disabled={loading || page <= 1}
          onclick={() => gotoPage(page - 1)}
        >
          <ChevronLeft class="size-3.5" />
          Prev
        </button>
        <button
          type="button"
          class="flex items-center gap-1 rounded-md px-2 py-1 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
          disabled={loading || !hasMore}
          onclick={() => gotoPage(page + 1)}
        >
          Next
          <ChevronRight class="size-3.5" />
        </button>
      </div>
    </div>
  {/if}
</section>

{#snippet filterSelect(
  label: string,
  options: Option[],
  value: string,
  onchange: (v: string) => void,
  includeAny: boolean = true,
)}
  <label class="flex items-center gap-1">
    <span class="text-slate-500">{label}:</span>
    <select
      value={value}
      onchange={(e) => onchange((e.currentTarget as HTMLSelectElement).value)}
      class="rounded border border-slate-800 bg-slate-900 px-1 py-0.5 text-[11px] text-slate-200 focus:border-sky-600 focus:outline-none"
    >
      {#if includeAny}
        <option value="">Any</option>
      {/if}
      {#each options as opt (opt.value)}
        <option value={opt.value}>{opt.label}</option>
      {/each}
    </select>
  </label>
{/snippet}
