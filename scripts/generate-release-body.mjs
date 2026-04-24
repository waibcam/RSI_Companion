#!/usr/bin/env node
// Generate a Markdown body suitable for a GitHub release from the
// bundled `release-notes.json`. Used at each release to produce one
// canonical description that covers the current version's changes plus
// a collapsible history of every previous release.
//
// Usage:
//   node scripts/generate-release-body.mjs <version> [out-path]
//   pnpm release:body <version>            (via the root script)
//
// When `<out-path>` is omitted the output is written to stdout. Pipe
// to pbcopy / clip / xsel as needed:
//   pnpm release:body 1.1.0 | clip                 (Windows)
//   pnpm release:body 1.1.0 | pbcopy               (macOS)
//   pnpm release:body 1.1.0 > release-1.1.0.md    (save to file)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const notesPath = resolve(
  scriptDir,
  '..',
  'packages/shared/src/data/release-notes.json',
);

const version = process.argv[2];
if (!version) {
  console.error('usage: generate-release-body.mjs <version> [out-path]');
  process.exit(2);
}

const notes = JSON.parse(readFileSync(notesPath, 'utf8'));
const current = notes.find((e) => e.version === version);
if (!current) {
  console.error(`version "${version}" not found in release-notes.json`);
  process.exit(2);
}

const cur = JSON.parse(current.notes);
const out = [];

// --- Current version: lead paragraph + feature list ---------------------
if (cur.info?.length) {
  out.push(cur.info.join('\n\n'));
  out.push('');
}
if (cur.features?.length) {
  out.push(`## What's new in v${version}`);
  out.push('');
  for (const f of cur.features) out.push(`- ${f}`);
  out.push('');
}

// --- Install block (boilerplate, easily edited before publishing) -------
out.push('## Install');
out.push('');
out.push(
  `- **Firefox** — via AMO auto-update (or side-load \`rsi-companionextension-${version}-firefox.zip\`).`,
);
out.push('- **Chrome / Edge** — once the stores finish reviewing this version.');
out.push(
  '- **Build from source** — see [README.md](../blob/v3/README.md#build-instructions-firefox-amo-reviewers).',
);
out.push('');
out.push('---');
out.push('');

// --- Collapsed history of every previous release ------------------------
out.push('## Release history');
out.push('');
out.push(
  'Full changelog bundled with every copy of the extension — also viewable in the Release Notes module of the popup.',
);
out.push('');

// Keep the most recent prior release expanded by default, older ones
// collapsed. A long single release body on GitHub becomes unreadable if
// every entry is open.
let firstHistoryEntry = true;
for (const e of notes) {
  if (e.version === version) continue;
  const d = JSON.parse(e.notes);
  const date = new Date(e.released_at * 1000).toISOString().slice(0, 10);
  out.push(`<details${firstHistoryEntry ? ' open' : ''}>`);
  out.push(`<summary><strong>v${e.version}</strong> — ${date}</summary>`);
  out.push('');
  if (d.info?.length) {
    for (const i of d.info) out.push(`*${i}*`);
    out.push('');
  }
  if (d.features?.length) {
    for (const f of d.features) out.push(`- ${f}`);
    out.push('');
  }
  out.push('</details>');
  out.push('');
  firstHistoryEntry = false;
}

const rendered = out.join('\n');
const outPath = process.argv[3];
if (outPath) {
  writeFileSync(outPath, rendered);
  console.error(`wrote ${outPath} (${rendered.length} chars)`);
} else {
  process.stdout.write(rendered);
}
