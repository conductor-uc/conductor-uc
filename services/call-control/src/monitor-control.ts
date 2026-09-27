import { randomUUID } from 'node:crypto';

import type { AuditEventInput } from '@cuc/audit';
import {
  allowed,
  type Actor,
  type OrgRef,
  type Permission,
  type Role,
  type Scope,
} from '@cuc/authz';
import {
  AccessUnavailableError,
  ProblemError,
  type AccessClient,
  type ActorAccess,
  type OrgType,
} from '@cuc/http';
import type { Logger } from '@cuc/logger';

import {
  UpstreamError,
  type ExtensionScopeLookup,
  type TenantDomainLookup,
  type UserExtensionLookup,
} from './clients.js';
import type { EslApiResult } from './esl/client.js';
import type { CallRegistry } from './redis/registry.js';

export type MonitorMode = 'listen' | 'whisper' | 'barge';

/** The part of an ESL client this needs. */
export interface MonitorEsl {
  sendApi(command: string): Promise<EslApiResult>;
  sendBgApi(command: string, timeoutMs: number): Promise<EslApiResult>;
}

export interface MonitorControllerOptions {
  readonly registry: CallRegistry;
  /** The ESL connection to a node, when this service has one up. */
  readonly esl: (nodeId: string) => MonitorEsl | undefined;
  /** What the person may do: their roles, and every grant naming them (identity-service). */
  readonly access: AccessClient;
  readonly userExtension: UserExtensionLookup;
  readonly extensionScope: ExtensionScopeLookup;
  readonly tenantDomain: TenantDomainLookup;
  /** Writes the audit event to the outbox; resolves once it is committed. */
  readonly audit: (input: AuditEventInput) => Promise<void>;
  /** OpenSIPs' SIP address as the nodes reach it (`opensips:5060`), like telephony-config's. */
  readonly opensipsSipUri: string;
  /** How long the supervisor's phone rings before the attempt is given up. */
  readonly ringTimeoutSeconds: number;
  readonly logger: Logger;
}

export interface MonitorCommand {
  readonly tenantId: string;
  /** Either leg of the call, from the live calls feed. */
  readonly callUuid: string;
  readonly mode: MonitorMode;
  /** The signed-in person. */
  readonly actor: {
    readonly id: string;
    readonly orgId: string;
    readonly orgType: OrgType;
    readonly resellerId: string | null;
  };
  readonly ip?: string;
  readonly requestId?: string;
}

export interface MonitorResult {
  readonly mode: MonitorMode;
  /** The leg the supervisor is joined to: the tenant's own party on the call, when it has one. */
  readonly callUuid: string;
  /** The supervisor's own leg, the call to their phone. */
  readonly monitorCallUuid: string;
}

export interface MonitorController {
  monitor(command: MonitorCommand): Promise<MonitorResult>;
}

/** A channel uuid, as FreeSWITCH makes them. Anything else never reaches an ESL command. */
const CHANNEL_UUID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
/** An extension number (pbx-config-service's `numbering.ts`: 2-6 digits). */
const EXTENSION_NUMBER = /^[0-9]{2,6}$/;
/** A SIP domain as org-service stores it. */
const SIP_DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
/** A queue id as `mod_callcenter` names the queue: `<queue id>@<tenant domain>`. */
const QUEUE_NAME = /^([0-9A-Za-z-]{1,64})@/;

/**
 * What the supervisor's phone shows as the caller while it rings. Neutral words only: never a
 * product, operator or brand name (CLAUDE.md rule 1).
 */
const CALLER_NAME: Readonly<Record<MonitorMode, string>> = {
  listen: 'Listen',
  whisper: 'Whisper',
  barge: 'Barge',
};

/**
 * Hangup causes that mean the supervisor's phone could not be reached at all (not registered, or
 * nothing answers for it), versus ones where it rang and nobody picked up.
 */
