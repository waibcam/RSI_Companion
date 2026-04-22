// Lightweight structured logger. The background worker and popup modules
// used to silently swallow errors via `catch {}`, which is fine until you
// need to diagnose a user report and realize the extension has zero trail.
//
// Every call goes to console (so it's visible in the service-worker / popup
// DevTools), AND is pushed into a capped in-memory ring buffer that the
// popup can dump via a "Copy debug logs" button if we ever add one.
//
// Kept deliberately tiny — this is a debugging aid, not telemetry. Nothing
// is persisted across reloads; nothing is sent off-device.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  time: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

const MAX_ENTRIES = 200;
const ring: LogEntry[] = [];

function push(level: LogLevel, scope: string, message: string, data?: unknown): void {
  const entry: LogEntry = { time: Date.now(), level, scope, message, data };
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.shift();

  const tag = `[${scope}]`;
  const args: unknown[] = data === undefined ? [tag, message] : [tag, message, data];
  switch (level) {
    case 'debug':
      console.debug(...args);
      break;
    case 'info':
      console.info(...args);
      break;
    case 'warn':
      console.warn(...args);
      break;
    case 'error':
      console.error(...args);
      break;
  }
}

export const log = {
  debug: (scope: string, message: string, data?: unknown) => push('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => push('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => push('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => push('error', scope, message, data),
  /** Snapshot of recent entries (oldest first). */
  snapshot: (): LogEntry[] => ring.slice(),
  /** Pretty-printed text dump for clipboard / bug reports. */
  dump: (): string =>
    ring
      .map((e) => {
        const ts = new Date(e.time).toISOString();
        const payload = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
        return `${ts} ${e.level.toUpperCase().padEnd(5)} [${e.scope}] ${e.message}${payload}`;
      })
      .join('\n'),
};
