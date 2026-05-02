<script lang="ts">
  // Settings module — user-controllable prefs + diagnostics.
  //
  // Six sections, each a card:
  //   1. Cache       — per-namespace stats, clear-all / clear-one buttons
  //   2. Sessions    — signed-in status + CSRF / CCU / Rsi-Token presence
  //   3. Prefetch    — enable/disable the boot-time prefetch + last-run stats
  //   4. Modules     — show/hide + reorder the sidebar entries
  //   5. Debug       — version, permissions, recent log buffer
  //   6. Reset       — wipe all Settings prefs back to defaults
  //
  // Everything is read on mount and refreshes via explicit buttons. No
  // automatic polling — the Settings module is rarely open and users open
  // it specifically to inspect a snapshot.

  import { log, sendRsiMessage } from '@rsi-companion/shared';
  import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    ClipboardCopy,
    Database,
    Eye,
    EyeOff,
    Info,
    Loader2,
    Maximize2,
    Minus,
    Plus,
    RefreshCw,
    RotateCcw,
    Settings as SettingsIcon,
    ShieldCheck,
    Trash2,
    ZoomIn,
  } from 'lucide-svelte';
  import ModuleHeader from '../components/ModuleHeader.svelte';
  import {
    appState,
    isSettingsTabId,
    isTabMode,
    MODULES,
    POPUP_SIZE_LIMITS,
    settingsState,
    type ModuleId,
    type SettingsTabId,
  } from '../state.svelte';
  import { errorMessage } from '../error';
  import { persistedState } from '../persist.svelte';

  // Three top-level tabs: Appearance / Performance / Diagnostics. The
  // module had grown to nine sections plus the Support card; tabs cut
  // the cognitive load by 2-3× and let users find what they need
  // (cache wipe, popup sizing, debug bundle) without scrolling past
  // unrelated cards. The Support section moved out of Settings
  // entirely into its own sidebar module — see Support.svelte.
  const tabP = persistedState<SettingsTabId>(
    'settings:activeTab',
    'appearance',
    isSettingsTabId,
  );
  const tab = $derived(tabP.value);

  // --- Cache section ---------------------------------------------------------

  type CacheStats = {
    total: { entries: number; sizeBytes: number };
    namespaces: Array<{ prefix: string; entries: number; sizeBytes: number }>;
  };
  let cacheStats = $state<CacheStats | null>(null);
  let cacheError = $state<string | null>(null);
  let cacheLoading = $state(false);
  let clearingPrefix = $state<string | null>(null);

  async function loadCacheStats() {
    cacheLoading = true;
    cacheError = null;
    try {
      cacheStats = await sendRsiMessage({ type: 'cache.stats' });
    } catch (e) {
      cacheError = errorMessage(e);
    } finally {
      cacheLoading = false;
    }
  }

  async function clearCache(prefix?: string) {
    if (clearingPrefix !== null) return;
    clearingPrefix = prefix ?? '__all__';
    try {
      await sendRsiMessage(
        prefix ? { type: 'cache.clear', prefix } : { type: 'cache.clear' },
      );
      await loadCacheStats();
    } catch (e) {
      cacheError = errorMessage(e);
    } finally {
      clearingPrefix = null;
    }
  }

  // Hard refresh — wipe every cache: entry, reset polling backoff state,
  // trigger an immediate poll, then reload the popup so every Svelte
  // module re-mounts against the empty cache. Heavier than a per-module
  // refresh button but useful when something feels broadly stale (e.g.
  // RSI just came back from an outage and the per-module TTLs haven't
  // expired yet, or a degraded module is stuck in backoff and the user
  // wants to retry it now).
  let refreshingAll = $state(false);
  async function refreshAllModules() {
    if (refreshingAll) return;
    refreshingAll = true;
    cacheError = null;
    try {
      await sendRsiMessage({ type: 'settings.refreshAll' });
      // Reload triggers a fresh popup mount → every module re-fetches
      // (cache miss) and renders against the BG's just-poll-seeded cache.
      window.location.reload();
    } catch (e) {
      cacheError = errorMessage(e);
      refreshingAll = false;
    }
  }

  function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // --- Sessions section ------------------------------------------------------

  type SessionStatus = {
    signedIn: boolean;
    handle: string | null;
    rsiTokenPresent: boolean;
    csrfTokenPresent: boolean;
    ccuSessionPrimed: boolean;
  };
  let sessionStatus = $state<SessionStatus | null>(null);
  let sessionError = $state<string | null>(null);
  let sessionLoading = $state(false);

  async function loadSessionStatus() {
    sessionLoading = true;
    sessionError = null;
    try {
      sessionStatus = await sendRsiMessage({ type: 'settings.sessionStatus' });
    } catch (e) {
      sessionError = errorMessage(e);
    } finally {
      sessionLoading = false;
    }
  }

  async function forceIdentityRefresh() {
    sessionLoading = true;
    try {
      await sendRsiMessage({ type: 'auth.identity', force: true });
      await loadSessionStatus();
    } catch (e) {
      sessionError = errorMessage(e);
    } finally {
      sessionLoading = false;
    }
  }

  // On-demand "Prime CCU now" — runs the full CSRF + upgrade-session
  // bootstrap without having to click the Upgrades tab. Gives the user
  // a way to self-diagnose "CCU won't load" before even visiting the
  // Pledge Store module. The flash message auto-clears after 4s.
  let primingCcu = $state(false);
  let primeCcuMessage = $state<{ kind: 'ok' | 'error'; text: string } | null>(null);
  let primeCcuMessageTimer: ReturnType<typeof setTimeout> | null = null;
  async function primeCcu() {
    if (primingCcu) return;
    primingCcu = true;
    primeCcuMessage = null;
    try {
      const res = await sendRsiMessage({ type: 'settings.primeCcu' });
      if (res.ok) {
        primeCcuMessage = { kind: 'ok', text: 'CSRF + upgrade session primed successfully.' };
      } else {
        primeCcuMessage = { kind: 'error', text: res.error ?? 'Unknown failure.' };
      }
      await loadSessionStatus();
    } catch (e) {
      primeCcuMessage = { kind: 'error', text: errorMessage(e) };
    } finally {
      primingCcu = false;
      if (primeCcuMessageTimer) clearTimeout(primeCcuMessageTimer);
      primeCcuMessageTimer = setTimeout(() => (primeCcuMessage = null), 4000);
    }
  }
  $effect(() => () => {
    if (primeCcuMessageTimer) clearTimeout(primeCcuMessageTimer);
  });

  // --- Prefetch section ------------------------------------------------------

  type PrefetchStats = {
    lastRunAt: number | null;
    durationMs: number | null;
    requestCount: number | null;
    rejectedCount: number | null;
  };
  let prefetchStats = $state<PrefetchStats | null>(null);

  async function loadPrefetchStats() {
    try {
      prefetchStats = await sendRsiMessage({ type: 'settings.prefetchStats' });
    } catch {
      prefetchStats = null;
    }
  }

  // --- Modules section -------------------------------------------------------
  // Local editable copy of the module order — committed to settingsState on
  // every move so the sidebar updates live.

  const moduleList = $derived.by(() => {
    const order = settingsState.moduleOrder;
    const byId = new Map(MODULES.map((m) => [m.id, m]));
    const seen = new Set<ModuleId>();
    const ordered: ModuleId[] = [];
    for (const id of order) {
      if (byId.has(id) && !seen.has(id) && id !== 'settings') {
        ordered.push(id);
        seen.add(id);
      }
    }
    // Append any new / never-ordered modules (except 'settings' which is
    // hardcoded at the end of the sidebar and isn't exposed here).
    for (const m of MODULES) {
      if (m.id === 'settings') continue;
      if (!seen.has(m.id)) ordered.push(m.id);
    }
    return ordered;
  });

  const hiddenSet = $derived(new Set(settingsState.moduleHidden));

  function moveModule(id: ModuleId, dir: -1 | 1) {
    const next = moduleList.slice();
    const i = next.indexOf(id);
    if (i === -1) return;
    const j = i + dir;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    settingsState.setModuleOrder(next);
  }

  function toggleHidden(id: ModuleId) {
    // Never let the user accidentally hide the Settings module (they'd
    // have no way back). The UI already filters it out of this list,
    // but be defensive.
    if (id === 'settings') return;
    settingsState.toggleModuleHidden(id);
  }

  // --- Debug section ---------------------------------------------------------

  type LogEntry = {
    time: number;
    level: 'debug' | 'info' | 'warn' | 'error';
    scope: string;
    message: string;
  };
  let logs = $state<LogEntry[] | null>(null);
  let permissions = $state<{ permissions: string[]; origins: string[] } | null>(null);
  const version = chrome.runtime.getManifest?.()?.version ?? '—';
  const userAgent = navigator.userAgent;

  async function loadDebug() {
    try {
      const [logsRes, permsRes] = await Promise.all([
        sendRsiMessage({ type: 'settings.logs' }),
        sendRsiMessage({ type: 'settings.permissions' }),
      ]);
      logs = logsRes.entries;
      permissions = permsRes;
    } catch (e) {
      logs = [{ time: Date.now(), level: 'error', scope: 'settings', message: errorMessage(e) }];
    }
  }

  async function copyDebugBundle() {
    const lines: string[] = [];
    lines.push(`RSI Companion v${version}`);
    lines.push(`UA: ${userAgent}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('');
    if (sessionStatus) {
      lines.push('## Session');
      lines.push(`signed-in: ${sessionStatus.signedIn}`);
      lines.push(`handle: ${sessionStatus.handle ?? '—'}`);
      lines.push(`rsi-token: ${sessionStatus.rsiTokenPresent}`);
      lines.push(`csrf-token: ${sessionStatus.csrfTokenPresent}`);
      lines.push(`ccu-session: ${sessionStatus.ccuSessionPrimed}`);
      lines.push('');
    }
    if (permissions) {
      lines.push('## Permissions');
      lines.push(`permissions: ${permissions.permissions.join(', ') || '—'}`);
      lines.push(`origins: ${permissions.origins.join(', ') || '—'}`);
      lines.push('');
    }
    if (cacheStats) {
      lines.push('## Cache');
      lines.push(`total: ${cacheStats.total.entries} entries, ${formatBytes(cacheStats.total.sizeBytes)}`);
      for (const ns of cacheStats.namespaces) {
        lines.push(`  ${ns.prefix}: ${ns.entries} entries, ${formatBytes(ns.sizeBytes)}`);
      }
      lines.push('');
    }
    if (logs) {
      lines.push('## Recent logs');
      for (const e of logs) {
        lines.push(
          `${new Date(e.time).toISOString()} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}`,
        );
      }
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      copiedFlash = true;
      setTimeout(() => (copiedFlash = false), 2000);
    } catch {
      copiedFlash = false;
    }
  }

  let copiedFlash = $state(false);

  // --- Popup size draft state ------------------------------------------------
  // The actual popup dimensions live in settingsState. Sliders below
  // bind to these "draft" values so the displayed % label updates
  // smoothly during a drag, while the popup window itself is only
  // resized on slider release (`onchange`). Without this split,
  // resizing the popup live during a drag yanked the slider thumb out
  // from under the user's cursor as the Settings panel reflowed —
  // dragging shorter became impossible. Reported by Kamille while
  // testing 7a9d180.
  let widthDraft = $state(settingsState.popupWidth);
  let heightDraft = $state(settingsState.popupHeight);
  // Re-sync the drafts whenever the persisted values change from
  // outside the sliders (e.g. the Reset button or a stored value
  // being clamped at startup). Reading the getter inside the effect
  // sets up the dependency so this fires automatically.
  $effect(() => {
    widthDraft = settingsState.popupWidth;
  });
  $effect(() => {
    heightDraft = settingsState.popupHeight;
  });

  // --- UI scale section (tab mode only) --------------------------------------
  //
  // Wraps the browser's native per-tab zoom (Ctrl + / Ctrl − /
  // Ctrl-scroll) behind a small Settings UI affordance — same effect,
  // just discoverable. The browser handles per-site persistence on
  // its own, so we don't need our own storage. Only meaningful in
  // tab mode (`?mode=tab`) — toolbar popups don't have a tab id and
  // browsers don't respond to zoom shortcuts on extension popups.
  //
  // Reported on GH #29 by @epoptic. The popup-size sliders (above)
  // already cover popup mode; this complements them for tab mode on
  // high-DPI / 4K displays where the default density feels cramped.

  const ZOOM_STEP = 0.1;
  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 5;

  let currentZoom = $state(1);

  // chrome.tabs.* used to need a per-call wrapper here on Firefox MV2
  // (chrome.tabs.getCurrent/getZoom/setZoom returned undefined
  // synchronously instead of a Promise). The popup boot now installs
  // a global polyfill (entrypoints/popup/lib/polyfill.ts) that
  // shadows globalThis.chrome with globalThis.browser when the latter
  // is present, so chrome.* transparently routes through the
  // Promise-native namespace. The local wrapper that lived here in
  // 1.3.5 is no longer needed.

  async function readZoom(): Promise<void> {
    if (!isTabMode) return;
    try {
      const tab = await chrome.tabs.getCurrent();
      if (!tab?.id) return;
      currentZoom = await chrome.tabs.getZoom(tab.id);
    } catch (e) {
      log.warn('settings', 'tabs.getZoom failed', e);
    }
  }

  async function applyZoom(factor: number): Promise<void> {
    if (!isTabMode) return;
    try {
      const tab = await chrome.tabs.getCurrent();
      if (!tab?.id) return;
      const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor));
      await chrome.tabs.setZoom(tab.id, clamped);
      currentZoom = clamped;
    } catch (e) {
      log.warn('settings', 'tabs.setZoom failed', e);
    }
  }

  function zoomIn(): Promise<void> {
    return applyZoom(currentZoom + ZOOM_STEP);
  }
  function zoomOut(): Promise<void> {
    return applyZoom(currentZoom - ZOOM_STEP);
  }
  function resetZoom(): Promise<void> {
    return applyZoom(1);
  }

  // Subscribe to the browser's onZoomChange event so the % label
  // stays in sync if the user uses Ctrl+scroll while Settings is
  // open (rather than only updating after a manual button click).
  $effect(() => {
    if (!isTabMode) return;
    void readZoom();
    const onZoomChange = (info: chrome.tabs.OnZoomChangeInfo) => {
      void (async () => {
        const tab = await chrome.tabs.getCurrent();
        if (tab?.id === info.tabId) currentZoom = info.newZoomFactor;
      })();
    };
    chrome.tabs.onZoomChange.addListener(onZoomChange);
    return () => chrome.tabs.onZoomChange.removeListener(onZoomChange);
  });

  function openInTab(): void {
    const url = chrome.runtime?.getURL?.('popup.html?mode=tab');
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }

  // --- Initial load ----------------------------------------------------------

  $effect(() => {
    void loadCacheStats();
    void loadSessionStatus();
    void loadPrefetchStats();
    void loadDebug();
  });

  function refreshAll() {
    void loadCacheStats();
    void loadSessionStatus();
    void loadPrefetchStats();
    void loadDebug();
  }

  function formatDate(ms: number | null): string {
    if (ms == null) return '—';
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return new Date(ms).toLocaleString();
  }
</script>

<section class="flex h-full flex-col overflow-hidden">
  <ModuleHeader title="Settings" loading={cacheLoading || sessionLoading} onRefresh={refreshAll} />

  <!-- Top-level tabs. Same visual pattern as Galactapedia / Contacts
       so the active-tab indicator looks consistent across modules.
       Each tab maps to a coherent group of cards below. -->
  <div class="flex border-b border-slate-800 bg-slate-950/20 px-3 text-xs">
    {#each [
      ['appearance',  'Appearance'],
      ['performance', 'Performance'],
      ['diagnostics', 'Diagnostics'],
    ] as const as [id, label] (id)}
      <button
        type="button"
        onclick={() => (tabP.value = id)}
        class="relative px-3 py-1.5 transition {tab === id
          ? 'text-sky-300'
          : 'text-slate-400 hover:text-slate-200'}"
      >
        {label}
        {#if tab === id}
          <span class="absolute inset-x-1 bottom-0 h-px bg-sky-400"></span>
        {/if}
      </button>
    {/each}
  </div>

  <div class="flex-1 overflow-y-auto p-3">
    <div class="mx-auto flex max-w-3xl flex-col gap-3">

      <!-- =================================================== CACHE =========== -->
      {#if tab === 'performance'}
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <Database class="size-4 text-sky-400" />
          <h2 class="text-sm font-semibold text-slate-100">Cache</h2>
          {#if cacheStats}
            <span class="ml-auto text-[10px] text-slate-500">
              {cacheStats.total.entries} entries · {formatBytes(cacheStats.total.sizeBytes)}
            </span>
          {/if}
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Cached RSI responses (ship lists, orgs, spectrum, galactapedia, etc.).
          Clearing is safe — data is re-fetched on demand.
        </p>
        {#if cacheError}
          <div class="mb-2 flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-2 text-[11px] text-rose-200">
            <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
            <span>{cacheError}</span>
          </div>
        {/if}
        {#if cacheStats}
          <ul class="mb-2 divide-y divide-slate-800 rounded-md border border-slate-800 bg-slate-950/40">
            {#each cacheStats.namespaces as ns (ns.prefix)}
              <li class="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                <code class="flex-1 font-mono text-slate-300">{ns.prefix}</code>
                <span class="w-16 text-right text-slate-500">{ns.entries}</span>
                <span class="w-20 text-right font-mono text-slate-400">{formatBytes(ns.sizeBytes)}</span>
                <button
                  type="button"
                  onclick={() => clearCache(ns.prefix)}
                  disabled={clearingPrefix !== null}
                  class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-rose-300 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Clear {ns.prefix}"
                  aria-label="Clear {ns.prefix}"
                >
                  {#if clearingPrefix === ns.prefix}
                    <Loader2 class="size-3.5 animate-spin" />
                  {:else}
                    <Trash2 class="size-3.5" />
                  {/if}
                </button>
              </li>
            {:else}
              <li class="px-2 py-3 text-center text-[11px] italic text-slate-500">Cache is empty.</li>
            {/each}
          </ul>
        {/if}
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onclick={loadCacheStats}
            disabled={cacheLoading}
            class="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw class="size-3" /> Refresh stats
          </button>
          <button
            type="button"
            onclick={refreshAllModules}
            disabled={refreshingAll || clearingPrefix !== null}
            class="inline-flex items-center gap-1 rounded-md bg-sky-500/20 px-2 py-1 text-[11px] font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            title="Wipe every module's cache, reset polling backoff, fetch fresh, and reload the popup"
          >
            {#if refreshingAll}
              <Loader2 class="size-3 animate-spin" />
            {:else}
              <RefreshCw class="size-3" />
            {/if}
            Refresh all modules
          </button>
          <button
            type="button"
            onclick={() => clearCache()}
            disabled={clearingPrefix !== null}
            class="inline-flex items-center gap-1 rounded-md bg-rose-500/20 px-2 py-1 text-[11px] font-semibold text-rose-300 ring-1 ring-rose-500/40 transition hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            title="Wipe cache without re-fetching or reloading"
          >
            {#if clearingPrefix === '__all__'}
              <Loader2 class="size-3 animate-spin" />
            {:else}
              <Trash2 class="size-3" />
            {/if}
            Clear all
          </button>
        </div>
      </section>
      {/if}

      <!-- =================================================== SESSIONS ======== -->
      {#if tab === 'diagnostics'}
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <ShieldCheck class="size-4 text-emerald-400" />
          <h2 class="text-sm font-semibold text-slate-100">Sessions</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Snapshot of auth / upgrade state. CSRF and CCU session tokens are
          lazily primed — they show <span class="text-slate-300">idle</span>
          until the first Upgrades tab interaction, which is normal.
        </p>
        {#if sessionError}
          <div class="mb-2 flex items-start gap-2 rounded-md border border-rose-900/60 bg-rose-950/40 p-2 text-[11px] text-rose-200">
            <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
            <span>{sessionError}</span>
          </div>
        {/if}
        {#if primeCcuMessage}
          <div
            class="mb-2 flex items-start gap-2 rounded-md border p-2 text-[11px]
              {primeCcuMessage.kind === 'error'
                ? 'border-rose-900/60 bg-rose-950/40 text-rose-200'
                : 'border-emerald-900/60 bg-emerald-950/40 text-emerald-200'}"
          >
            <span class="mt-0.5">{primeCcuMessage.kind === 'error' ? '✗' : '✓'}</span>
            <span>{primeCcuMessage.text}</span>
          </div>
        {/if}
        {#if sessionStatus}
          {@const rows = [
            { label: 'Signed in', lazy: false, ok: sessionStatus.signedIn, extra: sessionStatus.handle ?? '' },
            { label: 'Rsi-Token cookie', lazy: false, ok: sessionStatus.rsiTokenPresent, extra: '' },
            { label: 'CSRF token cached', lazy: true, ok: sessionStatus.csrfTokenPresent, extra: '' },
            { label: 'CCU session primed', lazy: true, ok: sessionStatus.ccuSessionPrimed, extra: '' },
          ]}
          <ul class="mb-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
            {#each rows as r (r.label)}
              <li class="flex items-center gap-2 rounded bg-slate-950/40 px-2 py-1.5 text-[11px] ring-1 ring-inset ring-slate-800/60">
                <span
                  class="size-2 rounded-full
                    {r.ok ? 'bg-emerald-400' : r.lazy ? 'bg-slate-500' : 'bg-rose-400'}"
                ></span>
                <span class="flex-1 text-slate-300">{r.label}</span>
                {#if r.extra}
                  <span class="font-mono text-slate-500">{r.extra}</span>
                {:else}
                  <span
                    class="text-[10px] uppercase tracking-wider
                      {r.ok ? 'text-emerald-400' : r.lazy ? 'text-slate-500' : 'text-rose-400'}"
                  >
                    {r.ok ? 'ok' : r.lazy ? 'idle' : 'missing'}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            onclick={forceIdentityRefresh}
            disabled={sessionLoading}
            class="inline-flex items-center gap-1 rounded-md bg-sky-500/20 px-2 py-1 text-[11px] font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw class="size-3 {sessionLoading ? 'animate-spin' : ''}" />
            Force identity check
          </button>
          <button
            type="button"
            onclick={primeCcu}
            disabled={primingCcu}
            class="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-300 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            title="Test the CSRF + upgrade-session bootstrap without opening the Upgrades tab"
          >
            {#if primingCcu}
              <Loader2 class="size-3 animate-spin" />
            {:else}
              <ShieldCheck class="size-3" />
            {/if}
            Prime CCU now
          </button>
        </div>
      </section>
      {/if}

      <!-- =================================================== PREFETCH ======== -->
      {#if tab === 'performance'}
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <RefreshCw class="size-4 text-sky-400" />
          <h2 class="text-sm font-semibold text-slate-100">Prefetch</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Fires ~29 RSI requests in parallel at popup open so every module
          has warm caches. Disable if you're on a slow or metered connection.
        </p>
        <label class="mb-2 flex items-center gap-2 text-[12px] text-slate-200">
          <input
            type="checkbox"
            checked={settingsState.prefetchEnabled}
            onchange={(e) => settingsState.setPrefetchEnabled(e.currentTarget.checked)}
            class="accent-sky-500"
          />
          Prefetch on popup open
        </label>
        {#if prefetchStats && prefetchStats.lastRunAt !== null}
          <div class="rounded bg-slate-950/40 px-2 py-1.5 text-[11px] text-slate-400 ring-1 ring-inset ring-slate-800/60">
            Last run {formatDate(prefetchStats.lastRunAt)} ·
            {prefetchStats.durationMs}ms ·
            {prefetchStats.requestCount} requests
            {#if (prefetchStats.rejectedCount ?? 0) > 0}
              · <span class="text-amber-300">{prefetchStats.rejectedCount} rejected</span>
            {/if}
          </div>
        {:else}
          <div class="rounded bg-slate-950/40 px-2 py-1.5 text-[11px] italic text-slate-500 ring-1 ring-inset ring-slate-800/60">
            No prefetch run recorded this session yet.
          </div>
        {/if}
      </section>
      {/if}

      <!-- =================================================== POPUP SIZE ===== -->
      {#if tab === 'appearance'}
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <Maximize2 class="size-4 text-sky-400" />
          <h2 class="text-sm font-semibold text-slate-100">Popup size</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Tune the popup window dimensions. The slider tops out at
          {POPUP_SIZE_LIMITS.maxWidth}×{POPUP_SIZE_LIMITS.maxHeight}px —
          browsers reserve a few extra pixels of scrollbar gutter
          beyond that and won't actually grant the larger size. For
          unlimited canvas, use the
          {#if isTabMode}<em>full-tab</em>{:else}
            <button
              type="button"
              class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
              onclick={() => {
                const url = chrome.runtime?.getURL?.('popup.html?mode=tab');
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
              }}
              >full-tab</button
            >
          {/if}
          mode. Changes apply immediately and persist across popup opens.
        </p>
        {#if isTabMode}
          <p class="rounded bg-slate-950/40 px-2 py-1.5 text-[11px] italic text-slate-500 ring-1 ring-inset ring-slate-800/60">
            You're already in tab mode — these sliders only affect the
            toolbar popup. Open the popup to see your changes.
          </p>
        {/if}
        <div class="space-y-2">
          <!-- Width slider. `oninput` only updates the local draft
               (drives the live label below), `onchange` commits to
               settingsState which actually triggers the popup resize.
               Splitting the two prevents the popup from reflowing
               under the cursor mid-drag — see the comment block on
               widthDraft/heightDraft above for the full rationale. -->
          <label class="block text-[11px] text-slate-300">
            <div class="mb-1 flex items-baseline justify-between">
              <span>Width</span>
              <span class="font-mono text-slate-400">
                {widthDraft}px
              </span>
            </div>
            <input
              type="range"
              min={POPUP_SIZE_LIMITS.minWidth}
              max={POPUP_SIZE_LIMITS.maxWidth}
              step="10"
              value={widthDraft}
              oninput={(e) =>
                (widthDraft = Number.parseInt(e.currentTarget.value, 10))}
              onchange={(e) =>
                settingsState.setPopupWidth(
                  Number.parseInt(e.currentTarget.value, 10),
                )}
              class="w-full accent-sky-500"
            />
            <div class="mt-0.5 flex justify-between text-[9px] text-slate-600">
              <span>{POPUP_SIZE_LIMITS.minWidth}px</span>
              <span>default {POPUP_SIZE_LIMITS.defaultWidth}px</span>
              <span>{POPUP_SIZE_LIMITS.maxWidth}px</span>
            </div>
          </label>

          <!-- Height slider — same release-to-commit pattern as width. -->
          <label class="block text-[11px] text-slate-300">
            <div class="mb-1 flex items-baseline justify-between">
              <span>Height</span>
              <span class="font-mono text-slate-400">
                {heightDraft}px
              </span>
            </div>
            <input
              type="range"
              min={POPUP_SIZE_LIMITS.minHeight}
              max={POPUP_SIZE_LIMITS.maxHeight}
              step="10"
              value={heightDraft}
              oninput={(e) =>
                (heightDraft = Number.parseInt(e.currentTarget.value, 10))}
              onchange={(e) =>
                settingsState.setPopupHeight(
                  Number.parseInt(e.currentTarget.value, 10),
                )}
              class="w-full accent-sky-500"
            />
            <div class="mt-0.5 flex justify-between text-[9px] text-slate-600">
              <span>{POPUP_SIZE_LIMITS.minHeight}px</span>
              <span>default {POPUP_SIZE_LIMITS.defaultHeight}px</span>
              <span>{POPUP_SIZE_LIMITS.maxHeight}px</span>
            </div>
          </label>

          <button
            type="button"
            onclick={() => settingsState.resetPopupSize()}
            disabled={settingsState.popupWidth === POPUP_SIZE_LIMITS.defaultWidth &&
              settingsState.popupHeight === POPUP_SIZE_LIMITS.defaultHeight}
            class="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RotateCcw class="size-3" />
            Reset to default
          </button>
        </div>
      </section>

      <!-- =================================================== UI SCALE ====== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <ZoomIn class="size-4 text-sky-400" />
          <h2 class="text-sm font-semibold text-slate-100">UI scale</h2>
        </header>
        {#if isTabMode}
          <p class="mb-2 text-[11px] text-slate-400">
            Adjusts the tab-mode zoom level — same effect as
            <kbd class="rounded bg-slate-950/60 px-1 py-0.5 font-mono text-[10px] ring-1 ring-inset ring-slate-700">Ctrl</kbd>
            +
            <kbd class="rounded bg-slate-950/60 px-1 py-0.5 font-mono text-[10px] ring-1 ring-inset ring-slate-700">scroll</kbd>
            on the page. Your browser persists this per site
            automatically. Useful on high-DPI / 4K displays where the
            default density feels too tight.
          </p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              onclick={() => void zoomOut()}
              disabled={currentZoom <= ZOOM_MIN + 0.001}
              title="Zoom out"
              aria-label="Zoom out"
              class="flex size-7 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Minus class="size-3.5" />
            </button>
            <div class="flex-1 text-center font-mono text-sm text-slate-100">
              {Math.round(currentZoom * 100)}%
            </div>
            <button
              type="button"
              onclick={() => void zoomIn()}
              disabled={currentZoom >= ZOOM_MAX - 0.001}
              title="Zoom in"
              aria-label="Zoom in"
              class="flex size-7 items-center justify-center rounded-md border border-slate-700 text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus class="size-3.5" />
            </button>
            <button
              type="button"
              onclick={() => void resetZoom()}
              disabled={Math.abs(currentZoom - 1) < 0.001}
              class="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-[11px] text-slate-300 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw class="size-3" />
              Reset
            </button>
          </div>
        {:else}
          <p class="text-[11px] leading-relaxed text-slate-400">
            UI scaling is only available in tab mode — browsers don't
            respond to zoom shortcuts on extension popups, and the
            popup window itself is intentionally fixed-size (see the
            sliders above). Open the extension in a tab via the
            <button
              type="button"
              onclick={openInTab}
              class="text-sky-400 underline decoration-sky-700 underline-offset-2 hover:decoration-sky-400"
              >full-tab</button
            >
            icon at the top right of the header (or click that link),
            then revisit this section to scale the UI to your display.
          </p>
        {/if}
      </section>

      <!-- =================================================== MODULES ========= -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <SettingsIcon class="size-4 text-slate-400" />
          <h2 class="text-sm font-semibold text-slate-100">Sidebar modules</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Reorder with the arrows, hide modules you don't use with the eye
          toggle. Settings is always pinned at the bottom.
        </p>
        <ul class="divide-y divide-slate-800 rounded-md border border-slate-800 bg-slate-950/40">
          {#each moduleList as id, i (id)}
            {@const mod = MODULES.find((m) => m.id === id)}
            {#if mod}
              {@const hidden = hiddenSet.has(id)}
              <li class="flex items-center gap-2 px-2 py-1.5 text-[11px]">
                <span class="flex-1 {hidden ? 'italic text-slate-500 line-through' : 'text-slate-200'}">
                  {mod.label}
                </span>
                <button
                  type="button"
                  onclick={() => toggleHidden(id)}
                  class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-100"
                  title={hidden ? 'Show in sidebar' : 'Hide from sidebar'}
                  aria-label={hidden ? 'Show in sidebar' : 'Hide from sidebar'}
                >
                  {#if hidden}
                    <EyeOff class="size-3.5" />
                  {:else}
                    <Eye class="size-3.5" />
                  {/if}
                </button>
                <button
                  type="button"
                  onclick={() => moveModule(id, -1)}
                  disabled={i === 0}
                  class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Move up"
                  aria-label="Move up"
                >
                  <ArrowUp class="size-3.5" />
                </button>
                <button
                  type="button"
                  onclick={() => moveModule(id, 1)}
                  disabled={i === moduleList.length - 1}
                  class="rounded p-1 text-slate-500 transition hover:bg-slate-800 hover:text-slate-100 disabled:cursor-not-allowed disabled:opacity-30"
                  title="Move down"
                  aria-label="Move down"
                >
                  <ArrowDown class="size-3.5" />
                </button>
              </li>
            {/if}
          {/each}
        </ul>
      </section>
      {/if}

      <!-- =================================================== DEBUG =========== -->
      {#if tab === 'diagnostics'}
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <Info class="size-4 text-slate-400" />
          <h2 class="text-sm font-semibold text-slate-100">Debug info</h2>
          <button
            type="button"
            onclick={copyDebugBundle}
            class="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            title="Copy bundle to clipboard"
          >
            <ClipboardCopy class="size-3" />
            {copiedFlash ? 'Copied!' : 'Copy bundle'}
          </button>
        </header>
        <dl class="mb-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          <dt class="text-slate-500">Version</dt>
          <dd class="font-mono text-slate-300">{version}</dd>
          <dt class="text-slate-500">User-Agent</dt>
          <dd class="truncate font-mono text-[10px] text-slate-400" title={userAgent}>
            {userAgent}
          </dd>
          {#if permissions}
            <dt class="text-slate-500">Permissions</dt>
            <dd class="font-mono text-[10px] text-slate-400">
              {permissions.permissions.join(', ') || '—'}
            </dd>
            <dt class="text-slate-500">Origins</dt>
            <dd class="font-mono text-[10px] text-slate-400">
              {permissions.origins.length} host{permissions.origins.length === 1 ? '' : 's'}
            </dd>
          {/if}
        </dl>
        {#if logs && logs.length > 0}
          <details class="rounded bg-slate-950/40 ring-1 ring-inset ring-slate-800/60">
            <summary class="cursor-pointer px-2 py-1.5 text-[11px] text-slate-400 hover:text-slate-200">
              Recent logs ({logs.length})
            </summary>
            <ul class="max-h-64 overflow-y-auto border-t border-slate-800 font-mono text-[10px]">
              {#each logs.slice().reverse() as e, i (i)}
                <li
                  class="border-b border-slate-800/60 px-2 py-0.5
                    {e.level === 'error' ? 'text-rose-300' : ''}
                    {e.level === 'warn'  ? 'text-amber-300' : ''}
                    {e.level === 'info'  ? 'text-slate-300' : ''}
                    {e.level === 'debug' ? 'text-slate-500' : ''}"
                >
                  <span class="text-slate-600">{new Date(e.time).toLocaleTimeString()}</span>
                  <span class="text-slate-500">[{e.scope}]</span>
                  {e.message}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </section>

      <!-- =================================================== RESET =========== -->
      <section class="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <header class="mb-2 flex items-center gap-2">
          <RotateCcw class="size-4 text-amber-400" />
          <h2 class="text-sm font-semibold text-slate-100">Reset settings</h2>
        </header>
        <p class="mb-2 text-[11px] text-slate-400">
          Wipes your sidebar order, hidden modules, and prefetch preference.
          Does <strong>not</strong> clear caches or sign you out — use the
          buttons above for that.
        </p>
        <div class="flex items-center justify-end">
          <button
            type="button"
            onclick={() => {
              settingsState.resetAll();
              // Bounce the user back to the default active module in case
              // they had picked Settings and just reset it.
              appState.setActiveModule('comm-link');
            }}
            class="inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2 py-1 text-[11px] font-semibold text-amber-300 ring-1 ring-amber-500/40 transition hover:bg-amber-500/30"
          >
            <RotateCcw class="size-3" />
            Reset settings to defaults
          </button>
        </div>
      </section>
      {/if}
    </div>
  </div>
</section>
