// Reactive wrapper around the background worker's notify state. The popup
// fetches the current state on mount, listens for chrome.storage changes so
// polls performed while the popup is open update the UI live, and exposes
// `markSeen(module)` to clear a module's unread count when the user opens it.

import {
  Notify,
  log,
  sendRsiMessage,
  type NotifyStateResponse,
} from '@rsi-companion/shared';

const STORAGE_KEY = 'notify:state';

function createNotifyState() {
  let state = $state<NotifyStateResponse>({
    signedIn: false,
    counts: { ...Notify.EMPTY_COUNTS },
    lastPolledAt: null,
    lastErrors: {},
  });

  let initialized = false;

  async function refresh(): Promise<void> {
    try {
      const next = await sendRsiMessage({ type: 'notify.state' });
      state = next;
    } catch (e) {
      // Non-fatal: the poll alarm will retry. Log so bug-report dumps still
      // show us what went wrong instead of hiding the failure entirely.
      log.warn('notify', 'state refresh failed', e);
    }
  }

  function init(): void {
    if (initialized) return;
    initialized = true;
    refresh();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const change = changes[STORAGE_KEY];
      if (!change) return;
      const next = change.newValue as NotifyStateResponse | undefined;
      if (next) state = next;
    });
  }

  async function markSeen(module: Notify.NotifyModule): Promise<void> {
    if (state.counts[module] === 0) return;
    // Optimistic local update: zero the count immediately so the
    // toolbar badge and sidebar pill drop visually before the BG
    // round-trip resolves. Without this, fast users (Dakota report
    // 2026-05-04: "I have to click on Notes twice") would close the
    // popup before the BG's markSeen response landed and the next
    // popup-open would still see the old number until init() pulled
    // fresh state from storage. The await below overwrites this
    // optimistic state with the authoritative one — if the BG
    // disagrees, the badge briefly drops then reappears, but in
    // practice the BG always agrees (it's just persisting what we
    // optimistically set locally).
    state = {
      ...state,
      counts: { ...state.counts, [module]: 0 },
    };
    try {
      const next = await sendRsiMessage({ type: 'notify.markSeen', module });
      state = next;
    } catch (e) {
      log.warn('notify', `markSeen(${module}) failed`, e);
    }
  }

  async function pollNow(): Promise<void> {
    try {
      const next = await sendRsiMessage({ type: 'notify.poll' });
      state = next;
    } catch (e) {
      log.warn('notify', 'pollNow failed', e);
    }
  }

  return {
    get state() {
      return state;
    },
    init,
    refresh,
    markSeen,
    pollNow,
  };
}

export const notifyState = createNotifyState();
