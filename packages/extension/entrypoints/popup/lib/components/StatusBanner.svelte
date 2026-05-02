<script lang="ts">
  import { AlertTriangle, ExternalLink } from 'lucide-svelte';
  import { notifyState } from '../notify.svelte';

  // Surfaces the BG poll's skippedReason — set by the status-feed circuit
  // breaker when RSI's published platform health says they're down or in
  // maintenance. Without this banner the user just saw stale data with no
  // indication anything was wrong, which trained them to suspect the
  // extension every time RSI itself misbehaved.
  //
  // Reads notifyState (the same store that drives the toolbar badge) so
  // the banner tracks the BG state live: appears the moment the poll
  // detects the outage, disappears the moment the next successful poll
  // clears `skippedReason`. No additional fetch.
  //
  // Hidden when no reason is set (the common case). The whole component
  // rendering boils down to a single conditional <div>.

  const RSI_STATUS_URL = 'https://status.robertsspaceindustries.com/';
</script>

{#if notifyState.state.skippedReason}
  <div
    class="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-[11px] text-amber-200"
    role="status"
  >
    <AlertTriangle class="size-3.5 shrink-0 text-amber-400" />
    <span class="flex-1 leading-tight">
      <span class="font-semibold">{notifyState.state.skippedReason}</span>
      <span class="text-amber-300/70"> — polling paused. Modules may show stale data.</span>
    </span>
    <a
      href={RSI_STATUS_URL}
      target="_blank"
      rel="noopener noreferrer"
      class="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-amber-200 transition hover:bg-amber-500/20 hover:text-amber-100"
      title="Open RSI status page"
    >
      Status <ExternalLink class="size-3" />
    </a>
  </div>
{/if}
