import { readFileSync } from 'node:fs';

import type { Static, TObject } from 'typebox';
import { Check, Convert, Default, Errors } from 'typebox/value';

import { ConfigError, type ConfigIssue } from './errors.js';

export interface LoadConfigOptions {
  /** Defaults to `process.env`. Injected in tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Reads, coerces, and validates the environment against `schema`.
 *
 * Only variables the schema declares are read; everything else in the
 * environment is ignored. An empty string counts as unset, so a variable left
 * blank by an orchestrator falls back to its default instead of failing as a
 * zero-length string.
 *
 * Any declared variable `NAME` can instead be read from a file named by
 * `NAME_FILE` (G-116), the convention Docker and Kubernetes secrets use: the
 * file is read as UTF-8 and trailing whitespace (the newline an editor or
 * `echo` leaves) is removed. It is meant for secrets, but applies to every
 * variable because one rule is easier to remember than a list. Setting both
 * `NAME` and `NAME_FILE`, naming a file that cannot be read, or naming an empty
 * file stops startup. A schema that itself declares `NAME_FILE` (api-gateway's
 * `TLS_CERT_FILE`, say) keeps that variable's own meaning, and the value read
 * from a file is redacted exactly like one from the environment.
 *
 * Throws {@link ConfigError} listing every problem at once, so a misconfigured
 * deployment does not have to be fixed one variable per restart. The returned
 * object is frozen.
 *
 * @example
 * ```ts
 * const schema = Type.Object({ ...baseEnvSchema.properties, DB_URL: Env.secret() });
 * export const config = loadConfig(schema);
 * ```
 */
export function loadConfig<T extends TObject>(
  schema: T,
  options: LoadConfigOptions = {},
): Readonly<Static<T>> {
  const env = options.env ?? process.env;
  const raw: Record<string, unknown> = {};
  const fileIssues: ConfigIssue[] = [];
  const unresolved = new Set<string>();

  for (const [key, property] of Object.entries(schema.properties)) {
    const resolved = resolveValue(schema, env, key);
    if ('issue' in resolved) {
      fileIssues.push(resolved.issue);
      unresolved.add(key);
      continue;
    }
    const { value } = resolved;
    if (value === undefined || value === '') continue;
    raw[key] = isArraySchema(property) ? splitList(value) : value;
  }

  const candidate = Default(schema, Convert(schema, raw)) as Static<T>;

  if (fileIssues.length > 0 || !Check(schema, candidate)) {
    // A variable whose file could not be read would otherwise also be reported
    // as "required but not set", which points at the wrong fix.
    const issues = collectIssues(schema, candidate).filter(
      (issue) => !unresolved.has(issue.variable),
    );
    throw new ConfigError(
      [...fileIssues, ...issues].sort((a, b) => a.variable.localeCompare(b.variable)),
    );
  }

  return Object.freeze(candidate);
}

/** The suffix naming a file to read a variable from (G-116). */
const FILE_SUFFIX = '_FILE';

/**
 * The value for `key`: from the environment, or from the file `${key}_FILE`
 * names. Issues never carry the file's contents, only its path and the reason.
 */
function resolveValue(
  schema: TObject,
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): { value: string | undefined } | { issue: ConfigIssue } {
  const direct = env[key];
  const fileVariable = `${key}${FILE_SUFFIX}`;
  // The schema's own `NAME_FILE` variable means whatever that schema says, not
  // "read NAME from here".
  if (Object.hasOwn(schema.properties, fileVariable)) return { value: direct };

  const path = env[fileVariable];
  if (path === undefined || path === '') return { value: direct };

  if (direct !== undefined && direct !== '') {
    return {
      issue: {
        variable: key,
        message: `is set both directly and through ${fileVariable}; set only one of them`,
      },
    };
  }

  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return {
      issue: { variable: fileVariable, message: `cannot read the file '${path}' (${code})` },
    };
  }

  const value = contents.trimEnd();
  if (value === '') {
    return { issue: { variable: fileVariable, message: `the file '${path}' is empty` } };
  }
  return { value };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isArraySchema(property: unknown): boolean {
  return isRecord(property) && property['type'] === 'array';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Turns validator output into one issue per environment variable.
 *
 * A failing union reports one error per member plus a summarising `anyOf`
 * error. Reporting each member is noise, so union failures collapse to a single
 * "must be one of" line naming the accepted values.
 */
function collectIssues<T extends TObject>(schema: T, candidate: unknown): ConfigIssue[] {
  const messages = new Map<string, Set<string>>();
  const unions = new Set<string>();

  const add = (variable: string, message: string): void => {
    const set = messages.get(variable) ?? new Set<string>();
    set.add(message);
    messages.set(variable, set);
  };

  for (const error of Errors(schema, candidate)) {
    if (error.keyword === 'required') {
      const params = error.params as { requiredProperties?: string[] };
      for (const variable of params.requiredProperties ?? [])
        add(variable, 'is required but not set');
      continue;
    }

    const variable = error.instancePath.split('/').filter(Boolean)[0];
    if (variable === undefined) continue;

    if (error.keyword === 'anyOf') {
      unions.add(variable);
      add(variable, describeUnion(schema.properties[variable]));
      continue;
    }
    add(variable, error.message);
  }

  const issues: ConfigIssue[] = [];
  for (const [variable, set] of messages) {
    // Union member failures are subsumed by the "must be one of" line.
    const relevant = unions.has(variable) ? [describeUnion(schema.properties[variable])] : [...set];
    for (const message of relevant) issues.push({ variable, message });
  }
  return issues.sort((a, b) => a.variable.localeCompare(b.variable));
}

function describeUnion(property: unknown): string {
  if (!isRecord(property) || !Array.isArray(property['anyOf'])) return 'is not an accepted value';

  const constants = property['anyOf']
    .filter(isRecord)
    .map((member) => member['const'])
    .filter(
      (value): value is string | number => typeof value === 'string' || typeof value === 'number',
    );

  if (constants.length !== property['anyOf'].length || constants.length === 0) {
    return 'is not an accepted value';
  }
  return `must be one of: ${constants.join(', ')}`;
}
