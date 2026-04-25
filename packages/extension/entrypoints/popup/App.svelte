<script lang="ts">
  import { AlertTriangle, Loader2, RefreshCw, X } from 'lucide-svelte';
  import type { Component } from 'svelte';
  import Header from './lib/components/Header.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';
  import {
    appState,
    getEffectiveModules,
    isTabMode,
    MODULES,
    settingsState,
    type ModuleId,
  } from './lib/state.svelte';
  import { notifyState } from './lib/notify.svelte';

  // Lazy-load each module so the initial popup bundle only parses the code
  // the user actually sees. The sidebar has 13 modules — eager-importing them
  // all meant every popup open parsed a few hundred KB of Svelte components
  // (Galactapedia + CommunityHub + Spectrum alone carry most of that weight),
  // even for users who only ever open Comm-Link.
  //
  // Vite splits each dynamic import into its own chunk. The chunk is cached
  // by the browser after first load, so switching back to a module is instant
  // from the second visit onward.
  type ModuleLoader = () => Promise<{ default: Component<any> }>;

  const moduleLoaders: Partial<Record<ModuleId, ModuleLoader>> = {
    roadmap: () => import('./lib/modules/Roadmap.svelte'),
    'progress-tracker': () => import('./lib/modules/ProgressTracker.svelte'),
    dashboard: () => import('./lib/modules/Dashboard.svelte'),
    'comm-link': () => import('./lib/modules/CommLink.svelte'),
    'patch-notes': () => import('./lib/modules/PatchNotes.svelte'),
    ships: () => import('./lib/modules/Ships.svelte'),
    'buy-back': () => import('./lib/modules/BuyBack.svelte'),
    'pledge-store': () => import('./lib/modules/PledgeStore.svelte'),
    contacts: () => import('./lib/modules/Contacts.svelte'),
    organizations: () => import('./lib/modules/MyOrganizations.svelte'),
    'org-browser': () => import('./lib/modules/OrgBrowser.svelte'),
    spectrum: () => import('./lib/modules/Spectrum.svelte'),
    'community-hub': () => import('./lib/modules/CommunityHub.svelte'),
    galactapedia: () => import('./lib/modules/Galactapedia.svelte'),
    support: () => import('./lib/modules/Support.svelte'),
    settings: () => import('./lib/modules/Settings.svelte'),
  };
  const comingSoonLoader: ModuleLoader = () => import('./lib/modules/ComingSoon.svelte');
  const releaseNotesLoader: ModuleLoader = () => import('./lib/modules/ReleaseNotes.svelte');

  // Memoize the Promise per module so switching away and back doesn't re-fire
  // the dynamic import (the browser would cache the chunk, but a new Promise
  // still resets the {#await} block — we'd flash the spinner for no reason).
  const moduleCache = new Map<string, Promise<{ default: Component<any> }>>();
  function loadModule(id: ModuleId): Promise<{ default: Component<any> }> {
    const cached = moduleCache.get(id);
    if (cached) return cached;
    const p = (moduleLoaders[id] ?? comingSoonLoader)();
    moduleCache.set(id, p);
    return p;
  }
  let releaseNotesPromise: Promise<{ default: Component<any> }> | null = null;
  function loadReleaseNotes() {
    if (!releaseNotesPromise) releaseNotesPromise = releaseNotesLoader();
    return releaseNotesPromise;
  }

  notifyState.init();
  // v2 used to do a full module refresh on startup, partly to populate badge
  // counts. v3 replicates that specifically for the notifications side: kick
  // off a fresh poll so the toolbar badge and Spectrum unread count reflect
  // what's waiting on the server right now, not whatever the alarm caught
  // last (which could be up to 10 minutes stale).
  void notifyState.pollNow();

  const current = $derived(MODULES.find((m) => m.id === appState.activeModule)!);
  const activeModulePromise = $derived(loadModule(current.id));

  function handleBackdropClick(event: MouseEvent) {
    if (event.target === event.currentTarget) appState.closeReleaseNotes();
  }

  function handleBackdropKey(event: KeyboardEvent) {
    if (event.key === 'Escape') appState.closeReleaseNotes();
  }

  // Global keyboard shortcuts.
  //   Ctrl/⌘+K        → focus the active module's search input
  //   Esc             → close release notes, or clear focused search input
  //   Alt+1..9        → jump to sidebar module N (skip the number row alone —
  //                     browsers swallow it for tab switching, and we don't
  //                     want to steal typing focus)
  // These stay lightweight: we only look for the first visible <input type="search">
  // inside <main>, which every module's header exposes.
  function focusActiveSearch(): boolean {
    const main = document.querySelector('main');
    const el = main?.querySelector<HTMLInputElement>('input[type="search"]');
    if (el) {
      el.focus();
      el.select();
      return true;
    }
    return false;
  }

  function handleGlobalKey(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    const inEditable =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target && target.isContentEditable);

    // Ctrl/⌘+K — focus search
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      if (focusActiveSearch()) {
        event.preventDefault();
      }
      return;
    }

    // Escape — close release notes first, otherwise clear focused search input
    if (event.key === 'Escape') {
      if (appState.releaseNotesOpen) {
        appState.closeReleaseNotes();
        event.preventDefault();
        return;
      }
      if (target instanceof HTMLInputElement && target.type === 'search' && target.value) {
        target.value = '';
        target.dispatchEvent(new Event('input', { bubbles: true }));
        event.preventDefault();
      }
      return;
    }

    // Alt+1..9 — jump to sidebar module. Indexes into the EFFECTIVE
    // (user-reordered, user-filtered) list so the shortcut matches what
    // the user sees in the sidebar.
    if (event.altKey && !event.ctrlKey && !event.metaKey && !inEditable) {
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9) {
        const effective = getEffectiveModules(
          settingsState.moduleOrder,
          settingsState.moduleHidden,
        );
        const mod = effective[n - 1];
        if (mod) {
          appState.setActiveModule(mod.id);
          event.preventDefault();
        }
      }
    }
  }
