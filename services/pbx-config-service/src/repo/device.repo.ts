import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError, requireTenant } from '@cuc/db';

import {
  generateProvisioningToken,
  hashProvisioningToken,
  normalizeMac,
} from '../domain/provisioning.js';
import type { PbxConfigServiceDb } from '../schema.js';

export type DeviceVendor = 'yealink';

export interface Device {
  readonly id: string;
  readonly tenantId: string;
  readonly extensionId: string;
  readonly vendor: DeviceVendor;
  readonly model: string | null;
  /** Twelve lower-case hex digits, no separators. */
  readonly mac: string;
  readonly label: string | null;
  /** Whether a provisioning password has been issued. Without one the phone cannot fetch its settings. */
  readonly provisioningIssued: boolean;
  readonly lastProvisionedAt: Date | null;
  readonly lastSeenIp: string | null;
  readonly lastUserAgent: string | null;
}

export interface CreateDeviceInput {
  readonly extensionId: string;
  readonly mac: string;
  readonly model?: string | null;
  readonly label?: string | null;
}

export interface UpdateDeviceInput {
  readonly extensionId?: string;
  readonly model?: string | null;
  readonly label?: string | null;
}

/** What the provisioning route needs to know about a device before it knows the tenant. */
export interface ProvisioningTarget {
  readonly id: string;
  readonly tenantId: string;
  readonly extensionId: string;
  readonly mac: string;
  readonly tokenHash: string | null;
}

export class DeviceNotFoundError extends Error {
  override readonly name = 'DeviceNotFoundError';
}

/** The extension does not exist in this tenant. */
export class DeviceExtensionNotFoundError extends Error {
  override readonly name = 'DeviceExtensionNotFoundError';
}

/** A device with this MAC address already exists (in this or another tenant). */
export class DeviceMacTakenError extends Error {
  override readonly name = 'DeviceMacTakenError';
}

interface DeviceRow {
  id: string;
  tenant_id: string;
  extension_id: string;
  vendor: string;
  model: string | null;
  mac: string;
  label: string | null;
  token_hash: string | null;
  last_provisioned_at: Date | null;
  last_seen_ip: string | null;
  last_user_agent: string | null;
}

function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    extensionId: row.extension_id,
    vendor: row.vendor as DeviceVendor,
    model: row.model,
    mac: row.mac,
    label: row.label,
    provisioningIssued: row.token_hash !== null,
    lastProvisionedAt: row.last_provisioned_at,
    lastSeenIp: row.last_seen_ip,
    lastUserAgent: row.last_user_agent,
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? null : trimmed;
}

