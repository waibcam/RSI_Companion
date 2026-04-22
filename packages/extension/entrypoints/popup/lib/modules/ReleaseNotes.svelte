<script lang="ts">
  import { RELEASE_NOTES, Schemas } from '@rsi-companion/shared';
  import { Sparkles, Info } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { formatDate } from '../format';
  import { notifyState } from '../notify.svelte';

  // Release notes ship bundled with the extension (see the shared
  // package's data/release-notes.json). No backend fetch — trade-off:
  // older installs don't see newer entries until they update. Fine for
  // a changelog.

  type Row = Schemas.Backend.ReleaseNoteRow;
  type Details = Schemas.Backend.ReleaseNoteDetails;

  const rows: Row[] = RELEASE_NOTES as Row[];

  function parseDetails(raw: string): Details {
    try {
      return Schemas.Backend.ReleaseNoteDetails.parse(JSON.parse(raw));
    } catch {
      return { info: [], features: [] };
    }
  }

  notifyState.markSeen('release-notes');
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Release Notes" />

  <div class="flex-1 overflow-y-auto">
    {#if rows.length === 0}
      <p class="p-6 text-center text-xs text-slate-500">No release notes yet.</p>
    {:else}
      <ol class="divide-y divide-slate-800">
        {#each rows as row (row.version)}
          {@const details = parseDetails(row.notes)}
          <li class="px-4 py-3">
            <header class="mb-2 flex items-baseline justify-between gap-2">
              <span class="text-sm font-semibold text-sky-300">v{row.version}</span>
              <time class="text-[10px] uppercase tracking-wider text-slate-500"
                >{formatDate(row.released_at)}</time
              >
            </header>

            {#if details.features.length > 0}
              <div class="mb-2">
                <div class="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                  <Sparkles class="size-3" />
                  Features
                </div>
                <ul class="ml-1 list-disc space-y-0.5 pl-4 text-xs text-slate-300">
                  {#each details.features as item, i (i)}<li>{item}</li>{/each}
                </ul>
              </div>
            {/if}

            {#if details.info.length > 0}
              <div>
                <div class="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  <Info class="size-3" />
                  Info
                </div>
                <ul class="ml-1 list-disc space-y-0.5 pl-4 text-xs text-slate-400">
                  {#each details.info as item, i (i)}<li>{item}</li>{/each}
                </ul>
              </div>
            {/if}

            {#if details.features.length === 0 && details.info.length === 0}
              <p class="text-xs italic text-slate-500">No details.</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
</section>
