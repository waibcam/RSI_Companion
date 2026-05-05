<script lang="ts">
  import { RELEASE_NOTES, Schemas } from '@rsi-companion/shared';
  import { Sparkles, Info } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { formatDate } from '../format';
  import { notifyState } from '../notify.svelte';
  import { appState, MODULES, type ModuleId } from '../state.svelte';

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

  // ---- Inline-link parsing -------------------------------------------------
  //
  // Release-note entries can embed deep links to in-app destinations
  // using a markdown-flavoured syntax:
  //
  //     [Display text](module:moduleId)
  //     [Display text](module:moduleId/tabName)
  //     [Display text](module:moduleId/tabName#sectionId)
  //     [Display text](module:moduleId#sectionId)
  //
  // - moduleId must match one of the sidebar entries (settings,
  //   hangar, contacts, …)
  // - tabName, when present, is the sub-tab id the target module
  //   uses internally — Settings tabs are appearance / performance /
  //   diagnostics; Hangar tabs are pledges / ships / export; etc.
  // - sectionId, when present, is a DOM element id inside the
  //   target module that the module will scroll into view after
  //   switching the tab. Lets us link straight to e.g. the new
  //   Toolbar-badge card without making the user scroll.
  //
  // Plain text (no links) is rendered as-is. Unknown moduleIds yield
  // a non-functional span (still legible, just not clickable) — we
  // don't want a typo in the JSON to throw a runtime error and break
  // the whole panel.
  type Segment =
    | { kind: 'text'; value: string }
    | {
        kind: 'link';
        text: string;
        moduleId: ModuleId;
        tab: string | null;
        anchor: string | null;
      };

  const VALID_MODULE_IDS = new Set<string>(MODULES.map((m) => m.id));
  // Markdown-style link with the `module:` scheme. The target capture
  // group accepts everything up to the closing paren so module ids
  // and tab names with hyphens (comm-link, patch-notes) work.
  const LINK_RE = /\[([^\]]+)\]\(module:([^)]+)\)/g;

  function parseSegments(text: string): Segment[] {
    const out: Segment[] = [];
    let last = 0;
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(text)) !== null) {
      if (m.index > last) {
        out.push({ kind: 'text', value: text.slice(last, m.index) });
      }
      const linkText = m[1] ?? '';
      const target = (m[2] ?? '').trim();
      // Split off the anchor first (#section), then the tab (/tab).
      // Order matters — a target like `settings/appearance#toolbar-badge`
      // splits as anchor='toolbar-badge', remainder='settings/appearance',
      // then moduleId='settings', tab='appearance'.
      const hashIdx = target.indexOf('#');
      const anchor = hashIdx >= 0 ? target.slice(hashIdx + 1) : null;
      const remainder = hashIdx >= 0 ? target.slice(0, hashIdx) : target;
      const [rawModule, ...tabParts] = remainder.split('/');
      const moduleId = rawModule ?? '';
      const tab = tabParts.length > 0 ? tabParts.join('/') : null;
      if (VALID_MODULE_IDS.has(moduleId)) {
        out.push({
          kind: 'link',
          text: linkText,
          moduleId: moduleId as ModuleId,
          tab,
          anchor,
        });
      } else {
        // Unknown module id — drop the link wrapper, render the
        // display text as plain so the note still reads correctly.
        out.push({ kind: 'text', value: linkText });
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) {
      out.push({ kind: 'text', value: text.slice(last) });
    }
    return out;
  }

  function jump(seg: Extract<Segment, { kind: 'link' }>): void {
    appState.navigateTo(
      seg.moduleId,
      seg.tab ?? undefined,
      seg.anchor ?? undefined,
    );
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
                  {#each details.features as item, i (i)}
                    <li>
                      {#each parseSegments(item) as seg, j (j)}
                        {#if seg.kind === 'text'}{seg.value}{:else}<button
                            type="button"
                            onclick={() => jump(seg)}
                            class="rounded px-0.5 font-medium text-sky-300 underline decoration-sky-700 underline-offset-2 transition hover:bg-sky-500/15 hover:decoration-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-500"
                            title="Open {seg.text} in the extension"
                          >{seg.text}</button
                          >{/if}
                      {/each}
                    </li>
                  {/each}
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
                  {#each details.info as item, i (i)}
                    <li>
                      {#each parseSegments(item) as seg, j (j)}
                        {#if seg.kind === 'text'}{seg.value}{:else}<button
                            type="button"
                            onclick={() => jump(seg)}
                            class="rounded px-0.5 font-medium text-sky-300 underline decoration-sky-700 underline-offset-2 transition hover:bg-sky-500/15 hover:decoration-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-500"
                            title="Open {seg.text} in the extension"
                          >{seg.text}</button
                          >{/if}
                      {/each}
                    </li>
                  {/each}
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
