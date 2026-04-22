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

export interface NotifyState {
  signedIn: boolean;
  counts: NotifyCounts;
  /** ms epoch; null before first successful poll. */
  lastPolledAt: number | null;
  /** Per-module errors from the last poll that touched each module. Empty
   *  when everything succeeded. */
  lastErrors: NotifyErrors;
}

export const EMPTY_COUNTS: NotifyCounts = {
  spectrum: 0,
  'comm-link': 0,
  'patch-notes': 0,
  roadmap: 0,
  contacts: 0,
  'release-notes': 0,
};

export function totalUnread(counts: NotifyCounts): number {
  return (
    counts.spectrum +
    counts['comm-link'] +
    counts['patch-notes'] +
    counts.roadmap +
    counts.contacts +
    counts['release-notes']
  );
}
