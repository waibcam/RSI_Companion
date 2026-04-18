# RSI Companion — v3

A browser extension for [robertsspaceindustries.com](https://robertsspaceindustries.com) (Star Citizen).

> **v3 is a ground-up rewrite.** The legacy v0.2.x source lives on the `master` branch and stopped
> working when Chrome removed support for Manifest V2 in 2024. The `v3` branch is Manifest V3,
> supports Chrome / Edge / Firefox from a single codebase, and ships with a modernized PHP backend.

## Repository layout

```
v3/
├── packages/
│   ├── extension/   WXT + Svelte 5 + TypeScript + Tailwind v4 browser extension (MV3)
│   ├── backend/     PHP 7.4 / Slim 4 / SQLite API served at rsi-companion.kamille.ovh
│   └── shared/      TypeScript types + Zod schemas shared with the extension
├── package.json     pnpm workspace root
└── pnpm-workspace.yaml
```

## Prerequisites

- Node.js ≥ 20, pnpm ≥ 9 (use `corepack enable` or `npm i -g pnpm`)
- PHP ≥ 7.4 with `pdo_sqlite` (only needed to run the backend locally)
- Composer

## Quickstart

```sh
pnpm install

# Extension (Chrome/Edge — auto-opens a profile with the extension loaded)
pnpm dev

# Extension (Firefox)
pnpm dev:firefox

# Backend (serves on http://127.0.0.1:8080)
cd packages/backend
composer install
cp .env.example .env
sqlite3 data/app.sqlite < migrations/001_init.sql
composer start
```

## Building for release

```sh
pnpm --filter=@rsi-companion/extension build           # Chrome/Edge bundle
pnpm --filter=@rsi-companion/extension build:firefox   # Firefox bundle
pnpm --filter=@rsi-companion/extension zip             # Chrome store ZIP
pnpm --filter=@rsi-companion/extension zip:firefox     # AMO ZIP
```

## Roadmap of the rewrite

- **Phase 0** — Monorepo scaffold, branch split, tooling (✅ current).
- **Phase 1** — Backend endpoints in PHP 7.4 / Slim, SQLite migrations, legacy data import, CORS + rate limiting, compatibility shims.
- **Phase 2** — Extension core: auth/cookie handling, RSI API client, first feature end-to-end (Comm-Links).
- **Phase 3** — Port the 7 remaining modules one by one (Ships, Buy-Back, Contacts, Organizations, Roadmap, Spectrum, Release Notes).
- **Phase 4** — Hardening: strict CSP, DOMPurify, E2E with Playwright, audit, signed backend responses.
- **Phase 5** — New features (TBD).

## License

GPL-3.0-only. See [COPYING](COPYING).

## Authors

- [Kamille92](https://github.com/waibcam) — original author and v3 rewrite.
- See the full list of [contributors](https://github.com/waibcam/RSI_Companion/contributors) on the legacy branch.
