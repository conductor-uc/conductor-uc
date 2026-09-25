/** One entry in the routing table: a path pattern and the service base URL behind it. */
export interface RouteEntry {
  /** The pattern as written, e.g. `/v1/tenants/*` + `/flows`. */
  readonly prefix: string;
  readonly target: string;
  /** The pattern's segments; `*` stands for any one segment. */
  readonly segments: readonly string[];
}

/** Every service the gateway can route to; each has a base URL in the config. */
export const KNOWN_SERVICES = [
  'identity',
  'org',
  'pbx',
  'callflow',
  'voicemail',
  'cdr',
  'trunk',
  'recording',
] as const;
export type ServiceKey = (typeof KNOWN_SERVICES)[number];

function isServiceKey(value: string): value is ServiceKey {
  return (KNOWN_SERVICES as readonly string[]).includes(value);
}

const WILDCARD = '*';

function segmentsOf(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** How specific a pattern is: literal segments first, then total length. */
function specificity(entry: RouteEntry): [number, number] {
  return [entry.segments.filter((s) => s !== WILDCARD).length, entry.segments.length];
}

/**
 * Parses `ROUTE_TABLE` (`pattern=service` entries) against the known service
 * base URLs, and orders the result most-specific-first so route resolution is
 * a simple first-match scan.
 *
 * A pattern is a path prefix whose segments are literals or `*`, which
 * matches any one segment: `/v1/tenants/*` + `/flows` sends a tenant's flows
 * to callflow-service while `/v1/tenants` alone still covers the rest of the
 * tenant tree. More literal segments win; between equals, the longer pattern.
 */
export function buildRouteTable(
  entries: readonly string[],
  services: Readonly<Record<ServiceKey, string>>,
): readonly RouteEntry[] {
  const table = entries.map((entry): RouteEntry => {
    const separator = entry.indexOf('=');
    if (separator === -1) {
      throw new Error(`Invalid ROUTE_TABLE entry '${entry}': expected 'prefix=service'.`);
    }
    const prefix = entry.slice(0, separator);
    const service = entry.slice(separator + 1);
    if (!prefix.startsWith('/')) {
      throw new Error(`Invalid ROUTE_TABLE entry '${entry}': prefix must start with '/'.`);
    }
    if (!isServiceKey(service)) {
      throw new Error(
        `Invalid ROUTE_TABLE entry '${entry}': unknown service '${service}', expected one of ${KNOWN_SERVICES.join(', ')}.`,
      );
    }
    return { prefix, target: services[service], segments: segmentsOf(prefix) };
  });

  return [...table].sort((a, b) => {
    const [aLiteral, aLength] = specificity(a);
    const [bLiteral, bLength] = specificity(b);
    return bLiteral - aLiteral || bLength - aLength;
  });
}

/** The most specific configured pattern that `path` falls under, or `undefined`. */
export function resolveRoute(table: readonly RouteEntry[], path: string): RouteEntry | undefined {
  const parts = segmentsOf(path.split('?')[0] ?? path);
  return table.find(
    (entry) =>
      entry.segments.length <= parts.length &&
      entry.segments.every((segment, i) => segment === WILDCARD || segment === parts[i]),
  );
}

/** Whether `path` falls under one of the configured public (no-auth) prefixes. */
export function isPublicPath(prefixes: readonly string[], path: string): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  );
}
