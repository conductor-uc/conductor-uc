#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { runBrandLeak } from './run.js';

const USAGE = `Usage: brand-leak [options]

Scans user-facing and network-visible surfaces for forbidden strings: the
codebase name, an operator name, and framework scaffolding (02 §5.5).

Options:
  --root <path>   Repository root (default: the working directory)
  --help

Configure it with brand-leak.config.json at the repository root. Deny rules
there are added to the built-in list, never replacing it.
`;

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  process.stdout.write(USAGE);
  process.exitCode = 0;
} else {
  try {
    const { report, exitCode } = runBrandLeak({ root: path.resolve(values.root ?? '.') });
    process.stdout.write(`${report}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
