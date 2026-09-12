import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      'apps/console/**',
    ],
  },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Rule 2 in CLAUDE.md: no console output from services; use @cuc/logger.
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a union of string literals or an object literal instead of an enum.',
        },
      ],
    },
  },
  // Raw SQL is allowed only in migrations and inside @cuc/db (05 §2.2).
  // Everywhere else, tenant-owned data goes through scoped(ctx), and a raw
  // query is exactly what silently skips the tenant_id predicate.
  {
    files: ['packages/**/*.ts', 'services/**/*.ts', 'apps/**/*.ts', 'tools/**/*.ts'],
    ignores: ['packages/db/**', '**/migrations/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'kysely',
              importNames: ['sql'],
              message:
                'Raw SQL belongs in migrations/ or @cuc/db. Use scoped(ctx) for tenant-owned tables, or unscoped(ctx, reason) when a query legitimately spans tenants.',
            },
            {
              name: 'mysql2',
              message: 'Talk to MariaDB through @cuc/db, which enforces tenant scoping.',
            },
            {
              name: 'mysql2/promise',
              message: 'Talk to MariaDB through @cuc/db, which enforces tenant scoping.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'Use a union of string literals or an object literal instead of an enum.',
        },
        {
          selector: 'TaggedTemplateExpression[tag.name="sql"]',
          message:
            'Raw SQL belongs in migrations/ or @cuc/db. Use scoped(ctx), or unscoped(ctx, reason) for a deliberate cross-tenant query.',
        },
        {
          selector:
            'MemberExpression[property.name=/^(executeQuery|raw)$/][object.property.name="kysely"]',
          message:
            'Reaching past scoped(ctx) into the raw Kysely instance skips tenant scoping. Use scoped(ctx), or unscoped(ctx, reason) if the query really spans tenants.',
        },
      ],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ['**/test/**', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  prettier,
);
