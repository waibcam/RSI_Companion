// Popup-wide reactive state. Svelte 5 runes work in .svelte.ts modules too.

import { log, sendRsiMessage } from '@rsi-companion/shared';

export type ModuleId =
  | 'roadmap'
  | 'progress-tracker'
  | 'release-notes'
  | 'dashboard'
  | 'ships'
  | 'buy-back'
  | 'pledge-store'
  | 'comm-link'
  | 'patch-notes'
  | 'spectrum'
  | 'contacts'
  | 'organizations'
  | 'org-browser'
  | 'community-hub'
  | 'galactapedia'
  | 'support'
  | 'settings';

export interface ModuleDescriptor {
  id: ModuleId;
  label: string;
  /** true = already implemented in v3 */
  ready: boolean;
}

// Sidebar ordering follows a rough "what is this for" grouping:
//   News & community first (Comm-Link, Spectrum, Community Hub)
//   Build tracking together (Roadmap ↔ Patch Notes are directly related)
//   Personal account middle (Dashboard, Ships, Buy-Back, Contacts, Orgs)
//   Reference (Org Browser, Galactapedia)
//
// Release Notes used to live here — it's about the extension itself, not RSI
// content, so it now lives in a Header button (see App.svelte / Header.svelte).
export const MODULES: ReadonlyArray<ModuleDescriptor> = [
  { id: 'comm-link',      label: 'Comm-Link',     ready: true },
  { id: 'spectrum',       label: 'Spectrum',      ready: true },
  { id: 'community-hub',  label: 'Community Hub', ready: true },
  { id: 'roadmap',           label: 'Roadmap',           ready: true },
  { id: 'progress-tracker',  label: 'Progress Tracker',  ready: true },
  { id: 'patch-notes',       label: 'Patch Notes',       ready: true },
  { id: 'dashboard',      label: 'Dashboard',     ready: true },
  { id: 'ships',          label: 'Ships',         ready: true },
  { id: 'buy-back',       label: 'Buy-Back',      ready: true },
  { id: 'pledge-store',   label: 'Pledge Store',  ready: true },
  { id: 'contacts',       label: 'Contacts',      ready: true },
  { id: 'organizations',  label: 'Organizations', ready: true },
  { id: 'org-browser',    label: 'Org Browser',   ready: true },
  { id: 'galactapedia',   label: 'Galactapedia',  ready: true },
  // Support sits just before Settings — it's a sibling concept (extension
  // self-care: bug reports, feedback, FAQ, links to GitHub/Discord/privacy)
  // but stays hide-able like any normal module. Settings remains the only
  // pinned-always-visible entry.
  { id: 'support',        label: 'Support',       ready: true },
  { id: 'settings',       label: 'Settings',      ready: true },
];

/** True when popup.html was opened in a browser tab (`?mode=tab`) rather than
 *  as the extension popup. Fixed at load time — never changes. */
export const isTabMode: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mode') === 'tab';
  } catch {
    return false;
  }
})();

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

// --- User settings ---------------------------------------------------------
// All three prefs are small JSON blobs persisted to localStorage (popup
// context only — the background doesn't need to read them directly). They
// tune UI behaviour, not data fetching. The Settings module reads+writes
// via the `settings.*` accessors; other modules (Sidebar, prefetch) just
// read.

const PREFS_KEYS = {
  prefetch: 'settings:prefetchEnabled',
  moduleOrder: 'settings:moduleOrder',
  moduleHidden: 'settings:moduleHidden',
  popupWidth: 'settings:popupWidth',
  popupHeight: 'settings:popupHeight',
} as const;

// Settings module's top-level tab IDs. Persisted via the popup-scoped
// `persistedState` helper (under the `popup:` namespace, alongside
// every other module's tab state) so reopening the extension lands
// the user on the same tab they were last using — e.g. someone
// troubleshooting a cache issue keeps coming back to Performance.
// Validated as a string-union on read.
export type SettingsTabId = 'appearance' | 'performance' | 'diagnostics';
const SETTINGS_TABS: readonly SettingsTabId[] = [
  'appearance',
  'performance',
  'diagnostics',
];
export function isSettingsTabId(v: unknown): v is SettingsTabId {
  return typeof v === 'string' && (SETTINGS_TABS as readonly string[]).includes(v);
}

