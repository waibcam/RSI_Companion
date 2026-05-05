// Global "am I signed in to RSI" state.
//
// Set once on popup boot via `auth.identity` (a BG round-trip that
// hits the chrome.cookies API and the RSI identity endpoint when the
// 5-min identity cache misses). Auth-required modules read `signedIn`
// to skip rendering their UI when known-false (and to avoid the
// "flash of tabs → sign-in prompt" when a stale cookie is rejected
// mid-fetch).
//
// Tri-state semantics:
//   - null  = not yet resolved (initial state, show nothing / skeleton)
//   - true  = signed in, render normally
//   - false = not signed in, render SignInPrompt
//
// We let the 5-min identity cache apply: sign-in/out on the RSI site
// fires `chrome.cookies.onChanged` in the BG, which wipes the
// identity cache entry (and the short in-memory identify memo) — so
// a stale `signedIn` value can't outlive an actual auth flip. Paying
// a fresh RSI call on every popup open (including the many
// within-a-session re-opens) was the main source of redundant
// identify traffic in v2.

import { log, sendRsiMessage } from '@rsi-companion/shared';

function createAuthState() {
  let signedIn = $state<boolean | null>(null);
  let identity = $state<{ handle: string; displayName: string; avatarUrl: string | null } | null>(
    null,
  );

  async function refresh(force = false): Promise<void> {
    try {
      const res = await sendRsiMessage({ type: 'auth.identity', force });
      signedIn = res.signedIn;
      identity = res.identity;
    } catch (e) {
      // On any error treat as signed-out so the UI falls back to SignInPrompt
      // instead of hanging in the "unknown" state indefinitely.
      log.warn('auth', 'identity refresh failed, treating as signed out', e);
      signedIn = false;
      identity = null;
    }
  }

  // Resolve on module load so by the time modules mount the state is known.
  void refresh(false);

  return {
    get signedIn() {
      return signedIn;
    },
    get identity() {
      return identity;
    },
    refresh,
    /** Allow a module to push a freshly-observed `signedIn` so the rest of the
     *  popup updates without waiting for its own auth.identity refresh. */
    markSignedIn(v: boolean) {
      signedIn = v;
      if (!v) identity = null;
    },
  };
}

export const authState = createAuthState();
