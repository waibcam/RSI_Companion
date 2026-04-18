# Contributing

Thanks for your interest in RSI Companion.

## Ground rules

- All work targets the `v3` branch. The `master` branch is frozen at legacy v0.2.14.
- Open an issue before starting significant work so we can align on scope.
- One logical change per pull request. Small PRs are reviewed faster.

## Coding conventions

- TypeScript / Svelte files follow the project Prettier + ESLint config (`pnpm format`, `pnpm lint`).
- PHP files follow PSR-12. Use `declare(strict_types=1);` at the top of every file.
- No new jQuery / Bootstrap. UI is Svelte 5 + Tailwind v4.
- Never commit secrets or `.env` files.

## Development loop

See the [Quickstart](README.md#quickstart) section of the README.

## Commit messages

Conventional Commits style is preferred but not required:

```
feat(extension): add ships module skeleton
fix(backend): return 429 on rate-limited routes
chore(deps): bump wxt to 0.19.14
```
