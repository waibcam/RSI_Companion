# RSI Companion

A browser extension for [robertsspaceindustries.com](https://robertsspaceindustries.com)
(Star Citizen). Supports Chrome, Edge and Firefox from a single Manifest V3 codebase.

---

## Build instructions (Firefox AMO reviewers)

This section documents how to rebuild the extension from this source archive
exactly as it was uploaded to the Firefox Add-ons store.

### Operating system

Any OS with Node.js and pnpm installed. Verified on Windows 10/11 and Linux.
No platform-specific steps.

### Required tooling

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 (tested on 24.13.0) | https://nodejs.org/en/download |
| pnpm    | ≥ 10 (tested on 10.33.0) | `corepack enable` (bundled with Node) or `npm install -g pnpm` |

No other system dependencies. No native modules, no PHP, no compilers,
no Python, no Rust.

### Steps

From the unzipped source archive root (contains `package.json`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, and a `packages/` directory):

```sh
pnpm install --frozen-lockfile
pnpm --filter @rsi-companion/extension zip:firefox
```

Output:

```
packages/extension/dist/rsi-companionextension-1.0.0-firefox.zip
```

The content of this zip is byte-identical to the one submitted to AMO
(timestamps aside). No remote code is fetched during the build. No
dependency is patched. The lockfile pins every dependency to an exact
version.

### What the build does

- `pnpm install --frozen-lockfile` installs the pinned dependency tree
  defined in `pnpm-lock.yaml` into `node_modules/`.
- `pnpm --filter @rsi-companion/extension zip:firefox` runs
  `wxt zip -b firefox`, which type-checks and bundles the TypeScript +
  Svelte 5 sources via Vite with Rollup, producing `dist/firefox-mv2/`
  (background script, popup HTML + chunks, assets, manifest) and then
  compresses that folder into the final `.zip`.

### Source tree

```
packages/extension/    WXT + Svelte 5 + TypeScript + Tailwind v4 extension
packages/shared/       Shared TypeScript types, Zod schemas and RSI API
                       wrappers (workspace dependency of packages/extension)
```

No minified, transpiled, machine-generated or obfuscated source files
are shipped in either package.

### Third-party libraries (bundled)

Runtime: `svelte` 5, `zod`, `lucide-svelte`, `linkedom`, `tailwindcss` v4.
Build-only: `wxt`, `vite`, `typescript`, `svelte-check`,
`@wxt-dev/module-svelte`, `@tailwindcss/vite`.

All are open-source and installed from the public npm registry via the
pinned `pnpm-lock.yaml`. No private packages.

---

## Repository layout

```
packages/
├── extension/   WXT + Svelte 5 + TypeScript + Tailwind v4 extension (MV3)
└── shared/      TypeScript types, Zod schemas, RSI API wrappers
```

## Development

```sh
pnpm install

pnpm dev                                       # Chrome/Edge dev profile
pnpm --filter @rsi-companion/extension dev:firefox  # Firefox dev profile

pnpm --filter @rsi-companion/shared test       # run shared-package tests
```

## Building for release

```sh
pnpm --filter @rsi-companion/extension zip           # Chrome Web Store ZIP
pnpm --filter @rsi-companion/extension zip:edge      # Edge Add-ons ZIP
pnpm --filter @rsi-companion/extension zip:firefox   # AMO ZIP (+ sources)
```

## Privacy

The extension has no backend component and does not collect, transmit,
sell or share any user data. All caching happens in `chrome.storage.local`
inside the user's browser. See the full policy at
<https://rsi-companion.kamille.ovh/Privacy_Policy.html>.

## Source repository

<https://github.com/waibcam/RSI_Companion> (branch `v3`)

## Bug reports

GitHub Issues: <https://github.com/waibcam/RSI_Companion/issues>

## License

GPL-3.0-only. See [COPYING](COPYING).

## Authors

- [Kamille92](https://github.com/waibcam) — original author and v1.0.0 rewrite.
- See the full list of [contributors](https://github.com/waibcam/RSI_Companion/contributors) on the legacy branch.
