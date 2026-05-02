// Persistent retry queue for the "Sync LIVE → PTU" workflow.
//
// Why this exists:
// When you run Sync, friends who don't have a PTU account at that
// moment land in the `notFound` bucket. CIG resets the PTU social
// graph on every test wave AND a meaningful share of users only
// create their PTU profile a few days into a wave. So a friend who's
// `notFound` on Tuesday might be available on Thursday.
//
// Without this retry queue, the user would have to remember to click
// Sync every couple of days. With it, the BG re-attempts the
// notFound entries every 12 hours for a week, silently — when one
// resolves, the friend-request goes out and the entry leaves the
// queue. Past the 7-day window, entries are dropped (CIG either
// hasn't shipped that wave or the user just isn't testing).

import type { ContactsSyncToPtuEntry } from './messaging.js';

/** chrome.storage.local key holding the array of pending retries. */
export const PTU_SYNC_RETRY_STORAGE_KEY = 'ptu-sync:pending-retries';

/** chrome.alarms name for the periodic retry tick. */
export const PTU_SYNC_RETRY_ALARM = 'ptu-sync-retry';

/** Tick interval, in minutes. 12 h = 2 ticks/day, low quota burn,
 *  catches PTU profile creations within a comfortable window without
 *  hammering the server. */
export const PTU_SYNC_RETRY_INTERVAL_MIN = 12 * 60;

/** Hard cutoff per entry. Stops re-trying after 7 days regardless of
 *  result so a long-dormant `notFound` doesn't sit in the queue
 *  forever. Tunable; one week was the cadence @Camille requested. */
export const PTU_SYNC_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** chrome.storage.local key holding the last retry-tick stats. Used by
 *  the popup to show "Last retry: Xh ago — Y succeeded" so the user has
 *  a visible signal that the queue is actually being processed. */
export const PTU_SYNC_RETRY_TICK_STATS_KEY = 'ptu-sync:last-tick';

/** Snapshot of the most recent retry-tick run. Persisted so the popup
 *  can render "last retry was Nh ago" even after the SW slept. */
export interface PtuSyncRetryTickStats {
  /** ms epoch when the tick completed. */
  at: number;
  /** How many entries the tick attempted (excludes drops past the
   *  7-day window). */
  retried: number;
  /** How many of those resulted in an `added` /
   *  `ErrExistingPendingFriendRequest` (treated as success since the
   *  contact is now in the user's PTU pending list either way). */
  succeeded: number;
  /** How many entries hit the 7-day window during this tick and got
   *  evicted from the queue. */
  dropped: number;
  /** Queue size after the tick — tells the user how many are still
   *  pending without forcing a separate read. */
  remaining: number;
}

/** One pending retry — a LIVE friend the most recent sync couldn't
 *  resolve on PTU yet. Keyed by lowercase(nickname) externally. */
export interface PtuSyncPendingRetry {
  nickname: string;
  displayName: string;
  avatar: string;
  /** ms epoch — when this entry first joined the queue. Used to
   *  enforce PTU_SYNC_RETRY_WINDOW_MS. */
  addedAt: number;
  /** ms epoch — most recent retry tick that touched this entry.
   *  Surfaced in the UI as "last tried X ago". 0 means we've added
   *  it but never retried (queued by sync, not yet ticked). */
  lastAttemptAt: number;
  /** Total retry attempts so far (excludes the original sync miss). */
  attemptCount: number;
}

/** Reconcile a finished sync's entries against the existing retry
 *  queue. Pure function — caller persists the result.
 *
 *   - status === 'notFound' → add (or refresh addedAt if already in)
 *     when not already queued. We DON'T reset addedAt on a refresh
 *     so the 7-day clock keeps ticking; user gets the new attempt
 *     count via the regular tick path.
 *   - status === 'added' / 'alreadyFriend' / 'alreadyPending' → drop
 *     from queue (the contact is resolved one way or another).
 *   - status === 'error' → leave queue alone. Could be transient.
 *
 *  Lower-cased nickname is the dedup key (RSI handles are
 *  case-insensitive but display capitalisation can drift). */
export function reconcilePtuRetryQueue(
  existing: ReadonlyArray<PtuSyncPendingRetry>,
  entries: ReadonlyArray<ContactsSyncToPtuEntry>,
  now: number,
): PtuSyncPendingRetry[] {
  const byKey = new Map<string, PtuSyncPendingRetry>();
  for (const e of existing) byKey.set(e.nickname.toLowerCase(), e);

  for (const e of entries) {
    const key = e.nickname.toLowerCase();
    if (e.status === 'added' || e.status === 'alreadyFriend' || e.status === 'alreadyPending') {
      byKey.delete(key);
    } else if (e.status === 'notFound') {
      if (!byKey.has(key)) {
        byKey.set(key, {
          nickname: e.nickname,
          displayName: e.displayName,
          avatar: e.avatar,
          addedAt: now,
          lastAttemptAt: 0,
          attemptCount: 0,
        });
      }
      // existing entry kept as-is; addedAt clock keeps ticking.
    }
    // 'error' → no change.
  }

  return [...byKey.values()];
}
