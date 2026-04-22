<script lang="ts">
  // Inline ship detail reader. Displayed as an overlay inside any module
  // that has ship cards (Ships, PledgeStore Ships tab, CCU targets). The
  // host module provides a back callback; this component owns its own
  // fetch/loading/error state and surfaces the reader UI.
  //
  // Slug resolution: when the caller only has a ship name (Ships module
  // or CCU catalogue), it passes `name` and the background handler
  // looks up the slug against the cached pledge ship list. PledgeStore's
  // Ships tab passes `slug` directly.
  //
  // `initialSnippet` seeds the hero (thumbnail + title + manufacturer +
  // price) so the reader renders something useful during the fetch
  // instead of a blank spinner. It's purely cosmetic — once `detail`
  // arrives, the real values take over.

  import { sendRsiMessage, type Rsi } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ArrowLeft,
    Cpu,
    ExternalLink,
    Gauge,
    Loader2,
    Package,
    Palette,
    Rocket,
    Ruler,
    Shield,
    Ship as ShipIcon,
    ShoppingCart,
    Sparkles,
    Target,
    Users,
    Wrench,
    Zap,
  } from 'lucide-svelte';

  type Detail = Rsi.PledgeShipDetail;
  type Variant = Detail['variants'][number];
  type Component = Detail['weapons'][number];

  interface Snippet {
    name: string;
    manufacturerName?: string;
    thumbnailUrl?: string;
    msrp?: number;
    type?: string;
    focus?: string;
    productionStatus?: string;
  }

  interface Props {
    /** DatoCMS slug. Preferred — avoids the lookup round-trip. */
    slug?: string;
    /** Ship display name. Used when `slug` is absent — handler resolves
     *  via the pledge ship list cache. */
    name?: string;
    /** Ship-matrix URL. Supplied alongside `name` for robust resolution —
     *  the handler falls back to URL matching when the display name
     *  doesn't line up between matrix and pledge store (e.g. "Sabre
     *  Comet" vs "Comet"). */
    url?: string;
    /** Optional placeholder data shown while the fetch is in flight. */
    initialSnippet?: Snippet;
    /** Back navigation (the host module controls visibility). */
    onBack: () => void;
    /** Click handler for the per-SKU "Add to cart" button in the
     *  Editions section. The host module (PledgeStore) owns the actual
     *  mutation + in-flight state. Omitted → buttons hidden (read-only
     *  view for callers that don't plumb this through, e.g. the Ships
     *  module, which can't know which SKU to add). */
    onAddToCart?: (skuId: string, title: string) => void;
    /** SKU id currently being added (if any). When it matches one of
     *  the SKUs in this reader, that SKU's button shows a spinner. */
    addingSkuId?: string | null;
    /** Last add-to-cart outcome for any SKU in this reader. Displayed
     *  as a small strip under the row. */
    addFlash?: { skuId: string; type: 'success' | 'error'; text: string } | null;
    /** When true the reader scrolls to the Editions section once the
     *  detail loads. Used by list-view "Add to cart" buttons that land
     *  the user directly on the SKU-picker rather than at the top of
     *  the reader (which forces a manual scroll past specs). */
    focusEditions?: boolean;
  }

  const {
    slug,
    name,
    url,
    initialSnippet,
    onBack,
    onAddToCart,
    addingSkuId = null,
    addFlash = null,
    focusEditions = false,
  }: Props = $props();

  // Anchor for the Editions section — gets scrolled into view after
  // loadDetail settles if `focusEditions` was set.
  let editionsEl = $state<HTMLElement | null>(null);

  let detail = $state<Detail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // Differentiates "GraphQL / network error" (error !== null) from
  // "no pledge-store entry for this ship" (notFound === true) — the
  // latter happens for ships not currently on sale (closed concept
  // sales, retired chassis) and deserves a gentler "open on RSI" UI
  // rather than a red error banner.
  let notFound = $state(false);

  // Variant navigation: clicking a shipVariant re-keys the fetch. Stack so
  // the back button inside the reader returns to the previous variant; the
  // host's onBack callback closes the whole reader.
  let variantStack = $state<string[]>([]);
  const activeSlug = $derived<string | null>(
    variantStack.length > 0 ? variantStack[variantStack.length - 1]! : slug ?? null,
  );
  // Name+URL hints are only used on the first frame; variant nav always
  // has a slug so the resolver path is skipped.
  const activeName = $derived<string | null>(variantStack.length > 0 ? null : name ?? null);
  const activeUrl = $derived<string | null>(variantStack.length > 0 ? null : url ?? null);

  $effect(() => {
    const s = activeSlug;
    const n = activeName;
    const u = activeUrl;
    void loadDetail(s ?? null, n ?? null, u ?? null);
  });

  async function loadDetail(s: string | null, n: string | null, u: string | null) {
    loading = true;
    error = null;
    notFound = false;
    detail = null;
    try {
      const res = await sendRsiMessage({
        type: 'pledge.shipDetail',
        ...(s ? { slug: s } : {}),
        ...(n ? { name: n } : {}),
        ...(u ? { url: u } : {}),
      });
      detail = res.detail;
      if (!res.detail) notFound = true;
      // When the host opened this reader via an "Add to cart" shortcut,
      // land the user on the Editions section so they can pick a SKU
      // without having to scroll past the hero/specs/body. Wait one tick
      // so the DOM has rendered the new section.
      if (focusEditions && res.detail && res.detail.skus.length > 0) {
        queueMicrotask(() => {
          editionsEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function openVariant(v: Variant): void {
    if (!v.slug) return;
    variantStack = [...variantStack, v.slug];
  }

  function back(): void {
    if (variantStack.length > 0) {
      variantStack = variantStack.slice(0, -1);
    } else {
      onBack();
    }
  }

  function formatPrice(cents: number): string {
    if (cents <= 0) return '—';
    return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  /** Format a SKU price in the user's native currency (from the detail's
   *  pricing context). Uses Intl.NumberFormat for correct locale symbol
   *  placement ($5.16 en-US, 5,16 € fr-FR, ¥516 ja-JP). Returns "—" for
   *  zero/missing prices so the UI doesn't show "$0.00" next to every
   *  concept sku that hasn't opened yet. */
  function formatNativePrice(amount: number): string {
    if (!detail || amount <= 0) return '—';
    const value = amount / Math.pow(10, detail.exponent);
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: detail.currencyCode,
      }).format(value);
    } catch {
      return `${value.toFixed(detail.exponent)} ${detail.currencySymbol}`;
    }
  }

  function formatNum(n: number | null, unit: string, digits = 0): string {
    if (n == null) return '—';
    return `${n.toLocaleString(undefined, { maximumFractionDigits: digits })} ${unit}`;
  }

  // --- Body / excerpt renderer ---------------------------------------------
  // The body is short prose. Bullet markers (`* text`) can appear inline
  // from older templates but more commonly come as the `excerpt` field
  // (one bullet per double-newline block). We render excerpt as a list
  // and body as paragraphs with `*italic*` emphasis.
  type Seg = { kind: 'text'; text: string } | { kind: 'em'; text: string };
  function parseInline(text: string): Seg[] {
    const out: Seg[] = [];
    const re = /\*([^*\n]+)\*/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
      out.push({ kind: 'em', text: m[1]! });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
    return out;
  }

  const bodyParagraphs = $derived<Seg[][]>(
    (detail?.body ?? '')
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map(parseInline),
  );

  const excerptBullets = $derived<string[]>(
    (detail?.excerpt ?? '')
      .split('\n')
      .map((l) => l.replace(/^\*\s*/, '').trim())
      .filter(Boolean),
  );

  // Component grouping: the equipment lists return one entry per hardpoint.
  // For display we group by `name` and sum the quantities — "Main Thruster
  // ×2 (Medium)" reads better than two identical rows.
  interface CompRow {
    name: string;
    description: string;
    manufacturerName: string;
    size: string;
    quantity: number;
  }
  function groupComponents(list: Component[]): CompRow[] {
    const map = new Map<string, CompRow>();
    for (const c of list) {
      if (!c.name) continue;
      const key = `${c.name}|${c.size}|${c.description}|${c.manufacturerName}`;
      const existing = map.get(key);
      if (existing) {
        existing.quantity += c.quantity;
      } else {
        map.set(key, {
          name: c.name,
          description: c.description,
          manufacturerName: c.manufacturerName,
          size: c.size,
          quantity: c.quantity,
        });
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  const weapons = $derived(detail ? groupComponents(detail.weapons) : []);
  const propulsions = $derived(detail ? groupComponents(detail.propulsions) : []);
  const thrusters = $derived(detail ? groupComponents(detail.thrusters) : []);
  const avionics = $derived(detail ? groupComponents(detail.avionics) : []);
  const modular = $derived(detail ? groupComponents(detail.modular) : []);

  // Production-status pill colour coding. The raw values come in several
  // forms depending on template version — normalise to a coarse bucket.
  function statusClass(s: string): string {
    const lc = s.toLowerCase();
    if (lc.includes('flight')) return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
    if (lc.includes('concept')) return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
    if (lc.includes('development') || lc.includes('production'))
      return 'bg-sky-500/15 text-sky-300 ring-sky-500/30';
    return 'bg-slate-700/40 text-slate-300 ring-slate-700';
  }

  // Visible snippet for the hero: real detail when loaded, fallback to
  // what the host gave us so the layout doesn't flicker.
  const hero = $derived({
    title: detail?.title || detail?.name || initialSnippet?.name || '…',
    manufacturer: detail?.manufacturerName || initialSnippet?.manufacturerName || '',
    thumbnail: detail?.thumbnailUrl || initialSnippet?.thumbnailUrl || '',
    msrp: detail?.msrp ?? initialSnippet?.msrp ?? 0,
    type: detail?.type || initialSnippet?.type || '',
    focus: detail?.focus || initialSnippet?.focus || '',
    productionStatus: detail?.productionStatus || initialSnippet?.productionStatus || '',
  });

  // Stop variant nav depth leaking once the user backs all the way out;
  // useful visual hint in the breadcrumb header.
  const depth = $derived(variantStack.length);
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Breadcrumb / back strip -->
  <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs">
    <button
      type="button"
      onclick={back}
      title="Back"
      aria-label="Back"
      class="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
    >
      <ArrowLeft class="size-3.5" />
    </button>
    <div class="min-w-0 flex-1 truncate text-slate-400">
      <span class="text-[10px] uppercase tracking-wider text-slate-500">Ship</span>
      <span class="ml-1.5 text-slate-200">{hero.title}</span>
    </div>
    {#if depth > 0}
      <span class="text-[10px] text-slate-600">variant depth {depth}</span>
    {/if}
    {#if detail?.url}
      <a
        href={detail.url.startsWith('http') ? detail.url : `https://robertsspaceindustries.com${detail.url.startsWith('/') ? '' : '/'}${detail.url}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Open on RSI"
        aria-label="Open on RSI"
        class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-sky-300"
      >
        <ExternalLink class="size-3.5" />
      </a>
    {/if}
  </div>

  <!-- Content cap: keep the reader at a readable column width on wide
       screens. Without this the hero image stretches edge-to-edge on
       ultrawide monitors in tab mode. 64rem (~1024px) matches the
       Galactapedia article reader and StoreItemReader, so all three
       inline readers feel consistent. -->
  <div class="flex-1 overflow-y-auto p-3">
    <div class="mx-auto max-w-5xl">
    {#if error && !loading}
      <div class="flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-xs text-rose-200">
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div>
          <p class="font-semibold">Couldn't load ship</p>
          <p class="mt-1 break-all text-rose-300/80">{error}</p>
        </div>
      </div>
    {:else if notFound && !loading}
      <!-- Ship wasn't found in the on-sale pledge catalogue. Common for
           ships owned from old concept sales that have since closed —
           CIG's detail GraphQL only exposes currently-sellable SKUs. We
           still show the hero snippet so the header isn't empty, and
           offer a direct RSI link as a graceful fallback. -->
      <header class="mb-3">
        {#if hero.thumbnail}
          <div class="mb-2 aspect-[16/9] overflow-hidden rounded bg-slate-950">
            <img src={hero.thumbnail} alt="" class="size-full object-cover" />
          </div>
        {/if}
        <h1 class="text-lg font-semibold text-slate-100">{hero.title}</h1>
        <p class="mt-0.5 text-[11px] text-slate-500">
          {hero.manufacturer}{hero.focus || hero.type ? ' · ' : ''}{hero.focus || hero.type}
        </p>
      </header>
      <div class="flex items-start gap-2 rounded-md border border-amber-700/40 bg-amber-950/20 p-3 text-xs text-amber-200">
        <AlertTriangle class="mt-0.5 size-4 shrink-0" />
        <div class="flex-1">
          <p class="font-semibold text-amber-100">Not currently available on the pledge store</p>
          <p class="mt-1 text-amber-300/80">
            The pledge-store detail endpoint only exposes ships CIG is actively
            selling. This ship might be a closed concept sale or a retired chassis —
            RSI's public site may still have the historical page.
          </p>
          {#if url}
            <a
              href={url.startsWith('http') ? url : `https://robertsspaceindustries.com${url.startsWith('/') ? '' : '/'}${url}`}
              target="_blank"
              rel="noopener noreferrer"
              class="mt-2 inline-flex items-center gap-1.5 rounded-md bg-amber-500/90 px-2.5 py-1 text-[11px] font-semibold text-amber-950 transition hover:bg-amber-400"
            >
              Open on RSI <ExternalLink class="size-3" />
            </a>
          {/if}
        </div>
      </div>
    {:else}
      <!-- Hero -->
      <header class="mb-3">
        {#if hero.thumbnail}
          <div class="mb-2 aspect-[16/9] overflow-hidden rounded bg-slate-950">
            <img src={hero.thumbnail} alt="" class="size-full object-cover" />
          </div>
        {:else}
          <div class="mb-2 flex aspect-[16/9] items-center justify-center rounded bg-slate-950 text-slate-700">
            <ShipIcon class="size-10" />
          </div>
        {/if}
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <h1 class="text-lg font-semibold text-slate-100">{hero.title}</h1>
            <p class="mt-0.5 text-[11px] text-slate-500">
              {hero.manufacturer}{hero.focus || hero.type ? ' · ' : ''}{hero.focus || hero.type}
            </p>
          </div>
          <div class="shrink-0 text-right">
            <p class="font-mono text-sm font-semibold text-amber-300">{formatPrice(hero.msrp)}</p>
            {#if hero.productionStatus}
              <span
                class="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ring-1 {statusClass(hero.productionStatus)}"
              >
                {hero.productionStatus.replace(/-/g, ' ')}
              </span>
            {/if}
          </div>
        </div>
      </header>

      {#if loading && !detail}
        <div class="flex items-center justify-center py-10 text-slate-500">
          <Loader2 class="size-5 animate-spin" />
        </div>
      {:else if detail}
        <!-- Key specs grid -->
        <section class="mb-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div class="rounded-md bg-slate-900/60 p-2 ring-1 ring-slate-800">
            <p class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
              <Users class="size-2.5" /> Crew
            </p>
            <p class="mt-0.5 font-mono text-sm text-slate-100">
              {#if detail.minCrew != null && detail.maxCrew != null}
                {detail.minCrew === detail.maxCrew ? detail.minCrew : `${detail.minCrew}–${detail.maxCrew}`}
              {:else}—{/if}
            </p>
          </div>
          <div class="rounded-md bg-slate-900/60 p-2 ring-1 ring-slate-800">
            <p class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
              <Ruler class="size-2.5" /> Size
            </p>
            <p class="mt-0.5 font-mono text-sm capitalize text-slate-100">{detail.size || '—'}</p>
          </div>
          <div class="rounded-md bg-slate-900/60 p-2 ring-1 ring-slate-800">
            <p class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
              <Gauge class="size-2.5" /> SCM
            </p>
            <p class="mt-0.5 font-mono text-sm text-slate-100">
              {formatNum(detail.maxScmSpeed, 'm/s')}
            </p>
          </div>
          <div class="rounded-md bg-slate-900/60 p-2 ring-1 ring-slate-800">
            <p class="flex items-center gap-1 text-[9px] uppercase tracking-wider text-slate-500">
              <Package class="size-2.5" /> Cargo
            </p>
            <p class="mt-0.5 font-mono text-sm text-slate-100">
              {formatNum(detail.cargoCapacity, 'SCU')}
            </p>
          </div>
        </section>

        <!-- Dimensions -->
        {#if detail.length || detail.beam || detail.height || detail.mass}
          <section class="mb-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
            <div class="rounded-md bg-slate-900/40 p-1.5 ring-1 ring-slate-800/60">
              <p class="text-[9px] uppercase tracking-wider text-slate-500">Length</p>
              <p class="mt-0.5 font-mono text-xs text-slate-200">{formatNum(detail.length, 'm', 1)}</p>
            </div>
            <div class="rounded-md bg-slate-900/40 p-1.5 ring-1 ring-slate-800/60">
              <p class="text-[9px] uppercase tracking-wider text-slate-500">Beam</p>
              <p class="mt-0.5 font-mono text-xs text-slate-200">{formatNum(detail.beam, 'm', 1)}</p>
            </div>
            <div class="rounded-md bg-slate-900/40 p-1.5 ring-1 ring-slate-800/60">
              <p class="text-[9px] uppercase tracking-wider text-slate-500">Height</p>
              <p class="mt-0.5 font-mono text-xs text-slate-200">{formatNum(detail.height, 'm', 1)}</p>
            </div>
            <div class="rounded-md bg-slate-900/40 p-1.5 ring-1 ring-slate-800/60">
              <p class="text-[9px] uppercase tracking-wider text-slate-500">Mass</p>
              <p class="mt-0.5 font-mono text-xs text-slate-200">{formatNum(detail.mass, 'kg')}</p>
            </div>
          </section>
        {/if}

        <!-- Excerpt bullets -->
        {#if excerptBullets.length > 0}
          <section class="mb-4">
            <ul class="space-y-1 text-[12px] text-slate-300">
              {#each excerptBullets as b, i (i)}
                <li class="flex items-start gap-1.5">
                  <Sparkles class="mt-0.5 size-3 shrink-0 text-sky-400" />
                  <span>{b}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- Body paragraphs -->
        {#if bodyParagraphs.length > 0}
          <section class="mb-4 space-y-2 text-sm leading-relaxed text-slate-300">
            {#each bodyParagraphs as p, i (i)}
              <p>
                {#each p as seg, j (j)}
                  {#if seg.kind === 'text'}{seg.text}{:else}<em class="italic text-slate-400">{seg.text}</em>{/if}
                {/each}
              </p>
            {/each}
          </section>
        {/if}

        <!-- Variants -->
        {#if detail.variants.length > 0}
          <section class="mb-4">
            <p class="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <ShipIcon class="size-2.5" /> Variants ({detail.variants.length})
            </p>
            <ul class="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {#each detail.variants as v (v.id)}
                <li>
                  <button
                    type="button"
                    onclick={() => openVariant(v)}
                    class="group flex w-full items-center gap-2 rounded-md bg-slate-900/70 p-1.5 text-left ring-1 ring-slate-800 transition hover:ring-sky-600"
                  >
                    {#if v.thumbnailUrl}
                      <img src={v.thumbnailUrl} alt="" loading="lazy" class="size-9 shrink-0 rounded object-cover" />
                    {:else}
                      <div class="flex size-9 shrink-0 items-center justify-center rounded bg-slate-950 text-slate-700">
                        <ShipIcon class="size-4" />
                      </div>
                    {/if}
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-[11px] font-medium text-slate-100">{v.title}</p>
                      <p class="text-[10px] text-slate-500">{formatPrice(v.msrp)}</p>
                    </div>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- Component sections -->
        {#snippet componentSection(rows: CompRow[], label: string, Icon: typeof Cpu)}
          {#if rows.length > 0}
            <section class="mb-4">
              <p class="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <Icon class="size-2.5" /> {label} ({rows.length})
              </p>
              <ul class="grid grid-cols-1 gap-1 text-[11px] sm:grid-cols-2">
                {#each rows as r, i (i)}
                  <li class="flex items-start gap-1.5 rounded bg-slate-900/40 px-1.5 py-1 ring-1 ring-inset ring-slate-800/60">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-slate-200">
                        {r.name}{r.quantity > 1 ? ` ×${r.quantity}` : ''}
                      </p>
                      <p class="truncate text-[10px] text-slate-500">
                        {#if r.size}<span class="capitalize">{r.size}</span>{/if}
                        {#if r.manufacturerName && r.manufacturerName !== 'TBD'}
                          · {r.manufacturerName}
                        {/if}
                        {#if r.description && r.description.toLowerCase() !== r.size.toLowerCase()}
                          · {r.description}
                        {/if}
                      </p>
                    </div>
                  </li>
                {/each}
              </ul>
            </section>
          {/if}
        {/snippet}

        {@render componentSection(weapons, 'Weapons', Target)}
        {@render componentSection(propulsions, 'Propulsion', Rocket)}
        {@render componentSection(thrusters, 'Thrusters', Zap)}
        {@render componentSection(avionics, 'Avionics', Cpu)}
        {@render componentSection(modular, 'Modular', Wrench)}

        <!-- Paints (just thumbnails) -->
        {#if detail.paints.length > 0}
          <section class="mb-4">
            <p class="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Palette class="size-2.5" /> Paints ({detail.paints.length})
            </p>
            <ul class="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
              {#each detail.paints as p (p.id)}
                <li class="rounded-md bg-slate-900/50 p-1 ring-1 ring-slate-800" title={p.title}>
                  {#if p.thumbnailUrl}
                    <img src={p.thumbnailUrl} alt={p.title} loading="lazy" class="mb-1 size-full rounded object-cover" />
                  {/if}
                  <p class="truncate text-[10px] text-slate-400">{p.title}</p>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <!-- SKUs (purchase options). When the host module wires an
             `onAddToCart` callback, each row gets a dedicated Add button;
             otherwise the section is read-only. Ships have multiple SKU
             variants (Standalone, Warbond, LTI editions, …) so the user
             picks which one to add. -->
        {#if detail.skus.length > 0}
          <!-- Capture the ship title up front so the onclick closure below
               doesn't need to re-narrow `detail` at click time — by then
               Svelte's reactive narrowing from `{:else if detail}` has
               been lost in TypeScript's eyes. -->
          {@const shipTitle = detail.title}
          <section class="mb-4 scroll-mt-3" bind:this={editionsEl}>
            <p class="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              <Shield class="size-2.5" /> Editions ({detail.skus.length})
            </p>
            <ul class="space-y-1">
              {#each detail.skus as s (s.id)}
                {@const busy = addingSkuId === s.id}
                {@const flash = addFlash && addFlash.skuId === s.id ? addFlash : null}
                {@const effectivePrice = s.discountedPrice ?? s.price}
                {@const hasDiscount = s.discountedPrice !== null && s.discountedPrice !== s.price}
                <li class="flex flex-col gap-0.5 rounded bg-slate-900/40 px-2 py-1 text-[11px] text-slate-300 ring-1 ring-inset ring-slate-800/60">
                  <div class="flex items-center gap-2">
                    <div class="min-w-0 flex-1">
                      <div class="flex flex-wrap items-center gap-1">
                        <span class="truncate">{s.title}</span>
                        {#if s.isWarbond}
                          <span class="rounded bg-fuchsia-500/20 px-1 py-0 text-[9px] font-semibold uppercase tracking-wider text-fuchsia-300">
                            Warbond
                          </span>
                        {/if}
                      </div>
                      {#if s.subtitle}
                        <!-- Type label — "Ship Upgrade", "Standalone Ship",
                             "Ship Package", "Anniversary Pack", etc. Lets
                             the user tell apart three "Avenger Titan"
                             rows at a glance. -->
                        <p class="truncate text-[9px] uppercase tracking-wider text-slate-500">
                          {s.subtitle}
                        </p>
                      {/if}
                    </div>
                    <!-- Price in the user's native currency — matches what
                         the cart will show after clicking Add. Strikethrough
                         + discounted pair when a sale is active. -->
                    {#if s.price > 0}
                      <div class="shrink-0 text-right">
                        {#if hasDiscount}
                          <p class="font-mono text-[9px] text-slate-500 line-through">
                            {formatNativePrice(s.price)}
                          </p>
                          <p class="font-mono text-[11px] font-semibold text-emerald-300">
                            {formatNativePrice(effectivePrice)}
                          </p>
                          {#if s.discountLabel}
                            <span class="inline-block rounded bg-emerald-500/15 px-1 py-0 text-[8px] font-semibold uppercase tracking-wider text-emerald-300">
                              {s.discountLabel}
                            </span>
                          {/if}
                        {:else}
                          <p class="font-mono text-[11px] font-semibold text-amber-300">
                            {formatNativePrice(effectivePrice)}
                          </p>
                        {/if}
                      </div>
                    {/if}
                    {#if onAddToCart}
                      <button
                        type="button"
                        onclick={() => onAddToCart(s.id, s.title || `${shipTitle} (SKU ${s.id})`)}
                        disabled={busy || addingSkuId !== null}
                        title="Add this edition to cart"
                        class="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/90 px-2 py-0.5 text-[10px] font-semibold text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                      >
                        {#if busy}
                          <Loader2 class="size-3 animate-spin" />
                        {:else}
                          <ShoppingCart class="size-2.5" /> Add
                        {/if}
                      </button>
                    {/if}
                  </div>
                  {#if flash}
                    <p class="text-[9px] {flash.type === 'success' ? 'text-emerald-300' : 'text-rose-300'}">
                      {flash.text}
                    </p>
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {/if}
    {/if}
    </div>
  </div>
</div>