const UNREACHABLE = new Set([
  'USER_NOT_REGISTERED',
  'UNALLOCATED_NUMBER',
  'NO_ROUTE_DESTINATION',
  'SUBSCRIBER_ABSENT',
  'NO_USER_RESPONSE',
  'DESTINATION_OUT_OF_ORDER',
  'NETWORK_OUT_OF_ORDER',
  'RECOVERY_ON_TIMER_EXPIRE',
]);
const NOT_ANSWERED = new Set([
  'NO_ANSWER',
  'USER_BUSY',
  'CALL_REJECTED',
  'ORIGINATOR_CANCEL',
  'NORMAL_CLEARING',
  'ALLOTTED_TIMEOUT',
]);

function notFound(): ProblemError {
  return ProblemError.notFound('There is no such call in progress.', { code: 'call_not_found' });
}

function unavailable(detail: string, code: string): ProblemError {
  return ProblemError.unavailable(detail, { code });
}

const NOTHING_DONE =
  'The call could not be reached right now. Nothing was done. Try again shortly.';

function tenantOrg(tenantId: string): OrgRef {
  // The tenant's reseller is not needed: resellers are turned away (H1) before this.
  return { id: tenantId, type: 'tenant', resellerId: null };
}

/** The live call's legs as the registry has them: the one asked about, and its partner. */
interface Leg {
  readonly uuid: string;
  readonly node: string;
  readonly ext: string | undefined;
  readonly state: string;
}

function legOf(uuid: string, hash: Record<string, string>): Leg {
  const ext = hash['ext'];
  return {
    uuid,
    node: hash['node'] ?? '',
    ext: ext !== undefined && EXTENSION_NUMBER.test(ext) ? ext : undefined,
    state: hash['state'] ?? '',
  };
}

/**
 * S5-09: a supervisor listens to, whispers into, or barges a live call, from their own phone
 * (O-14: no browser audio). Nothing about the call is taken from the client but its uuid.
 *
 * 1. Finds the leg in the registry, in the tenant the URL names; anything else is "no such call".
 *    The supervisor joins the tenant's own party on the call (the leg with an extension: for a
 *    queue call, the agent), so a whisper is heard by the person the supervisor coaches.
 * 2. Checks `monitor.<mode>` for *this* call (07 §3.3, G-121): held across the tenant (a role,
 *    like `tenant_supervisor`, or a grant on the org) covers every call; a grant scoped to an
 *    extension covers calls that extension is on; one scoped to a queue covers calls in the queue
 *    (`cc_queue` on either leg, read on the node) and calls whose target is one of its agents.
 * 3. Rings the person's own extension (from the signed actor, never the request), and only after
 *    the audit event for the attempt is committed: nothing unaudited is done.
 * 4. Originates from the node that holds the call (`bgapi`, so the ringing does not hold the
 *    node's ESL connection), through OpenSIPs like any call to a phone, into `eavesdrop` (listen;
 *    whisper, with `eavesdrop_whisper_aleg` so only the target hears the supervisor) or
 *    `three_way` (barge). `eavesdrop_enable_dtmf=false`: a listener cannot press a digit to start
 *    whispering or barging, which would bypass the permission for that mode.
 *
 * Resolves when the supervisor has answered and is joined; the call ends when either side hangs up.
 */
