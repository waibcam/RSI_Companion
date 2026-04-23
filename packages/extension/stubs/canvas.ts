// Empty shim for the `canvas` npm package.
//
// `linkedom` declares `canvas` as an OPTIONAL peer dependency
// (`peerDependenciesMeta.canvas.optional: true`) and uses it only for
// HTMLCanvasElement image rendering — which we never invoke. We only
// use linkedom to parse RSI HTML pages (e.g. /account/pledges) and
// traverse the resulting tree via `querySelector`.
//
// Production builds tree-shake the canvas import out through Rollup's
// dead-code elimination. Vite's dev server, however, eagerly resolves
// every static import during its esbuild pre-bundle pass and throws
// "Could not resolve 'canvas'" on a fresh clone — breaking
// `pnpm dev`/`pnpm dev:firefox` on machines that have never installed
// the (large, native-binary) `canvas` package globally.
//
// Aliasing `canvas` to this empty module in `wxt.config.ts` keeps the
// dev server resolution happy without installing the native dep. The
// exported shape is the minimum subset linkedom's optional path
// references on import; if linkedom ever reaches out for methods we
// haven't stubbed, it'll throw a TypeError at call time — which is
// fine, because we never hit those code paths. See GH #26.

export default {};
