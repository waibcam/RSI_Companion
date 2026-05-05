<script lang="ts">
  import { sendRsiMessage, Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ChevronRight,
    Clipboard,
    Coins,
    Download,
    FileText,
    Gift,
    Heart,
    Loader2,
    Package,
    PackageOpen,
    Sparkles,
    Tag,
    TrendingUp,
    Warehouse,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import SignInPrompt from '../components/SignInPrompt.svelte';
  import { authState } from '../state.svelte';
  import { persistedState } from '../persist.svelte';
  import { errorMessage, extractSignedIn } from '../error';

  type Pledge = Rsi.HangarPledge;
  type PledgeType = Rsi.HangarPledgeType;
  type Tab = 'pledges' | 'ships' | 'export';

  const TABS: readonly Tab[] = ['pledges', 'ships', 'export'];
  const isTab = (v: unknown): v is Tab =>
    typeof v === 'string' && (TABS as readonly string[]).includes(v);
  const tabP = persistedState<Tab>('hangar:tab', 'pledges', isTab);

  // ---- Data ----------------------------------------------------------------

  let pledges = $state<Pledge[]>([]);
  let signedIn = $state<boolean | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let fromCache = $state(false);

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      const res = await sendRsiMessage({ type: 'hangar.list', force });
      pledges = res.pledges;
      signedIn = res.signedIn;
      fromCache = res.fromCache;
    } catch (e) {
      error = errorMessage(e);
      if (extractSignedIn(e) === false) signedIn = false;
    } finally {
      loading = false;
    }
  }

  let kicked = false;
  $effect(() => {
    if (authState.signedIn === true && !kicked) {
      kicked = true;
      void load();
    } else if (authState.signedIn === false) {
      signedIn = false;
      loading = false;
    }
  });

  // ---- Filter state --------------------------------------------------------
  // 3-state cycle for boolean attributes: '' (no filter) → 'on' (only
  // matching) → 'off' (only NOT matching) → ''. Mirrors HangarXPLOR's
  // filter pattern. Each chip cycles via `cycleTri()` and renders in
  // sky (on) / rose (off) / neutral (no filter) so the user can see at
  // a glance which way the filter points without reading the label.
  type Tri = '' | 'on' | 'off';
  const isTri = (v: unknown): v is Tri => v === '' || v === 'on' || v === 'off';

  // Each filter is its own persisted state so power-user sessions
  // round-trip cleanly. Using one persisted-state per filter keeps the
  // type narrow ('' | 'on' | 'off') instead of a Record-of-tri which
  // we'd have to validate as a whole.
  const fLtiP = persistedState<Tri>('hangar:f:lti', '', isTri);
  const fWarbondP = persistedState<Tri>('hangar:f:warbond', '', isTri);
  const fGiftableP = persistedState<Tri>('hangar:f:giftable', '', isTri);
  const fMeltableP = persistedState<Tri>('hangar:f:meltable', '', isTri);
  const fValuableP = persistedState<Tri>('hangar:f:valuable', '', isTri);
  const fUpgradedP = persistedState<Tri>('hangar:f:upgraded', '', isTri);
  const fRewardP = persistedState<Tri>('hangar:f:reward', '', isTri);
  // Free CCUs default to 'off' (excluded) — matches HangarXPLOR's
  // out-of-the-box behaviour. Free CCUs are typically referral /
  // promotional grants that clutter the main hangar view; users who
  // want to inspect them cycle the chip to '' (no filter).
  const fFreeCcuP = persistedState<Tri>('hangar:f:freeccu', 'off', isTri);

  function cycleTri(state: { value: Tri }): void {
    state.value = state.value === '' ? 'on' : state.value === 'on' ? 'off' : '';
  }

  // Pledge-type filter ('' = all). Persists. The list of options matches
  // the dropdown the hangar page itself surfaces, plus our 'pack' and
  // 'standalone-vehicle' which RSI breaks out separately.
  const isPledgeType = (v: unknown): v is PledgeType | '' =>
    v === '' ||
    v === 'standalone-ship' ||
    v === 'standalone-vehicle' ||
    v === 'package' ||
    v === 'combo' ||
    v === 'pack' ||
    v === 'add-on' ||
    v === 'upgrade' ||
    v === 'extra' ||
    v === 'paint' ||
    v === 'other';
  const fTypeP = persistedState<PledgeType | ''>('hangar:f:type', '', isPledgeType);

  const PLEDGE_TYPE_LABELS: Record<PledgeType, string> = {
    'standalone-ship': 'Standalone Ships',
    'standalone-vehicle': 'Standalone Vehicles',
    package: 'Game Packages',
    combo: 'Combo Packs',
    pack: 'Packs',
    'add-on': 'Add-Ons',
    upgrade: 'Ship Upgrades',
    extra: 'Extras',
    paint: 'Paints',
    other: 'Other',
  };

  // List of types actually present in the user's hangar — drives which
  // entries appear in the type dropdown so we don't surface empty
  // categories. Always-include 'All' first.
  const presentTypes = $derived.by<PledgeType[]>(() => {
    const seen = new Set<PledgeType>();
    for (const p of pledges) seen.add(p.pledgeType);
    // Stable ordering — matches the dropdown layout above.
    const order: PledgeType[] = [
      'standalone-ship',
      'standalone-vehicle',
      'package',
      'combo',
      'pack',
      'add-on',
      'upgrade',
      'extra',
      'paint',
      'other',
    ];
    return order.filter((t) => seen.has(t));
  });

  let query = $state('');

  // Tri-state predicate helper. `attr` is the pledge attribute to test;
  // `state` is the filter's current Tri value.
  function triMatch(attr: boolean, state: Tri): boolean {
    if (state === '') return true;
    if (state === 'on') return attr;
    return !attr;
  }

  function pledgeMatches(p: Pledge): boolean {
    if (!triMatch(p.lti, fLtiP.value)) return false;
    if (!triMatch(p.warbond, fWarbondP.value)) return false;
    if (!triMatch(p.isGiftable, fGiftableP.value)) return false;
    if (!triMatch(p.isMeltable, fMeltableP.value)) return false;
    // Valuable = pledge cost > 0. Surfaces what's actually got
    // melt-value in the account (filters out $0 promotional pledges,
    // referral CCUs, AMD partnership freebies, etc.). HangarXPLOR
    // exposes the same notion under the name "Valuable".
    if (!triMatch(p.pledgeCostNumeric > 0, fValuableP.value)) return false;
    if (!triMatch(p.hasUpgrade, fUpgradedP.value)) return false;
    if (!triMatch(p.hasReward, fRewardP.value)) return false;
    if (!triMatch(p.isFreeCcu, fFreeCcuP.value)) return false;
    if (fTypeP.value !== '' && p.pledgeType !== fTypeP.value) return false;

    if (query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      const hay = [
        p.pledgeName,
        p.pledgeNameRaw,
        p.pledgeId,
        p.pledgeDate,
        ...p.ships.map((s) => `${s.shipName} ${s.shipNickname ?? ''}`),
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  const filteredPledges = $derived.by<Pledge[]>(() => pledges.filter(pledgeMatches));

  // ---- Bundled (transitive) ships ----------------------------------------
  // Shown in the popup with a "+ bundled" badge but NOT in the HTF
  // export — see the long comment in hangar.ts for why.
  //
  // Keyed by the SHIP NAME the hangar HTML renders, which sometimes
  // differs from the parent SKU's matrix name. RSI's hangar collapses
  // the Carrack-Expedition-w/C8X SKU (matrix id 205) into a single
  // ship row labelled "Carrack Expedition with Pisces Expedition" —
  // we recognise both spellings so the count matches Ships module
  // (which sees the SKU id directly via CCU and bundle-expands).
  const BUNDLED_BY_SHIP_NAME: Record<string, string[]> = {
    'Constellation Phoenix': ['Lynx', 'P-72 Archimedes'],
    'Constellation Phoenix Emerald': ['Lynx', 'P-72 Archimedes Emerald'],
    'Constellation Aquila': ['Ursa'],
    'Carrack w/C8X': ['C8X Pisces Expedition'],
    'Carrack Expedition w/C8X': ['C8X Pisces Expedition'],
    // RSI's hangar HTML actually renders these collapsed names —
    // matches what a real hangar dump showed (without the w/C8X
    // suffix, with " with Pisces Expedition" appended instead).
    'Carrack with Pisces Expedition': ['C8X Pisces Expedition'],
    'Carrack Expedition with Pisces Expedition': ['C8X Pisces Expedition'],
  };
  function bundledShipsFor(p: Pledge): string[] {
    const hits: string[] = [];
    const seen = new Set<string>();
    for (const s of p.ships) {
      const list = BUNDLED_BY_SHIP_NAME[s.shipName];
      if (list) {
        for (const child of list) {
          if (seen.has(child)) continue;
          seen.add(child);
          hits.push(child);
        }
      }
    }
    return hits;
  }

  let expanded = $state(new Set<string>());
  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  // ---- Ships tab — denormalised view --------------------------------------

  type DenormShipRow = {
    shipName: string;
    shipNickname: string | null;
    manufacturerName: string;
    manufacturerCode: string;
    pledgeId: string;
    pledgeName: string;
    pledgeDate: string;
    pledgeCost: string;
    lti: boolean;
    warbond: boolean;
    bundled: boolean;
  };

  const denormShips = $derived.by<DenormShipRow[]>(() => {
    const out: DenormShipRow[] = [];
    for (const p of filteredPledges) {
      for (const s of p.ships) {
        out.push({
          shipName: s.shipName,
          shipNickname: s.shipNickname,
          manufacturerName: s.manufacturerName,
          manufacturerCode: s.manufacturerCode,
          pledgeId: p.pledgeId,
          pledgeName: p.pledgeName,
          pledgeDate: p.pledgeDate,
          pledgeCost: p.pledgeCost,
          lti: p.lti,
          warbond: p.warbond,
          bundled: false,
        });
      }
      for (const childName of bundledShipsFor(p)) {
        const alreadyListed = p.ships.some((s) => s.shipName === childName);
        if (alreadyListed) continue;
        out.push({
          shipName: childName,
          shipNickname: null,
          manufacturerName: '',
          manufacturerCode: '',
          pledgeId: p.pledgeId,
          pledgeName: p.pledgeName,
          pledgeDate: p.pledgeDate,
          pledgeCost: p.pledgeCost,
          lti: p.lti,
          warbond: p.warbond,
          bundled: true,
        });
      }
    }
    out.sort((a, b) => {
      const m = a.manufacturerName.localeCompare(b.manufacturerName);
      if (m !== 0) return m;
      return a.shipName.localeCompare(b.shipName);
    });
    return out;
  });

  // ---- Export --------------------------------------------------------------

  let copyState = $state<'idle' | 'copied' | 'error'>('idle');
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  function downloadJson() {
    const rows = Rsi.buildHtfRows(pledges);
    const blob = new Blob([JSON.stringify(rows, null, 2)], {
      type: 'application/json',
    });
    triggerDownload(blob, `shiplist-${formatStamp()}.json`);
  }

  function downloadCsv() {
    const csv = Rsi.buildHtfCsv(pledges);
    const blob = new Blob([csv], { type: 'text/csv' });
    triggerDownload(blob, `shiplist-${formatStamp()}.csv`);
  }

  async function copyJson() {
    try {
      const rows = Rsi.buildHtfRows(pledges);
      await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
      copyState = 'copied';
    } catch {
      copyState = 'error';
    } finally {
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => (copyState = 'idle'), 2000);
    }
  }

  function triggerDownload(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function formatStamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ---- Aggregate counts (rendered in the prominent banner + header) -------

  const totalPledges = $derived(pledges.length);
  // Ship count INCLUDES bundled (transitive) children so this number
  // matches the "owned" total the Ships module reports — both views
  // should agree on "how many ships does the user effectively have
  // access to". The HTF export still excludes bundled (HangarXPLOR
  // compat); the disconnect between popup count and export count is
  // explicit in the export-tab help text.
  const totalShips = $derived(
    pledges.reduce(
      (acc, p) => acc + p.ships.length + bundledShipsFor(p).length,
      0,
    ),
  );
  const totalCost = $derived(
    pledges.reduce((acc, p) => acc + p.pledgeCostNumeric, 0),
  );
  // Filtered subtotals so the banner reflects whatever the user has
  // narrowed down to — handy when you want to see "how much warbond
  // did I spend" or "what's the meltable total".
  const filteredShipsCount = $derived(
    filteredPledges.reduce(
      (acc, p) => acc + p.ships.length + bundledShipsFor(p).length,
      0,
    ),
  );
  const filteredCost = $derived(
    filteredPledges.reduce((acc, p) => acc + p.pledgeCostNumeric, 0),
  );
  // Show "filtered" when the filter set is non-trivial. Anything
  // narrower than the full set counts. Note: free-ccu defaults to
  // 'off' so an active 'off' state on it alone doesn't count as
  // user-driven filtering — only when it differs from the default.
  const isFiltering = $derived(
    fLtiP.value !== '' ||
      fWarbondP.value !== '' ||
      fGiftableP.value !== '' ||
      fMeltableP.value !== '' ||
      fValuableP.value !== '' ||
      fUpgradedP.value !== '' ||
      fRewardP.value !== '' ||
      fFreeCcuP.value !== 'off' ||
      fTypeP.value !== '' ||
      query.trim().length > 0,
  );

  // ---- Chip class helper -------------------------------------------------
  // Static class strings per state so Tailwind's JIT can extract them
  // (dynamic templates like `bg-${color}-500/15` produce no CSS). Keeps
  // every chip's three states in one place.

  function triChipClass(state: Tri): string {
    if (state === 'on')
      return 'bg-sky-500/20 text-sky-200 ring-1 ring-inset ring-sky-500/50 hover:bg-sky-500/30';
    if (state === 'off')
      return 'bg-rose-500/20 text-rose-200 ring-1 ring-inset ring-rose-500/50 hover:bg-rose-500/30';
    return 'bg-slate-900 text-slate-400 ring-1 ring-inset ring-slate-800 hover:text-slate-200 hover:ring-slate-700';
  }
  function triChipTitle(label: string, state: Tri): string {
    if (state === 'on') return `Showing only ${label}. Click for "no ${label}".`;
    if (state === 'off') return `Hiding ${label}. Click to reset.`;
    return `Click to filter to ${label}.`;
  }
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Hangar" {loading} {fromCache} onRefresh={() => load(true)}>
    {#snippet meta()}
      {#if signedIn}
        <span class="text-[10px] text-slate-500">
          {totalPledges} pledges · {totalShips} ships
        </span>
      {/if}
    {/snippet}
    {#snippet controls()}
      {#if tabP.value !== 'export'}
        <input
          type="search"
          placeholder="Filter…"
          bind:value={query}
          class="min-w-0 flex-1 max-w-56 rounded-md border border-slate-800 bg-slate-900 px-2 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-sky-600 focus:outline-none"
        />
      {:else}
        <div class="flex-1"></div>
      {/if}
    {/snippet}
  </ModuleHeader>

  {#if signedIn}
    <!-- Tabs row -->
    <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
      {#each [['pledges', 'Pledges', Package], ['ships', 'Ships', Warehouse], ['export', 'Export', Download]] as const as [id, label, IconCmp] (id)}
        <button
          type="button"
          onclick={() => (tabP.value = id)}
          class="relative flex items-center gap-1 px-3 py-1.5 transition {tabP.value ===
          id
            ? 'text-sky-300'
            : 'text-slate-400 hover:text-slate-200'}"
        >
          <IconCmp class="size-3" />
          {label}
          {#if tabP.value === id}
            <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
          {/if}
        </button>
      {/each}
    </div>

    {#if tabP.value !== 'export' && pledges.length > 0}
      <!-- Stats banner: prominent total value + filtered subtotal.
           Sits between tabs and filter chips so it's the first thing
           the user reads on the page — answers "how much have I sunk
           in this game" without making them squint at the header
           meta.
           HEIGHT IS FIXED — every card reserves the slot for the
           filtered-subtotal line whether or not we're filtering, so
           toggling a chip never shifts the chip-row position. (User
           reported being unable to double-click chips because the
           layout would jump under their cursor.) -->
      <div class="grid grid-cols-3 gap-2 border-b border-slate-800 bg-gradient-to-r from-slate-950/60 via-slate-900/40 to-slate-950/60 px-3 py-2">
        <div class="rounded bg-slate-950/40 p-2 ring-1 ring-slate-800/60">
          <div class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
            <Coins class="size-3" />
            Total spent
          </div>
          <div class="mt-0.5 font-mono text-lg font-bold tabular-nums text-amber-300">
            ${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </div>
          <!-- Filtered subline — always rendered to reserve vertical
               space, hidden via opacity-0 when no filter is active.
               Keeps the banner height stable so chips below don't
               jump when toggling. -->
          <div
            class="flex h-3.5 items-center gap-1 text-[9px] tabular-nums {isFiltering &&
            filteredCost !== totalCost
              ? 'text-emerald-300'
              : 'opacity-0'}"
          >
            <TrendingUp class="size-2.5" />
            {#if isFiltering && filteredCost !== totalCost}
              ${filteredCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              <span class="text-slate-500">
                ({Math.round((filteredCost / Math.max(totalCost, 1)) * 100)}%)
              </span>
            {:else}
              <span>placeholder</span>
            {/if}
          </div>
        </div>
        <div class="rounded bg-slate-950/40 p-2 ring-1 ring-slate-800/60">
          <div class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
            <Package class="size-3" />
            Pledges
          </div>
          <div class="mt-0.5 font-mono text-lg font-bold tabular-nums text-slate-100">
            {filteredPledges.length}<span
              class="text-[10px] font-normal {isFiltering
                ? 'text-slate-500'
                : 'opacity-0'}">/{totalPledges}</span
            >
          </div>
          <div class="h-3.5 opacity-0"></div>
        </div>
        <div class="rounded bg-slate-950/40 p-2 ring-1 ring-slate-800/60">
          <div class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
            <Warehouse class="size-3" />
            Ships
          </div>
          <div class="mt-0.5 font-mono text-lg font-bold tabular-nums text-slate-100">
            {filteredShipsCount}<span
              class="text-[10px] font-normal {isFiltering
                ? 'text-slate-500'
                : 'opacity-0'}">/{totalShips}</span
            >
          </div>
          <div class="h-3.5 opacity-0"></div>
        </div>
      </div>

      <!-- Filter row 1: tri-state chips. Sky background = include only,
           rose = exclude, neutral = no filter. Clicking cycles. -->
      <div class="flex flex-wrap items-center gap-1 border-b border-slate-800 bg-slate-950/10 px-3 py-1.5 text-[10px]">
        <button
          type="button"
          onclick={() => cycleTri(fLtiP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fLtiP.value)}"
          title={triChipTitle('Lifetime Insurance', fLtiP.value)}
        >
          LTI
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fWarbondP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fWarbondP.value)}"
          title={triChipTitle('Warbond pledges', fWarbondP.value)}
        >
          Warbond
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fGiftableP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fGiftableP.value)}"
          title={triChipTitle('giftable pledges', fGiftableP.value)}
        >
          Giftable
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fMeltableP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fMeltableP.value)}"
          title={triChipTitle('meltable pledges', fMeltableP.value)}
        >
          Meltable
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fValuableP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fValuableP.value)}"
          title={triChipTitle('pledges with a non-zero cost', fValuableP.value)}
        >
          Valuable
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fUpgradedP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fUpgradedP.value)}"
          title={triChipTitle('pledges containing an upgrade / CCU', fUpgradedP.value)}
        >
          Upgraded
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fRewardP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fRewardP.value)}"
          title={triChipTitle('reward pledges', fRewardP.value)}
        >
          Reward
        </button>
        <button
          type="button"
          onclick={() => cycleTri(fFreeCcuP)}
          class="rounded-full px-2 py-0.5 transition {triChipClass(fFreeCcuP.value)}"
          title={triChipTitle('free CCUs', fFreeCcuP.value)}
        >
          Free CCUs
        </button>

        {#if presentTypes.length > 1}
          <span class="mx-1 h-3 w-px bg-slate-800"></span>
          <select
            bind:value={fTypeP.value}
            class="rounded-full border-0 bg-slate-900 px-2 py-0.5 text-[10px] text-slate-300 ring-1 ring-inset ring-slate-800 transition hover:text-slate-100 hover:ring-slate-700 focus:outline-none focus:ring-sky-500/40"
            title="Filter by pledge type"
          >
            <option value="">All types</option>
            {#each presentTypes as t (t)}
              <option value={t}>{PLEDGE_TYPE_LABELS[t]}</option>
            {/each}
          </select>
        {/if}
      </div>
    {/if}
  {/if}

  <div class="flex-1 overflow-y-auto p-3">
    {#if authState.signedIn === false || signedIn === false}
      <SignInPrompt label="Hangar" />
    {:else if authState.signedIn === null}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if error}
      <div
        class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200"
      >
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Failed to load hangar</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if loading && pledges.length === 0}
      <div class="flex h-full items-center justify-center text-slate-500">
        <Loader2 class="size-5 animate-spin" />
      </div>
    {:else if pledges.length === 0}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
        <PackageOpen class="size-8" />
        <p class="text-xs italic">No pledges in your hangar.</p>
      </div>

    {:else if tabP.value === 'pledges'}
      <ul class="space-y-1.5">
        {#each filteredPledges as p (p.pledgeId || p.pledgeName)}
          {@const isOpen = expanded.has(p.pledgeId || p.pledgeName)}
          {@const bundled = bundledShipsFor(p)}
          {@const totalContent = p.ships.length + bundled.length}
          {@const isExpandable = totalContent > 0}
          {@const thumbUrl = p.imageUrl ?? p.ships[0]?.imageUrl ?? null}
          <li class="virt-item-lg rounded-md bg-slate-900/60 ring-1 ring-slate-800">
            <!-- Pledges with no Ship/Vehicle items inside (rewards-only,
                 coupon-only, sub-flair, etc.) render as a static row —
                 no chevron, no hover, no onclick. The header's snippet
                 below switches between <button> and <div> based on
                 whether there's anything to show in the expanded
                 panel. (Reported by the user: "j'ai un truc pour
                 dérouler mais rien à l'intérieur" — pledges with only
                 Reward kinds were offering an empty expand.) -->
            {#if isExpandable}
              <button
                type="button"
                class="flex w-full items-stretch gap-2 rounded-t-md py-1.5 pl-2 pr-2 text-left transition hover:bg-slate-800/40"
                onclick={() => toggleExpand(p.pledgeId || p.pledgeName)}
              >
                <ChevronRight
                  class="size-3.5 shrink-0 self-center text-slate-500 transition {isOpen
                    ? 'rotate-90'
                    : ''}"
                />
                <!-- Pledge thumbnail. Square, full-row-height. The
                     image comes from the first ship's hangar
                     thumbnail; bundled-only pledges (rare) fall back
                     to a placeholder slot to preserve alignment. -->
                {#if thumbUrl}
                  <img
                    src={thumbUrl}
                    alt=""
                    loading="lazy"
                    class="aspect-square size-9 shrink-0 rounded bg-slate-950 object-cover ring-1 ring-slate-800"
                  />
                {:else}
                  <div
                    class="flex aspect-square size-9 shrink-0 items-center justify-center rounded bg-slate-950 ring-1 ring-slate-800"
                  >
                    <Package class="size-4 text-slate-700" />
                  </div>
                {/if}
                <div class="flex min-w-0 flex-1 flex-col justify-center">
                  <p class="truncate text-xs font-medium text-slate-200">
                    {p.pledgeName || '(unnamed pledge)'}
                  </p>
                  <p class="truncate text-[10px] text-slate-500">
                    #{p.pledgeId} · {p.pledgeDate}
                    {#if p.pledgeCost} · {p.pledgeCost}{/if}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1 self-center">
                  {#if p.lti}
                    <span
                      class="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-emerald-300 ring-1 ring-inset ring-emerald-500/30"
                      title="Lifetime Insurance">LTI</span
                    >
                  {/if}
                  {#if p.warbond}
                    <span
                      class="rounded bg-sky-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-sky-300 ring-1 ring-inset ring-sky-500/30"
                      title="Warbond pledge">WB</span
                    >
                  {/if}
                  {#if p.isGiftable}
                    <Gift class="size-3 text-pink-300" />
                  {/if}
                  {#if p.isMeltable}
                    <Tag class="size-3 text-amber-300" />
                  {/if}
                  <span class="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                    {totalContent}
                  </span>
                </div>
              </button>
            {:else}
              <div class="flex w-full items-stretch gap-2 rounded-t-md py-1.5 pl-2 pr-2">
                <!-- Reserve the chevron column so the layout aligns
                     with expandable rows above/below. The dot is a
                     subtle "this row has no children" hint. -->
                <span class="size-3.5 shrink-0 self-center text-center text-[10px] text-slate-700"
                  >·</span
                >
                <!-- Same thumbnail slot as expandable rows so empty
                     pledges (Reward / Coupon-only) still feel like
                     part of the list. Falls back to placeholder when
                     none is found. -->
                {#if thumbUrl}
                  <img
                    src={thumbUrl}
                    alt=""
                    loading="lazy"
                    class="aspect-square size-9 shrink-0 rounded bg-slate-950 object-cover ring-1 ring-slate-800"
                  />
                {:else}
                  <div
                    class="flex aspect-square size-9 shrink-0 items-center justify-center rounded bg-slate-950 ring-1 ring-slate-800"
                  >
                    <Package class="size-4 text-slate-700" />
                  </div>
                {/if}
                <div class="flex min-w-0 flex-1 flex-col justify-center">
                  <p class="truncate text-xs font-medium text-slate-300">
                    {p.pledgeName || '(unnamed pledge)'}
                  </p>
                  <p class="truncate text-[10px] text-slate-500">
                    #{p.pledgeId} · {p.pledgeDate}
                    {#if p.pledgeCost} · {p.pledgeCost}{/if}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-1 self-center">
                  {#if p.hasReward}
                    <span
                      class="rounded bg-purple-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-purple-300 ring-1 ring-inset ring-purple-500/30"
                      title="Reward / promotional content (no ship)">Reward</span
                    >
                  {/if}
                  {#if p.hasUpgrade}
                    <span
                      class="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 ring-1 ring-inset ring-amber-500/30"
                      title="Upgrade / CCU">Upgrade</span
                    >
                  {/if}
                  {#if p.isMeltable}
                    <Tag class="size-3 text-amber-300" />
                  {/if}
                </div>
              </div>
            {/if}
            {#if isOpen && isExpandable}
              <ul class="border-t border-slate-800 bg-slate-950/30 px-2 py-1.5">
                {#each p.ships as s, i (`${p.pledgeId}-${i}-${s.shipName}`)}
                  <li class="flex items-center gap-2 py-0.5 text-[11px]">
                    {#if s.imageUrl}
                      <img
                        src={s.imageUrl}
                        alt=""
                        loading="lazy"
                        class="size-5 shrink-0 rounded bg-slate-950 object-cover ring-1 ring-slate-800"
                      />
                    {:else}
                      <Sparkles class="size-3 shrink-0 text-emerald-400" />
                    {/if}
                    <span class="text-slate-200">{s.shipName}</span>
                    {#if s.shipNickname}
                      <span class="text-[10px] italic text-slate-500"
                        >"{s.shipNickname}"</span
                      >
                    {/if}
                    {#if s.manufacturerCode}
                      <span class="ml-auto rounded bg-slate-800 px-1 py-0.5 text-[9px] uppercase tracking-wider text-slate-400">
                        {s.manufacturerCode}
                      </span>
                    {/if}
                  </li>
                {/each}
                {#each bundled as bname (bname)}
                  <li class="flex items-center gap-2 py-0.5 text-[11px]">
                    <Heart class="size-3 shrink-0 text-pink-400" />
                    <span class="text-slate-300">{bname}</span>
                    <span
                      class="ml-auto rounded bg-pink-500/10 px-1 py-0.5 text-[9px] uppercase tracking-wider text-pink-300 ring-1 ring-inset ring-pink-500/30"
                      title="Bundled with the parent pledge — owned but not exported in HTF"
                    >
                      + bundled
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ul>

      {#if filteredPledges.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No pledges match your filters.
        </p>
      {/if}

    {:else if tabP.value === 'ships'}
      {#if denormShips.length === 0}
        <p class="mt-6 text-center text-xs italic text-slate-500">
          No ships match your filters.
        </p>
      {:else}
        <ul class="space-y-0.5">
          {#each denormShips as r, i (`${r.pledgeId}-${i}-${r.shipName}`)}
            <li
              class="virt-item flex items-center gap-2 rounded bg-slate-900/40 px-2 py-1 text-[11px] {r.bundled
                ? 'opacity-75'
                : ''}"
            >
              <span class="w-10 shrink-0 truncate text-[9px] uppercase tracking-wider text-slate-500">
                {r.manufacturerCode || '—'}
              </span>
              <span class="flex-1 truncate text-slate-200">{r.shipName}</span>
              {#if r.shipNickname}
                <span class="hidden truncate text-[10px] italic text-slate-500 sm:block">
                  "{r.shipNickname}"
                </span>
              {/if}
              {#if r.lti}
                <span
                  class="rounded bg-emerald-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-emerald-300"
                  title="Lifetime Insurance">LTI</span
                >
              {/if}
              {#if r.warbond}
                <span
                  class="rounded bg-sky-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-sky-300"
                  title="Warbond">WB</span
                >
              {/if}
              {#if r.bundled}
                <span
                  class="rounded bg-pink-500/10 px-1 py-px text-[9px] uppercase tracking-wider text-pink-300"
                  title="Bundled with the parent pledge — included for display, omitted from HTF export"
                  >+ bundled</span
                >
              {/if}
              <span class="hidden shrink-0 text-[10px] text-slate-500 md:inline">
                {r.pledgeName}
              </span>
            </li>
          {/each}
        </ul>
      {/if}

    {:else if tabP.value === 'export'}
      <div class="mx-auto flex max-w-2xl flex-col gap-3 text-xs">
        <div class="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-slate-300">
          <p class="flex items-center gap-1 font-semibold text-slate-200">
            <FileText class="size-3.5 text-sky-400" /> Export your hangar
          </p>
          <p class="mt-1.5 leading-relaxed text-slate-400">
            Download a flat list of every ship in your hangar in the
            community-standard <code class="rounded bg-slate-950 px-1 text-[10px]"
              >shiplist.json</code
            > format compatible with HangarXPLOR-style tooling (value calculators,
            buyback matchers, account-transfer helpers). One row per ship; pledge
            attributes (id, name, date, cost, LTI, warbond) are denormalised onto
            each row.
          </p>
          <p class="mt-1.5 leading-relaxed text-slate-500">
            Bundled ships (e.g. the Lynx rover bundled with a Constellation
            Phoenix) are shown in this popup with a <span class="text-pink-300"
              >+ bundled</span
            > badge but intentionally <em>not</em> included in the export — that
            keeps the file strictly compatible with what HangarXPLOR
            consumers expect.
          </p>
        </div>

        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            onclick={downloadJson}
            class="flex items-center justify-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-2 text-xs font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30"
          >
            <Download class="size-3.5" />
            shiplist.json
          </button>
          <button
            type="button"
            onclick={downloadCsv}
            class="flex items-center justify-center gap-1.5 rounded-md bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-300 ring-1 ring-emerald-500/40 transition hover:bg-emerald-500/30"
          >
            <Download class="size-3.5" />
            shiplist.csv
          </button>
          <button
            type="button"
            onclick={copyJson}
            class="flex items-center justify-center gap-1.5 rounded-md bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-200 ring-1 ring-slate-700 transition hover:bg-slate-700"
          >
            <Clipboard class="size-3.5" />
            {copyState === 'copied'
              ? 'Copied!'
              : copyState === 'error'
                ? 'Copy failed'
                : 'Copy JSON'}
          </button>
        </div>

        <div class="rounded-md border border-slate-800 bg-slate-900/30 p-3 text-[11px] text-slate-400">
          <p class="font-semibold text-slate-300">Schema preview</p>
          <pre class="mt-2 overflow-x-auto rounded bg-slate-950 p-2 text-[10px] leading-relaxed text-slate-300">{`{
  "ship_code": "ANVL_Arrow",
  "ship_name": "Arrow",
  "manufacturer_code": "ANVL",
  "manufacturer_name": "Anvil Aerospace",
  "lti": false,
  "name": "Arrow",
  "warbond": false,
  "entity_type": "ship",
  "pledge_id": "21072264",
  "pledge_name": "Standalone Ship - Anvil Arrow",
  "pledge_date": "January 24, 2020",
  "pledge_cost": "$75.00 USD"
}`}</pre>
        </div>
      </div>
    {/if}
  </div>
</section>
