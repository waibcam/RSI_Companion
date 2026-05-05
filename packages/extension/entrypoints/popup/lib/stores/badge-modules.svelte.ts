// Toolbar badge modules preference.
//
// Which modules' unread counts contribute to the number on the toolbar
// icon. Distinct from settingsState (popup-only) because the BG reads
// this too — it's the BG that calls `chrome.action.setBadgeText`. So
// the storage layer is `chrome.storage.local`, NOT `localStorage`,
// and changes are observed reactively in both contexts via
// `chrome.storage.onChanged`. A checkbox click in the popup repaints
// the badge without a poll re-trigger.
//
// Default = BADGE_MODULES_DEFAULT (the five RSI-content modules, no
// release-notes). Users who want their own changelog updates to
// surface in the badge can opt in via the Settings UI. Initialised
// asynchronously from App.svelte at popup mount; reads return the
// in-memory copy (which is the default until init() resolves).

import { log, Notify } from '@rsi-companion/shared';

const BADGE_MODULES_KEY = 'settings:badgeModules';

function createBadgeModulesState() {
  let modules = $state<Notify.NotifyModule[]>([
    ...Notify.BADGE_MODULES_DEFAULT,
  ]);
  let initialised = false;

  async function init(): Promise<void> {
    if (initialised) return;
    initialised = true;
    try {
      const res = await chrome.storage.local.get(BADGE_MODULES_KEY);
      const stored = res[BADGE_MODULES_KEY];
      if (Array.isArray(stored)) {
        modules = stored.filter((m): m is Notify.NotifyModule =>
          Notify.BADGE_MODULES_ALL.includes(m as Notify.NotifyModule),
        );
      }
    } catch (e) {
      log.warn('badge', 'failed to read badge-modules pref', e);
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[BADGE_MODULES_KEY];
      if (!change) return;
      const next = change.newValue;
      if (Array.isArray(next)) {
        modules = next.filter((m): m is Notify.NotifyModule =>
          Notify.BADGE_MODULES_ALL.includes(m as Notify.NotifyModule),
        );
      }
    });
  }

  async function setModules(next: ReadonlyArray<Notify.NotifyModule>): Promise<void> {
    const dedup = Array.from(new Set(next)).filter((m) =>
      Notify.BADGE_MODULES_ALL.includes(m),
    );
    modules = dedup;
    try {
      await chrome.storage.local.set({ [BADGE_MODULES_KEY]: dedup });
    } catch (e) {
      log.warn('badge', 'failed to persist badge-modules pref', e);
    }
  }

  function toggleModule(m: Notify.NotifyModule): Promise<void> {
    return setModules(
      modules.includes(m) ? modules.filter((x) => x !== m) : [...modules, m],
    );
  }

  function reset(): Promise<void> {
    return setModules(Notify.BADGE_MODULES_DEFAULT);
  }

  return {
    get modules(): readonly Notify.NotifyModule[] {
      return modules;
    },
    init,
    setModules,
    toggleModule,
    reset,
  };
}

export const badgeModulesState = createBadgeModulesState();
