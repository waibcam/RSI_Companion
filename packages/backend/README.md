# @rsi-companion/backend

PHP 7.4 / Slim 4 backend serving `rsi-companion.kamille.ovh`.

## Requirements

- PHP 7.4+ (code also runs on PHP 8.x)
- Composer
- SQLite3 / PDO SQLite extension

## Setup

```sh
composer install
cp .env.example .env
sqlite3 data/app.sqlite < migrations/001_init.sql
composer start   # http://127.0.0.1:8080
```

## Endpoints (Phase 1 targets)

| Method | Path                          | Purpose                                                |
| ------ | ----------------------------- | ------------------------------------------------------ |
| GET    | `/api/v1/health`              | Readiness probe                                        |
| GET    | `/api/v1/release-notes`       | Release notes for the extension                        |
| GET    | `/api/v1/loaners`             | Ship → loaner IDs mapping                              |
| GET    | `/api/v1/ships/name-info`     | Display-name → ship ID mapping                         |
| GET    | `/api/v1/roadmap/{boardId}`   | Cached roadmap snapshot (fetched from RSI if stale)    |
| POST   | `/api/v1/reports`             | Anonymous telemetry (unknown ship names, etc.)         |

Legacy endpoints (`/getBoard`, `/getLoaners`, `/getShipNameInfo`, `/getReleaseNotes`, `/sendReport`) will be kept
as thin compatibility shims during the transition while the old 0.2.x extension is still in the wild.

## Deployment

Source of truth for production is `D:/OneDrive/projects/rsi-companion/` (auto-synced to the OVH server).
When ready to deploy v3:

1. `composer install --no-dev --optimize-autoloader`
2. Copy the built tree to the OVH auto-sync folder.
3. Run migrations via SSH.
4. Flip DNS / path to point extension at the new endpoints.
