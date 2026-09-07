#!/usr/bin/env node
// Refresh the checked-in ship-matrix id fixture used by the
// SHIP_NAME_CATALOG guard in `packages/shared/src/__tests__/ships.test.ts`.
//
// The guard asserts every matrix id referenced by the bundled alias
// catalog still exists in the live Ship Matrix. CIG retires matrix
// entries when a limited-edition SKU is folded back into its base hull
// (the 2949 "Best in Show" liveries went that way), which silently turns
// a catalog alias into a no-op — `mergeHangarIntoMatrix` only registers
// an alias when at least one of its ids resolves. The fixture is what
// makes that detectable offline; refresh it when the guard fails, then
// remap or delete the aliases the diff exposes.
//
// Usage:
//   node scripts/refresh-ship-matrix-fixture.mjs
//   pnpm fixture:ship-matrix           (via the root script)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(
  scriptDir,
  '..',
  'packages/shared/src/__tests__/fixtures/ship-matrix-ids.json',
);

const SOURCE = 'POST https://robertsspaceindustries.com/ship-matrix/index';

const response = await fetch('https://robertsspaceindustries.com/ship-matrix/index', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: '{}',
});
if (!response.ok) {
  console.error(`ship-matrix returned ${response.status}`);
  process.exit(1);
}
const payload = await response.json();
if (payload?.success !== 1 || !Array.isArray(payload.data) || payload.data.length === 0) {
  console.error('ship-matrix response was not valid');
  process.exit(1);
}

// Only id + name are kept: the guard needs the id set, and the name is
// there so a failure message can say what the id used to be.
const ships = payload.data
  .map((ship) => ({ id: Number(ship.id), name: String(ship.name).trim() }))
  .sort((a, b) => a.id - b.id);

const fixture = {
  source: SOURCE,
  fetchedAt: new Date().toISOString().slice(0, 10),
  count: ships.length,
  ships,
};

writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${ships.length} ships to ${fixturePath}`);
