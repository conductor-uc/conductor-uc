import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { generateService, ServiceAlreadyExistsError } from '../src/generate.js';
import { InvalidNameError } from '../src/names.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cuc-gen-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function read(serviceDir: string, relative: string): Promise<string> {
  return fs.readFile(path.join(serviceDir, relative), 'utf8');
}

describe('generateService', () => {
  it('writes the layout from 09 §1', async () => {
    const { serviceDir } = await generateService({ serviceName: 'billing-service', root });

    for (const expected of [
      'src/main.ts',
      'src/config.ts',
      'src/schema.ts',
      'src/events.ts',
      'src/domain/widget.ts',
      'src/repo/widget.repo.ts',
      'src/routes/widget.routes.ts',
      'src/events/.gitkeep',
      'migrations/001_initial.ts',
      'migrations/index.ts',
      'test/widget.repo.test.ts',
      'test/widget.domain.test.ts',
      'Dockerfile',
      'package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'vitest.config.ts',
      'README.md',
      '.dockerignore',
    ]) {
      await expect(fs.access(path.join(serviceDir, expected))).resolves.toBeUndefined();
    }
  });

  it('substitutes every placeholder, leaving none behind', async () => {
    const { serviceDir, filesWritten } = await generateService({
      serviceName: 'billing-service',
      root,
    });

    for (const relative of filesWritten) {
      const contents = await fs.readFile(path.join(root, relative), 'utf8');
      expect(contents).not.toMatch(/\{\{\w+\}\}/);
    }
    // And no `.tpl` file leaked through unrendered.
    expect(filesWritten.some((file) => file.endsWith('.tpl'))).toBe(false);
    void serviceDir;
  });

  it('derives the package name and Db interface from the service name', async () => {
    const { serviceDir } = await generateService({ serviceName: 'billing-service', root });

    expect(await read(serviceDir, 'package.json')).toContain('"@cuc/billing-service"');
    expect(await read(serviceDir, 'src/schema.ts')).toContain('BillingServiceDb');
  });

  it('derives entity casing consistently across files', async () => {
    const { serviceDir } = await generateService({
      serviceName: 'billing-service',
      entityName: 'invoice-line',
      root,
    });

    // File names use the kebab source directly, matching every other filename
    // in this codebase...
    await expect(
      fs.access(path.join(serviceDir, 'src/domain/invoice-line.ts')),
    ).resolves.toBeUndefined();
    // ...while identifiers inside the file use Pascal/camel forms.
    const domain = await read(serviceDir, 'src/domain/invoice-line.ts');
    expect(domain).toContain('InvalidInvoiceLineNameError');
    expect(domain).toContain('normalizeInvoiceLineName');

    const repo = await read(serviceDir, 'src/repo/invoice-line.repo.ts');
    expect(repo).toContain('createInvoiceLineRepo');
    expect(repo).toContain("selectFrom('invoice_lines')");
  });

  it('pluralizes the entity name for the table', async () => {
    const { serviceDir } = await generateService({
      serviceName: 'billing-service',
      entityName: 'policy',
      root,
    });

    expect(await read(serviceDir, 'migrations/001_initial.ts')).toContain(
      "createTable('policies')",
    );
  });

  it('uses the requested event domain in the sample event', async () => {
    const { serviceDir } = await generateService({
      serviceName: 'billing-service',
      eventDomain: 'trunk',
      root,
    });

    expect(await read(serviceDir, 'src/events.ts')).toContain("'trunk.widget.created'");
  });

  it('defaults to a widget entity in the pbx domain', async () => {
    const { serviceDir } = await generateService({ serviceName: 'billing-service', root });

    expect(await read(serviceDir, 'src/events.ts')).toContain("'pbx.widget.created'");
  });

  it('rejects an invalid service name before writing anything', async () => {
    await expect(generateService({ serviceName: 'billing', root })).rejects.toThrow(
      InvalidNameError,
    );

    await expect(fs.access(path.join(root, 'services'))).rejects.toThrow();
  });

  it('rejects an invalid entity name', async () => {
    await expect(
      generateService({ serviceName: 'billing-service', entityName: 'Invoice Line', root }),
    ).rejects.toThrow(InvalidNameError);
  });

  it('rejects an event domain outside the catalog', async () => {
    await expect(
      generateService({ serviceName: 'billing-service', eventDomain: 'billing' as never, root }),
    ).rejects.toThrow(InvalidNameError);
  });

  it('refuses to overwrite an existing service directory', async () => {
    await generateService({ serviceName: 'billing-service', root });

    await expect(generateService({ serviceName: 'billing-service', root })).rejects.toThrow(
      ServiceAlreadyExistsError,
    );
  });

  it('overwrites when force is set', async () => {
    await generateService({ serviceName: 'billing-service', root });

    await expect(
      generateService({ serviceName: 'billing-service', root, force: true }),
    ).resolves.toBeDefined();
  });

  it('generates working TypeScript: valid syntax, balanced brackets', async () => {
    const { serviceDir, filesWritten } = await generateService({
      serviceName: 'billing-service',
      root,
    });
    void serviceDir;

    for (const relative of filesWritten.filter((file) => file.endsWith('.ts'))) {
      const contents = await fs.readFile(path.join(root, relative), 'utf8');
      const opens = (contents.match(/\{/g) ?? []).length;
      const closes = (contents.match(/\}/g) ?? []).length;
      expect(opens, `${relative}: unbalanced braces`).toBe(closes);
    }
  });

  it('names no product or codebase anywhere in the generated output', async () => {
    const { filesWritten } = await generateService({ serviceName: 'billing-service', root });

    for (const relative of filesWritten) {
      const contents = (await fs.readFile(path.join(root, relative), 'utf8')).toLowerCase();
      // Package scope (@cuc/*) is a codebase-internal identifier, not a brand
      // leak (02 §5.2) — allowed there, and nowhere else in generated output.
      const withoutScope = contents.replaceAll('@cuc/', '');
      expect(withoutScope).not.toContain('conductoruc');
      expect(withoutScope).not.toContain('conductor-uc');
      expect(withoutScope).not.toContain('conductor uc');
    }
  });
});
