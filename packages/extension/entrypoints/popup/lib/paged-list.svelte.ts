// Reusable paginated-list state with scroll-event-driven infinite
// scroll.
//
// Factors out the ~80-line pattern that lived in lockstep across
// CommLink, PatchNotes, BuyBack, Galactapedia (each with subtle bugs
// of its own). Single source of truth for:
//
//   - the loading / error / fromCache reactive trio
//   - dedup-on-append (by user-supplied key) so adjacent-page overlap
//     from the upstream paginator can't crash a keyed {#each}
//   - the scroll-event near-bottom detector + the "drain on
//     load-complete" effect that re-fires loadPage(N) after a batch
//     arrives if the user is still close to the bottom (covers the
//     "stopped scrolling but near the end" case that
//     IntersectionObserver historically failed to)
//   - the refresh() / loadPage() / hasMore plumbing
//
// Design constraints encountered while designing this:
//   - The `fetchPage` callback closes over module-local filter state
//     (CommLink's channel/series/sort, PatchNotes' query, BuyBack's
//     hideCcu, Galactapedia's tag). The helper must NOT try to know
//     what's "in" a request — only how to fetch it and dedup it.
//   - hasMore is computed two ways across modules: (a) server-supplied
//     `hasNextPage` flag (BuyBack), (b) inferred from "empty page"
//     (CommLink, PatchNotes, Galactapedia). The fetchPage return
//     shape lets callers pick whichever fits.
//   - Some modules suppress pagination while a client-side filter is
//     active (BuyBack with `query.trim()`, PatchNotes with the same):
//     the `canFetchNext` callback gates that without leaking state
//     plumbing into the helper.
//   - The auth-extraction nuance (e.g. BuyBack reads `signedIn` off
//     the response and falls back to false on a typed-error) varies
//     too much to bake in. Callers handle it inside `fetchPage`'s
//     try/catch — we just surface the error string.
//
// Usage:
//
//     const list = createPagedList<PatchNote>({
//       keyOf: (n) => n.href,
//       fetchPage: async (page, force) => {
//         const res = await sendRsiMessage({ type: 'patchnotes.list', page, force });
//         return { items: res.notes, fromCache: res.fromCache };
//       },
//     });
//
//     // template:
//     // <div bind:this={list.scrollContainer} onscroll={list.onScroll}>
//     //   {#each list.items as n (n.href)} ... {/each}
//     // </div>

import { errorMessage } from './error';

/** Per-page response shape. Callers map their RSI message response
 *  into this. `hasNextPage` is optional — if absent, the helper
 *  infers no-more-pages from `items.length === 0`. */
export interface PageResult<T> {
  items: T[];
  /** Server-supplied next-page flag, when the upstream has one
   *  (BuyBack does). When omitted, the helper falls back to the
   *  empty-page heuristic. */
  hasNextPage?: boolean;
  fromCache?: boolean;
}

export interface CreatePagedListOptions<T> {
  /** How to fetch one page. Receives the page number (1-indexed) and
   *  whether the call should force-bypass cache. Throws translate to
   *  `error` via `errorMessage`. */
  fetchPage: (page: number, force: boolean) => Promise<PageResult<T>>;
  /** Stable unique key per item — used to dedup on append when the
   *  upstream paginator overlaps adjacent pages. Must be cheap. */
  keyOf: (item: T) => string | number;
  /** Optional gate on whether to auto-fire the next page on scroll
   *  (modules use this to suppress pagination while a client-side
   *  filter is active). Defaults to "always allow". */
  canFetchNext?: () => boolean;
  /** Distance from the bottom of the scroll container at which to
   *  fire the next page. Default 600 px — far enough that the next
   *  batch lands before the user reaches the actual end. */
  nearBottomPx?: number;
}

export interface PagedList<T> {
  /** All accumulated items across loaded pages, in the order the
   *  upstream returned them (after dedup). Reactive — bind in
   *  `{#each}`. */
  readonly items: T[];
  /** True while a `loadPage` call is in flight. Use to render
   *  spinners and to gate user-driven re-loads. */
  readonly loading: boolean;
  /** Last error message from a failed `loadPage`, or null. */
  readonly error: string | null;
  /** Whether the most recent fetched page came from the BG cache
   *  rather than a fresh upstream call. Surfaced in some modules
   *  to label the data freshness. */
  readonly fromCache: boolean;
  /** Whether more pages are available. Goes false once the upstream
   *  returns an empty page (or its server-supplied flag flips). */
  readonly hasMore: boolean;
  /** The page number that the next `loadPage()` call should fetch.
   *  Always 1-indexed. */
  readonly nextPage: number;

