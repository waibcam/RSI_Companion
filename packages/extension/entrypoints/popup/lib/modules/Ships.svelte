<script lang="ts">
  import { sendRsiMessage, RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    Database,
    Download,
    Loader2,
    LogIn,
    RefreshCw,
    ExternalLink,
    Ship as ShipIcon,
    ShoppingCart,
    Star,
    TriangleAlert,
    X,
  } from 'lucide-svelte';
  import { authState } from '../state.svelte';
  import { persistedState } from '../persist.svelte';
  import { createFavorites } from '../favorites.svelte';
  import { extractSignedIn, errorMessage } from '../error';
  import ShipReader from '../components/ShipReader.svelte';

  type Ship = Rsi.Ship;

  let ships = $state<Ship[]>([]);
  let loanerIds = $state<number[]>([]);
  let ownedCount = $state(0);
  let notFound = $state<string[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);

  // The ships handler reports signedIn based on token-cookie presence, but a
  // stale Rsi-Token cookie can survive a server-side logout — so the handler
  // happily returns `signedIn: true` with cached owned flags from a previous
  // session. We drive the UI off authState.signedIn (which validates via
  // /api/spectrum/auth/identify) so Owned/Loaners controls disappear as soon
  // as the identity check says the user is actually signed out.
  const signedIn = $derived<boolean | null>(authState.signedIn);

  // Filter state persists across popup open/close. Power-users reopen the popup
  // many times a session and losing "Owned + focus: Cargo" every time was the
  // single biggest UX paper-cut.
  let query = $state('');
  // Mutually exclusive: '' | 'owned' | 'loans'
  // Clicking the active option toggles it off (unlike radio buttons).
  const shipFilterP = persistedState<'' | 'owned' | 'loans'>('ships:filter', '');
  const onlyFavsP = persistedState('ships:onlyFavs', false);
  const manufacturerP = persistedState('ships:manufacturer', '');
  const focusP = persistedState('ships:focus', '');
  const statusP = persistedState('ships:status', '');
  let notFoundOpen = $state(false);

  // Per-user starred ships. Surfacing them first (and optionally filtering to
  // just favorites) is the canonical request from power-users who own 50+
  // ships and mostly fly 5 of them.
  const favorites = createFavorites('ships');

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({ type: 'ships.list', force });
      ships = res.ships;
      loanerIds = res.loanerIds;
      ownedCount = res.ownedCount;
      notFound = res.notFound;
      fromCache = res.fromCache;
      // If the hangar call surfaced an auth failure even though the cookie is
      // still present, push the signed-out state up to authState so every
      // module (not just this one) gets the corrected value.
      if (res.signedIn === false && authState.signedIn !== false) {
        authState.markSignedIn(false);
      }
    } catch (e) {
      error = errorMessage(e);
      if (extractSignedIn(e) === false) authState.markSignedIn(false);
    } finally {
      loading = false;
    }
  }

  // Single pass over ships to collect the three filter-dropdown vocabularies.
  // Previously this was three separate $derived.by blocks, each iterating the
  // full ship list — small per call, but recomputed on every ships mutation.
  const filterOptions = $derived.by<{ manufacturers: string[]; focuses: string[]; statuses: string[] }>(() => {
    const makes = new Set<string>();
    const foc = new Set<string>();
    const stat = new Set<string>();
    for (const s of ships) {
      if (s.manufacturer?.name) makes.add(s.manufacturer.name);
      if (s.focus) foc.add(s.focus);
      if (s.production_status) stat.add(s.production_status);
    }
    return {
      manufacturers: [...makes].sort(),
      focuses: [...foc].sort(),
      statuses: [...stat].sort(),
    };
  });
  const manufacturers = $derived(filterOptions.manufacturers);
  const focuses = $derived(filterOptions.focuses);
  const statuses = $derived(filterOptions.statuses);

  const filtered = $derived.by<Ship[]>(() => {
    const q = query.trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const matches = ships.filter((s) => {
      if (shipFilterP.value === 'owned' && !s.owned) return false;
      if (shipFilterP.value === 'loans' && !s.loaner) return false;
      if (onlyFavsP.value && !favorites.has(String(s.id))) return false;
      if (manufacturerP.value && s.manufacturer?.name !== manufacturerP.value) return false;
      if (focusP.value && s.focus !== focusP.value) return false;
      if (statusP.value && s.production_status !== statusP.value) return false;
      if (terms.length === 0) return true;
      const hay = `${s.manufacturer?.name ?? ''} ${s.name} ${s.type ?? ''} ${s.focus ?? ''}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    // Favorites float to the top so starred ships are always one glance away,
    // regardless of the underlying manufacturer+name sort from the merge step.
    // The tie-break keeps the original ordering stable.
    return matches.slice().sort((a, b) => {
      const fa = favorites.has(String(a.id)) ? 0 : 1;
      const fb = favorites.has(String(b.id)) ? 0 : 1;
      return fa - fb;
    });
  });

  // Count ships actually marked as loaners for the user's owned ships (not the
  // full loaner catalog size which is what loanerIds.length would give).
  const loanerCount = $derived(ships.filter((s) => s.loaner).length);

  function toCsvField(v: string): string {
    // Quote + escape embedded quotes. Comma / newline inside a quoted field
    // is fine per RFC 4180.
    const needsQuotes = /[",\n]/.test(v);
    const escaped = v.replace(/"/g, '""');
    return needsQuotes ? `"${escaped}"` : escaped;
  }

  function exportCsv() {
    // Export the current filtered set — same thing the user is looking at,
    // so "filter to Owned + export" produces a hangar CSV without surprises.
    const rows = filtered;
    const header = [
      'id',
      'manufacturer',
      'name',
      'focus',
      'type',
      'production_status',
      'owned',
      'count',
      'loaner',
      'favorite',
      'url',
    ];
    const lines = [header.join(',')];
    for (const s of rows) {
      lines.push(
        [
          String(s.id),
          s.manufacturer?.name ?? '',
          s.name,
          s.focus ?? '',
          s.type ?? '',
          s.production_status ?? '',
          s.owned ? '1' : '0',
          String(s.count),
          s.loaner ? '1' : '0',
          favorites.has(String(s.id)) ? '1' : '0',
          s.url ? `${RSI_BASE_URL}${s.url.startsWith('/') ? s.url : `/${s.url}`}` : '',
        ]
          .map(toCsvField)
          .join(','),
      );
    }
    const csv = lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 10);
    a.download = `rsi-ships-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer revoke: Chrome occasionally aborts the download if the URL is
    // revoked in the same microtask the <a> was clicked.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Ships has a public fallback — the ship-matrix renders without auth. We fetch
  // as soon as the auth state is resolved (either true or false) so the full
  // matrix shows up either way; owned/loaner flags only populate when signed in.
  let kicked = false;
  $effect(() => {
    if (authState.signedIn !== null && !kicked) {
      kicked = true;
      void load();
    }
  });

  // Inline ship reader. The module's Ship entries come from the ship-matrix
  // REST endpoint which doesn't expose the DatoCMS slug needed by the
  // pledge-store detail GraphQL — we pass `name` and let the background
  // resolver look the slug up from the cached pledge ship list. The hero
  // snippet is the current card data so the reader shows something useful
  // during the (usually sub-100ms) fetch.
  let readerShip = $state<Ship | null>(null);
  // When true, the reader auto-scrolls to the Editions section on load.
  // Set by the card's "Add to cart" shortcut so the user lands directly
  // on the SKU picker rather than the hero/specs.
  let readerFocusEditions = $state(false);
  function openReader(s: Ship, opts: { focusEditions?: boolean } = {}): void {
    readerShip = s;
    readerFocusEditions = opts.focusEditions ?? false;
  }
  function closeReader(): void {
    readerShip = null;
    readerFocusEditions = false;
  }

  // Per-SKU add-to-cart flow for the Editions section of the reader.
  // Same pattern as PledgeStore.svelte — the ShipReader renders Add
  // buttons when we pass it an `onAddToCart` callback. Stays local to
  // this module so the Ships grid doesn't need to know anything about
  // the cart.
  let addingStoreSkuId = $state<string | null>(null);
  let storeCartFlash = $state<{ skuId: string; type: 'success' | 'error'; text: string } | null>(null);
  let storeCartFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function setStoreCartFlash(skuId: string, type: 'success' | 'error', text: string): void {
    storeCartFlash = { skuId, type, text };
    if (storeCartFlashTimer) clearTimeout(storeCartFlashTimer);
    storeCartFlashTimer = setTimeout(() => {
      if (storeCartFlash?.skuId === skuId) storeCartFlash = null;
    }, 4000);
  }

  $effect(() => () => {
    if (storeCartFlashTimer) clearTimeout(storeCartFlashTimer);
  });

  async function addSkuToCart(skuId: string, title: string): Promise<void> {
    if (addingStoreSkuId !== null) return;
    addingStoreSkuId = skuId;
    try {
      await sendRsiMessage({ type: 'pledge.addToCart', skuId, qty: 1 });
      setStoreCartFlash(skuId, 'success', `${title} added to cart`);
    } catch (e) {
      setStoreCartFlash(skuId, 'error', errorMessage(e));
    } finally {
      addingStoreSkuId = null;
    }
  }

  // "Report unknown ship names" flow. v0.2.x relied on a backend
  // auto-report endpoint to collect these names; v1.0.0 is serverless so
  // we redirect to the community Discord instead of GitHub Issues (the
  // maintainer's preferred channel for community-sourced catalog gaps,
  // as opposed to actual bug reports which live on GitHub).
  //
  // Discord has no pre-filled message URL, so the flow is:
  //   1. Copy a pre-formatted snippet to the clipboard.
  //   2. Open the Discord invite in a new tab.
  //   3. Flash "Copied!" so the user knows they just need to paste.
  const DISCORD_INVITE_URL = 'https://discord.gg/ZKTVvyUkjn';
  let reportCopied = $state(false);
  let reportCopiedTimer: ReturnType<typeof setTimeout> | null = null;

  async function reportUnknownShipsToDiscord(names: readonly string[]): Promise<void> {
    const version = chrome.runtime.getManifest?.()?.version ?? '—';
    const message = [
      `**Unknown ship${names.length === 1 ? '' : 's'} in my hangar** (RSI Companion v${version}):`,
      ...names.map((n) => `- ${n}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(message);
      reportCopied = true;
      if (reportCopiedTimer) clearTimeout(reportCopiedTimer);
      reportCopiedTimer = setTimeout(() => (reportCopied = false), 4000);
    } catch {
      // Clipboard access denied (rare in extension context) — open
      // Discord anyway so the user can manually report.
    }
    window.open(DISCORD_INVITE_URL, '_blank', 'noopener,noreferrer');
  }

  $effect(() => () => {
    if (reportCopiedTimer) clearTimeout(reportCopiedTimer);
  });
</script>

<section class="relative flex h-full flex-col overflow-hidden">
  {#if readerShip}
    <!-- Inline ship reader — replaces the grid while a ship is selected.
         Slug unknown (ship matrix doesn't expose it), so we pass `name`
         and the background handler resolves via the cached pledge ship
         list. Hero snippet seeds the first paint before the real detail
         arrives so the header doesn't flicker. -->
    <ShipReader
      name={readerShip.name}
      url={readerShip.url ?? undefined}
      initialSnippet={{
        name: readerShip.name,
        manufacturerName: readerShip.manufacturer?.name ?? '',
        thumbnailUrl: readerShip.image ?? '',
        type: readerShip.type ?? '',
        focus: readerShip.focus ?? '',
        productionStatus: readerShip.production_status ?? '',
      }}
      onBack={closeReader}
      onAddToCart={(skuId, title) => void addSkuToCart(skuId, title)}
      addingSkuId={addingStoreSkuId}
      addFlash={storeCartFlash}
      focusEditions={readerFocusEditions}
    />
  {:else}
  <div class="relative border-b border-slate-800 bg-slate-950/40">
  <div
    class="flex flex-wrap items-center gap-2 px-4 py-2"
  >
    <div class="flex items-baseline gap-2">
      <h2 class="text-sm font-semibold text-slate-200">Ships</h2>
      {#if ships.length > 0}
        <span class="text-[10px] text-slate-500">
          {filtered.length}/{ships.length}
          {#if signedIn}
            · {ownedCount} owned · {loanerCount} {loanerCount === 1 ? 'loaner' : 'loaners'}
          {/if}
        </span>
      {/if}
      {#if fromCache}
        <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
          <Database class="size-3" />
          cached
        </span>
      {/if}
    </div>

    <div class="ml-auto flex items-center gap-2">
      {#if signedIn && notFound.length > 0}
        <button
          type="button"
          class="flex items-center gap-1 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[11px] text-amber-300 transition hover:bg-amber-900/40"
          onclick={() => (notFoundOpen = true)}
          title="Unknown ships detected in your hangar"
        >
          <TriangleAlert class="size-3.5" />
          {notFound.length} unknown
        </button>
      {/if}
      <input
        type="search"
        placeholder="Filter..."
        bind:value={query}
        class="w-36 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
      />
      <button
        type="button"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
        disabled={loading || filtered.length === 0}
        onclick={exportCsv}
        title="Export current view as CSV"
        aria-label="Export CSV"
      >
        <Download class="size-3.5" />
      </button>
      <button
        type="button"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
        disabled={loading}
        onclick={async () => {
          // Re-check identity alongside the ships fetch — if the user has just
          // signed in (or out) between popup opens, we want the Owned/Loaners
          // gate to flip without waiting for the auth cache to expire.
          await authState.refresh(true);
          void load(true);
        }}
        title="Refresh"
      >
        <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
      </button>
    </div>
  </div>
  {#if loading}
    <div class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-slate-800/60">
      <div class="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] bg-sky-400"></div>
    </div>
  {/if}
  </div>

  {#if notFoundOpen}
    <div
      class="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-lg overflow-hidden rounded-lg border border-slate-800 bg-slate-900 shadow-xl">
        <div class="flex items-center justify-between gap-3 border-b border-slate-800 bg-amber-950/30 px-4 py-2">
          <div class="flex items-center gap-2 text-amber-200">
            <TriangleAlert class="size-4" />
            <h3 class="text-sm font-semibold">Unknown ships in your hangar</h3>
          </div>
          <button
            type="button"
            class="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            onclick={() => (notFoundOpen = false)}
            title="Close"
            aria-label="Close"
          >
            <X class="size-4" />
          </button>
        </div>
        <div class="max-h-[50vh] overflow-y-auto px-4 py-3 text-xs text-slate-300">
          <p class="mb-2 text-slate-400">
            {notFound.length} hangar {notFound.length === 1 ? 'entry' : 'entries'} could not be matched to a ship in the public Ship Matrix — usually renamed SKUs or chassis that CIG hasn't published to the matrix yet. If you'd like these added to the extension's alias catalog, share them on the community Discord; otherwise you can safely ignore this.
          </p>
          <ul class="space-y-1 font-mono">
            {#each notFound as name (name)}
              <li class="rounded bg-slate-950/60 px-2 py-1">{name}</li>
            {/each}
          </ul>
        </div>
        <div class="flex items-center justify-end gap-2 border-t border-slate-800 px-4 py-2">
          {#if reportCopied}
            <span class="text-[10px] italic text-emerald-300">
              Copied to clipboard — paste in Discord
            </span>
          {/if}
          <button
            type="button"
            onclick={() => void reportUnknownShipsToDiscord(notFound)}
            class="inline-flex items-center gap-1.5 rounded-md bg-indigo-500/20 px-3 py-1 text-xs font-semibold text-indigo-300 ring-1 ring-indigo-500/40 transition hover:bg-indigo-500/30"
          >
            Share on Discord <ExternalLink class="size-3" />
          </button>
          <button
            type="button"
            class="rounded-md bg-slate-800 px-3 py-1 text-xs text-slate-200 hover:bg-slate-700"
            onclick={() => (notFoundOpen = false)}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if ships.length > 0}
    <div
      class="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/20 px-4 py-2 text-xs"
    >
      {#if signedIn}
        <label class="flex items-center gap-1 text-slate-400">
          <input
            type="checkbox"
            class="accent-sky-500"
            checked={shipFilterP.value === 'owned'}
            onclick={() => {
              shipFilterP.value = shipFilterP.value === 'owned' ? '' : 'owned';
            }}
          />
          Owned
        </label>
        <label class="flex items-center gap-1 text-slate-400">
          <input
            type="checkbox"
            class="accent-sky-500"
            checked={shipFilterP.value === 'loans'}
            onclick={() => {
              shipFilterP.value = shipFilterP.value === 'loans' ? '' : 'loans';
            }}
          />
          Loaners
        </label>
      {/if}
      {#if favorites.size > 0}
        <label class="flex items-center gap-1 text-slate-400" title="Show only starred ships">
          <input type="checkbox" bind:checked={onlyFavsP.value} class="accent-amber-400" />
          <Star class="size-3 text-amber-400" />
          <span>Favorites ({favorites.size})</span>
        </label>
      {/if}
      {#if signedIn === false}
        <!-- Anonymous: no hangar/loaner info is available, so surface a direct
             sign-in affordance where the Owned/Loaners checkboxes would be. -->
        <a
          href={RSI_BASE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 rounded-md border border-sky-700/60 bg-sky-950/40 px-2 py-1 text-[11px] font-semibold text-sky-200 transition hover:bg-sky-900/50"
          title="Opens robertsspaceindustries.com in a new tab"
        >
          <LogIn class="size-3" />
          Open RSI sign-in
        </a>
      {/if}
      <select
        bind:value={manufacturerP.value}
        class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300"
      >
        <option value="">All makes</option>
        {#each manufacturers as m (m)}
          <option value={m}>{m}</option>
        {/each}
      </select>
      <select
        bind:value={focusP.value}
        class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300"
      >
        <option value="">All roles</option>
        {#each focuses as f (f)}
          <option value={f}>{f}</option>
        {/each}
      </select>
      <select
        bind:value={statusP.value}
        class="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-xs text-slate-300"
      >
        <option value="">All status</option>
        {#each statuses as s (s)}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </div>
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if authState.signedIn === null && ships.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load ships</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && ships.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else}
      <ul class="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 3xl:grid-cols-6 4xl:grid-cols-7">
        {#each filtered as s (s.id)}
          {@const isFav = favorites.has(String(s.id))}
          <li class="virt-item-lg relative">
            <!-- Star + cart affordances sit above the card link so clicking
                 them doesn't also open the reader normally. -->
            <button
              type="button"
              class="absolute right-1 top-1 z-10 rounded-full bg-slate-950/70 p-1 text-slate-500 transition hover:bg-slate-950 hover:text-amber-300 {isFav
                ? 'text-amber-400'
                : ''}"
              onclick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                favorites.toggle(String(s.id));
              }}
              title={isFav ? 'Remove from favorites' : 'Add to favorites'}
              aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
              aria-pressed={isFav}
            >
              <Star class="size-3.5 {isFav ? 'fill-amber-400' : ''}" />
            </button>
            <!-- "Add to cart" shortcut. Ships have multiple SKU variants
                 (Standalone / Warbond / LTI / …) so we can't pick one from
                 the grid alone — instead this opens the reader and
                 auto-scrolls to the Editions section where the user picks
                 which SKU to add. Stacked below the Star so both
                 affordances stay clustered at the top-right without
                 covering the body text. -->
            <button
              type="button"
              class="absolute right-1 top-8 z-10 rounded-full bg-amber-500/90 p-1 text-amber-950 transition hover:bg-amber-400"
              onclick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openReader(s, { focusEditions: true });
              }}
              title="Pick an edition to add to cart"
              aria-label="Pick an edition to add to cart"
            >
              <ShoppingCart class="size-3.5" />
            </button>
            <button
              type="button"
              onclick={() => openReader(s)}
              class="group block w-full overflow-hidden rounded-md bg-slate-900/70 text-left ring-1 ring-slate-800 transition hover:ring-sky-600
                {s.owned ? 'ring-emerald-700/60' : ''}
                {s.loaner && !s.owned ? 'ring-amber-700/50' : ''}
                {isFav ? 'ring-amber-500/60' : ''}"
            >
              <div class="aspect-[16/9] overflow-hidden bg-slate-950">
                {#if s.image}
                  <img
                    src={s.image}
                    alt=""
                    loading="lazy"
                    class="size-full object-cover transition group-hover:scale-105"
                  />
                {:else}
                  <div class="flex size-full items-center justify-center text-slate-700">
                    <ShipIcon class="size-8" />
                  </div>
                {/if}
              </div>
              <div class="p-2">
                <div class="mb-1 flex flex-wrap items-center gap-1">
                  {#if s.owned}
                    <span
                      class="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300"
                    >
                      Owned{s.count > 1 ? ` ×${s.count}` : ''}
                    </span>
                  {/if}
                  {#if s.loaner && !s.owned}
                    <span
                      class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-300"
                    >
                      Loaner
                    </span>
                  {/if}
                  {#if s.production_status}
                    <span class="text-[9px] uppercase tracking-wider text-slate-500"
                      >{s.production_status}</span
                    >
                  {/if}
                </div>
                <p class="line-clamp-1 text-[10px] text-slate-500">{s.manufacturer?.name ?? ''}</p>
                <p class="line-clamp-1 text-xs font-medium text-slate-200">{s.name}</p>
                <p class="mt-0.5 line-clamp-1 text-[10px] text-slate-400">
                  {s.focus || s.type || ''}
                </p>
              </div>
            </button>
          </li>
        {/each}
      </ul>

      {#if filtered.length === 0 && ships.length > 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">No ships match your filter.</p>
      {/if}
    {/if}
  </div>
  {/if}
</section>
