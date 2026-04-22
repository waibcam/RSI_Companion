<script lang="ts">
  // Inline detail reader for non-ship Pledge Store items (Ship Packs, Game
  // Packages, Paints, Gear, Merchandise, Add-Ons, Event Tickets, Gift
  // Cards, UEC). Mirrors ShipReader's breadcrumb/back UX but renders the
  // generic `StoreItem` shape — we don't fire a detail fetch here because
  // the `excerpt` / price / stock / tags / thumbnail fields already
  // arrive on the list response, and there's no detail-query shape we
  // can rely on for TySku across all categories. If CIG exposes a
  // GetStoreItem detail op later, wire it in the same pattern as
  // ShipReader.
  //
  // Category is used purely for the breadcrumb label and the CTA verb
  // ("Buy", "Redeem", etc. — currently a single "View on RSI" for all).

  import { RSI_BASE_URL, type Rsi } from '@rsi-companion/shared';
  import {
    ArrowLeft,
    ExternalLink,
    Loader2,
    Package,
    ShoppingCart,
    Sparkles,
    Tags as TagsIcon,
    TriangleAlert,
  } from 'lucide-svelte';

  type StoreItem = Rsi.StoreItem;
  type StoreCategoryId = Rsi.StoreCategoryId;

  interface Props {
    item: StoreItem;
    /** Shown in the breadcrumb strip. */
    categoryLabel: string;
    /** Category id — drives small UX niceties like category-specific
     *  badges. Currently unused but kept for forward-compat. */
    categoryId?: StoreCategoryId;
    /** Back navigation (the host module controls visibility). */
    onBack: () => void;
    /** Click handler for the in-reader "Add to cart" button. The host
     *  module (PledgeStore) owns the actual mutation + in-flight state
     *  so the same Add/busy/flash lifecycle is shared between the
     *  browse grid and the reader. Omitted → button hidden. */
    onAddToCart?: (skuId: string, title: string) => void;
    /** SKU id currently being added (if any). When it matches `item.id`
     *  the button in this reader shows a spinner and disables itself. */
    addingSkuId?: string | null;
    /** Last add-to-cart outcome for this item, displayed as a small
     *  confirmation strip above the CTA. */
    addFlash?: { type: 'success' | 'error'; text: string } | null;
  }

  const {
    item,
    categoryLabel,
    onBack,
    onAddToCart,
    addingSkuId = null,
    addFlash = null,
  }: Props = $props();

  function formatPrice(cents: number): string {
    if (cents <= 0) return '—';
    return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function externalUrl(url: string): string {
    if (!url) return `${RSI_BASE_URL}/pledge`;
    if (url.startsWith('http')) return url;
    return `${RSI_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  const itemUrl = $derived(externalUrl(item.url));

  // Excerpt is a block of bullet lines (`* …`) — the listing response
  // already trims to a useful short paragraph. Split on double newlines
  // or single-newline bullets so the layout renders cleanly as a list
  // when that's the format, or as paragraphs otherwise.
  const excerptBlocks = $derived<string[]>(
    (item.excerpt ?? '')
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .filter(Boolean),
  );

  function isBulletBlock(b: string): boolean {
    return b.startsWith('* ') || b.startsWith('- ');
  }
  function bulletLines(b: string): string[] {
    return b
      .split('\n')
      .map((l) => l.replace(/^[*-]\s*/, '').trim())
      .filter(Boolean);
  }

  // Stock level → colour bucket. The server sends 'low'/'medium'/'high'
  // for capped SKUs and leaves it blank for unlimited stock.
  function stockClass(level: string): string {
    const l = level.toLowerCase();
    if (l === 'low') return 'bg-rose-500/15 text-rose-300 ring-rose-500/30';
    if (l === 'medium') return 'bg-amber-500/15 text-amber-300 ring-amber-500/30';
    if (l === 'high') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30';
    return 'bg-slate-700/40 text-slate-300 ring-slate-700';
  }

  const hasDiscount = $derived(item.discounted != null && item.discounted !== item.msrp);
</script>

<div class="flex h-full flex-col overflow-hidden">
  <!-- Breadcrumb / back strip -->
  <div class="flex items-center gap-2 border-b border-slate-800 bg-slate-950/40 px-3 py-1.5 text-xs">
    <button
      type="button"
      onclick={onBack}
      title="Back"
      aria-label="Back"
      class="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
    >
      <ArrowLeft class="size-3.5" />
    </button>
    <div class="min-w-0 flex-1 truncate text-slate-400">
      <span class="text-[10px] uppercase tracking-wider text-slate-500">{categoryLabel}</span>
      <span class="ml-1.5 text-slate-200">{item.title || item.name}</span>
    </div>
    <a
      href={itemUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Open on RSI"
      aria-label="Open on RSI"
      class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-sky-300"
    >
      <ExternalLink class="size-3.5" />
    </a>
  </div>

  <div class="flex-1 overflow-y-auto p-3">
    <article class="mx-auto max-w-prose tab:max-w-5xl">
      <!-- Hero -->
      {#if item.thumbnailUrl}
        <div class="mb-3 aspect-[16/9] overflow-hidden rounded bg-slate-950">
          <img src={item.thumbnailUrl} alt="" class="size-full object-cover" />
        </div>
      {:else}
        <div class="mb-3 flex aspect-[16/9] items-center justify-center rounded bg-slate-950 text-slate-700">
          <Package class="size-10" />
        </div>
      {/if}

      <!-- Title + price -->
      <header class="mb-3 flex items-start gap-2">
        <div class="min-w-0 flex-1">
          <h1 class="text-lg font-semibold text-slate-100">{item.title || item.name}</h1>
          {#if item.subtitle}
            <p class="mt-0.5 text-[11px] text-slate-500">{item.subtitle}</p>
          {/if}
        </div>
        <div class="shrink-0 text-right">
          {#if hasDiscount}
            <p class="font-mono text-[11px] text-slate-500 line-through">{formatPrice(item.msrp)}</p>
            <p class="font-mono text-sm font-semibold text-emerald-300">
              {formatPrice(item.discounted ?? 0)}
            </p>
            {#if item.discountLabel}
              <span class="inline-block rounded bg-emerald-500/15 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-300 ring-1 ring-emerald-500/30">
                {item.discountLabel}
              </span>
            {/if}
          {:else}
            <p class="font-mono text-sm font-semibold text-amber-300">{formatPrice(item.msrp)}</p>
          {/if}
        </div>
      </header>

      <!-- Status badges -->
      {#if item.isWarbond || item.isPackage || item.isVip || !item.available || item.stockLevel}
        <div class="mb-3 flex flex-wrap items-center gap-1.5 text-[10px]">
          {#if !item.available}
            <span class="inline-flex items-center gap-1 rounded bg-rose-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-rose-300 ring-1 ring-rose-500/30">
              <TriangleAlert class="size-2.5" /> Sold out
            </span>
          {/if}
          {#if item.isWarbond}
            <span class="rounded bg-fuchsia-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-fuchsia-300 ring-1 ring-fuchsia-500/30">
              Warbond
            </span>
          {/if}
          {#if item.isPackage}
            <span class="rounded bg-sky-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-sky-300 ring-1 ring-sky-500/30">
              Package
            </span>
          {/if}
          {#if item.isVip}
            <span class="rounded bg-amber-500/15 px-1.5 py-0.5 font-semibold uppercase tracking-wider text-amber-300 ring-1 ring-amber-500/30">
              VIP
            </span>
          {/if}
          {#if item.stockLevel}
            <span class="rounded px-1.5 py-0.5 font-semibold uppercase tracking-wider ring-1 {stockClass(item.stockLevel)}">
              Stock: {item.stockLevel}
            </span>
          {/if}
        </div>
      {/if}

      <!-- Excerpt -->
      {#if excerptBlocks.length > 0}
        <section class="mb-4 space-y-2 text-sm leading-relaxed text-slate-300">
          {#each excerptBlocks as b, i (i)}
            {#if isBulletBlock(b)}
              <ul class="space-y-1 text-[12px]">
                {#each bulletLines(b) as line, j (j)}
                  <li class="flex items-start gap-1.5">
                    <Sparkles class="mt-0.5 size-3 shrink-0 text-sky-400" />
                    <span>{line}</span>
                  </li>
                {/each}
              </ul>
            {:else}
              <p>{b}</p>
            {/if}
          {/each}
        </section>
      {/if}

      <!-- Tags -->
      {#if item.tags.length > 0}
        <section class="mb-4">
          <p class="mb-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <TagsIcon class="size-2.5" /> Tags
          </p>
          <ul class="flex flex-wrap gap-1">
            {#each item.tags as t (t)}
              <li class="rounded-full bg-slate-900/70 px-2 py-0.5 text-[10px] text-slate-400 ring-1 ring-slate-800">
                {t}
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      <!-- CTA -->
      {#if addFlash}
        <div
          class="mt-4 flex items-start gap-2 rounded-md border p-2 text-[11px]
            {addFlash.type === 'success'
              ? 'border-emerald-900/60 bg-emerald-950/40 text-emerald-200'
              : 'border-rose-900/60 bg-rose-950/40 text-rose-200'}"
        >
          <span class="mt-0.5">{addFlash.type === 'success' ? '✓' : '✗'}</span>
          <span>{addFlash.text}</span>
        </div>
      {/if}
      <div class="mt-4 flex items-center justify-end gap-2">
        <a
          href={itemUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="inline-flex items-center gap-1.5 rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-700"
        >
          View on RSI <ExternalLink class="size-3" />
        </a>
        {#if onAddToCart}
          {@const busy = addingSkuId === item.id}
          <button
            type="button"
            onclick={() => onAddToCart(item.id, item.title || item.name)}
            disabled={!item.available || busy || addingSkuId !== null}
            title={item.available ? 'Add to cart' : 'Not available'}
            class="inline-flex items-center gap-1.5 rounded-md bg-amber-500/90 px-3 py-1.5 text-xs font-semibold text-amber-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {#if busy}
              <Loader2 class="size-3 animate-spin" /> Adding…
            {:else}
              <ShoppingCart class="size-3" /> Add to cart
            {/if}
          </button>
        {/if}
      </div>
    </article>
  </div>
</div>
