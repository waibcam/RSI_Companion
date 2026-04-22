// Popup-open prefetch.
//
// v2 loaded every module's data sequentially on extension boot so by the
// time the user clicked into any tab the cache was already warm. The v3
// rewrite lazy-loads components — which means on a fresh popup open, only
// the active module's data is being fetched, and switching tabs kicks a
// new round-trip per tab.
//
// This helper fires one round of `sendRsiMessage` per module at popup
// launch. Each call either:
//   - hits the background's storage cache (free, microsecond read)
//   - triggers a fetch via the background, deduplicated against any other
//     tab/module that happens to request the same key
//
// Errors are swallowed (Promise.allSettled): a failure in one fetch
// shouldn't block the others. The popup's per-module UI still owns its
// own explicit load + error rendering; this just primes the cache.
//
// Non-blocking: called fire-and-forget from main.ts so the Svelte mount
// starts immediately. The prefetched data lands via cache hits as each
// module mounts.
//
// Signed-out handlers short-circuit (no RSI network call) so this is
// cheap for anonymous users too.

import { sendRsiMessage, log } from '@rsi-companion/shared';
import { settingsState } from './state.svelte';

export function prefetchAll(): void {
  // User-controllable via Settings → Prefetch. Default on; when off the
  // extension relies entirely on lazy per-module loads. Useful for users
  // on slow/metered connections who'd rather pay the latency per-module.
  if (!settingsState.prefetchEnabled) {
    log.info('prefetch', 'skipped (disabled in settings)');
    return;
  }
  const startedAt = performance.now();
  void Promise.allSettled([
    // Global (always needed)
    sendRsiMessage({ type: 'auth.identity' }),
    sendRsiMessage({ type: 'status.summary' }),
    sendRsiMessage({ type: 'stats.summary' }),
    sendRsiMessage({ type: 'notify.state' }),

    // Account
    sendRsiMessage({ type: 'dashboard.summary' }),
    sendRsiMessage({ type: 'ships.list' }),
    sendRsiMessage({ type: 'buyback.list', page: 1 }),
    sendRsiMessage({ type: 'contacts.list' }),
    sendRsiMessage({ type: 'orgs.myList' }),
    sendRsiMessage({ type: 'orgs.invitations' }),
    sendRsiMessage({ type: 'orgs.applications' }),

    // Spectrum (all 4 tabs)
    sendRsiMessage({ type: 'spectrum.threads' }),
    sendRsiMessage({ type: 'spectrum.trending' }),
    sendRsiMessage({ type: 'spectrum.notifications' }),
    sendRsiMessage({ type: 'spectrum.lobbies' }),

    // Content feeds
    sendRsiMessage({ type: 'commlink.list', page: 1 }),
    sendRsiMessage({ type: 'patchnotes.list', page: 1 }),
    sendRsiMessage({ type: 'pledge.shipList' }),
    // CCU catalogue carries owned flags + full ship list for the upgrade
    // picker. Cheap on cache hit, and prefetching makes the Upgrade tab
    // render instantly when the user clicks it.
    sendRsiMessage({ type: 'pledge.ccuInit' }),
    // Cart (items + totals). Short-TTL (~1 min) so this prefetch is mostly
    // a freshness nudge — popup-open fires a new fetch if the cached cart
    // is older than a minute, which is what we want given how volatile
    // the cart is between sessions.
    sendRsiMessage({ type: 'pledge.cart' }),
    // Community Hub: one fetch per tab. Each tab is a distinct RSI URL
    // (different SSR'd Next.js page for Live/Events, different GraphQL
    // variables for Discover/Gameplay/Tutorial) so we can't fan them out
    // from a single call. Cheap enough to parallelize though.
    sendRsiMessage({ type: 'communityHub.list', tab: 'live' }),
    sendRsiMessage({ type: 'communityHub.list', tab: 'events' }),
    sendRsiMessage({ type: 'communityHub.list', tab: 'discover' }),
    sendRsiMessage({ type: 'communityHub.list', tab: 'gameplay' }),
    sendRsiMessage({ type: 'communityHub.list', tab: 'tutorial' }),
    sendRsiMessage({ type: 'progressTracker.list' }),
    // Raw roadmap payload shared between Roadmap + Progress Tracker.
    // Without this they'd each fetch /roadmap independently.
    sendRsiMessage({ type: 'roadmap.data' }),

    // Galactapedia articles, categories, tags — cheap, one request each.
    sendRsiMessage({ type: 'galactapedia.list', first: 30, skip: 0, search: '' }),
    sendRsiMessage({ type: 'galactapedia.categories' }),
    sendRsiMessage({ type: 'galactapedia.tags' }),
    // Home tab: featured article + in-the-news + 4 featured categories.
    // Lands the Home tab instantly on first open.
    sendRsiMessage({ type: 'galactapedia.home' }),
    // A-Z index: fire-once bootstrap. The handler is a no-op after the
    // first successful crawl, so this line stays cheap on every subsequent
    // popup open — even after the 30-day TTL expires, we rely on the
    // user's next Galactapedia module visit (or manual refresh) to
    // repopulate it, rather than silently paying 5-15 sequential GraphQL
    // requests at every boot.
    sendRsiMessage({ type: 'galactapedia.indexBootstrap' }),
  ]).then((results) => {
    const durationMs = Math.round(performance.now() - startedAt);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      log.debug('prefetch', `${failed}/${results.length} prefetch calls rejected (benign — per-module UI retries)`);
    }
    // Report outcome to the background so the Settings → Prefetch panel
    // can show "last run: 850ms, 29 requests, 2 rejected" for diagnostics.
    void sendRsiMessage({
      type: 'settings.recordPrefetch',
      durationMs,
      requestCount: results.length,
      rejectedCount: failed,
    }).catch((e: unknown) => log.debug('prefetch', 'failed to record stats', e));
  });
}
