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
//
// SCOPE TRIM (1.5.5 audit):
// The previous list was 30 messages on every popup open — a noticeable
// burst on slow connections, and ~70% of them prefetched modules the
// user rarely opens (Galactapedia A-Z bootstrap, Community Hub all 5
// tabs, Pledge cart + CCU init, Buy-Back). The shortlist below covers:
//   1. The four globals every popup needs (auth, status, badge counts,
//      referral stats — all surfaced in the header / sidebar).
//   2. The five "high-traffic" modules: Comm-Link, Patch Notes,
//      Spectrum notifications, Roadmap, Contacts. These match
//      BADGE_MODULES_DEFAULT — i.e. the modules whose unread counts
//      already feed the toolbar badge by default.
// Everything else loads on first click via the module's own `$effect`,
// which has been the case since v3 — the prefetch was extra warm-up,
// not a hard requirement. Settings → Diagnostics → Recent prefetches
// will show the new shorter run, which is the intended state.

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
    // Global — every popup open consumes these in the header / sidebar /
    // dashboard, so warming them is always a win.
    sendRsiMessage({ type: 'auth.identity' }),
    sendRsiMessage({ type: 'status.summary' }),
    sendRsiMessage({ type: 'notify.state' }),
    sendRsiMessage({ type: 'stats.summary' }),

    // High-traffic modules (BADGE_MODULES_DEFAULT alignment). These five
    // back the toolbar-badge unread counters by default and tend to be
    // the first stops once a user opens the popup. Other modules
    // (Hangar, Pledge, Galactapedia, Community Hub, Buy-Back, Org
    // Browser, Settings, etc.) fetch on first click via their own
    // `$effect` — fast enough for a single click target without
    // bloating the boot burst.
    sendRsiMessage({ type: 'commlink.list', page: 1 }),
    sendRsiMessage({ type: 'patchnotes.list', page: 1 }),
    sendRsiMessage({ type: 'spectrum.notifications' }),
    sendRsiMessage({ type: 'roadmap.data' }),
    sendRsiMessage({ type: 'contacts.list' }),
  ]).then((results) => {
    const durationMs = Math.round(performance.now() - startedAt);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      log.debug('prefetch', `${failed}/${results.length} prefetch calls rejected (benign — per-module UI retries)`);
    }
    // Report outcome to the background so the Settings → Prefetch panel
    // can show "last run: 850ms, 9 requests, 2 rejected" for diagnostics.
    void sendRsiMessage({
      type: 'settings.recordPrefetch',
      durationMs,
      requestCount: results.length,
      rejectedCount: failed,
    }).catch((e: unknown) => log.debug('prefetch', 'failed to record stats', e));
  });
}
