// User settings — UI behaviour preferences only.
//
// All five prefs are small JSON blobs persisted to localStorage (popup
// context only — the background doesn't need to read them directly,
// unlike the badge-modules pref which lives in chrome.storage.local).
// They tune UI behaviour, not data fetching. The Settings module
// reads+writes via the `settings.*` accessors; other modules
// (Sidebar, prefetch) just read.

import { log } from '@rsi-companion/shared';
import type { ModuleId } from '../module-registry';

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
  defaultHeight: 570,
} as const;

function clampPopupWidth(v: number): number {
  if (!Number.isFinite(v)) return POPUP_SIZE_LIMITS.defaultWidth;
  return Math.min(POPUP_SIZE_LIMITS.maxWidth, Math.max(POPUP_SIZE_LIMITS.minWidth, Math.round(v)));
}
function clampPopupHeight(v: number): number {
  if (!Number.isFinite(v)) return POPUP_SIZE_LIMITS.defaultHeight;
  return Math.min(POPUP_SIZE_LIMITS.maxHeight, Math.max(POPUP_SIZE_LIMITS.minHeight, Math.round(v)));
}

// Local helpers — settings keys already include their own prefix
// (`settings:prefetchEnabled`, `settings:moduleOrder`, …) so we read
// straight off the raw key without the `popup:` envelope used by
// `persist.svelte.ts`. Could in principle migrate to `persistedState`
// but that would force a key rename (popup:settings:…) which would
// silently lose every existing user's preferences on first 1.5.x
// boot — not worth the consolidation.
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
