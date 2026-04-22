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