export function createMonitorController(options: MonitorControllerOptions): MonitorController {
  const { registry, access, logger } = options;

  async function variable(
    esl: MonitorEsl,
    uuid: string,
    name: string,
  ): Promise<string | undefined> {
    let result: EslApiResult;
    try {
      result = await esl.sendApi(`uuid_getvar ${uuid} ${name}`);
    } catch (error) {
      logger.warn({ err: error }, 'monitor: the media node could not be asked');
      throw unavailable(NOTHING_DONE, 'media_unavailable');
    }
    if (!result.ok) return undefined;
    const value = result.body.trim();
    return value === '' || value === '_undef_' || value.startsWith('-ERR') ? undefined : value;
  }

  async function upstream<T>(what: string, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof UpstreamError) {
        logger.error({ err: error }, `monitor: ${what} could not be asked`);
        throw unavailable(
          'Monitoring could not be set up right now, so nothing was done. Try again shortly.',
          'monitor_unavailable',
        );
      }
      throw error;
    }
  }

  async function resolveAccess(command: MonitorCommand): Promise<ActorAccess> {
    try {
      return await access.resolve({ orgId: command.actor.orgId, actorId: command.actor.id });
    } catch (error) {
      if (error instanceof AccessUnavailableError) {
        throw unavailable(
          'Permissions could not be checked; nothing was done. Try again shortly.',
          'permissions_unavailable',
        );
      }
      throw error;
    }
  }

  /** Whether the person may monitor this call: see step 2 above. */
  async function mayMonitor(
    command: MonitorCommand,
    permission: Permission,
    esl: MonitorEsl,
    target: Leg,
    legs: readonly Leg[],
  ): Promise<boolean> {
    const held = await resolveAccess(command);
    const actor: Actor = {
      id: command.actor.id,
      type: 'user',
      org: {
        id: command.actor.orgId,
        type: command.actor.orgType,
        resellerId: command.actor.resellerId,
      },
      roleIds: held.roles.map((role) => role.id),
    };
    const roles = new Map<string, Role>(
      held.roles.map((role) => [role.id, { id: role.id, permissions: new Set(role.permissions) }]),
    );
    const org = tenantOrg(command.tenantId);
    const check = (scope?: Scope): boolean =>
      allowed({
        actor,
        permission,
        resource: scope === undefined ? { org } : { org, scope },
        roles,
        grants: held.grants,
      });
    if (check()) return true;

    // No holding across the tenant: only a grant on something this call touches will do. Skip the
    // lookups for someone who holds the permission on no extension or queue at all.
    const scoped = held.grants.some(
      (grant) =>
        (grant.scope.type === 'extension' || grant.scope.type === 'queue') &&
        grant.permission === permission,
    );
    if (!scoped) return false;

    const scopes: Scope[] = [];
    for (const leg of legs) {
      if (leg.ext === undefined) continue;
      const found = await upstream('pbx-config-service', () =>
        options.extensionScope(command.tenantId, leg.ext!),
      );
      if (found === undefined) continue;
      scopes.push({ type: 'extension', id: found.extensionId });
      if (leg.uuid === target.uuid) {
        for (const queueId of found.agentQueueIds) scopes.push({ type: 'queue', id: queueId });
      }
    }
    for (const leg of legs) {
      const queue = await variable(esl, leg.uuid, 'cc_queue');
      const queueId = queue === undefined ? undefined : QUEUE_NAME.exec(queue)?.[1];
      if (queueId !== undefined) scopes.push({ type: 'queue', id: queueId });
    }
    return scopes.some((scope) => check(scope));
  }

  return {
    async monitor(command) {
      const { tenantId, callUuid, mode } = command;
      const permission: Permission = `monitor.${mode}`;
      if (!CHANNEL_UUID.test(callUuid)) throw notFound();

      const asked = await registry.getCall(callUuid);
      if (asked === undefined || asked['tenant'] !== tenantId) throw notFound();
      const legs: Leg[] = [legOf(callUuid, asked)];
      const partnerUuid = asked['bridgedTo'];
      if (partnerUuid !== undefined && CHANNEL_UUID.test(partnerUuid)) {
        const partner = await registry.getCall(partnerUuid);
        // A partner that is some other tenant's leg is not this call's business. A trunk leg that
        // has not learnt its tenant yet (`normalize.ts`) is still this call's.
        const partnerTenant = partner?.['tenant'] ?? '';
        if (partner !== undefined && (partnerTenant === tenantId || partnerTenant === '')) {
          legs.push(legOf(partnerUuid, partner));
        }
      }
      const target = legs.find((leg) => leg.ext !== undefined) ?? legs[0]!;
      if (target.state !== 'answered' && target.state !== 'held') {
        throw ProblemError.conflict('This call has not been answered yet.', {
          code: 'call_not_answered',
        });
      }

      const esl = options.esl(target.node);
      if (esl === undefined) throw unavailable(NOTHING_DONE, 'media_unavailable');

      if (!(await mayMonitor(command, permission, esl, target, legs))) {
        logger.warn({ tenantId, callUuid, mode, actorId: command.actor.id }, 'monitor: refused');
        throw ProblemError.forbidden(
          `You do not have the ${permission} permission for this call.`,
          {
            code: 'insufficient_permission',
          },
        );
      }

      const own = await upstream('pbx-config-service', () =>
        options.userExtension(tenantId, command.actor.id),
      );
      if (own === undefined || !EXTENSION_NUMBER.test(own.number)) {
        throw ProblemError.notFound(
          'No extension is linked to your account, so there is no phone to ring. Ask an administrator to link one.',
          { code: 'no_linked_extension' },
        );
      }
      if (legs.some((leg) => leg.ext === own.number)) {
        throw ProblemError.conflict('You are on this call.', { code: 'own_call' });
      }

      const domain = await upstream('org-service', () => options.tenantDomain(tenantId));
      if (domain === undefined || !SIP_DOMAIN.test(domain)) {
        logger.error({ tenantId }, 'monitor: the tenant has no usable SIP domain');
        throw unavailable(
          'Monitoring could not be set up right now, so nothing was done. Try again shortly.',
          'monitor_unavailable',
        );
      }

      try {
        await options.audit({
          actorType: 'user',
          actorId: command.actor.id,
          actorOrgId: command.actor.orgId,
          targetOrgId: tenantId,
          action: `call.monitor.${mode}`,
          resource: `call:${target.uuid}`,
          dataClass: 'private',
          ...(command.ip === undefined ? {} : { ip: command.ip }),
          ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
        });
      } catch (error) {
        logger.error({ err: error, tenantId }, 'monitor: the audit event could not be written');
        throw unavailable(
          'Monitoring could not be set up right now, so nothing was done. Try again shortly.',
          'monitor_unavailable',
        );
      }

      const monitorCallUuid = randomUUID();
      const vars = [
        `origination_uuid=${monitorCallUuid}`,
        `sip_route_uri=sip:${options.opensipsSipUri}`,
        `origination_caller_id_name=${CALLER_NAME[mode]}`,
        `origination_caller_id_number=${target.ext ?? '0'}`,
        `originate_timeout=${String(options.ringTimeoutSeconds)}`,
        `cuc_tenant_id=${tenantId}`,
        `cuc_monitor_mode=${mode}`,
        `cuc_monitor_target=${target.uuid}`,
        'eavesdrop_enable_dtmf=false',
        ...(mode === 'whisper' ? ['eavesdrop_whisper_aleg=true'] : []),
      ];
      const app = mode === 'barge' ? `three_way(${target.uuid})` : `eavesdrop(${target.uuid})`;
      const originate = `originate {${vars.join(',')}}sofia/internal/${own.number}@${domain} &${app}`;

      let done: EslApiResult;
      try {
        done = await esl.sendBgApi(originate, (options.ringTimeoutSeconds + 10) * 1000);
      } catch (error) {
        logger.error(
          { err: error, tenantId, callUuid: target.uuid, mode },
          'monitor: originate failed',
        );
        throw unavailable(
          'The call to your phone could not be placed. Try again shortly.',
          'media_node_failed',
        );
      }
      if (!done.ok) {
        const cause =
          done.body
            .replace(/^-ERR\s*/, '')
            .trim()
            .split(/\s/)[0] ?? '';
        logger.warn({ tenantId, callUuid: target.uuid, mode, cause }, 'monitor: phone not joined');
        if (UNREACHABLE.has(cause)) {
          throw ProblemError.conflict('Your phone could not be reached. Is it registered?', {
            code: 'phone_unreachable',
          });
        }
        if (NOT_ANSWERED.has(cause)) {
          throw ProblemError.conflict('Your phone was not answered.', {
            code: 'phone_not_answered',
          });
        }
        throw unavailable(
          'The call to your phone could not be placed. Try again shortly.',
          'media_node_failed',
        );
      }
      logger.info({ tenantId, callUuid: target.uuid, mode, monitorCallUuid }, 'monitor: joined');
      return { mode, callUuid: target.uuid, monitorCallUuid };
    },
  };
}