// Browser-imposed popup dimension limits. Chromium and Firefox both
// document an 800x600 cap on extension popups, but in practice the
// effective ceiling is ~10px lower on each axis on most platforms —
// the browser reserves a scrollbar gutter on the popup window
// itself, and asking for the documented 800x600 makes the inner
// content overflow that gutter and surface a window-level scrollbar
// that our `overflow: hidden` can't suppress (it's a browser-chrome
// element, not part of the document).
//
// Verified on Firefox 149 / Windows 10: requesting 800x600 yields a
// 790x600 actual viewport with a horizontal scrollbar. Capping the
// sliders at 790x590 leaves enough margin to dodge the gutter on
// every browser/OS combination we've tested.
//
// Floors are our own call: below ~360x400 the modules collapse into
// illegible single-column views with overflow.
export const POPUP_SIZE_LIMITS = {
  minWidth: 360,
  maxWidth: 790,
  minHeight: 400,
  maxHeight: 590,
  defaultWidth: 760,
  defaultHeight: 530,
} as const;

function clampPopupWidth(v: number): number {
  if (!Number.isFinite(v)) return POPUP_SIZE_LIMITS.defaultWidth;
  return Math.min(POPUP_SIZE_LIMITS.maxWidth, Math.max(POPUP_SIZE_LIMITS.minWidth, Math.round(v)));
}
function clampPopupHeight(v: number): number {
  if (!Number.isFinite(v)) return POPUP_SIZE_LIMITS.defaultHeight;
  return Math.min(POPUP_SIZE_LIMITS.maxHeight, Math.max(POPUP_SIZE_LIMITS.minHeight, Math.round(v)));
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    log.warn('settings', `persist ${key} failed`, e);
  }
}

function createSettingsState() {
  let prefetchEnabled = $state<boolean>(readJson(PREFS_KEYS.prefetch, true));
  // Module order: list of module ids in the sidebar order the user has
  // chosen. Unknown or newly-added modules (e.g. a future 'spectrum2')
  // are auto-appended at render time so a shipping release never drops
  // a new module out of the sidebar because the user has a stale prefs
  // blob from an earlier version.
  let moduleOrder = $state<ModuleId[]>(readJson(PREFS_KEYS.moduleOrder, []));
  let moduleHidden = $state<ModuleId[]>(readJson(PREFS_KEYS.moduleHidden, []));
  // Popup dimensions when opened from the toolbar (NOT in tab mode).
  // Browsers fix the popup window themselves but honour CSS-driven
  // body sizing up to ~800x600 — we expose two sliders in Settings
  // that let the user tune the popup to their screen and density
  // preference. Stored values are always clamped within the
  // platform-supported envelope so a corrupt prefs blob can't ship a
  // 50px-wide popup.
  let popupWidth = $state<number>(
    clampPopupWidth(readJson(PREFS_KEYS.popupWidth, POPUP_SIZE_LIMITS.defaultWidth)),
  );
  let popupHeight = $state<number>(
    clampPopupHeight(readJson(PREFS_KEYS.popupHeight, POPUP_SIZE_LIMITS.defaultHeight)),
  );

  return {
    get prefetchEnabled() {
      return prefetchEnabled;
    },
    setPrefetchEnabled(v: boolean) {
      prefetchEnabled = v;
      writeJson(PREFS_KEYS.prefetch, v);
    },
    get moduleOrder(): readonly ModuleId[] {
      return moduleOrder;
    },
    setModuleOrder(next: ModuleId[]) {
      moduleOrder = next;
      writeJson(PREFS_KEYS.moduleOrder, next);
    },
    get moduleHidden(): readonly ModuleId[] {
      return moduleHidden;
    },
    toggleModuleHidden(id: ModuleId) {
      const set = new Set(moduleHidden);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      moduleHidden = [...set];
      writeJson(PREFS_KEYS.moduleHidden, moduleHidden);
    },
    get popupWidth(): number {
      return popupWidth;
    },
    setPopupWidth(v: number) {
      popupWidth = clampPopupWidth(v);
      writeJson(PREFS_KEYS.popupWidth, popupWidth);
    },
    get popupHeight(): number {
      return popupHeight;
    },
    setPopupHeight(v: number) {
      popupHeight = clampPopupHeight(v);
      writeJson(PREFS_KEYS.popupHeight, popupHeight);
    },
    resetPopupSize() {
      popupWidth = POPUP_SIZE_LIMITS.defaultWidth;
      popupHeight = POPUP_SIZE_LIMITS.defaultHeight;
      writeJson(PREFS_KEYS.popupWidth, popupWidth);
      writeJson(PREFS_KEYS.popupHeight, popupHeight);
    },
    /** Drop all settings back to defaults. Used by the Settings "Reset"
     *  button. Does NOT clear caches — that's a separate action. */
    resetAll() {
      prefetchEnabled = true;
      moduleOrder = [];
      moduleHidden = [];
      popupWidth = POPUP_SIZE_LIMITS.defaultWidth;
      popupHeight = POPUP_SIZE_LIMITS.defaultHeight;
      writeJson(PREFS_KEYS.prefetch, true);
      writeJson(PREFS_KEYS.moduleOrder, []);
      writeJson(PREFS_KEYS.moduleHidden, []);
      writeJson(PREFS_KEYS.popupWidth, popupWidth);
      writeJson(PREFS_KEYS.popupHeight, popupHeight);
    },
  };
}

