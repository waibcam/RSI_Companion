// Reactive store for the RSI Status summary.
//
// Two call sites:
//   1. Header status pill — reads the current state to color itself + show
//      a tooltip. Triggers `ensureLoaded()` on mount.
//   2. Module error banners — call `ensureLoaded()` before rendering an error
//      so the banner can add "RSI is currently reporting an incident" context
//      when the fetch failure coincides with a known status issue.
//
// The background caches the JSON feed for 90 s, so multiple popup components
// calling ensureLoaded() share one HTTP round-trip per popup session.

import {
  log,
  sendRsiMessage,
  type StatusSummaryResponsePayload,
  type Rsi,
} from '@rsi-companion/shared';

type StatusSummary = StatusSummaryResponsePayload;

function createStatusState() {
  let summary = $state<StatusSummary | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let requested = false;

  async function load(force = false) {
    loading = true;
    error = null;
    try {
      summary = await sendRsiMessage({ type: 'status.summary', force });
    } catch (e) {
      // Status lookup failing is itself a hint that something network-level
      // is wrong (status.rsi is hosted separately from the main site, so a
      // failure here often means the user is offline, not that RSI is down).
      // We surface the error but don't escalate — callers fall through to
      // their own error rendering.
      error = e instanceof Error ? e.message : String(e);
      log.warn('status', 'fetch failed', e);
    } finally {
      loading = false;
    }
  }

  function ensureLoaded(): void {
    if (requested) return;
    requested = true;
    void load(false);
  }

  async function refresh(): Promise<void> {
    await load(true);
  }

  return {
    get summary(): Rsi.RsiStatusSummary | null {
      return summary?.summary ?? null;
    },
    get fetchedAt(): number | null {
      return summary?.fetchedAt ?? null;
    },
    get fromCache(): boolean {
      return summary?.fromCache ?? false;
    },
    get loading(): boolean {
      return loading;
    },
    get error(): string | null {
      return error;
    },
    /** True when RSI is reporting a user-visible problem (disrupted / down /
     *  maintenance). `notice` level returns false — that's informational. */
    get hasIncident(): boolean {
      const lvl = summary?.summary.level;
      return lvl === 'disrupted' || lvl === 'down' || lvl === 'maintenance';
    },
    ensureLoaded,
    refresh,
  };
}

export const statusState = createStatusState();
