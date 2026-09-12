import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/**
 * The repository's ESLint config forbids raw SQL outside `migrations/` and
 * `@cuc/db` (05 §2.2). A guardrail nobody tests is one that silently stops
 * working, so these assert against the real config rather than a copy.
 *
 * The checks use `calculateConfigForFile` rather than linting sample text: the
 * repo lints with type information, and a made-up file path belongs to no
 * tsconfig, so the parser rejects it before any rule runs. Resolving the config
 * tests what can actually regress — which paths the rule covers, and what it
 * tells the author to do instead.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const eslint = new ESLint({ cwd: repoRoot });

interface ResolvedRules {
  restrictedImports: unknown[] | undefined;
  restrictedSyntax: unknown[] | undefined;
}

/** `calculateConfigForFile` is typed as `any`, so the shape is narrowed here. */
function rulesOf(config: unknown): Record<string, unknown[]> {
  if (typeof config !== 'object' || config === null) return {};
  const rules = (config as { rules?: unknown }).rules;
  if (typeof rules !== 'object' || rules === null) return {};
  return rules as Record<string, unknown[]>;
}

async function rulesFor(filePath: string): Promise<ResolvedRules> {
  const rules = rulesOf(await eslint.calculateConfigForFile(path.join(repoRoot, filePath)));
  return {
    restrictedImports: rules['no-restricted-imports'],
    restrictedSyntax: rules['no-restricted-syntax'],
  };
}

function serialize(rules: ResolvedRules): string {
  return JSON.stringify(rules);
}

/** The `selector` of each no-restricted-syntax entry. */
function selectorsIn(entries: unknown[] | undefined): string[] {
  return (entries ?? [])
    .filter(
      (entry): entry is { selector: string } =>
        typeof entry === 'object' && entry !== null && 'selector' in entry,
    )
    .map((entry) => entry.selector);
}

const SERVICE_FILE = 'services/org-service/src/repo/tenants.ts';

describe('where raw SQL is forbidden', () => {
  it('covers service source', async () => {
    const rules = await rulesFor(SERVICE_FILE);

    expect(rules.restrictedImports).toBeDefined();
    expect(serialize(rules)).toContain('Raw SQL belongs in migrations');
  });

  it('covers other shared packages', async () => {
    const rules = await rulesFor('packages/audit/src/writer.ts');

    expect(serialize(rules)).toContain('Raw SQL belongs in migrations');
  });

  it('bans importing mysql2 directly, so every query goes through @cuc/db', async () => {
    const rules = await rulesFor(SERVICE_FILE);

    expect(serialize(rules)).toContain('mysql2');
    expect(serialize(rules)).toContain('through @cuc/db');
  });

  it('bans the sql tagged template', async () => {
    const rules = await rulesFor(SERVICE_FILE);

    expect(selectorsIn(rules.restrictedSyntax)).toContain(
      'TaggedTemplateExpression[tag.name="sql"]',
    );
  });

  it('bans reaching past scoped(ctx) into the raw Kysely instance', async () => {
    const rules = await rulesFor(SERVICE_FILE);

    expect(serialize(rules)).toContain('skips tenant scoping');
  });

  it('says what to do instead, not just no', async () => {
    const serialized = serialize(await rulesFor(SERVICE_FILE));

    expect(serialized).toContain('scoped(ctx)');
    expect(serialized).toContain('unscoped(ctx, reason)');
  });
});

describe('where raw SQL is allowed', () => {
  it('exempts migrations, which are the one place it belongs', async () => {
    const rules = await rulesFor('services/org-service/migrations/20260101000000_init.ts');

    expect(rules.restrictedImports).toBeUndefined();
    expect(serialize(rules)).not.toContain('Raw SQL belongs in migrations');
  });

  it('exempts @cuc/db, which is what enforces scoping', async () => {
    const rules = await rulesFor('packages/db/src/client.ts');

    expect(rules.restrictedImports).toBeUndefined();
    expect(serialize(rules)).not.toContain('Raw SQL belongs in migrations');
  });

  it('still bans enums everywhere, so the exemption is narrow', async () => {
    const rules = await rulesFor('packages/db/src/client.ts');

    expect(selectorsIn(rules.restrictedSyntax)).toEqual(['TSEnumDeclaration']);
  });
});

describe('the rule fires on real code', () => {
  it('flags the mysql2 import in @cuc/testing when its suppression is ignored', async () => {
    // @cuc/testing needs raw mysql2 to create and drop schemas, and carries an
    // explained eslint-disable for exactly that line. Linting it with inline
    // configuration switched off proves the rule is live, not merely configured.
    const strict = new ESLint({ cwd: repoRoot, allowInlineConfig: false });
    const [result] = await strict.lintFiles([
      path.join(repoRoot, 'packages/testing/src/mariadb.ts'),
    ]);

    const messages = (result?.messages ?? []).filter(
      (message) => message.ruleId === 'no-restricted-imports',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.message).toContain('through @cuc/db');
  });

  it('passes that same file with its documented suppression in place', async () => {
    const [result] = await eslint.lintFiles([
      path.join(repoRoot, 'packages/testing/src/mariadb.ts'),
    ]);

    expect(result?.errorCount).toBe(0);
  });
});
