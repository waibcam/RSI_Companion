// Popup navigation state.
//
// Owns:
//   - the currently active sidebar module (persisted to localStorage so
//     reopening the popup lands the user on the same module)
//   - the Release Notes drawer's open/closed state (transient — never
//     persisted, the drawer is only useful in-session)
//   - a one-shot pending-tab queue that release-note deep-links use to
//     hand off both a sub-tab and a scroll anchor to the destination
//     module.
//
// Cross-store coupling: this is the only store that other stores
// don't import. `app-state` doesn't read settings/auth/badge/rate;
// the navigation is a pure function of user clicks + persisted
// active-module id. Keeps the dependency graph one-way.

import { log } from '@rsi-companion/shared';
import type { ModuleId } from '../module-registry';
import { MODULES } from '../module-registry';

const STORAGE_KEY = 'popup:activeModule';

function readInitialModule(): ModuleId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && MODULES.some((m) => m.id === stored)) {
      return stored as ModuleId;
    }
  } catch (e) {
    log.warn('state', 'failed to read active module from localStorage', e);
  }
  return 'comm-link';
}

function createAppState() {
  let activeModule = $state<ModuleId>(readInitialModule());
  let releaseNotesOpen = $state(false);
  // Pending navigation request, set by `navigateTo(module, tab?, anchor?)`
  // and consumed by the target module's `$effect` once it mounts (or
  // re-renders if it was already mounted). Decouples release-notes
  // deep-links from each module's own internal tab / scroll state —
  // the module just calls `appState.consumePendingTab(moduleId)` and
  // applies whatever it gets back. Reset to null after consumption
  // so a stale request doesn't fire twice.
  //
  // `anchor` is a DOM element id the module should scroll into view
  // after switching the tab. Lets release notes deep-link directly
  // to a specific section (e.g. Settings → Appearance → Toolbar
  // badge with `#toolbar-badge`) so the user lands on the relevant
  // card without scrolling.
  let pendingTab = $state<{
    moduleId: ModuleId;
    tab: string | null;
    anchor: string | null;
  } | null>(null);

  return {
    get activeModule() {
      return activeModule;
    },
    setActiveModule(id: ModuleId) {
      activeModule = id;
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch (e) {
        log.warn('state', 'failed to persist active module', e);
      }
    },
    /** Switch to `moduleId`, optionally requesting a specific sub-tab
     *  AND a specific in-module scroll anchor. Targets are stored as
     *  pending; the module's `$effect` consumes them on its next
     *  reactive pass. Closes the release-notes modal so the user
     *  lands on the destination instead of a covered popup. */
    navigateTo(moduleId: ModuleId, tab?: string, anchor?: string): void {
      if (tab || anchor) {
        pendingTab = {
          moduleId,
          tab: tab ?? null,
          anchor: anchor ?? null,
        };
      }
      releaseNotesOpen = false;
      activeModule = moduleId;
      try {
        localStorage.setItem(STORAGE_KEY, moduleId);
      } catch (e) {
        log.warn('state', 'failed to persist active module', e);
      }
    },
    get pendingTab() {
      return pendingTab;
    },
    /** Pull and clear the pending-navigation request if it's for
     *  `moduleId`. Modules call this in a `$effect` that reads
     *  `pendingTab` so the effect re-runs whenever a new request
     *  arrives. Returns `{tab, anchor}` — both fields can be null;
     *  the module applies whichever ones are present (switch tab,
     *  scroll to anchor, or both). */
    consumePendingTab(
      moduleId: ModuleId,
    ): { tab: string | null; anchor: string | null } | null {
      if (pendingTab && pendingTab.moduleId === moduleId) {
        const out = { tab: pendingTab.tab, anchor: pendingTab.anchor };
        pendingTab = null;
        return out;
      }
      return null;
    },
    get releaseNotesOpen() {
      return releaseNotesOpen;
    },
    openReleaseNotes() {
      releaseNotesOpen = true;
    },
    closeReleaseNotes() {
      releaseNotesOpen = false;
    },
  };
}

export const appState = createAppState();
