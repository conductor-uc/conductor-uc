import { EVENT_DOMAINS, type EventDomain } from '@cuc/api-contracts';

/** Thrown when a proposed service or entity name does not fit the conventions. */
export class InvalidNameError extends Error {
  override readonly name = 'InvalidNameError';
}

const KEBAB_SERVICE_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*-service$/;

/**
 * Validates a service directory name.
 *
 * Required to end in `-service`, matching every name in the catalog (06):
 * `org-service`, `pbx-config-service`, and so on. `services/example` would be
 * a directory nobody could tell apart from a typo.
 */
export function validateServiceName(name: string): string {
  if (!KEBAB_SERVICE_NAME.test(name)) {
    throw new InvalidNameError(
      `'${name}' is not a valid service name. Use lowercase kebab-case ending in ` +
        `'-service', e.g. 'billing-service'.`,
    );
  }
  return name;
}

const KEBAB_ENTITY_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Validates an entity name (the "thing" the generated sample manages). */
export function validateEntityName(name: string): string {
  if (!KEBAB_ENTITY_NAME.test(name)) {
    throw new InvalidNameError(`'${name}' is not a valid entity name. Use lowercase kebab-case.`);
  }
  return name;
}

/** Validates that `domain` is one of the event domains from 05 §5. */
export function validateDomain(domain: string): EventDomain {
  if (!(EVENT_DOMAINS as readonly string[]).includes(domain)) {
    throw new InvalidNameError(
      `'${domain}' is not an event domain. Expected one of: ${EVENT_DOMAINS.join(', ')}.`,
    );
  }
  return domain as EventDomain;
}

/** kebab-case to PascalCase: `pbx-config` -> `PbxConfig`. */
export function toPascalCase(kebab: string): string {
  return kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** kebab-case to camelCase: `pbx-config` -> `pbxConfig`. */
export function toCamelCase(kebab: string): string {
  const pascal = toPascalCase(kebab);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** kebab-case to snake_case: `pbx-config` -> `pbx_config`. */
export function toSnakeCase(kebab: string): string {
  return kebab.replaceAll('-', '_');
}

/** A naive English pluralization, good enough for a generated table name. */
export function pluralize(word: string): string {
  if (/(s|sh|ch|x|z)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}
