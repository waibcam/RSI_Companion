// Static catalogue of every popup module + the helper that resolves
// the user-effective sidebar list from their order/hidden preferences.
//
// Keeps the union type and the ordered descriptors next to each other
// so adding a new module is a single edit (the union, the MODULES
// array, the icon mapping in Sidebar.svelte, and the loader in
// App.svelte). All other surfaces — Settings sidebar-modules card,
// keyboard shortcuts (Alt+1..9), prefetch list — derive from
// MODULES via `getEffectiveModules`.

/** Every module the popup knows about. Order here is the *default*
 *  sidebar order — the user can reorder via Settings → Sidebar
 *  modules. New modules appended here automatically appear at the
 *  bottom of an existing user's sidebar (see `getEffectiveModules`). */
export type ModuleId =
  | 'roadmap'
  | 'progress-tracker'
  | 'release-notes'
  | 'dashboard'
  | 'ships'
  | 'hangar'
  | 'buy-back'
  | 'pledge-store'
  | 'comm-link'
  | 'patch-notes'
  | 'spectrum'
  | 'contacts'
  | 'organizations'
  | 'org-browser'
  | 'community-hub'
  | 'galactapedia'
  | 'support'
  | 'settings';

export interface ModuleDescriptor {
  id: ModuleId;
  label: string;
  /** true = already implemented in v3 */
  ready: boolean;
}

// Sidebar ordering follows a rough "what is this for" grouping:
//   News & community first (Comm-Link, Spectrum, Community Hub)
//   Build tracking together (Roadmap ↔ Patch Notes are directly related)
//   Personal account middle (Dashboard, Ships, Buy-Back, Contacts, Orgs)
//   Reference (Org Browser, Galactapedia)
//
// Release Notes used to live here — it's about the extension itself, not RSI
// content, so it now lives in a Header button (see App.svelte / Header.svelte).
export const MODULES: ReadonlyArray<ModuleDescriptor> = [
  { id: 'comm-link',      label: 'Comm-Link',     ready: true },
  { id: 'spectrum',       label: 'Spectrum',      ready: true },
  { id: 'community-hub',  label: 'Community Hub', ready: true },
  { id: 'roadmap',           label: 'Roadmap',           ready: true },
  { id: 'progress-tracker',  label: 'Progress Tracker',  ready: true },
  { id: 'patch-notes',       label: 'Patch Notes',       ready: true },
  { id: 'dashboard',      label: 'Dashboard',     ready: true },
  { id: 'ships',          label: 'Ships',         ready: true },
  // Hangar sits between Ships and Buy-Back / Pledge Store: Ships is the
  // matrix-overlay view ("everything CIG ever made, with my owned flag"),
  // Hangar is the per-pledge breakdown ("the X pledges in my account,
  // each with their N ships and metadata"), Buy-Back / Pledge Store are
  // outflow / inflow surfaces. Logical "what I have → details of what
  // I have → what I can buy" reading order.
  { id: 'hangar',         label: 'Hangar',        ready: true },
  { id: 'buy-back',       label: 'Buy-Back',      ready: true },
  { id: 'pledge-store',   label: 'Pledge Store',  ready: true },
  { id: 'contacts',       label: 'Contacts',      ready: true },
  { id: 'organizations',  label: 'Organizations', ready: true },
  { id: 'org-browser',    label: 'Org Browser',   ready: true },
  { id: 'galactapedia',   label: 'Galactapedia',  ready: true },
  // Support sits just before Settings — it's a sibling concept (extension
  // self-care: bug reports, feedback, FAQ, links to GitHub/Discord/privacy)
  // but stays hide-able like any normal module. Settings remains the only
  // pinned-always-visible entry.
  { id: 'support',        label: 'Support',       ready: true },
  { id: 'settings',       label: 'Settings',      ready: true },
];

/** Effective sidebar module list: user-defined order first, then any
 *  unknown/new modules appended in their MODULES order, then hidden
 *  modules filtered out. Memoized per (order, hidden) pair via $derived
 *  when consumed in a Svelte context — here we just return the array.
 *  The Settings module itself is ALWAYS visible and always last, even
 *  if the user tries to hide it (otherwise they'd be stuck). */
export function getEffectiveModules(
  order: readonly ModuleId[],
  hidden: readonly ModuleId[],
): ModuleDescriptor[] {
  const hiddenSet = new Set(hidden);
  const byId = new Map(MODULES.map((m) => [m.id, m]));
  const seen = new Set<ModuleId>();
  const out: ModuleDescriptor[] = [];

  // 1) User-defined order, filtering unknowns and hidden (except 'settings')
  for (const id of order) {
    if (seen.has(id)) continue;
    const mod = byId.get(id);
    if (!mod) continue; // stale entry from a removed module
    if (id !== 'settings' && hiddenSet.has(id)) continue;
    seen.add(id);
    if (id !== 'settings') out.push(mod);
  }
  // 2) Modules not in the user's order yet (new ones after an update)
  for (const mod of MODULES) {
    if (seen.has(mod.id)) continue;
    if (mod.id === 'settings') continue;
    if (hiddenSet.has(mod.id)) continue;
    out.push(mod);
  }
  // 3) Settings always last + always visible
  const settings = byId.get('settings');
  if (settings) out.push(settings);
  return out;
}