export const settingsState = createSettingsState();

/** Effective sidebar module list: user-defined order first, then any
 *  unknown/new modules appended in their MODULES order, then hidden
 *  modules filtered out. Memoized per (order, hidden) pair via $derived
 *  when consumed in a Svelte context — here we just return the array.
 *  The Settings module itself is ALWAYS visible and always last, even
 *  if the user tries to hide it (otherwise they'd be stuck). */
export function getEffectiveModules(
  order: readonly ModuleId[],
  hidden: readonly ModuleId[],
): ModuleDescriptor[] {
  const hiddenSet = new Set(hidden);
  const byId = new Map(MODULES.map((m) => [m.id, m]));
  const seen = new Set<ModuleId>();
  const out: ModuleDescriptor[] = [];

  // 1) User-defined order, filtering unknowns and hidden (except 'settings')
  for (const id of order) {
    if (seen.has(id)) continue;
    const mod = byId.get(id);
    if (!mod) continue; // stale entry from a removed module
    if (id !== 'settings' && hiddenSet.has(id)) continue;
    seen.add(id);
    if (id !== 'settings') out.push(mod);
  }
  // 2) Modules not in the user's order yet (new ones after an update)
  for (const mod of MODULES) {
    if (seen.has(mod.id)) continue;
    if (mod.id === 'settings') continue;
    if (hiddenSet.has(mod.id)) continue;
    out.push(mod);
  }
  // 3) Settings always last + always visible
  const settings = byId.get('settings');
  if (settings) out.push(settings);
  return out;
}

/**
 * Global "am I signed in to RSI" state. Set once on popup boot via auth.identity
 * so auth-required modules can skip rendering their UI (and avoid the
 * "flash of tabs → sign-in prompt" when a stale cookie gets rejected mid-fetch).
 *
 * - null  = not yet resolved (initial state, show nothing / skeleton)
 * - true  = signed in, render normally
 * - false = not signed in, render SignInPrompt
 */
function createAuthState() {
  let signedIn = $state<boolean | null>(null);
  let identity = $state<{ handle: string; displayName: string; avatarUrl: string | null } | null>(
    null,
  );

  async function refresh(force = false): Promise<void> {
    try {
      const res = await sendRsiMessage({ type: 'auth.identity', force });
      signedIn = res.signedIn;
      identity = res.identity;
    } catch (e) {
      // On any error treat as signed-out so the UI falls back to SignInPrompt
      // instead of hanging in the "unknown" state indefinitely.
      log.warn('auth', 'identity refresh failed, treating as signed out', e);
      signedIn = false;
      identity = null;
    }
  }

  // Resolve on module load so by the time modules mount the state is known.
  // We let the 5-min identity cache apply: sign-in/out on the RSI site fires
  // chrome.cookies.onChanged in the background worker, which wipes the identity
  // cache entry (and the short in-memory identify memo) — so a stale `signedIn`
  // value can't outlive an actual auth flip. Paying a fresh RSI call on every
  // popup open (including the many within-a-session re-opens) was the main
  // source of redundant identify traffic.
  void refresh(false);

  return {
    get signedIn() {
      return signedIn;
    },
    get identity() {
      return identity;
    },
    refresh,
    /** Allow a module to push a freshly-observed `signedIn` so the rest of the
     *  popup updates without waiting for its own auth.identity refresh. */
    markSignedIn(v: boolean) {
      signedIn = v;
      if (!v) identity = null;
    },
  };
}

export const authState = createAuthState();
