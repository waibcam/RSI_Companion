import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifest: {
    name: 'RSI Companion',
    description: 'Improve your RSI experience on robertsspaceindustries.com.',
    // Firefox's validator rejects the object form of `author` — it must be
    // a plain string. Chrome accepts both shapes, so a string works on
    // both stores with a single manifest. WXT's manifest types still only
    // know the `{ email: string }` shape, hence the suppression.
    // @ts-expect-error WXT typings lag behind the runtime (string is valid).
    author: 'Camille (waibcam)',
    permissions: ['cookies', 'alarms', 'storage', 'scripting', 'tabs'],
    host_permissions: [
      'https://robertsspaceindustries.com/*',
      'https://status.robertsspaceindustries.com/*',
    ],
    // Firefox-specific metadata. `id` lets AMO track the extension across
    // updates without the store-assigned id; `data_collection_permissions`
    // is the new (2026) Mozilla privacy-consent declaration — `"none"`
    // advertises that no user data is collected anywhere in the
    // extension, matching the Privacy Policy.
    browser_specific_settings: {
      gecko: {
        // UUID assigned by AMO on the first upload of v1.0.0 (before we
        // set an explicit id). AMO binds the listing to this id, so every
        // subsequent upload must match — switching to a vanity id like
        // `rsi-companion@kamille.ovh` would require creating a brand new
        // listing and losing the review history. Left as-is.
        id: '{5f6df4d5-2bc0-4f21-9a05-ca509c64a7ff}',
        // @ts-expect-error WXT typings don't yet know about Firefox's
        // 2026 `data_collection_permissions` field (see
        // https://mzl.la/firefox-builtin-data-consent) but AMO requires
        // it. Runtime accepts it fine; only svelte-check complained.
        data_collection_permissions: {
          required: ['none'],
        },
      },
    },
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
  // The Firefox AMO reviewer must be able to rebuild the extension from
  // the sources.zip produced next to the packaged zip. Default WXT
  // `sourcesRoot` is the extension package only, which omits our
  // workspace dependency `@rsi-companion/shared`. Widen the root to the
  // monorepo and exclude the usual generated/vendored artifacts so the
  // archive stays reasonably small. `pnpm-lock.yaml` is intentionally
  // INCLUDED so `pnpm install --frozen-lockfile` reproduces the exact
  // dependency tree.
  zip: {
    sourcesRoot: '../..',
    excludeSources: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.wxt/**',
      '**/.output/**',
      '**/.turbo/**',
      '**/.vite/**',
      '**/.git/**',
      '**/.DS_Store',
      '**/coverage/**',
      // v2 tree and legacy PHP backend — not required to build v3.
      'packages/backend/**',
    ],
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