export function createDeviceRepo(db: Database<PbxConfigServiceDb>) {
  async function requireExtension(ctx: DbContext, extensionId: string): Promise<void> {
    const found = await db
      .scoped(ctx)
      .selectFrom('extensions')
      .select('id')
      .where('id', '=', extensionId)
      .executeTakeFirst();
    if (found === undefined) {
      throw new DeviceExtensionNotFoundError(
        `No extension with id '${extensionId}' in this tenant.`,
      );
    }
  }

  return {
    list: (ctx: DbContext): Promise<Device[]> =>
      db
        .scoped(ctx)
        .selectFrom('devices')
        .selectAll()
        .orderBy('created_at', 'asc')
        .execute()
        .then((rows) => rows.map(toDevice)),

    findById: (ctx: DbContext, id: string): Promise<Device | undefined> =>
      db
        .scoped(ctx)
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : toDevice(row))),

    async create(ctx: DbContext, input: CreateDeviceInput): Promise<Device> {
      const { tenantId } = requireTenant(ctx);
      const mac = normalizeMac(input.mac);
      await requireExtension(ctx, input.extensionId);

      const id = randomUUID();
      const now = new Date();
      try {
        await db
          .scoped(ctx)
          .insertInto('devices')
          .values({
            id,
            extension_id: input.extensionId,
            vendor: 'yealink',
            model: blankToNull(input.model),
            mac,
            label: blankToNull(input.label),
            token_hash: null,
            last_provisioned_at: null,
            last_seen_ip: null,
            last_user_agent: null,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new DeviceMacTakenError(mac);
        throw error;
      }

      return {
        id,
        tenantId,
        extensionId: input.extensionId,
        vendor: 'yealink',
        model: blankToNull(input.model),
        mac,
        label: blankToNull(input.label),
        provisioningIssued: false,
        lastProvisionedAt: null,
        lastSeenIp: null,
        lastUserAgent: null,
      };
    },

    async update(ctx: DbContext, id: string, input: UpdateDeviceInput): Promise<Device> {
      const existing = await db
        .scoped(ctx)
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) throw new DeviceNotFoundError(`No device with id '${id}'.`);

      if (input.extensionId !== undefined) await requireExtension(ctx, input.extensionId);

      const next = {
        extension_id: input.extensionId ?? existing.extension_id,
        model: input.model === undefined ? existing.model : blankToNull(input.model),
        label: input.label === undefined ? existing.label : blankToNull(input.label),
        updated_at: new Date(),
      };
      await db.scoped(ctx).updateTable('devices').set(next).where('id', '=', id).execute();
      return toDevice({ ...existing, ...next });
    },

    async remove(ctx: DbContext, id: string): Promise<void> {
      const result = await db
        .scoped(ctx)
        .deleteFrom('devices')
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) {
        throw new DeviceNotFoundError(`No device with id '${id}'.`);
      }
    },

    /**
     * Issues a new provisioning password and returns it. This is the only time
     * it exists in the clear: only its hash is kept, so issuing again replaces
     * it and the previous one stops working at once.
     */
    async issueProvisioningPassword(
      ctx: DbContext,
      id: string,
    ): Promise<{ readonly deviceId: string; readonly password: string }> {
      const token = generateProvisioningToken();
      const result = await db
        .scoped(ctx)
        .updateTable('devices')
        .set({ token_hash: hashProvisioningToken(token), updated_at: new Date() })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(result.numUpdatedRows) === 0) {
        throw new DeviceNotFoundError(`No device with id '${id}'.`);
      }
      return { deviceId: id, password: token };
    },

    /**
     * Cross-tenant, like `cdr-service`'s export lookup: a phone arrives with a
     * device id and a password, so which tenant it belongs to is the answer,
     * not something known beforehand. Everything after this call is scoped to
     * the tenant it returns.
     */
    findProvisioningTarget(id: string): Promise<ProvisioningTarget | undefined> {
      return db.kysely
        .selectFrom('devices')
        .select(['id', 'tenant_id', 'extension_id', 'mac', 'token_hash'])
        .where('id', '=', id)
        .executeTakeFirst()
        .then((row) =>
          row === undefined
            ? undefined
            : {
                id: row.id,
                tenantId: row.tenant_id,
                extensionId: row.extension_id,
                mac: row.mac,
                tokenHash: row.token_hash,
              },
        );
    },

    /**
     * Cross-tenant, for the same reason as `findProvisioningTarget`: a phone
     * that authenticated with the platform-wide credential names itself only
     * by its MAC address, so the tenant is what the lookup returns.
     */
    findProvisioningTargetByMac(mac: string): Promise<ProvisioningTarget | undefined> {
      return db.kysely
        .selectFrom('devices')
        .select(['id', 'tenant_id', 'extension_id', 'mac', 'token_hash'])
        .where('mac', '=', mac)
        .executeTakeFirst()
        .then((row) =>
          row === undefined
            ? undefined
            : {
                id: row.id,
                tenantId: row.tenant_id,
                extensionId: row.extension_id,
                mac: row.mac,
                tokenHash: row.token_hash,
              },
        );
    },

    /** Notes that the phone just fetched its settings, and from where. */
    async recordFetch(
      ctx: DbContext,
      id: string,
      seen: { readonly ip?: string; readonly userAgent?: string },
    ): Promise<void> {
      await db
        .scoped(ctx)
        .updateTable('devices')
        .set({
          last_provisioned_at: new Date(),
          last_seen_ip: seen.ip?.slice(0, 64) ?? null,
          last_user_agent: seen.userAgent?.slice(0, 255) ?? null,
        })
        .where('id', '=', id)
        .execute();
    },
  };
}

export type DeviceRepo = ReturnType<typeof createDeviceRepo>;
