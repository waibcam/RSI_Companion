<script lang="ts">
  import { ExternalLink, Info } from 'lucide-svelte';
  import { statusState } from '../status.svelte';

  // Drop-in hint that surfaces the RSI Status feed's current incident
  // summary whenever it's user-visible (disrupted / down / maintenance).
  // Renders nothing when RSI is operational or only carrying a `notice`.
  //
  // Intended to be placed next to a module's error state so users see
  //   "Hangar fetch failed" followed by
  //   "RSI is currently reporting disruption · Platform Services Disruption"
  // instead of an HTTP error with no context.

  statusState.ensureLoaded();

  const incidents = $derived(
    statusState.hasIncident ? statusState.summary?.unresolvedIssues ?? [] : [],
  );
  const statusLevelLabel = $derived.by(() => {
    const lvl = statusState.summary?.level;
    if (lvl === 'down') return 'outage';
    if (lvl === 'disrupted') return 'disruption';
    if (lvl === 'maintenance') return 'maintenance';
    return null;
  });
</script>

{#if statusLevelLabel}
  <div
    class="flex items-start gap-2 rounded border border-amber-900/60 bg-amber-950/40 p-2 text-[11px] text-amber-200"
    role="note"
  >
    <Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-semibold">
        RSI is currently reporting {statusLevelLabel}
      </p>
      {#if incidents.length > 0}
        <ul class="mt-1 space-y-0.5 text-amber-300/90">
          {#each incidents.slice(0, 3) as incident (incident.url)}
            <li class="truncate">
              <a
                href={incident.url}
                target="_blank"
                rel="noopener noreferrer"
                class="underline decoration-dotted underline-offset-2 hover:text-amber-100"
              >
                {incident.title}
              </a>
            </li>
          {/each}
        </ul>
      {/if}
      <a
        href="https://status.robertsspaceindustries.com/"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-1 inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-amber-300 hover:text-amber-100"
      >
        RSI Status
        <ExternalLink class="size-3" />
      </a>
    </div>
  </div>
{/if}
