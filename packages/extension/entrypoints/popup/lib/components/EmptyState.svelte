<script lang="ts">
  import type { Component } from 'svelte';

  // Centered empty-state with optional icon + title + subtext. Used when a
  // module loads successfully but has nothing to show (no patches for the
  // current filter, no DMs, no notifications, etc). Keeps the visual
  // language identical across modules without copy-pasting the same div.
  interface Props {
    icon?: Component;
    title: string;
    subtitle?: string;
    /** When true the empty-state fills the module area; otherwise it just
     *  sits where it's placed (inline). Default: inline. */
    fullHeight?: boolean;
  }
  let { icon: Icon, title, subtitle, fullHeight = false }: Props = $props();
</script>

<div
  class="flex flex-col items-center justify-center gap-2 text-slate-500
    {fullHeight ? 'h-full' : 'mt-6'}"
>
  {#if Icon}
    <Icon class="size-8" aria-hidden="true" />
  {/if}
  <p class="text-xs italic">{title}</p>
  {#if subtitle}
    <p class="max-w-xs text-center text-[10px] text-slate-600">{subtitle}</p>
  {/if}
</div>
