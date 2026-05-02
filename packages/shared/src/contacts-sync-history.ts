// Sync run history. Persists the last N completed/cancelled Sync
// LIVE → PTU runs so the user can see what they did and when from
// the Sync tab without rerunning anything.
//
// Cap is intentionally small (10 entries × ~150 bytes each) — this
// is a "last few" UX surface, not a full audit log. If a power user
// needs more, they'd need a different mechanism (and we'd have a
// bigger reason to ship it).

/** chrome.storage.local key holding the bounded history array. */
export const PTU_SYNC_HISTORY_KEY = 'ptu-sync:history';

/** Maximum number of entries kept. Older entries get pushed out by
 *  appendSyncHistory below. */
export const PTU_SYNC_HISTORY_MAX = 10;

export interface PtuSyncHistoryEntry {
  /** ms epoch — when the sync started (clicked Sync now). */
  startedAt: number;
  /** ms epoch — when the sync ended (either complete or cancelled). */
  completedAt: number;
  /** True when the user clicked Cancel mid-run. The counts then reflect
   *  the partial work; entries that hadn't been attempted yet aren't
   *  represented. */
  cancelled: boolean;
  counts: {
    added: number;
    alreadyFriend: number;
    alreadyPending: number;
    notFound: number;
    error: number;
  };
}
