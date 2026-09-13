#!/usr/bin/env node
import * as path from 'node:path';
import { parseArgs } from 'node:util';

import { EVENT_DOMAINS } from '@cuc/api-contracts';

import { generateService, ServiceAlreadyExistsError } from './generate.js';
import { InvalidNameError } from './names.js';

const USAGE = `Usage: cuc-gen service <name> [options]

Generates services/<name> from the template in 09 §1: bootstrap, routes,
domain, repo, events, migrations, a Dockerfile, and a sample test.

Options:
  --entity <name>   Sample entity name (default: widget)
  --domain <domain> Event domain for the sample entity's events
                     (default: pbx; one of ${EVENT_DOMAINS.join(', ')})
  --root <path>     Repository root (default: the working directory)
  --force           Overwrite an existing services/<name>
  --help
`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    entity: { type: 'string' },
    domain: { type: 'string' },
    root: { type: 'string' },
    force: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || positionals[0] !== 'service' || positionals[1] === undefined) {
  process.stdout.write(USAGE);
  process.exitCode = values.help ? 0 : 1;
} else {
  try {
    const result = await generateService({
      serviceName: positionals[1],
      root: path.resolve(values.root ?? '.'),
      force: values.force,
      ...(values.entity === undefined ? {} : { entityName: values.entity }),
      ...(values.domain === undefined ? {} : { eventDomain: values.domain as never }),
    });

    process.stdout.write(`Generated ${result.serviceDir}\n\n`);
    for (const file of result.filesWritten) process.stdout.write(`  ${file}\n`);
    process.stdout.write(
      `\nNext: pnpm install, then pnpm --filter @cuc/${positionals[1]} build test\n`,
    );
  } catch (error) {
    if (error instanceof InvalidNameError || error instanceof ServiceAlreadyExistsError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  }
}
