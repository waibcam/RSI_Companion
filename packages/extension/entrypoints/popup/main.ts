// IMPORTANT: ./lib/polyfill MUST be the first import. It shadows
// globalThis.chrome with globalThis.browser on Firefox / Waterfox /
// LibreWolf so every chrome.* call in the popup transparently routes
// through the Promise-native namespace. The shadow has to be in
// place BEFORE any other module's top-level code runs.
import './lib/polyfill';
// Capture uncaught exceptions + unhandled promise rejections into the
// log ring buffer. Surfaces silent crashes in Settings → Diagnostics
// without forcing the user to open DevTools.
import './lib/error-handler';
import { mount } from 'svelte';
import './app.css';
import App from './App.svelte';
import { prefetchAll } from './lib/prefetch';

const target = document.getElementById('app');
if (!target) throw new Error('#app root not found');

// Warm every module's cache in parallel as soon as the popup starts. Each
// call either hits the background storage cache (free) or triggers a fetch
// the per-module component would have done a moment later anyway — firing
// them all now lets module chunks load + render against already-warm data.
// Non-blocking: mount proceeds immediately.
prefetchAll();

mount(App, { target });
