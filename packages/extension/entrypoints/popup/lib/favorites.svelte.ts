// Per-namespace favorite-id store backed by localStorage.
//
// The store is a reactive Set<string>. Each call to `createFavorites('ships')`
// returns an object with `has`, `toggle`, `add`, `remove`, and `list` that
// survive popup open/close. The Set is materialised into a plain state array
// behind the scenes so Svelte 5's reactivity picks up changes (Sets aren't
// deeply tracked by $state).
//
// Shared across modules (ships, galactapedia articles, …) via the namespace
// argument — we don't want a user's favorited Gladius to leak into the
// Galactapedia "favorites only" filter.

import { readPersisted, writePersisted } from './persist.svelte';

const NS_PREFIX = 'favorites:';

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export interface FavoritesStore {
  /** Reactive read-only list of favorited ids, in insertion order. */
  readonly ids: readonly string[];
  has(id: string): boolean;
  toggle(id: string): void;
  add(id: string): void;
  remove(id: string): void;
  /** Drop every favorite in this namespace. */
  clear(): void;
  /** Number of favorites currently stored. */
  readonly size: number;
}

export function createFavorites(namespace: string): FavoritesStore {
  const storageKey = NS_PREFIX + namespace;
  // Array is the source of truth for insertion order + serialisation.
  // `membership` is a `$derived` Set so `has()` is O(1) *and* reactive —
  // templates that call `favs.has(id)` re-run when `list` changes.
  //
  // Pre-fix, `membership` was a plain `new Set()` mutated imperatively in
  // `toggle/add/remove`. Svelte 5 couldn't see those Set mutations as
  // reactive, so the star icon in the UI wouldn't flip until something else
  // forced a re-render (like re-entering the module). Deriving the Set from
  // `list` reuses list's reactivity for membership lookups at O(n) rebuild
  // cost per favorites change — fine for any realistic favorites count
  // (thousands would still rebuild in well under 1ms).
  const initial = readPersisted<string[]>(storageKey, [], isStringArray);
  let list = $state<string[]>(initial);
  const membership = $derived(new Set(list));

  function persist() {
    writePersisted(storageKey, list);
  }

  return {
    get ids(): readonly string[] {
      return list;
    },
    get size(): number {
      return list.length;
    },
    has(id: string): boolean {
      return membership.has(id);
    },
    toggle(id: string): void {
      if (membership.has(id)) {
        list = list.filter((x) => x !== id);
      } else {
        list = [...list, id];
      }
      persist();
    },
    add(id: string): void {
      if (membership.has(id)) return;
      list = [...list, id];
      persist();
    },
    remove(id: string): void {
      if (!membership.has(id)) return;
      list = list.filter((x) => x !== id);
      persist();
    },
    clear(): void {
      if (list.length === 0) return;
      list = [];
      persist();
    },
  };
}
