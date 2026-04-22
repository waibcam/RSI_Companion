<script lang="ts">
  import {
    Archive,
    ExternalLink,
    FileText,
    HandCoins,
    Rocket,
    Users,
  } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import {
    log,
    sendRsiMessage,
    type StatsSummaryResponse,
    type Rsi,
  } from '@rsi-companion/shared';
  import { appState, isTabMode } from '../state.svelte';
  import { notifyState } from '../notify.svelte';
  import { statusState } from '../status.svelte';
  import { formatAbbrev, formatUsdCompact } from '../format';

  // Kick off the status fetch so the pill renders with real data instead
  // of the "operational" default. Background caches for 90 s so extra
  // popup opens share the same HTTP call.
  statusState.ensureLoaded();

  // Cosmetic mapping for the status pill. `notice` borrows the disrupted
  // amber so users still spot CIG's scheduled-window messages, but the
  // tooltip text keeps it framed as informational.
  const statusMeta: Record<Rsi.RsiStatusLevel, { dot: string; label: string; pill: string }> = {
    operational: {
      dot: 'bg-emerald-500',
      label: 'Operational',
      pill: 'border-emerald-800/60 text-emerald-200/90 hover:bg-emerald-950/30',
    },
    notice: {
      dot: 'bg-sky-400',
      label: 'Notice',
      pill: 'border-sky-800/60 text-sky-200 hover:bg-sky-950/30',
    },
    maintenance: {
      dot: 'bg-amber-400',
      label: 'Maintenance',
      pill: 'border-amber-700/60 text-amber-200 hover:bg-amber-950/40',
    },
    disrupted: {
      dot: 'bg-orange-500',
      label: 'Disrupted',
      pill: 'border-orange-700/60 text-orange-200 hover:bg-orange-950/40',
    },
    down: {
      dot: 'bg-rose-500',
      label: 'Down',
      pill: 'border-rose-700/60 text-rose-200 hover:bg-rose-950/40',
    },
  };

  const statusLevel = $derived<Rsi.RsiStatusLevel>(statusState.summary?.level ?? 'operational');
  const statusPill = $derived(statusMeta[statusLevel]);
  const statusTitle = $derived.by(() => {
    const s = statusState.summary;
    if (!s) return 'RSI status — checking…';
    if (s.unresolvedIssues.length > 0) {
      const titles = s.unresolvedIssues.map((i) => i.title).join('\n');
      return `RSI status: ${statusPill.label}\n\n${titles}`;
    }
    return `RSI status: ${statusPill.label}`;
  });

  let stats = $state<StatsSummaryResponse | null>(null);

  function openInTab() {
    const url = chrome.runtime?.getURL?.('popup.html?mode=tab');
    if (!url) return;
    chrome.tabs?.create?.({ url });
  }

  function openReleaseNotes() {
    appState.openReleaseNotes();
  }

  const releaseUnread = $derived(notifyState.state.counts['release-notes'] ?? 0);

  async function load() {
    try {
      stats = await sendRsiMessage({ type: 'stats.summary' });
    } catch (e) {
      // Non-fatal: the crowdfund / citizen-count strip just stays empty.
      log.warn('header', 'stats summary failed', e);
    }
  }

  onMount(load);
</script>

<header
  class="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-4 py-2"
