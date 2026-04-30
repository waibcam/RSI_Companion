// Side-effect module. Imported once at popup boot so uncaught errors
// and unhandled promise rejections are funnelled into the existing
// log ring buffer (shared/log.ts) — and from there into the Settings
// → Diagnostics → Recent logs panel + the "Copy debug logs" button.
//
// Why it exists
// -------------
// Without this hook, an uncaught exception or unhandled rejection in
// the popup just appears as a console message that the user only sees
// if they happen to have DevTools open. The Hadjimels report on #44
// (chrome.tabs.getCurrent() returning undefined on Firefox) was a
// textbook example — the user only included the console error
// because they thought to look. Most users won't.
//
// What it does
// ------------
// Catches the two browser-level error events (`error` for sync
// throws bubbled to the window, `unhandledrejection` for async ones
// without a `.catch`) and pushes them into the same ring buffer that
// our regular `log.error(...)` calls use. The user can then dump the
// logs from Settings → Diagnostics without us asking them to open
// DevTools first.

import { log } from '@rsi-companion/shared';

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason;
  const message =
    reason instanceof Error
      ? reason.message
      : typeof reason === 'string'
        ? reason
        : 'unknown rejection';
  log.error('uncaught', `unhandled promise rejection: ${message}`, reason);
});

window.addEventListener('error', (event) => {
  log.error('uncaught', `script error: ${event.message}`, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
  });
});
