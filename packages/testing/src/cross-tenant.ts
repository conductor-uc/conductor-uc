/**
 * Thrown when a repository lets one tenant see, change, or delete another
 * tenant's rows — or when it cannot see its own.
 */
export class TenantIsolationError extends Error {
  override readonly name = 'TenantIsolationError';
  readonly probe: string;

  constructor(probe: string, detail: string) {
    super(`Tenant isolation probe "${probe}" failed: ${detail}`);
    this.probe = probe;
  }
}

/**
 * A repository under probe, described only by what it can do.
 *
 * The probe drives the real repository, not a mock: the whole point is to catch
 * a missing `WHERE tenant_id`, which only a real query has.
 */
export interface TenantProbeSubject<Id> {
  /** A name for failure messages, e.g. `extensions`. */
  readonly name: string;

  /** Creates one row owned by `tenantId` and returns its id. */
  readonly seed: (tenantId: string) => Promise<Id>;

  /** Reads the rows the given tenant can see. Must return only its own. */
  readonly list: (tenantId: string) => Promise<readonly { id: Id }[]>;

  /** Reads one row by id as the given tenant. Must be undefined across tenants. */
  readonly findById?: (tenantId: string, id: Id) => Promise<{ id: Id } | undefined>;

  /** Updates one row as the given tenant. Must affect 0 rows across tenants. */
  readonly update?: (tenantId: string, id: Id) => Promise<number>;

  /** Deletes one row as the given tenant. Must affect 0 rows across tenants. */
  readonly remove?: (tenantId: string, id: Id) => Promise<number>;
}

export interface TenantProbeOptions {
  /** Defaults to two generated UUIDs. */
  readonly tenantA?: string;
  readonly tenantB?: string;
}

/**
 * Runs the cross-tenant probe from 05 §2.4: create data in tenant A, then query
 * as tenant B and expect it to be absent.
 *
 * It also asserts the opposite direction — that tenant A *can* see its own row.
 * Without that, a repository that returns nothing at all would pass every
 * isolation check, and "returns nothing" is a far more common bug than
 * "returns too much".
 *
 * Throws {@link TenantIsolationError} on the first violation. Use
 * {@link crossTenantProbe} to register it as a test.
 */
export async function assertTenantIsolation<Id>(
  subject: TenantProbeSubject<Id>,
  options: TenantProbeOptions = {},
): Promise<void> {
  const { randomUUID } = await import('node:crypto');
  const tenantA = options.tenantA ?? randomUUID();
  const tenantB = options.tenantB ?? randomUUID();
  const fail = (detail: string): never => {
    throw new TenantIsolationError(subject.name, detail);
  };

  const idA = await subject.seed(tenantA);
  const idB = await subject.seed(tenantB);

  // Visibility: a repository that reads nothing must not pass as "isolated".
  const ownRows = await subject.list(tenantA);
  if (!ownRows.some((row) => String(row.id) === String(idA))) {
    fail(
      `tenant A cannot see its own row ${String(idA)}. The repository returned ` +
        `${String(ownRows.length)} row(s); isolation cannot be judged until it reads its own data.`,
    );
  }

  // Isolation on list.
  const leaked = ownRows.filter((row) => String(row.id) === String(idB));
  if (leaked.length > 0) {
    fail(
      `list(tenantA) returned tenant B's row ${String(idB)}. ` +
        `The query is missing its tenant_id predicate — use scoped(ctx).`,
    );
  }

  // Isolation on read-by-id, which is where a lookup by primary key alone hides.
  if (subject.findById !== undefined) {
    const own = await subject.findById(tenantA, idA);
    if (own === undefined) fail(`findById(tenantA, ${String(idA)}) could not read its own row.`);

    const other = await subject.findById(tenantA, idB);
    if (other !== undefined) {
      fail(
        `findById(tenantA, ${String(idB)}) returned tenant B's row. A lookup by ` +
          `primary key still needs the tenant_id predicate.`,
      );
    }
  }

  // Isolation on write. A cross-tenant update that reports 0 rows but still
  // wrote would be caught by the list check that follows it.
  if (subject.update !== undefined) {
    const ownAffected = await subject.update(tenantA, idA);
    if (ownAffected === 0) fail(`update(tenantA, ${String(idA)}) affected no rows of its own.`);

    const crossAffected = await subject.update(tenantA, idB);
    if (crossAffected !== 0) {
      fail(`update(tenantA, ${String(idB)}) affected ${String(crossAffected)} of tenant B's rows.`);
    }
  }

  if (subject.remove !== undefined) {
    const crossDeleted = await subject.remove(tenantA, idB);
    if (crossDeleted !== 0) {
      fail(`remove(tenantA, ${String(idB)}) deleted ${String(crossDeleted)} of tenant B's rows.`);
    }

    const stillThere = await subject.list(tenantB);
    if (!stillThere.some((row) => String(row.id) === String(idB))) {
      fail(
        `remove(tenantA, ${String(idB)}) reported 0 rows but tenant B's row is gone. ` +
          `The delete ran without its tenant_id predicate.`,
      );
    }

    const ownDeleted = await subject.remove(tenantA, idA);
    if (ownDeleted === 0) fail(`remove(tenantA, ${String(idA)}) deleted none of its own rows.`);
  }
}