>
  <div class="flex items-center gap-2">
    <Rocket class="size-5 text-sky-400" />
    <h1 class="text-sm font-semibold tracking-wide text-slate-100">RSI Companion</h1>
    <span class="text-[10px] font-medium uppercase tracking-wider text-slate-500">v3</span>

    <a
      href="https://status.robertsspaceindustries.com/"
      target="_blank"
      rel="noopener noreferrer"
      class="group ml-1 flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] transition {statusPill.pill}"
      title={statusTitle}
    >
      <span class="relative flex size-1.5">
        <span
          class="absolute inline-flex size-full rounded-full opacity-75 {statusPill.dot} {statusLevel !== 'operational' ? 'animate-ping' : ''}"
        ></span>
        <span class="relative inline-flex size-1.5 rounded-full {statusPill.dot}"></span>
      </span>
      <span class="font-medium">{statusPill.label}</span>
    </a>
  </div>

  {#if stats}
    <div class="flex flex-1 items-center justify-center gap-4 text-[11px] text-slate-400">
      {#if stats.crowdfund.fans > 0}
        <a
          href="https://robertsspaceindustries.com/funding-goals"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 transition hover:text-slate-200"
          title="Star Citizens (backers)"
        >
          <Users class="size-3.5 text-sky-400" />
          <span class="font-mono">{formatAbbrev(stats.crowdfund.fans)}</span>
        </a>
      {/if}
      {#if stats.crowdfund.funds > 0}
        <a
          href="https://robertsspaceindustries.com/funding-goals"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 transition hover:text-slate-200"
          title="Funds raised"
        >
          <HandCoins class="size-3.5 text-emerald-400" />
          <span class="font-mono">{formatUsdCompact(stats.crowdfund.funds)}</span>
        </a>
      {/if}
      {#if stats.signedIn && stats.buyBackTokens !== null && stats.buyBackTokens > 0}
        <a
          href="https://robertsspaceindustries.com/account/buy-back-pledges"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 transition hover:text-slate-200"
          title="Available buy-back tokens"
        >
          <Archive class="size-3.5 text-amber-400" />
          <span class="font-mono">{stats.buyBackTokens}</span>
          <span class="text-slate-500">tok</span>
        </a>
      {/if}
      {#if stats.signedIn && stats.referral && (stats.referral.recruits > 0 || stats.referral.prospects > 0)}
        {@const ref = stats.referral}
        <a
          href="https://robertsspaceindustries.com/referral-program"
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-1 transition hover:text-slate-200"
          title={`${ref.recruits} recruit${ref.recruits === 1 ? '' : 's'} · ${ref.prospects} prospect${ref.prospects === 1 ? '' : 's'}${ref.nextRank ? ` · next: ${ref.nextRank} at ${ref.progressTarget}` : ''}`}
        >
          <Users class="size-3.5 text-violet-400" />
          {#if ref.recruits > 0}
            <span class="font-mono">{ref.recruits}</span>
            <span class="text-slate-500">
              recruits{ref.prospects > 0 ? ` +${ref.prospects}p` : ''}
            </span>
          {:else}
            <!-- No confirmed recruits yet — surface the prospects count so
                 the user still sees their referral activity (they signed up
                 but haven't bought a game package yet). -->
            <span class="font-mono text-slate-400">{ref.prospects}</span>
            <span class="text-slate-500">prospects</span>
          {/if}
        </a>
      {/if}
    </div>
  {/if}

  <div class="flex items-center gap-1">
    <!-- Cache clear lives in the Settings module now (dedicated panel
         with per-namespace stats + bulk clear). The header button was
         removed to declutter. -->
    <button
      type="button"
      class="relative flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
      title="Release notes (extension changelog)"
      onclick={openReleaseNotes}
    >
      <FileText class="size-3.5" />
      <span>Notes</span>
      {#if releaseUnread > 0}
        <span
          class="absolute -right-1 -top-1 min-w-[1.125rem] rounded-full bg-emerald-500/90 px-1 py-0.5 text-center text-[9px] font-semibold text-slate-950 ring-2 ring-slate-950"
          title="{releaseUnread} new"
        >
          {releaseUnread > 99 ? '99+' : releaseUnread}
        </span>
      {/if}
    </button>

    {#if !isTabMode}
      <button
        type="button"
        class="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
        title="Open in tab"
        onclick={openInTab}
      >
        <ExternalLink class="size-3.5" />
        <span>Tab</span>
      </button>
    {/if}
  </div>
</header>
