import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'RSI Companion',
    description: 'Improve your RSI experience on robertsspaceindustries.com.',
    author: { email: 'contact@kamille.ovh' },
    permissions: ['cookies', 'alarms', 'storage', 'scripting', 'tabs'],
    host_permissions: [
      'https://robertsspaceindustries.com/*',
      'https://status.robertsspaceindustries.com/*',
    ],
    action: {
      default_title: 'RSI Companion',
      default_popup: 'popup.html',
    },
    icons: {
      64: 'icon/64.png',
      128: 'icon/128.png',
      256: 'icon/256.png',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
    build: {
      // Emit sourcemaps when ANALYZE=1. Used by the root `pnpm analyze`
      // script with source-map-explorer to break down chunk contents without
      // committing a new devDependency — run on-demand via pnpm dlx.
      // The analyze script passes --no-border-checks to source-map-explorer
      // so Rollup's occasional `Infinity` column mappings don't abort it.
      sourcemap: process.env.ANALYZE === '1',
      // NOTE on vendor chunking: WXT builds the background entrypoint with
      // `output.inlineDynamicImports: true` (required for MV3 service
      // workers), which Rollup rejects alongside `output.manualChunks`. So
      // any global manualChunks config breaks the background build. And
      // since the popup's chunks already load from the packed extension's
      // local filesystem — no HTTP round trips — grouping icons into a
      // single vendor-lucide chunk wouldn't save real latency anyway. Left
      // off intentionally.
    },
  }),
  outDir: 'dist',
});
