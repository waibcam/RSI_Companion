// Popup environment detection. Single source of truth for "is this
// popup running as a browser-tab page or as a toolbar-popup window?".
//
// Read once at module load — neither the URL nor the popup mode can
// flip at runtime — so consumers can `import { isTabMode } from
// './env';` without worrying about reactive subscriptions. Used to
// gate the `tab:` Tailwind variant breakpoints (wider sidebar,
// densified Settings tabs, larger Spectrum lobbies grid) and to
// skip the toolbar-popup width/height clamping in App.svelte.

/** True when popup.html was opened in a browser tab (`?mode=tab`)
 *  rather than as the toolbar popup. Fixed at load time — never
 *  changes. Wrapped in a try so an extension context with no
 *  `window.location` (e.g. tests) doesn't crash boot. */
export const isTabMode: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mode') === 'tab';
  } catch {
    return false;
  }
})();
