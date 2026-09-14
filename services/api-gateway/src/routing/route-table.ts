/** One entry in the routing table: a path prefix and the service base URL behind it. */
export interface RouteEntry {
  readonly prefix: string;
  readonly target: string;
}

const KNOWN_SERVICES = ['identity', 'org'] as const;
type ServiceKey = (typeof KNOWN_SERVICES)[number];

function isServiceKey(value: string): value is ServiceKey {
  return (KNOWN_SERVICES as readonly string[]).includes(value);
}

/**
 * Parses `ROUTE_TABLE` (`prefix=service` entries) against the known service
 * base URLs, and orders the result longest-prefix-first so route resolution
 * is a simple first-match scan.
 */
export function buildRouteTable(
  entries: readonly string[],
  services: Readonly<Record<ServiceKey, string>>,
): readonly RouteEntry[] {
  const table = entries.map((entry) => {
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
    return { prefix, target: services[service] };
  });

  return [...table].sort((a, b) => b.prefix.length - a.prefix.length);
}

/** The longest configured prefix that `path` starts under, or `undefined`. */
export function resolveRoute(table: readonly RouteEntry[], path: string): RouteEntry | undefined {
  return table.find(
    (entry) =>
      path === entry.prefix ||
      path.startsWith(`${entry.prefix}/`) ||
      path.startsWith(`${entry.prefix}?`),
  );
}

/** Whether `path` falls under one of the configured public (no-auth) prefixes. */
export function isPublicPath(prefixes: readonly string[], path: string): boolean {
  return prefixes.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  );
}
