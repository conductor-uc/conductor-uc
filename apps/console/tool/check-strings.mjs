#!/usr/bin/env node
// Keeps user-facing text out of the console's Dart code (S9-01, D-018): every
// string a person reads lives in lib/l10n/app_en.arb and reaches widgets
// through `context.l10n`.
//
// About 1,600 literals predate this check. They are counted per file in
// tool/strings-baseline.json, and the count may only go down: a change that
// adds a literal fails, and a change that removes some must lower the
// baseline (`--update`) so the room cannot be spent again.
//
//   node apps/console/tool/check-strings.mjs            check
//   node apps/console/tool/check-strings.mjs --update   rewrite the baseline
//
// The patterns are a heuristic for "text a person reads": a string literal
// that starts with a letter, given to Text(...) and its relatives, or to a
// named argument such as labelText:, helperText:, tooltip:, title:. Demo
// backends (lib/dev) and generated code (lib/l10n) are not scanned.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lib = join(root, 'lib');
const baselinePath = join(root, 'tool', 'strings-baseline.json');
const skipped = ['lib/dev/', 'lib/l10n/'];

const literal = String.raw`(?:r?'[^'\n]*[A-Za-z][^'\n]*'|r?"[^"\n]*[A-Za-z][^"\n]*")`;
const patterns = [
  // Text('Save'), const Text("Save"), SelectableText('…'), FormMessage('…')
  new RegExp(
    String.raw`\b(?:Text|SelectableText|FormMessage|ErrorText|Tooltip)\(\s*` + literal,
    'g',
  ),
  // labelText: 'Email', tooltip: 'Delete', title: 'Sign in', … (dart format
  // writes no space before a named argument's colon; a ternary's has one)
  new RegExp(
    String.raw`\b(?:labelText|helperText|hintText|errorText|prefixText|suffixText|counterText|tooltip|title|subtitle|semanticLabel|semanticsLabel|message|emptyText|label|singular|plural|blurb|help):\s*` +
      literal,
    'g',
  ),
  // Label maps: 'no_answer': 'No answer'
  new RegExp(String.raw`'[a-z][a-z0-9_]*':\s*r?'[A-Z][^'\n]*'`, 'g'),
  // Switch arms and one-line functions that return text: => 'Talking'
  new RegExp(String.raw`=>\s*r?'[A-Z][^'\n]*'`, 'g'),
];

async function* dartFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* dartFiles(path);
    else if (entry.name.endsWith('.dart')) yield path;
  }
}

/// Counts the literals in [source], ignoring comment lines.
function count(source) {
  const code = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
  let n = 0;
  for (const re of patterns) {
    for (const match of code.matchAll(re)) {
      // Only words count: '${row['name']}' or '$count' is data, not text.
      const literal = /(['"])(.*)\1\s*$/.exec(match[0])?.[2] ?? match[0];
      const words = literal.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, '');
      if (/[A-Za-z]/.test(words)) n++;
    }
  }
  return n;
}

const counts = {};
for await (const file of dartFiles(lib)) {
  const rel = relative(root, file).split('\\').join('/');
  if (skipped.some((prefix) => rel.startsWith(prefix))) continue;
  const n = count(await readFile(file, 'utf8'));
  if (n > 0) counts[rel] = n;
}
const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
const total = Object.values(sorted).reduce((a, b) => a + b, 0);

if (process.argv.includes('--update')) {
  await writeFile(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Baseline updated: ${total} literals in ${Object.keys(sorted).length} files.`);
  process.exit(0);
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
const grew = [];
const shrank = [];
for (const file of new Set([...Object.keys(sorted), ...Object.keys(baseline)])) {
  const now = sorted[file] ?? 0;
  const before = baseline[file] ?? 0;
  if (now > before) grew.push(`  ${file}: ${before} → ${now}`);
  else if (now < before) shrank.push(`  ${file}: ${before} → ${now}`);
}

if (grew.length > 0) {
  console.error(
    'User-facing text was added to Dart code. Put it in lib/l10n/app_en.arb ' +
      'and use context.l10n instead (S9-01, D-018):\n' +
      grew.join('\n'),
  );
}
if (shrank.length > 0) {
  console.error(
    'Fewer literals than the baseline records: well done. Lower the baseline ' +
      'so they cannot come back:\n  node apps/console/tool/check-strings.mjs --update\n' +
      shrank.join('\n'),
  );
}
if (grew.length > 0 || shrank.length > 0) process.exit(1);
console.log(`No new user-facing literals (${total} left to move, in ${Object.keys(sorted).length} files).`);