</script>

<svelte:window onkeydown={handleGlobalKey} />

<!-- Popup dimensions: tab mode takes the whole browser tab (h-screen
     w-screen). Toolbar-popup mode reads
     `settingsState.popup{Width,Height}` so the user can tune the
     popup size from Settings → Popup size. The state has its own
     min/max clamping and persists to localStorage.

     The actual scrollbar suppression at the 800×600 platform max
     lives in app.css (`overflow: hidden` on html/body): the browser
     can allocate slightly less than what we request because of its
     own UI chrome, and without that guard a 1-2px overflow surfaces
     a system scrollbar on the popup window. We do NOT use
     `min(Npx, 100vw)` here — at popup open time `100vw` reflects
     the browser's initial viewport allocation BEFORE our style
     applies, which can be tiny (eg. 80px), and would lock the
     popup at that pre-layout size forever. -->
<div
  class="relative flex flex-col overflow-hidden bg-slate-950 font-sans text-slate-100 antialiased
    {isTabMode ? 'tab-mode h-screen w-screen' : ''}"
  style={isTabMode
    ? ''
    : `width: ${settingsState.popupWidth}px; height: ${settingsState.popupHeight}px;`}
>
  <Header />

  <div class="flex flex-1 overflow-hidden">
    <Sidebar />

    <main class="flex-1 overflow-hidden bg-slate-900/40">
      {#key current.id}
        {#await activeModulePromise}
          <div class="flex h-full items-center justify-center text-slate-500">
            <Loader2 class="size-5 animate-spin" />
          </div>
        {:then mod}
          {@const Mod = mod.default}
          <!-- Runtime error boundary: catches errors thrown during
               render or inside $effect/$derived of the active module.
               Without this, a single malformed server response or a
               bad runtime assumption would blank the whole popup and
               make switching to other modules impossible. The `reset`
               callback re-mounts just the module subtree, so the user
               can retry without closing and reopening the popup. -->
          <svelte:boundary>
            {#if moduleLoaders[current.id]}
              <Mod />
            {:else}
              <!-- ComingSoon fallback — only it accepts a `label` prop. -->
              <Mod label={current.label} />
            {/if}
            {#snippet failed(err, reset)}
              <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
                <AlertTriangle class="size-8 text-rose-400" />
                <div class="text-sm text-slate-200">
                  <p class="font-semibold">This module crashed</p>
                  <p class="mt-1 break-all text-[11px] text-rose-300/80">
                    {err instanceof Error ? err.message : String(err)}
                  </p>
                </div>
                <button
                  type="button"
                  onclick={reset}
                  class="inline-flex items-center gap-1.5 rounded-md bg-sky-500/20 px-3 py-1.5 text-xs font-semibold text-sky-300 ring-1 ring-sky-500/40 transition hover:bg-sky-500/30"
                >
                  <RefreshCw class="size-3" /> Reload module
                </button>
              </div>
            {/snippet}
          </svelte:boundary>
        {:catch err}
          <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-rose-300">
            <p class="font-semibold">Failed to load module</p>
            <p class="break-all text-rose-400/80">{err instanceof Error ? err.message : String(err)}</p>
          </div>
        {/await}
      {/key}
    </main>
  </div>

  {#if appState.releaseNotesOpen}
    <div
      class="absolute inset-0 z-30 flex items-stretch justify-end bg-slate-950/70"
      role="presentation"
      onclick={handleBackdropClick}
      onkeydown={handleBackdropKey}
    >
      <div
        class="flex h-full w-[420px] max-w-full flex-col border-l border-slate-800 bg-slate-900 shadow-xl tab:w-[680px]"
        role="dialog"
        aria-modal="true"
        aria-label="Release Notes"
      >
        <div class="flex items-center justify-between border-b border-slate-800 bg-slate-950/60 px-3 py-1.5">
          <span class="text-[10px] uppercase tracking-wider text-slate-500">Extension</span>
          <button
            type="button"
            class="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
            title="Close"
            aria-label="Close"
            onclick={() => appState.closeReleaseNotes()}
          >
            <X class="size-3.5" />
            <span>Close</span>
          </button>
        </div>
        <div class="flex-1 overflow-hidden">
          {#await loadReleaseNotes()}
            <div class="flex h-full items-center justify-center text-slate-500">
              <Loader2 class="size-5 animate-spin" />
            </div>
          {:then mod}
            {@const Mod = mod.default}
            <Mod />
          {/await}
        </div>
      </div>
    </div>
  {/if}
</div>
