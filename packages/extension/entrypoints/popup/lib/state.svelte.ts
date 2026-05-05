// Backward-compatible barrel for the popup-wide reactive state.
//
// Historical context: until 1.5.5 every store (navigation, rate
// prompt, settings, badge modules, auth) lived in this single file
// alongside the module-registry constants and the `isTabMode`
// environment flag — about 700 lines mixing 5 unrelated concerns.
// 1.5.5 split each store into its own `stores/*.svelte.ts` file so
// future audit work (createResource, createPagedList, etc.) can
// land without touching unrelated stores.
//
// This barrel exists so existing imports (`import { appState,
// settingsState, ... } from './lib/state.svelte';` in 30+ Svelte
// files) keep resolving without a churn-day rename. New code can
// import directly from the granular paths if it prefers a tighter
// dependency:
//
//     import { appState } from './stores/nav.svelte';
//     import { settingsState } from './stores/settings.svelte';
//     // ...
//
// Singleton identity is preserved: `appState` here IS the same
// reference as the one exported from `stores/nav.svelte`, so a
// component reading via the barrel and another reading directly
// observe the same reactive state.

export { isTabMode } from './env';
export {
  MODULES,
  type ModuleDescriptor,
  type ModuleId,
  getEffectiveModules,
} from './module-registry';
export { appState } from './stores/nav.svelte';
export {
  ratePromptState,
  recordPopupOpen,
  type RatePromptResponse,
} from './stores/rate-prompt.svelte';
export {
  POPUP_SIZE_LIMITS,
  type SettingsTabId,
  isSettingsTabId,
  settingsState,
} from './stores/settings.svelte';
export { badgeModulesState } from './stores/badge-modules.svelte';
export { authState } from './stores/auth.svelte';
