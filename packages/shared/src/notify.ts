// Notification state shared between the background worker and the popup.
//
// The background polls Spectrum threads, Comm-Link page 1, Patch Notes page 1,
// and the Roadmap snapshot on an alarm, and diffs each set against the user's
// `lastSeen` fingerprint. New items surface as per-module unread counts and
// drive the extension icon badge. The popup subscribes via `notify.state` and
// clears a module's count via `notify.markSeen` when the user opens that
// module.

export type NotifyModule =
  | 'spectrum'
  | 'comm-link'
  | 'patch-notes'
  | 'roadmap'
  | 'contacts'
  | 'release-notes';

export interface NotifyCounts {
  spectrum: number;
  'comm-link': number;
  'patch-notes': number;
  roadmap: number;
  contacts: number;
  'release-notes': number;
}

/** Per-module error messages from the most recent poll. A module with no
 *  entry here succeeded (or wasn't polled in this scope — e.g. a slow-tick
 *  poll won't touch fast modules, so their prior errors stick until the next
 *  fast tick overwrites them). */
export type NotifyErrors = Partial<Record<NotifyModule, string>>;

/** Per-module backoff state for the consecutive-failure circuit. Reset
 *  to {failStreak:0, nextRetryAt:0} on the next successful poll. */
export interface NotifyModuleBackoff {
  /** Number of consecutive failed polls for this module since the last
   *  success. Drives the exponential next-retry delay. */
  failStreak: number;
  /** ms epoch — the poll loop skips this module when Date.now() < this.
   *  0 means no backoff active (allow immediate retry). */
  nextRetryAt: number;
}

export type NotifyBackoffs = Partial<Record<NotifyModule, NotifyModuleBackoff>>;

export interface NotifyState {
  signedIn: boolean;
  counts: NotifyCounts;
  /** ms epoch; null before first successful poll. */
  lastPolledAt: number | null;
  /** Per-module errors from the last poll that touched each module. Empty
   *  when everything succeeded. */
  lastErrors: NotifyErrors;
  /** Per-module exponential backoff state. Modules whose collectors fail
   *  N times in a row get skipped for increasing intervals (10/20/40/60
   *  minutes capped) so a flaky upstream doesn't waste quota. Cleared
   *  on first success. */
  backoffs?: NotifyBackoffs;
  /** Reason the last poll skipped every module (e.g. "RSI Platform down").
   *  Set by the status-feed circuit breaker; cleared when the next poll
   *  actually runs. */
  skippedReason?: string | null;
}

export const EMPTY_COUNTS: NotifyCounts = {
  spectrum: 0,
  'comm-link': 0,
  'patch-notes': 0,
  roadmap: 0,
  contacts: 0,
  'release-notes': 0,
};

/** Default set of modules that contribute to the toolbar badge total
 *  when the user hasn't customised the preference. All five
 *  RSI / Star Citizen content surfaces; the extension's own
 *  `release-notes` is intentionally excluded by default — Etyx
 *  reported on Discord (2026-05-04) that internal changelog updates
 *  shouldn't pollute the count of "stuff happening on RSI". Users
 *  who want to include it can flip the toggle in
 *  Settings → Appearance → Toolbar badge. */
export const BADGE_MODULES_DEFAULT: ReadonlyArray<NotifyModule> = [
  'spectrum',
  'comm-link',
  'patch-notes',
  'roadmap',
  'contacts',
];

/** Every module the badge could possibly contribute from. Drives
 *  the Settings UI (one checkbox per entry). Order matters — it's
 *  the order the checkboxes render. */
export const BADGE_MODULES_ALL: ReadonlyArray<NotifyModule> = [
  'spectrum',
  'comm-link',
  'patch-notes',
  'roadmap',
  'contacts',
  'release-notes',
];

/** Sum of unread counts that contribute to the TOOLBAR BADGE.
 *
 *  `modules` is the list of NotifyModule keys to include in the sum.
 *  Pass the user's preference (read from `chrome.storage.local`
 *  under `settings:badgeModules`) to honour their per-module opt-in
 *  / opt-out. Defaults to `BADGE_MODULES_DEFAULT` (the five RSI
 *  modules, release-notes excluded) — matches what the badge did
 *  hard-coded before this preference was introduced.
 *
 *  Modules NOT in the list are still counted on their per-module
 *  sidebar pill. The list only controls what bubbles up to the
 *  global toolbar badge. */
export function totalUnread(
  counts: NotifyCounts,
  modules: ReadonlyArray<NotifyModule> = BADGE_MODULES_DEFAULT,
): number {
  let sum = 0;
  for (const m of modules) {
    sum += counts[m] ?? 0;
  }
  return sum;
}
