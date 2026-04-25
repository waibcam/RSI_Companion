<script lang="ts">
  // Support module — extension self-care.
  //
  // Centralizes everything that's not "use the extension" but rather
  // "talk to the maintainer about the extension":
  //   - Get help: links out to GitHub repo + Discord + ready-made bug
  //     report URL.
  //   - Share feedback: shortcuts that copy formatted snippets to the
  //     clipboard for posting on Discord (carry-over from the existing
  //     "share unknown ships" flow that lived in the Ships module).
  //   - FAQ: short answers to the questions that come up most often
  //     (ship detection, popup sizing, UI scale, privacy).
  //   - About: version, links to the privacy policy and Release Notes
  //     module, license note.
  //
  // The flows already wired into Ships (the "Unknown ships" modal,
  // the "Copy hangar dump" button) stay where they are — discoverable
  // in context. This module adds a second entry point so users who
  // come straight here looking for help find it without bouncing
  // through Ships first.

  import { sendRsiMessage } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    BookOpen,
    Bug,
    Check,
    ChevronRight,
    ClipboardCopy,
    ExternalLink,
    FileText,
    Github,
    Heart,
    HelpCircle,
    Info,
    LifeBuoy,
    MessageSquare,
    Shield,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import { appState } from '../state.svelte';

  const REPO_URL = 'https://github.com/waibcam/RSI_Companion';
  const ISSUES_URL = `${REPO_URL}/issues`;
  const DISCORD_INVITE_URL = 'https://discord.gg/ZKTVvyUkjn';
  const PRIVACY_URL = 'https://rsi-companion.kamille.ovh/Privacy_Policy.html';

  const version = chrome.runtime?.getManifest?.()?.version ?? '—';

  // Pre-fills a GitHub issue with the OS / browser context we'd
  // otherwise have to ask for. The user still writes the actual
  // report; we just save them the boilerplate.
  function buildBugReportUrl(): string {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    const body = [
      '<!-- Thanks for taking the time to file this. The fields below help us reproduce. -->',
      '',
      '### What happened?',
      '',
      '<!-- A short description. Screenshots welcome. -->',
      '',
      '### Steps to reproduce',
      '',
      '1. ',
      '2. ',
      '3. ',
      '',
      '### Expected vs actual',
      '',
      '- Expected: ',
      '- Actual: ',
      '',
      '### Environment',
      '',
      `- Extension version: \`${version}\``,
      `- Browser: \`${ua}\``,
      '',
      '### Debug bundle (optional but very helpful)',
      '',
      '<!-- Settings → Debug info → "Copy bundle" — paste below. -->',
      '',
      '```',
      '',
      '```',
    ].join('\n');
    const params = new URLSearchParams({
      title: '',
      body,
    });
    return `${ISSUES_URL}/new?${params.toString()}`;
  }

  // --- Discord share template ----------------------------------------------
  // Copies a short text the user can paste in #unknown-ships or
  // similar. Same flavour as the Ships module's
  // reportUnknownShipsToDiscord — just routed through Support too.

  let copiedFlash: 'discord' | 'dump' | null = $state(null);
  let copiedTimer: ReturnType<typeof setTimeout> | null = null;

  function flashCopied(which: 'discord' | 'dump') {
    copiedFlash = which;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedFlash = null), 4000);
  }

  $effect(() => () => {
    if (copiedTimer) clearTimeout(copiedTimer);
  });

  async function copyDiscordTemplate(): Promise<void> {
    const message = [
      `**RSI Companion feedback** (v${version})`,
      '',
      '<!-- Replace this comment with your message. Common cases:',
      '  • Unknown ships in your hangar — paste the names here.',
      '  • A hangar dump from Settings → Debug info or Ships → Copy hangar dump.',
      '  • A general bug report or feature idea.',
      '-->',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(message);
      flashCopied('discord');
    } catch {
      // Clipboard denied — open Discord anyway.
    }
    window.open(DISCORD_INVITE_URL, '_blank', 'noopener,noreferrer');
  }

  // --- Hangar dump (mirror of Ships → Copy hangar dump) -------------------
  // Re-fetches via the existing ships.list message so this works even
  // if the user has never opened the Ships module this session.

  async function copyHangarDump(): Promise<void> {
    try {
      const res = await sendRsiMessage({ type: 'ships.list' });
      const matched = res.ships
        .filter((s) => s.owned && s.count > 0)
        .map((s) => `${s.manufacturer.name} ${s.name}`)
        .sort((a, b) => a.localeCompare(b));
      const unknown = [...res.notFound].sort((a, b) => a.localeCompare(b));
      const lines: string[] = [];
      lines.push(`**RSI Companion hangar dump** (v${version})`);
      lines.push(`Generated: ${new Date().toISOString()}`);
      lines.push('');
      lines.push(
        `Summary: ${res.rawHangarNames.length} scraped · ${res.ownedCount} owned (incl. duplicates) · ${res.loanerIds.length} loaners · ${unknown.length} unknown`,
      );
      lines.push('');
      lines.push(`## Matched ships (${matched.length})`);
      if (matched.length === 0) lines.push('_(none)_');
      else for (const n of matched) lines.push(`- ${n}`);
      lines.push('');
      lines.push(`## Unknown / unmatched (${unknown.length})`);
      if (unknown.length === 0) lines.push('_(none)_');
      else for (const n of unknown) lines.push(`- ${n}`);
      await navigator.clipboard.writeText(lines.join('\n'));
      flashCopied('dump');
    } catch {
      // Clipboard denied or ships fetch failed — fail silently.
    }
  }

  // --- FAQ ---------------------------------------------------------------
  // Open by default for the first item; users can expand the rest as
  // needed. Markup uses native <details>/<summary> for keyboard
  // accessibility and zero JS state.

  type FaqItem = { id: string; q: string; a: string };
  const faq: FaqItem[] = [
    {
      id: 'missing-ship',
      q: 'Why are some of my ships missing from the Ships module?',
      a:
        'The extension reconciles your hangar (the list at robertsspaceindustries.com/account/pledges) against the public ship matrix. RSI sometimes labels pledges with names that don\'t exactly match the matrix — typically renamed SKUs ("Mercury Star Runner" vs "Mercury") or legacy referral / subscriber bundles with no product-type tag. When a hangar entry can\'t be matched, it shows up in the orange "unknown ships" badge in the Ships header. Click "Share on Discord" or "Copy hangar dump" from there and we can add an alias entry in a future patch. The catalogue auto-strips manufacturer prefixes (Crusader / Anvil / Drake / etc.) so most asymmetries are handled without manual aliases.',
    },
    {
      id: 'ui-scale',
      q: 'How do I make the UI bigger or smaller?',
      a:
        'Two complementary controls in Settings → Appearance. "Popup size" sliders set the dimensions of the toolbar popup window itself (between 360×400 and 790×590 — the platform cap). "UI scale" wraps your browser\'s native zoom (Ctrl + / Ctrl − / Ctrl-scroll) for tab mode, with persistence handled by the browser per site. The popup sliders affect popup mode only; the UI scale affects tab mode only. If both feel too small on a 4K display, open the extension in a browser tab via the icon at the top right of the header, then bump the UI scale.',
    },
    {
      id: 'popup-tiny',
      q: 'Why is the popup window so small?',
      a:
        'Browsers cap extension popups at around 800×600 — anything beyond that is silently truncated and starts surfacing scrollbars on the popup chrome itself. The Settings → Appearance → "Popup size" sliders let you pick anywhere from 360×400 (very compact) to 790×590 (the practical platform max). For an unlimited canvas, use the "Open in tab" icon at the top right of the popup header — that opens the extension in a regular browser tab where everything is responsive to your window size.',
    },
    {
      id: 'privacy',
      q: 'Does this extension collect my data?',
      a:
        'No. There is no backend, no analytics, no telemetry, and no third-party calls. Every network request goes from your browser directly to robertsspaceindustries.com and uses the session cookie you already have when signed in there. The extension caches API responses and your preferences in chrome.storage.local — that data never leaves your device. The full policy lives at rsi-companion.kamille.ovh/Privacy_Policy.html.',
    },
    {
      id: 'auth-ptu',
      q: 'My PTU sync says I\'m not signed in even though I am.',
      a:
        'PTU (Public Test Universe) runs on a separate domain — ptu.cloudimperiumgames.com — with its own session cookie. The extension reads each cookie independently, so you have to be signed in on BOTH robertsspaceindustries.com AND ptu.cloudimperiumgames.com in the same browser for the Sync to PTU workflow to work. Sign in to both, reopen the popup, then run the sync.',
    },
    {
      id: 'auto-update',
      q: 'How do I get the latest version?',
      a:
        'Browser stores auto-update extensions in the background. Chrome / Edge typically pull updates within 4-6 hours of the store approving a release; Firefox AMO is similar. To force an immediate check: in Chrome go to chrome://extensions → toggle Developer mode on → click "Update". In Firefox: about:addons → menu next to RSI Companion → Check for Updates.',
    },
  ];

  function openReleaseNotes(): void {
    appState.openReleaseNotes();
  }
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Support" />

  <div class="flex-1 overflow-y-auto p-3">
    <div class="mx-auto flex max-w-3xl flex-col gap-3 text-xs">
      <!-- =================================================== GET HELP ====== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <LifeBuoy class="size-4 text-sky-400" />
          <h2 class="text-sm font-semibold text-slate-100">Get help</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Bug reports go to GitHub for tracking. Quick questions or
          community-sourced data (unknown ship names, etc.) usually
          land best on Discord.
        </p>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-slate-200 transition hover:border-sky-600 hover:bg-slate-800"
          >
            <Github class="size-4 shrink-0 text-slate-400" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold">GitHub repository</p>
              <p class="truncate text-[10px] text-slate-500">View source &amp; star</p>
            </div>
            <ExternalLink class="size-3 shrink-0 text-slate-500" />
          </a>
          <a
            href={buildBugReportUrl()}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-slate-200 transition hover:border-sky-600 hover:bg-slate-800"
          >
            <Bug class="size-4 shrink-0 text-amber-400" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold">Report a bug</p>
              <p class="truncate text-[10px] text-slate-500">Pre-filled GitHub issue</p>
            </div>
            <ExternalLink class="size-3 shrink-0 text-slate-500" />
          </a>
          <a
            href={DISCORD_INVITE_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-slate-200 transition hover:border-indigo-500 hover:bg-slate-800"
          >
            <MessageSquare class="size-4 shrink-0 text-indigo-400" />
            <div class="min-w-0 flex-1">
              <p class="font-semibold">Join Discord</p>
              <p class="truncate text-[10px] text-slate-500">Community channel</p>
            </div>
            <ExternalLink class="size-3 shrink-0 text-slate-500" />
          </a>
        </div>
      </section>

      <!-- =================================================== SHARE ========== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <ClipboardCopy class="size-4 text-emerald-400" />
          <h2 class="text-sm font-semibold text-slate-100">Share feedback</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          One-click shortcuts that copy a formatted snippet to your
          clipboard, then open the right destination tab. Paste and
          fill in the blanks.
        </p>
        <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onclick={() => void copyDiscordTemplate()}
            class="flex items-center gap-2 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-3 py-2 text-left text-indigo-300 transition hover:bg-indigo-500/20"
          >
            {#if copiedFlash === 'discord'}
              <Check class="size-4 shrink-0 text-emerald-300" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold text-emerald-300">Copied — paste in Discord</p>
                <p class="truncate text-[10px] text-emerald-300/70">
                  Discord opened in a new tab
                </p>
              </div>
            {:else}
              <MessageSquare class="size-4 shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold">Discord template</p>
                <p class="truncate text-[10px] text-indigo-300/70">
                  Copy + open the invite link
                </p>
              </div>
            {/if}
          </button>
          <button
            type="button"
            onclick={() => void copyHangarDump()}
            class="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-800/40 px-3 py-2 text-left text-slate-200 transition hover:border-sky-600 hover:bg-slate-800"
          >
            {#if copiedFlash === 'dump'}
              <Check class="size-4 shrink-0 text-emerald-300" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold text-emerald-300">Hangar dump copied</p>
                <p class="truncate text-[10px] text-emerald-300/70">
                  Paste in your bug report or Discord
                </p>
              </div>
            {:else}
              <ClipboardCopy class="size-4 shrink-0 text-slate-400" />
              <div class="min-w-0 flex-1">
                <p class="font-semibold">Copy hangar dump</p>
                <p class="truncate text-[10px] text-slate-500">
                  Markdown snapshot of your owned + unknown ships
                </p>
              </div>
            {/if}
          </button>
        </div>
      </section>

      <!-- =================================================== FAQ =========== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <HelpCircle class="size-4 text-amber-400" />
          <h2 class="text-sm font-semibold text-slate-100">FAQ</h2>
        </header>
        <ul class="divide-y divide-slate-800 rounded-md border border-slate-800 bg-slate-950/40">
          {#each faq as item, i (item.id)}
            <li>
              <details class="group">
                <summary
                  class="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[12px] text-slate-200 hover:bg-slate-900/60"
                >
                  <ChevronRight
                    class="size-3.5 shrink-0 text-slate-500 transition group-open:rotate-90"
                  />
                  <span class="flex-1">{item.q}</span>
                </summary>
                <div class="px-8 pb-3 text-[11px] leading-relaxed text-slate-400">
                  {item.a}
                </div>
              </details>
            </li>
          {/each}
        </ul>
      </section>

      <!-- =================================================== ABOUT ========== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <Info class="size-4 text-slate-400" />
          <h2 class="text-sm font-semibold text-slate-100">About</h2>
        </header>
        <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          <dt class="text-slate-500">Version</dt>
          <dd class="font-mono text-slate-200">{version}</dd>

          <dt class="text-slate-500">Release notes</dt>
          <dd>
            <button
              type="button"
              onclick={openReleaseNotes}
              class="inline-flex items-center gap-1 text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
            >
              <FileText class="size-3" />
              View what's new
            </button>
          </dd>

          <dt class="text-slate-500">Privacy</dt>
          <dd>
            <a
              href={PRIVACY_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
            >
              <Shield class="size-3" />
              Privacy policy
              <ExternalLink class="size-2.5" />
            </a>
          </dd>

          <dt class="text-slate-500">License</dt>
          <dd class="text-slate-400">
            GPL-3.0-only — extension is free, source is open at
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
              >github.com/waibcam/RSI_Companion<ExternalLink class="ml-0.5 inline size-2.5" /></a
            >
          </dd>

          <dt class="text-slate-500">Made by</dt>
          <dd class="flex items-center gap-1 text-slate-400">
            Kamille for the SC community
            <Heart class="size-3 fill-rose-500/40 text-rose-400" />
          </dd>
        </dl>
      </section>
    </div>
  </div>
</section>