  /** Fetch a specific page. Defaults to `nextPage`. `force` re-fetches
   *  upstream instead of serving from cache. */
  loadPage(page?: number, force?: boolean): Promise<void>;
  /** Wipe all loaded items and re-fetch page 1 with `force=true`.
   *  Used by Refresh buttons and filter-change handlers. */
  refresh(): Promise<void>;
  /** Reset to the initial empty state WITHOUT triggering a fetch.
   *  Used by filter-change handlers that immediately call `loadPage(1)`
   *  themselves. */
  reset(): void;

  /** Svelte action: wire onto the scrollable container with
   *  `<div use:list.attach>`. Registers the element as the scroll
   *  container AND installs the scroll-event listener. Cleans up
   *  both on unmount. Replaces the old `bind:this + onscroll` pair
   *  with a single binding. */
  attach: (node: HTMLElement) => { destroy(): void };
}

/** Build a reactive paged-list state machine. Call ONCE per module
 *  (top of the `<script>`). The returned object's getters are runes
 *  under the hood; reading them inside the template re-renders
 *  reactively. */
export function createPagedList<T>(opts: CreatePagedListOptions<T>): PagedList<T> {
  const nearBottomPx = opts.nearBottomPx ?? 600;
  const canFetchNext = opts.canFetchNext ?? (() => true);

  let items = $state<T[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let fromCache = $state(false);
  let hasMore = $state(true);
  let nextPage = $state(1);
  let scrollContainer: HTMLElement | null = null;

  function isNearBottom(): boolean {
    const el = scrollContainer;
    if (!el) return false;
    return el.scrollHeight - el.scrollTop - el.clientHeight < nearBottomPx;
  }

  async function loadPage(page: number = nextPage, force = false): Promise<void> {
    if (loading) return;
    loading = true;
    error = null;
    try {
      const res = await opts.fetchPage(page, force);
      // Dedup unconditionally, and against the incoming batch as well as
      // the accumulated items. The earlier version only deduped on
      // append (page > 1) and only against what was already in `items`,
      // so a page that carried a repeated key *within itself* — page 1
      // included — went straight into the keyed `{#each}` and crashed it
      // with `each_key_duplicate`. Keys are the caller's contract, but a
      // scraped upstream can't be trusted to honour it, and a dropped
      // row beats a dead module.
      const base = page === 1 ? [] : items;
      const seen = new Set(base.map(opts.keyOf));
      const fresh: T[] = [];
      for (const it of res.items) {
        const key = opts.keyOf(it);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(it);
      }
      items = page === 1 ? fresh : [...items, ...fresh];
      if (res.fromCache !== undefined) fromCache = res.fromCache;
      nextPage = page + 1;
      // hasMore: server flag wins when supplied; otherwise infer from
      // empty-page (the conservative fallback that all 4 historical
      // call sites used).
      if (res.hasNextPage !== undefined) {
        hasMore = res.hasNextPage;
      } else {
        hasMore = res.items.length > 0;
      }
    } catch (e) {
      error = errorMessage(e);
    } finally {
      loading = false;
    }
  }

  async function refresh(): Promise<void> {
    nextPage = 1;
    items = [];
    hasMore = true;
    await loadPage(1, true);
  }

  function reset(): void {
    items = [];
    nextPage = 1;
    hasMore = true;
    error = null;
  }

  function onScroll(): void {
    if (isNearBottom() && !loading && hasMore && canFetchNext()) {
      void loadPage(nextPage);
    }
  }

  function attach(node: HTMLElement) {
    scrollContainer = node;
    node.addEventListener('scroll', onScroll);
    return {
      destroy() {
        if (scrollContainer === node) scrollContainer = null;
        node.removeEventListener('scroll', onScroll);
      },
    };
  }

  // Drain on load-complete: when `loading` flips back to false, if
  // we're still within nearBottomPx of the bottom, fire the next
  // page. Without this, a user who scrolled to the bottom and stopped
  // (no further scroll events) wouldn't get the next batch after the
  // first one arrived. Reading `items.length` makes the effect
  // re-run after a new batch lands and the DOM updates scrollHeight.
  $effect(() => {
    void items.length;
    if (!loading && hasMore && canFetchNext() && isNearBottom()) {
      void loadPage(nextPage);
    }
  });

  return {
    get items() {
      return items;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    get fromCache() {
      return fromCache;
    },
    get hasMore() {
      return hasMore;
    },
    get nextPage() {
      return nextPage;
    },
    loadPage,
    refresh,
    reset,
    attach,
  };
}
