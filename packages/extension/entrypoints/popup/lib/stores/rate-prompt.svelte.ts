// "Do you like the extension?" prompt state.
//
// Lightweight install-tracking + response storage. Lives in localStorage
// under the popup: namespace alongside every other UI pref. We only
// surface the prompt after the user has had time to actually try the
// extension — both on the calendar and on real usage:
//   firstSeenAt  : ms-epoch of the first popup open we saw. Set once.
//   opens        : how many popup opens since first install. Incremented
//                  on every App.svelte mount via `recordPopupOpen`.
//   response     : 'liked' | 'disliked' | 'snoozed' | 'never' | null
//   lastSnoozeAt : when the user clicked "Ask me later". Snoozed prompts
//                  re-arm after another 7 days; the other terminal
//                  responses ('liked' / 'disliked' / 'never') stick
//                  forever.
//
// The eligibility derived (`shouldShow`) is: at least 7 days
// since first install, at least 5 popup opens, AND no terminal response
// stored. Snoozed prompts also need 7 days from the last snooze.

import { log } from '@rsi-companion/shared';

const RATE_KEYS = {
  firstSeenAt: 'rate:firstSeenAt',
  opens: 'rate:opens',
  response: 'rate:response',
  lastSnoozeAt: 'rate:lastSnoozeAt',
} as const;

export type RatePromptResponse = 'liked' | 'disliked' | 'snoozed' | 'never' | null;

const RATE_MIN_DAYS = 7;
const RATE_MIN_OPENS = 5;
const RATE_SNOOZE_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Local helpers — small enough that consolidating them with
// persist.svelte.ts would only save 10 lines and would also force a
// key-namespace migration (persist.svelte.ts owns the `popup:` prefix
// implicitly, while these add it explicitly to keep the storage shape
// stable across versions). Keeping them inline preserves binary
// compatibility for users upgrading from earlier 1.5.x.

function readNumber(key: string, fallback = 0): number {
  try {
    const raw = localStorage.getItem('popup:' + key);
    if (raw == null) return fallback;
    const n = Number(JSON.parse(raw));
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonScalar(key: string, value: unknown): void {
  try {
    localStorage.setItem('popup:' + key, JSON.stringify(value));
  } catch (e) {
    log.warn('rate', `failed to persist ${key}`, e);
  }
}

function readResponse(): RatePromptResponse {
  try {
    const raw = localStorage.getItem('popup:' + RATE_KEYS.response);
    if (raw == null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === 'liked' ||
      parsed === 'disliked' ||
      parsed === 'snoozed' ||
      parsed === 'never'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/** Called once on App mount. Sets `firstSeenAt` if missing and bumps
 *  the popup-open counter. Cheap: two localStorage writes max. */
export function recordPopupOpen(): void {
  const firstSeenAt = readNumber(RATE_KEYS.firstSeenAt, 0);
  if (firstSeenAt === 0) {
    writeJsonScalar(RATE_KEYS.firstSeenAt, Date.now());
  }
  const opens = readNumber(RATE_KEYS.opens, 0);
  writeJsonScalar(RATE_KEYS.opens, opens + 1);
}

/** Reactive snapshot of the prompt's current state. The RatePrompt
 *  component reads this to decide whether to render. */
function createRatePromptState() {
  let firstSeenAt = $state<number>(readNumber(RATE_KEYS.firstSeenAt, 0));
  let opens = $state<number>(readNumber(RATE_KEYS.opens, 0));
  let response = $state<RatePromptResponse>(readResponse());
  let lastSnoozeAt = $state<number>(readNumber(RATE_KEYS.lastSnoozeAt, 0));
  // Test override — let the maintainer (or anyone via Settings →
  // Diagnostics → "Trigger rate prompt") preview the banner without
  // waiting for the calendar / opens gates. Not persisted; resets on
  // popup close.
  let forceShow = $state(false);

  return {
    get firstSeenAt() {
      return firstSeenAt;
    },
    get opens() {
      return opens;
    },
    get response() {
      return response;
    },
    get lastSnoozeAt() {
      return lastSnoozeAt;
    },
    /** Whether the "Do you like the extension?" banner should show
     *  right now. Combines the calendar gate, the usage gate, and
     *  the response gate (incl. snooze). The `forceShow` test flag
     *  bypasses every gate. */
    get shouldShow(): boolean {
      if (forceShow) return true;
      // Terminal responses other than 'snoozed' freeze the prompt
      // forever — the user told us their answer, we stop asking.
      if (response === 'liked' || response === 'disliked' || response === 'never')
        return false;
      // Calendar gate.
      if (firstSeenAt === 0) return false;
      if (Date.now() - firstSeenAt < RATE_MIN_DAYS * ONE_DAY_MS) return false;
      // Usage gate — at least N popup opens. Means a fresh install
      // can't trigger the prompt before the user has actually used
      // the extension.
      if (opens < RATE_MIN_OPENS) return false;
      // Snooze gate — re-arm 7 days after the user last clicked
      // "Ask me later".
      if (response === 'snoozed') {
        if (Date.now() - lastSnoozeAt < RATE_SNOOZE_DAYS * ONE_DAY_MS) return false;
      }
      return true;
    },
    /** Lock in a terminal response (or transition to 'snoozed').
     *  Idempotent — safe to call from any of the prompt's button
     *  handlers without checking the current state. */
    setResponse(next: RatePromptResponse): void {
      response = next;
      writeJsonScalar(RATE_KEYS.response, next);
      if (next === 'snoozed') {
        const now = Date.now();
        lastSnoozeAt = now;
        writeJsonScalar(RATE_KEYS.lastSnoozeAt, now);
      }
      // Any explicit response also clears the test override so the
      // banner doesn't bounce back when the user closes the
      // "thanks" panel.
      forceShow = false;
    },
    /** Test trigger. Wired into Settings → Diagnostics so the
     *  maintainer can preview the banner immediately instead of
     *  waiting 7 days. Also resets the response to null so the
     *  prompt isn't immediately suppressed by a previous click. */
    showForTesting(): void {
      response = null;
      writeJsonScalar(RATE_KEYS.response, null);
      forceShow = true;
    },
    /** Wipe every rate-prompt key. Useful for QA / debug — gets the
     *  install back to "first-time" state so the regular gates
     *  re-engage from scratch. */
    reset(): void {
      firstSeenAt = 0;
      opens = 0;
      response = null;
      lastSnoozeAt = 0;
      forceShow = false;
      writeJsonScalar(RATE_KEYS.firstSeenAt, 0);
      writeJsonScalar(RATE_KEYS.opens, 0);
      writeJsonScalar(RATE_KEYS.response, null);
      writeJsonScalar(RATE_KEYS.lastSnoozeAt, 0);
    },
  };
}

export const ratePromptState = createRatePromptState();
