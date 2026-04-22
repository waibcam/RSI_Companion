<script lang="ts">
  import {
    Archive,
    BookOpen,
    ClipboardList,
    Map as MapIcon,
    FileText,
    GitCommitHorizontal,
    LayoutDashboard,
    Ship,
    Newspaper,
    MessagesSquare,
    Contact,
    Building2,
    Globe,
    Settings as SettingsIcon,
    ShoppingCart,
    Users,
  } from 'lucide-svelte';
  import type { ComponentType } from 'svelte';
  import { appState, getEffectiveModules, settingsState, type ModuleId } from '../state.svelte';
  import { notifyState } from '../notify.svelte';

  const ICONS: Record<ModuleId, ComponentType> = {
    'release-notes':    FileText,
    roadmap:            MapIcon,
    'progress-tracker': ClipboardList,
    dashboard:          LayoutDashboard,
    ships:              Ship,
    'buy-back':         Archive,
    'pledge-store':     ShoppingCart,
    'comm-link':        Newspaper,
    'patch-notes':      GitCommitHorizontal,
    spectrum:           MessagesSquare,
    contacts:           Contact,
    organizations:      Building2,
    'org-browser':      Globe,
    'community-hub':    Users,
    galactapedia:       BookOpen,
    settings:           SettingsIcon,
  };

  // Derived from user prefs: reorder + filter hidden modules. Settings
  // is always present and always last (enforced in getEffectiveModules).
  const visibleModules = $derived(
    getEffectiveModules(settingsState.moduleOrder, settingsState.moduleHidden),
  );

  function unreadFor(id: ModuleId): number {
    if (id === 'spectrum') return notifyState.state.counts.spectrum;
    if (id === 'comm-link') return notifyState.state.counts['comm-link'];
    if (id === 'patch-notes') return notifyState.state.counts['patch-notes'];
    if (id === 'roadmap') return notifyState.state.counts.roadmap;
    if (id === 'contacts') return notifyState.state.counts.contacts;
    if (id === 'release-notes') return notifyState.state.counts['release-notes'];
    return 0;
  }
</script>

<nav
  class="flex w-44 shrink-0 flex-col gap-0.5 border-r border-slate-800 bg-slate-950/40 p-2"
>
  {#each visibleModules as mod (mod.id)}
    {@const Icon = ICONS[mod.id]}
    {@const active = appState.activeModule === mod.id}
    {@const unread = unreadFor(mod.id)}
    <button
      type="button"
      class="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition
        {active
        ? 'bg-sky-500/15 text-sky-300 ring-1 ring-inset ring-sky-500/30'
        : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'}
        {mod.ready ? '' : 'opacity-60'}"
      onclick={() => appState.setActiveModule(mod.id)}
    >
      <Icon class="size-4 shrink-0" />
      <span class="flex-1 truncate">{mod.label}</span>
      {#if !mod.ready}
        <span
          class="rounded bg-slate-800 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-slate-500"
        >
          soon
        </span>
      {:else if unread > 0}
        <span
          class="min-w-[1.25rem] rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-center text-[10px] font-semibold text-emerald-300 ring-1 ring-inset ring-emerald-500/40"
          title="{unread} new"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      {/if}
    </button>
  {/each}
</nav>
