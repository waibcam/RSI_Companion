// Helpers for persisting popup state across popup close/open cycles.
//
// Power-users bounce in and out of the popup constantly; losing your Ships
// filter every time you reopen it is the single most noticeable UX paper-cut.
// This file is the one place all persistence decisions live:
//   - what storage (localStorage — synchronous, small data)
//   - how to namespace keys (popup:<module>:<field>)
//   - how to handle storage being unavailable (degrade silently)
//
// Not wired to chrome.storage.local on purpose: we don't need cross-device
// sync, we don't want MV3 service-worker wake-ups for UI state changes,
// and localStorage is already in use for the active-module selection.

import { log } from '@rsi-companion/shared';

const NS = 'popup:';

/** Read a JSON-encoded value from localStorage. Returns `fallback` on any
 *  failure (missing, parse error, storage unavailable).
 *
 *  When validation fails we fall back silently (log.debug). This is most
 *  commonly a legitimate type migration — a previous extension version
 *  stored `pledge:tab: "browse"` and the current code only accepts
 *  `"store" | "upgrade" | "shortcuts"`. A genuine parse error (malformed
 *  JSON, storage access denied) still warns because that's a real bug. */
export function readPersisted<T>(key: string, fallback: T, validate?: (v: unknown) => v is T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw == null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (validate && !validate(parsed)) {
      log.debug('persist', `stored value at "${key}" no longer matches the current type; using fallback`);
      return fallback;
    }
    return parsed as T;
  } catch (e) {
    log.warn('persist', `read failed for "${key}"`, e);
    return fallback;
  }
}

/** Write a JSON-encoded value to localStorage. Silently ignores quota / access errors. */
export function writePersisted(key: string, value: unknown): void {
  try {
    localStorage.setItem(NS + key, JSON.stringify(value));
  } catch (e) {
    log.warn('persist', `write failed for "${key}"`, e);
  }
}

/** Create a Svelte 5 rune-backed state that automatically persists every change.
 *
 *  Usage:
 *    let filter = persistedState('ships:filter', 'all' as ShipFilter);
 *    filter.value = 'owned';            // writes to localStorage
 *    const current = filter.value;      // reactive read
 *
 *  The `validate` guard is optional but recommended when the stored shape is
 *  a union / enum — it discards garbage from old versions silently instead
 *  of poisoning the UI. */
export function persistedState<T>(
  key: string,
  initial: T,
  validate?: (v: unknown) => v is T,
): { value: T } {
  let current = $state<T>(readPersisted<T>(key, initial, validate));
  return {
    get value(): T {
      return current;
    },
    set value(next: T) {
      current = next;
      writePersisted(key, next);
    },
  };
}
