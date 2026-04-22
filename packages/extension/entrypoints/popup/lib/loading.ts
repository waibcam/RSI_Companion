// Loading-indicator flash suppression.
//
// Every module load function follows the same shape: set loading=true,
// await a sendRsiMessage call, set loading=false. The background serves
// cached responses in tens of milliseconds, which means the spinner
// flashes on every module mount even when nothing is actually being
// fetched over the network — visually noisy and confusing ("why is it
// loading? I was just here").
//
// `runWithDelayedLoading` wraps a task so the loading flag only flips to
// true after a threshold (default 200ms). Fast cache hits resolve under
// the threshold and never trigger the spinner. Real network fetches
// (cold start, a slow endpoint, the A-Z index crawl) cross the threshold
// and the loading indicator shows normally.

const DEFAULT_THRESHOLD_MS = 200;

export async function runWithDelayedLoading<T>(
  setLoading: (v: boolean) => void,
  task: () => Promise<T>,
  thresholdMs = DEFAULT_THRESHOLD_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    setLoading(true);
  }, thresholdMs);
  try {
    return await task();
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
      // Fast path: never flipped to true, nothing to reset.
    } else {
      // Threshold elapsed and loading flag went up — restore it.
      setLoading(false);
    }
  }
}
