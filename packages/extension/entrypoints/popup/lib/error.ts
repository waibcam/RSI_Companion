// Extract structured metadata from errors thrown by sendRsiMessage.
//
// The background worker attaches a `signedIn: false` flag on its error
// responses for auth-required handlers (see messaging.ts — the rejected
// promise's Error has an extra property merged in). Every module was
// hand-casting `(e as Error & { signedIn?: boolean }).signedIn` — four or
// five call-sites each with its own cast expression. One helper keeps the
// cast tidy and gives us a single knob if the contract ever changes.

export interface AuthAwareError extends Error {
  signedIn?: boolean;
}

/** Pull a `signedIn` flag off an arbitrary thrown value. Returns `undefined`
 *  when the error is generic (unknown auth status) so callers can decide to
 *  preserve their current signedIn assumption rather than flipping it. */
export function extractSignedIn(e: unknown): boolean | undefined {
  if (e && typeof e === 'object' && 'signedIn' in e) {
    const v = (e as { signedIn?: unknown }).signedIn;
    if (typeof v === 'boolean') return v;
  }
  return undefined;
}

/** Turn any thrown value into a displayable message string. Mirrors the
 *  `e instanceof Error ? e.message : String(e)` pattern scattered across
 *  every module. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
