// fetch() doesn't time out by default — hung RSI requests would just sit
// forever and pin the service worker. fetchWithTimeout wraps fetch with an
// AbortController so every outbound call fails fast on network stalls.
//
// We also guard against runaway response bodies. RSI is trusted-ish, but a
// misconfigured or poisoned response of tens of megabytes would exhaust the
// service worker's memory before the JSON/HTML parsers can bail. Both the
// Content-Length header (when present) and the actual streamed body size
// are checked against a ceiling.

export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
/**
 * Hard upper bound on any RSI response body we'll buffer. 8 MB comfortably
 * covers every legitimate payload seen in practice — the biggest (the full
 * Galactapedia index crawl page) is ~200 KB, org listings ~500 KB.
 */
export const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export class FetchTimeoutError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'FetchTimeoutError';
  }
}

export class FetchBodyTooLargeError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly maxBytes: number,
  ) {
    super(message);
    this.name = 'FetchBodyTooLargeError';
  }
}

export interface FetchWithTimeoutOptions {
  timeoutMs?: number;
  /** Maximum allowed response body size in bytes. Defaults to DEFAULT_MAX_BODY_BYTES. */
  maxBodyBytes?: number;
}

/**
 * Wraps `response.text()` / `.json()` with an up-front Content-Length check
 * plus a streamed cap so pathologically large bodies can't exhaust memory.
 * Returns the same Response shape but with text/json guaranteed bounded.
 */
function enforceBodyLimit(response: Response, url: string, maxBytes: number): Response {
  const declared = response.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new FetchBodyTooLargeError(
        `Response body ${n}B exceeds limit ${maxBytes}B: ${url}`,
        url,
        maxBytes,
      );
    }
  }

  if (!response.body) return response;

  // Stream-cap: re-wrap the body in a ReadableStream that aborts when the
  // cumulative byte count exceeds the ceiling. The branching on body being
  // already consumed is why we clone() first — calling .text() / .json()
  // on the returned Response will go through this wrapper.
  const reader = response.body.getReader();
  let received = 0;
  const capped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      received += value.byteLength;
      if (received > maxBytes) {
        controller.error(
          new FetchBodyTooLargeError(
            `Response body exceeded limit ${maxBytes}B mid-stream: ${url}`,
            url,
            maxBytes,
          ),
        );
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      try {
        void reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(capped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithTimeoutOptions,
): Promise<Response> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = options?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Compose with any caller-provided signal so their abort still works.
  const userSignal = init?.signal;
  const onUserAbort = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }

  const urlStr = typeof input === 'string' ? input : input.toString();
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    return enforceBodyLimit(response, urlStr, maxBytes);
  } catch (e) {
    if (controller.signal.aborted && !userSignal?.aborted) {
      throw new FetchTimeoutError(
        `Request timed out after ${timeoutMs}ms: ${urlStr}`,
        urlStr,
        timeoutMs,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
  }
}

// ----- Retry-aware fetch ----------------------------------------------------
//
// Wraps `fetchWithTimeout` with a centralised retry policy for the two
// transient failure modes that crop up against RSI's API:
//
//   - HTTP 429 (rate-limited)  → respect `Retry-After` if present
//                                 (capped via `maxRetryAfterMs` so a hostile
//                                 or buggy header can't pin the BG worker
//                                 for hours), otherwise treat as 5xx.
//   - HTTP 5xx (server error)  → exponential backoff with full-jitter
//                                 (range [0, base * 2^attempt]).
//   - Network error            → same exponential backoff as 5xx.
//
// 4xx responses other than 429 are NOT retried — they're caller-input
// problems (auth expired, bad query) and the caller's error-handling
// path already deals with them. 429 IS retried because RSI sometimes
// over-throttles burst polls and a one-second wait fixes it cleanly
// without surfacing an error to the user.
//
// Default policy: 2 retries (3 total attempts), 500 ms base, 60 s
// Retry-After cap. Callers can tune via options. POST endpoints that
// might be non-idempotent should pass `maxRetries: 0` (or just keep
// using `fetchWithTimeout`) to opt out.

export interface FetchWithRetryOptions extends FetchWithTimeoutOptions {
  /** Number of retry attempts AFTER the initial fetch. Default 2
   *  (3 total attempts). Pass 0 to disable retry while still keeping
   *  the timeout + body-limit guards. */
  maxRetries?: number;
  /** Base delay (ms) for exponential backoff on 5xx / network errors.
   *  Effective sleep is `random(0, base * 2^attempt)` — full-jitter
   *  avoids the "every client retries at the same instant" stampede
   *  pattern that pure exponential gives. Default 500 ms. */
  baseDelayMs?: number;
  /** Cap on `Retry-After` honouring. RSI's headers are typically
   *  small (1–10 s), but we don't want a buggy or hostile value to
   *  freeze the BG worker for hours. Default 60_000 (1 min). */
  maxRetryAfterMs?: number;
  /** Telemetry hook fired between attempts. `attempt` is 1-indexed
   *  (the FIRST retry passes attempt=1). Used by the cache layer to
   *  surface "rate-limited, backing off" diagnostics. */
  onRetry?: (
    attempt: number,
    reason: 'rate-limit' | 'server-error' | 'network',
    waitMs: number,
  ) => void;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

/** Parse a `Retry-After` header into milliseconds. The header can be
 *  either an integer count of seconds or an HTTP-date. Returns null
 *  when missing, malformed, or in the past. */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Numeric form: integer seconds.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  // HTTP-date form (RFC 7231): parse and diff with now.
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return null;
  const delta = ts - Date.now();
  return delta > 0 ? delta : 0;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Fetch with timeout AND a transient-error retry policy. See the
 *  block comment above for the full policy. Returns the final
 *  Response (which may itself be a 4xx the caller has to handle) or
 *  rethrows after exhausting retries. */
export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxRetryAfterMs = options?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const onRetry = options?.onRetry;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(input, init, options);

      if (response.status === 429 && attempt < maxRetries) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const wait =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, maxRetryAfterMs)
            : Math.floor(Math.random() * baseDelayMs * 2 ** attempt);
        onRetry?.(attempt + 1, 'rate-limit', wait);
        // Drain the body so the underlying connection can be reused
        // (Chrome holds onto connections with un-consumed bodies).
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(wait, init?.signal ?? undefined);
        continue;
      }

      if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
        const wait = Math.floor(Math.random() * baseDelayMs * 2 ** attempt);
        onRetry?.(attempt + 1, 'server-error', wait);
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        await sleep(wait, init?.signal ?? undefined);
        continue;
      }

      return response;
    } catch (e) {
      lastError = e;
      // Timeouts and abort errors propagate without retry — the
      // caller's signal won (or the platform timeout already
      // bottomed out). Other network errors get the same backoff
      // as 5xx.
      if (e instanceof FetchTimeoutError) throw e;
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (attempt < maxRetries) {
        const wait = Math.floor(Math.random() * baseDelayMs * 2 ** attempt);
        onRetry?.(attempt + 1, 'network', wait);
        await sleep(wait, init?.signal ?? undefined);
        continue;
      }
      throw e;
    }
  }

  // Unreachable: the loop either returns a Response, throws, or
  // continues. The fallback exists to satisfy the type checker.
  throw lastError ?? new Error('fetchWithRetry exhausted without a response');
}
