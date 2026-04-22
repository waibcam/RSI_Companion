<script lang="ts">
  import { Database, RefreshCw } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    loading?: boolean;
    fromCache?: boolean;
    onRefresh?: () => void;
    refreshLabel?: string;
    meta?: Snippet;
    controls?: Snippet;
    /** Determinate progress (0..1) while loading a multi-step fetch.
     *  Falsy = indeterminate bar. The bar only renders while `loading`. */
    progress?: number | null;
  }

  let {
    title,
    loading = false,
    fromCache = false,
    onRefresh,
    refreshLabel,
    meta,
    controls,
    progress = null,
  }: Props = $props();

  // Clamp to [0, 1] so stray NaN / >1 values can't blow out the bar width.
  const progressPct = $derived(
    typeof progress === 'number' && Number.isFinite(progress)
      ? Math.min(100, Math.max(0, progress * 100))
      : null,
  );
</script>

<div class="relative border-b border-slate-800 bg-slate-950/40">
<div
  class="flex items-center justify-between gap-3 px-4 py-2"
>
  <div class="flex items-baseline gap-2">
    <h2 class="text-sm font-semibold text-slate-200">{title}</h2>
    {#if meta}
      {@render meta()}
    {/if}
    {#if fromCache}
      <span class="flex items-center gap-1 text-[10px] uppercase tracking-wider text-slate-500">
        <Database class="size-3" />
        cached
      </span>
    {/if}
  </div>

  {#if controls}
    {@render controls()}
  {/if}

  {#if onRefresh}
    <button
      type="button"
      class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:opacity-50"
      disabled={loading}
      onclick={onRefresh}
      title="Refresh"
    >
      <RefreshCw class="size-3.5 {loading ? 'animate-spin' : ''}" />
      {#if refreshLabel}
        <span>{refreshLabel}</span>
      {/if}
    </button>
  {/if}
</div>

<!-- Progress bar: sits flush with the bottom border so the header itself
     doesn't change height. Indeterminate mode animates a sliding sliver;
     determinate mode grows a fixed-width bar. -->
{#if loading}
  <div class="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-slate-800/60">
    {#if progressPct !== null}
      <div
        class="h-full bg-sky-400 transition-[width] duration-200"
        style:width="{progressPct}%"
      ></div>
    {:else}
      <div class="h-full w-1/3 animate-[loadbar_1.2s_ease-in-out_infinite] bg-sky-400"></div>
    {/if}
  </div>
{/if}
</div>
