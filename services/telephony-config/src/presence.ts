import type { Database } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { parseCallHandling } from './domain/call-handling.js';
import { telephonyEvents } from './events.js';
import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { TelephonyConfigDb } from './schema.js';

/** One extension's presence, as this service knows it. */
export interface ExtensionPresence {
  readonly extensionId: string;
  /** The dialable number. */
  readonly extension: string;
  /** A phone is registered for it now (OpenSIPs' `usrloc`). */
  readonly registered: boolean;
  /** Its call handling says do not disturb. */
  readonly dnd: boolean;
}

/**
 * The AORs (`user@domain`, lowercased) that have a live contact in OpenSIPs' `ul_dump` answer.
 *
 * The shape, confirmed live against OpenSIPs 3.6: `{Domains: [{name: 'location', AORs: [{AOR,
 * Contacts: [{Contact, Expires, ...}]}]}]}`. `Expires` is the seconds left, or `"deleted"` for a
 * contact that is gone but not yet purged (a re-registration leaves the old one so), or
 * `"permanent"`. Anything unexpected counts as not registered rather than failing the poll.
 */
export function registeredAors(result: unknown): Set<string> {
  const registered = new Set<string>();
  const domains = (result as { Domains?: unknown } | null)?.Domains;
  if (!Array.isArray(domains)) return registered;
  for (const domain of domains) {
    const aors = (domain as { AORs?: unknown } | null)?.AORs;
    if (!Array.isArray(aors)) continue;
    for (const entry of aors) {
      const aor = (entry as { AOR?: unknown } | null)?.AOR;
      const contacts = (entry as { Contacts?: unknown } | null)?.Contacts;
      if (typeof aor !== 'string' || !Array.isArray(contacts)) continue;
      const live = contacts.some((contact) => {
        const expires = (contact as { Expires?: unknown } | null)?.Expires;
        return (typeof expires === 'number' && expires > 0) || expires === 'permanent';
      });
      if (live) registered.add(aor.toLowerCase());
    }
  }
  return registered;
}

export interface PresenceWatcher {
  /** One pass: ask OpenSIPs, compare, and announce what changed. Resolves with how many changed. */
  pollOnce(): Promise<number>;
  /** The tenant's extensions with their presence (`GET /internal/v1/tenants/:t/presence`). */
  forTenant(tenantId: string): Promise<ExtensionPresence[]>;
  start(intervalMs: number): void;
  stop(): void;
}

/**
 * S5-10 (G-122): where registration and do-not-disturb presence comes from.
 *
 * No other service can see either: registrations live in OpenSIPs (`usrloc`, which only this
 * service talks to, over MI), and do not disturb in each extension's call handling (this
 * service's copy, `extension_call_handling`). Each pass asks OpenSIPs for every registration
 * (`ul_dump`), works out every extension's presence from the read model (an extension is
 * registered when its SIP username at its tenant's domain has a live contact), compares with what
 * was last announced (`extension_presence`) and, for each extension that changed, stores the new
 * state and enqueues `call.presence.changed` in one transaction (CLAUDE.md rule 6). So a change
 * reaches the live views within one poll interval, and a restart announces nothing that did not
 * change. When OpenSIPs cannot be asked, the pass does nothing: it never marks every phone offline
 * because the registrar is briefly unreachable.
 *
 * Like the read model, not `scoped(ctx)`: this is a background pass over every tenant, with no
 * tenant request to scope to (`read-model.repo.ts`'s own comment).
 */
export function createPresenceWatcher(options: {
  readonly db: Database<TelephonyConfigDb>;
  readonly mi: OpenSipsMiClient;
  readonly logger: Logger;
}): PresenceWatcher {
  const { db, mi, logger } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  /** Every extension's presence now, given the registered AORs. */
  async function current(registered: ReadonlySet<string>, tenantId?: string) {
    let query = db.kysely
      .selectFrom('extensions')
      .innerJoin('domains', 'domains.tenant_id', 'extensions.tenant_id')
      .leftJoin('extension_call_handling', 'extension_call_handling.extension_id', 'extensions.id')
      .select([
        'extensions.id as extensionId',
        'extensions.tenant_id as tenantId',
        'extensions.number as number',
        'extensions.username as username',
        'domains.fqdn as fqdn',
        'extension_call_handling.settings as settings',
      ]);
    if (tenantId !== undefined) query = query.where('extensions.tenant_id', '=', tenantId);
    const rows = await query.execute();
    return rows.map((row) => ({
      tenantId: row.tenantId,
      extensionId: row.extensionId,
      extension: row.number,
      registered: registered.has(`${row.username}@${row.fqdn}`.toLowerCase()),
      dnd: row.settings === null ? false : parseCallHandling(row.settings).dnd,
    }));
  }

  async function pollOnce(): Promise<number> {
    const registered = registeredAors(await mi.query('ul_dump'));
    const now = await current(registered);
    const before = new Map(
      (
        await db.kysely
          .selectFrom('extension_presence')
          .select(['extension_id', 'registered', 'dnd'])
          .execute()
      ).map((row) => [row.extension_id, row]),
    );

    let changed = 0;
    for (const presence of now) {
      const last = before.get(presence.extensionId);
      before.delete(presence.extensionId);
      if (
        last !== undefined &&
        Boolean(last.registered) === presence.registered &&
        Boolean(last.dnd) === presence.dnd
      ) {
        continue;
      }
      await db.kysely.transaction().execute(async (trx) => {
        const row = {
          tenant_id: presence.tenantId,
          registered: presence.registered,
          dnd: presence.dnd,
          updated_at: new Date(),
        };
        if (last === undefined) {
          await trx
            .insertInto('extension_presence')
            .values({ extension_id: presence.extensionId, ...row })
            .execute();
        } else {
          await trx
            .updateTable('extension_presence')
            .set(row)
            .where('extension_id', '=', presence.extensionId)
            .execute();
        }
        await enqueueEvent(trx, telephonyEvents, {
          type: 'call.presence.changed',
          data: {
            extensionId: presence.extensionId,
            extension: presence.extension,
            registered: presence.registered,
            dnd: presence.dnd,
          },
          orgContext: { tenantId: presence.tenantId },
        });
      });
      changed += 1;
    }

    // Extensions that no longer exist: forget them. Nothing to announce; the live views drop an
    // extension that is no longer in a snapshot.
    const gone = [...before.keys()];
    if (gone.length > 0) {
      await db.kysely.deleteFrom('extension_presence').where('extension_id', 'in', gone).execute();
    }
    return changed;
  }

  return {
    pollOnce,

    async forTenant(tenantId) {
      // The stored rows are what was last announced, so a snapshot and the events after it agree.
      const stored = new Map(
        (
          await db.kysely
            .selectFrom('extension_presence')
            .select(['extension_id', 'registered', 'dnd'])
            .where('tenant_id', '=', tenantId)
            .execute()
        ).map((row) => [row.extension_id, row]),
      );
      const extensions = await current(new Set(), tenantId);
      return extensions
        .map((extension) => {
          const known = stored.get(extension.extensionId);
          return {
            extensionId: extension.extensionId,
            extension: extension.extension,
            // Not polled yet: not known to be registered, and do not disturb from call handling.
            registered: known === undefined ? false : Boolean(known.registered),
            dnd: known === undefined ? extension.dnd : Boolean(known.dnd),
          };
        })
        .sort((a, b) => a.extension.localeCompare(b.extension, 'en', { numeric: true }));
    },

    start(intervalMs) {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        pollOnce()
          .catch((error: unknown) => {
            logger.warn({ err: error }, 'presence: pass failed; will try again');
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
    },

    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
