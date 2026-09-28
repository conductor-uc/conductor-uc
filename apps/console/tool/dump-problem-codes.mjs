#!/usr/bin/env node
// Lists every problem code the services can send (S9-02, D-018), so the
// console's translations can be checked against real codes
// (test/problem_codes_test.dart) and a renamed code is noticed.
//
// Every ProblemError names its code as a literal (`code: 'extension_not_found'`),
// which `@cuc/http`'s types require; this collects those literals from the
// services' and packages' sources. It is a superset: a `code:` that is not a
// problem's is harmless here.
//
//   node apps/console/tool/dump-problem-codes.mjs
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const out = join(root, 'apps/console/api/problem-codes.json');

async function* sources(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) yield path;
  }
}

// Default codes `@cuc/http` itself assigns (validation, 5xx, unknown routes).
const codes = new Set(['validation_failed', 'internal_error', 'route_not_found']);
// `code: 'x'` in a call, or `code = 'x'` on an error class, even across a line break.
const pattern = /\bcode\??\s*[:=]\s*'([a-z][a-z0-9_]*)'/g;
for (const top of ['services', 'packages']) {
  for (const unit of await readdir(join(root, top))) {
    for await (const file of sources(join(root, top, unit, 'src'))) {
      for (const match of (await readFile(file, 'utf8')).matchAll(pattern)) codes.add(match[1]);
    }
  }
}

const sorted = [...codes].sort();
await writeFile(out, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${sorted.length} codes -> ${out}`);
