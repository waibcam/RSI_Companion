// Side-effect module. Imported FIRST in main.ts so its body runs
// before any other popup module's top-level code — and therefore
// before any `chrome.*` call captures or invokes the wrong namespace.
//
// Why it exists
// -------------
// Firefox MV2 (and Waterfox / LibreWolf) provides the `chrome.*`
// namespace as a callback-style API for compatibility, while
// `browser.*` is Promise-native. Calling `chrome.runtime.sendMessage(msg)`
// without a callback returns `undefined` synchronously instead of a
// Promise — and the silent `await undefined` (resolves to undefined
// immediately) is exactly the failure mode that:
//
//   • broke popup → background message passing in 1.2.x (fixed in
//     1.3.0 via a per-call wrapper in shared/messaging.ts)
//   • broke Settings → UI scale +/- buttons in 1.3.x (fixed in 1.3.5
//     via a per-call wrapper in Settings.svelte for chrome.tabs.*)
//
// Per-call wrappers don't scale: every new `chrome.*` API surface a
// future module reaches for re-introduces the same class of bug.
//
// What it does
// ------------
// On Firefox / Waterfox / LibreWolf, `globalThis.browser` is the
// Promise-native namespace and `globalThis.browser.runtime.id` is set.
// We shadow `globalThis.chrome` with that object once at load time,
// so every subsequent `chrome.x.y(...)` call in any popup module —
// existing OR future, statically-imported OR lazy-loaded — transparently
// routes through the Promise-native namespace. WXT's auto-polyfill
// already does the same for the background bundle; this matches it
// for the popup.
//
// On Chrome / Edge / other Chromium browsers, `globalThis.browser` is
// undefined, the if-condition is false, and `chrome.*` keeps its
// native (already Promise-native) behavior. Zero overhead.

const g = globalThis as unknown as {
  browser?: { runtime?: { id?: string } } & Record<string, unknown>;
  chrome?: typeof chrome;
};

if (g.browser?.runtime?.id) {
  g.chrome = g.browser as unknown as typeof chrome;
}
