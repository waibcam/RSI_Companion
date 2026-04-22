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
