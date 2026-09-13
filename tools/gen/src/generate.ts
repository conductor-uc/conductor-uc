import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { EventDomain } from '@cuc/api-contracts';

import {
  pluralize,
  toCamelCase,
  toPascalCase,
  toSnakeCase,
  validateDomain,
  validateEntityName,
  validateServiceName,
} from './names.js';

export interface GenerateOptions {
  /** kebab-case, must end in `-service`. */
  readonly serviceName: string;
  /** kebab-case name for the sample entity the template ships with. */
  readonly entityName?: string;
  /** Which event domain the sample entity's events belong to. */
  readonly eventDomain?: EventDomain;
  /** Repository root. Templates render into `services/<serviceName>`. */
  readonly root: string;
  /** Overwrite an existing directory instead of refusing. Testing only. */
  readonly force?: boolean;
}

export interface GenerateResult {
  readonly serviceDir: string;
  readonly filesWritten: readonly string[];
}

/**
 * One key per `{{placeholder}}` used in the templates.
 *
 * `entity` and `kebabEntity` differ on purpose: `entity` (camelCase) names
 * identifiers inside a file — `createWidgetRepo`, `widgetEvents` — while
 * `kebabEntity` names files and import paths, so a multi-word entity such as
 * `invoice-line` produces `invoice-line.repo.ts`, matching every other
 * filename in this codebase, rather than `invoiceLine.repo.ts`.
 */
interface Placeholders {
  readonly name: string;
  readonly Pascal: string;
  readonly entity: string;
  readonly kebabEntity: string;
  readonly Entity: string;
  readonly table: string;
  readonly domain: string;
}

export class ServiceAlreadyExistsError extends Error {
  override readonly name = 'ServiceAlreadyExistsError';

  constructor(dir: string) {
    super(`${dir} already exists. Remove it first, or choose a different name.`);
  }
}

/**
 * The directory this package ships its templates in.
 *
 * Resolved from the module's own location rather than `process.cwd()`, so the
 * generator works the same whether it is run from the repository root or from
 * inside `tools/gen`.
 */
function templatesDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'service');
}

function placeholdersFor(options: GenerateOptions): Placeholders {
  const serviceName = validateServiceName(options.serviceName);
  const entityKebab = validateEntityName(options.entityName ?? 'widget');
  const domain = validateDomain(options.eventDomain ?? 'pbx');

  return {
    name: serviceName,
    Pascal: toPascalCase(serviceName),
    entity: toCamelCase(entityKebab),
    kebabEntity: entityKebab,
    Entity: toPascalCase(entityKebab),
    table: toSnakeCase(pluralize(entityKebab)),
    domain,
  };
}

/** Replaces every `{{key}}` in `text` with its value from `placeholders`. */
const PLACEHOLDER_KEYS: readonly (keyof Placeholders)[] = [
  'name',
  'Pascal',
  'entity',
  'kebabEntity',
  'Entity',
  'table',
  'domain',
];

function render(text: string, placeholders: Placeholders): string {
  return text.replaceAll(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!isPlaceholderKey(key)) {
      throw new Error(`Template references unknown placeholder '{{${key}}}'.`);
    }
    return placeholders[key];
  });
}

function isPlaceholderKey(key: string): key is keyof Placeholders {
  return (PLACEHOLDER_KEYS as readonly string[]).includes(key);
}

/** Renders a template's relative path: substitutes placeholders, drops `.tpl`. */
function renderPath(relative: string, placeholders: Placeholders): string {
  const substituted = render(relative, placeholders);
  return substituted.endsWith('.tpl') ? substituted.slice(0, -4) : substituted;
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

/**
 * Generates a service from the template into `services/<serviceName>`.
 *
 * Every `.tpl` file is rendered (placeholders substituted, extension dropped);
 * every other file is copied byte-for-byte, for binary or otherwise-templated
 * assets the template ships. Directory and file names may themselves contain
 * placeholders — `src/repo/{{kebabEntity}}.repo.ts.tpl` becomes, for a
 * `location` entity, `src/repo/location.repo.ts`.
 */
export async function generateService(options: GenerateOptions): Promise<GenerateResult> {
  const placeholders = placeholdersFor(options);
  const sourceDir = templatesDir();
  const serviceDir = path.join(options.root, 'services', placeholders.name);

  if (options.force !== true) {
    const exists = await fs
      .access(serviceDir)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new ServiceAlreadyExistsError(serviceDir);
  }

  const sourceFiles = await listFiles(sourceDir);
  const filesWritten: string[] = [];

  for (const sourceFile of sourceFiles) {
    const relative = path.relative(sourceDir, sourceFile);
    const targetRelative = renderPath(relative, placeholders);
    const targetPath = path.join(serviceDir, targetRelative);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (sourceFile.endsWith('.tpl')) {
      const contents = await fs.readFile(sourceFile, 'utf8');
      await fs.writeFile(targetPath, render(contents, placeholders));
    } else {
      await fs.copyFile(sourceFile, targetPath);
    }
    filesWritten.push(path.relative(options.root, targetPath));
  }

  return { serviceDir, filesWritten: filesWritten.sort() };
}
