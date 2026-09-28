import { randomUUID } from 'node:crypto';

import type { AuditEventInput } from '@cuc/audit';
import { ProblemError } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import {
  UpstreamError,
  type ParkingLotLookup,
  type PickupPeersLookup,
  type TenantDomainLookup,
  type UserExtensionLookup,
} from './clients.js';
import type { EslApiResult } from './esl/client.js';
import type { CallRegistry } from './redis/registry.js';

/** The part of an ESL client this needs. */
export interface OperationsEsl {
  sendApi(command: string): Promise<EslApiResult>;
  sendBgApi(command: string, timeoutMs: number): Promise<EslApiResult>;
}

/** Where a parking lot's lease is (the affinity manager's `getOwner`, kind `park`). */
export type ParkingLotNode = (tenantId: string, lotId: string) => Promise<string | undefined>;

export interface CallOperationsOptions {
  readonly registry: CallRegistry;
  /** The ESL connection to a node, when this service has one up. */
  readonly esl: (nodeId: string) => OperationsEsl | undefined;
  /** Any node this service can reach, for a call that starts at the person's phone. */
  readonly anyNode: () => Promise<string | undefined>;
  readonly userExtension: UserExtensionLookup;
  readonly tenantDomain: TenantDomainLookup;
  readonly parkingLot: ParkingLotLookup;
  /** S9-18: whose ringing calls an extension may pick up (its pickup groups). */
  readonly pickupPeers: PickupPeersLookup;
  readonly parkingLotNode: ParkingLotNode;
  /** Writes the audit event to the outbox; resolves once it is committed. */
  readonly audit: (input: AuditEventInput) => Promise<void>;
  /** OpenSIPs' SIP address as the nodes reach it (`opensips:5060`). */
  readonly opensipsSipUri: string;
  /** How long the person's own phone rings before the attempt is given up. */
  readonly ringTimeoutSeconds: number;
  readonly logger: Logger;
}

/** The signed-in person, from the signed request. */
export interface OperationActor {
  readonly id: string;
  readonly orgId: string;
}

interface Base {
  readonly tenantId: string;
  readonly actor: OperationActor;
  readonly ip?: string;
  readonly requestId?: string;
}

/**
 * A command on a live leg. With `own`, it is self-service: the leg must be the person's own
 * extension's, and a transfer or park moves the other party. Without, it is the console's
 * (`call.control`): the leg named is the one hung up, moved or parked.
 */
export interface LegCommand extends Base {
  readonly callUuid: string;
  readonly own?: boolean;
}

export interface CallOperations {
  hangup(command: LegCommand): Promise<{ readonly result: 'hungup' }>;
  /** A blind transfer: the leg goes to `to` as if it had dialed it; the other party is let go. */
  transfer(
    command: LegCommand & { readonly to: string },
  ): Promise<{ readonly result: 'transferred'; readonly callUuid: string }>;
  park(
    command: LegCommand & { readonly parkingLotId: string },
  ): Promise<{ readonly result: 'parked'; readonly parkingLotId: string; readonly slot: number }>;
  /** Rings the person's own phone and, when answered, takes a call ringing someone else's. */
  pickup(command: LegCommand): Promise<{ readonly result: 'picked_up'; readonly callUuid: string }>;
  /**
   * S9-18 (G-125): the calls ringing within the person's pickup groups, oldest first, which
   * [pickupMine] can take.
   */
  pickupable(command: Base): Promise<PickupCandidate[]>;
  /**
   * S9-18: takes a call ringing within the person's pickup groups on their own phone: the one
   * named, or the oldest.
   */
  pickupMine(
    command: Base & { readonly callUuid?: string },
  ): Promise<{ readonly result: 'picked_up'; readonly callUuid: string }>;
  /**
   * S9-18: for `*8` dialed from [extension]'s phone: the caller's leg to intercept (the oldest call
   * ringing within its pickup groups) and the node it is on; undefined when there is none.
   */
  pickupTarget(
    tenantId: string,
    extension: string,
  ): Promise<{ readonly callUuid: string; readonly nodeId: string } | undefined>;
  /** Click-to-call: rings the person's own phone and, when answered, dials `to` from it. */
  dial(
    command: Base & { readonly to: string },
  ): Promise<{ readonly result: 'dialing'; readonly callUuid: string }>;
  /** An attended transfer, step one: the other party waits, and the person's call goes to `to`. */
  consult(
    command: LegCommand & { readonly to: string },
  ): Promise<{ readonly result: 'consulting'; readonly heldCallUuid: string }>;
  /** Step two: the waiting party is joined to the one consulted, and the person leaves. */
  completeTransfer(command: LegCommand): Promise<{ readonly result: 'transferred' }>;
  /** Or: back to the waiting party; the one consulted is let go. */
  cancelTransfer(command: LegCommand): Promise<{ readonly result: 'resumed' }>;
}

/** A call ringing a phone that someone may pick up (S9-18). */
export interface PickupCandidate {
  /** The ringing leg. */
  readonly callUuid: string;
  /** The extension it is ringing. */
  readonly extension: string;
  /** Who is calling. */
  readonly from: string;
  /** When it started ringing (ISO). */
  readonly startedAt: string;
}

/** A channel uuid, as FreeSWITCH makes them. Anything else never reaches an ESL command. */
const CHANNEL_UUID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;
/** An extension number (pbx-config-service's `numbering.ts`: 2-6 digits). */
const EXTENSION_NUMBER = /^[0-9]{2,6}$/;
/** What may be dialed: digits, and `*`, `#` and a leading `+`. The routes' schemas say the same. */
export const DIALABLE = /^\+?[0-9*#]{1,32}$/;
/** A SIP domain as org-service stores it. */
const SIP_DOMAIN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
/** A caller's number as shown on the person's phone while it rings. */
const SHOWN_NUMBER = /^\+?[0-9]{1,32}$/;

/**
 * The context every call from a phone runs in (`sip_profiles/internal.xml`). telephony-config
 * echoes it back and decides nothing by it: the tenant and direction come from the variables
 * {@link intoDialplan} sets.
 */
const CONTEXT = 'public';
/**
 * S9-19 (G-125): how long a caller waits during an attended transfer before their call rings the
 * person who put them on hold again.
 */
const HELD_TIMEOUT_SECONDS = 300;
/**
 * S9-19: what a waiting caller hears when their call has no `hold_music` (telephony-config
 * exports the tenant's on every call it routes; this is its neutral tone).
 */
const NEUTRAL_HOLD_TONE = 'tone_stream://%(250,4750,440);loops=-1';

/** The FreeSWITCH scheduler task that rings the transferrer back for [waiting]. */
function ringBackTask(waiting: string): string {
  return `cuc-ringback-${waiting}`;
}
/** How long a slot stays reserved while its call is moved into it. */
const SLOT_RESERVATION_MS = 15_000;
/** The registry field on the person's leg naming the party waiting during a consultation. */
const HELD_FIELD = 'consultHeld';

/**
 * What the person's phone shows as the caller while it rings for a pickup. Neutral words only:
 * never a product, operator or brand name (CLAUDE.md rule 1).
 */
const PICKUP_CALLER_NAME = 'Pickup';

const NOTHING_DONE =
  'The call could not be reached right now. Nothing was done. Try again shortly.';

/** Hangup causes meaning the person's phone could not be reached at all. */
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

interface Leg {
  readonly uuid: string;
  readonly node: string;
  readonly ext: string | undefined;
  readonly state: string;
  readonly from: string;
  readonly partner: string | undefined;
  readonly held: string | undefined;
}

function legOf(uuid: string, hash: Record<string, string>): Leg {
  const ext = hash['ext'];
  const partner = hash['bridgedTo'];
  const held = hash[HELD_FIELD];
  return {
    uuid,
    node: hash['node'] ?? '',
    ext: ext !== undefined && EXTENSION_NUMBER.test(ext) ? ext : undefined,
    state: hash['state'] ?? '',
    from: hash['from'] ?? '',
    partner: partner !== undefined && CHANNEL_UUID.test(partner) ? partner : undefined,
    held: held !== undefined && CHANNEL_UUID.test(held) ? held : undefined,
  };
}

/** A channel variable's value, or undefined when unset, empty, or the command failed. */
function variableValue(result: EslApiResult): string | undefined {
  if (!result.ok) return undefined;
  const value = result.body.trim();
  return value === '' || value === '_undef_' || value.startsWith('-ERR') ? undefined : value;
}

/** The occupied slots `valet_info <lot>` lists. */
export function occupiedSlots(valetInfo: string): Set<number> {
  const slots = new Set<number>();
  for (const match of valetInfo.matchAll(/<extension\b[^>]*>\s*(\d{1,6})\s*<\/extension>/g)) {
    slots.add(Number(match[1]));
  }
  return slots;
}

/**
 * S9-12: moving live calls, from the console and from a person's own portal (O-14: every call the
 * person takes part in rings their own phone; nothing plays in the browser).
 *
 * - **Hang up**: `uuid_kill`.
 * - **Transfer** (blind) and **park**: the leg is sent back through the tenant's dialplan as if it
 *   had dialed the number (or the free slot) itself, so extensions, ring groups, call flows,
 *   outside numbers, parking and their rules (toll-fraud limits, emergency routing) all apply
 *   exactly as they would to a phone. It is marked an internal call of the tenant with the same
 *   variables OpenSIPs' trusted headers give a phone's call; its caller ID is left as it was, so
 *   whoever answers sees the original caller.
 * - **Pickup**: rings the person's own phone and `intercept`s the ringing call's caller, which
 *   stops the ringing phone.
 * - **Click-to-call**: rings the person's own phone and, once answered, sends that leg through the
 *   dialplan as a call from their extension.
 * - **Attended transfer**: the other party waits (parked, silent), the person's own leg dials the
 *   number, and then `uuid_bridge` joins the waiting party to whoever answered (complete) or back
 *   to the person (cancel).
 *
 * Every operation is audited (outbox, before the call is touched: nothing unaudited is done, and
 * nothing is done when the audit cannot be written). Nothing about the call is taken from the
 * client but its leg's uuid, the number and the lot, and each of those is checked before it reaches
 * an ESL command.
 */
export function createCallOperations(options: CallOperationsOptions): CallOperations {
  const { registry, logger } = options;

  async function upstream<T>(what: string, ask: () => Promise<T>): Promise<T> {
    try {
      return await ask();
    } catch (error) {
      if (error instanceof UpstreamError) {
        logger.error({ err: error }, `call operations: ${what} could not be asked`);
        throw unavailable(
          'The call could not be changed right now, so nothing was done. Try again shortly.',
          'call_control_unavailable',
        );
      }
      throw error;
    }
  }

  /** The person's own extension number: from the signed actor, never the request. */
  async function ownNumber(command: Base): Promise<string> {
    const own = await upstream('pbx-config-service', () =>
      options.userExtension(command.tenantId, command.actor.id),
    );
    if (own === undefined || !EXTENSION_NUMBER.test(own.number)) {
      throw ProblemError.notFound(
        'No extension is linked to your account, so there is no phone to use. Ask an administrator to link one.',
        { code: 'no_linked_extension' },
      );
    }
    return own.number;
  }

  async function legIn(tenantId: string, uuid: string): Promise<Leg | undefined> {
    if (!CHANNEL_UUID.test(uuid)) return undefined;
    const hash = await registry.getCall(uuid);
    if (hash === undefined || hash['tenant'] !== tenantId) return undefined;
    return legOf(uuid, hash);
  }

  /** The leg named, in the tenant, and (self-service) on the person's own extension. */
  async function resolve(command: LegCommand): Promise<{ leg: Leg; own: string | undefined }> {
    const leg = await legIn(command.tenantId, command.callUuid);
    if (leg === undefined) throw notFound();
    if (command.own !== true) return { leg, own: undefined };
    const own = await ownNumber(command);
    // Someone else's call is no call of theirs.
    if (leg.ext !== own) throw notFound();
    return { leg, own };
  }

  /**
   * The leg bridged to `leg`. The registry keeps the partner on the leg whose bridge event named
   * it, usually the caller's; the answering leg often has none, so the tenant's legs are searched
   * for one naming `leg`.
   */
  async function bridgedWith(
    tenantId: string,
    leg: Leg,
    except?: string,
  ): Promise<string | undefined> {
    if (leg.partner !== undefined && leg.partner !== except) return leg.partner;
    const naming = (await registry.callsForTenant(tenantId)).find(
      (call) =>
        call.bridgedTo === leg.uuid &&
        call.callUuid !== except &&
        call.callUuid !== leg.uuid &&
        CHANNEL_UUID.test(call.callUuid),
    );
    return naming?.callUuid;
  }

  /** The other party on the person's own leg. */
  async function partnerOf(tenantId: string, leg: Leg): Promise<Leg> {
    const partnerUuid = await bridgedWith(tenantId, leg);
    leg = { ...leg, partner: partnerUuid };
    const partner = leg.partner === undefined ? undefined : await legIn(tenantId, leg.partner);
    // A trunk leg that has not learnt its tenant yet (`normalize.ts`) is still this call's.
    if (partner === undefined && leg.partner !== undefined) {
      const hash = await registry.getCall(leg.partner);
      if (hash !== undefined && (hash['tenant'] ?? '') === '') return legOf(leg.partner, hash);
    }
    if (partner === undefined) {
      throw ProblemError.conflict('This call is not connected to anyone yet.', {
        code: 'call_not_connected',
      });
    }
    return partner;
  }

  function answered(leg: Leg): void {
    if (leg.state !== 'answered' && leg.state !== 'held') {
      throw ProblemError.conflict('This call has not been answered yet.', {
        code: 'call_not_answered',
      });
    }
  }

  function eslFor(nodeId: string): OperationsEsl {
    const esl = options.esl(nodeId);
    if (esl === undefined) throw unavailable(NOTHING_DONE, 'media_unavailable');
    return esl;
  }

  async function domainOf(tenantId: string): Promise<string> {
    const domain = await upstream('org-service', () => options.tenantDomain(tenantId));
    if (domain === undefined || !SIP_DOMAIN.test(domain)) {
      logger.error({ tenantId }, 'call operations: the tenant has no usable SIP domain');
      throw unavailable(
        'The call could not be changed right now, so nothing was done. Try again shortly.',
        'call_control_unavailable',
      );
    }
    return domain;
  }

  async function audit(command: Base, action: string, resource: string, reason?: string) {
    try {
      await options.audit({
        actorType: 'user',
        actorId: command.actor.id,
        actorOrgId: command.actor.orgId,
        targetOrgId: command.tenantId,
        action,
        resource,
        dataClass: 'private',
        ...(reason === undefined ? {} : { reason }),
        ...(command.ip === undefined ? {} : { ip: command.ip }),
        ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
      });
    } catch (error) {
      logger.error({ err: error, action }, 'call operations: the audit event could not be written');
      throw unavailable(
        'The call could not be changed right now, so nothing was done. Try again shortly.',
        'call_control_unavailable',
      );
    }
  }

  /** Runs `command` on the node; a channel that has gone meanwhile is "no such call". */
  async function run(esl: OperationsEsl, command: string): Promise<void> {
    let result: EslApiResult;
    try {
      result = await esl.sendApi(command);
    } catch (error) {
      logger.error({ err: error, command: command.split(' ')[0] }, 'call operations: ESL failed');
      throw unavailable('The media node did not carry that out. Try again.', 'media_node_failed');
    }
    if (!result.ok || result.body.trim().startsWith('-ERR')) {
      if (/no such channel|invalid uuid|not found/i.test(result.body)) throw notFound();
      logger.warn(
        { command: command.split(' ')[0], body: result.body },
        'call operations: refused',
      );
      throw unavailable('The media node did not carry that out. Try again.', 'media_node_failed');
    }
  }

  /**
   * Sends `uuid` through the tenant's dialplan to `destination`, as an internal call of the
   * tenant: the variables a phone's call gets from OpenSIPs' trusted headers (03 §3.2), and, when
   * the call is the person's own, their extension as the caller (`sip_from_user`, which the
   * dialplan reads for the calling extension, and the caller ID the other side sees).
   */
  async function intoDialplan(
    esl: OperationsEsl,
    tenantId: string,
    uuid: string,
    destination: string,
    caller?: string,
  ): Promise<void> {
    const vars = [
      'sip_h_X-Call-Direction=internal',
      `sip_h_X-Tenant-Id=${tenantId}`,
      ...(caller === undefined
        ? []
        : [
            `sip_from_user=${caller}`,
            `effective_caller_id_number=${caller}`,
            `effective_caller_id_name=${caller}`,
          ]),
    ];
    await run(esl, `uuid_setvar_multi ${uuid} ${vars.join(';')}`);
    await run(esl, `uuid_transfer ${uuid} ${destination} XML ${CONTEXT}`);
  }

  /**
   * Rings the person's own phone from `nodeId`, through OpenSIPs like any call to a phone, and
   * runs `app` on the new leg once it is answered. Resolves with the new leg's uuid.
   */
  async function ringOwnPhone(
    esl: OperationsEsl,
    tenantId: string,
    own: string,
    shown: { name: string; number: string },
    app: string,
  ): Promise<string> {
    const domain = await domainOf(tenantId);
    const uuid = randomUUID();
    const vars = [
      `origination_uuid=${uuid}`,
      `sip_route_uri=sip:${options.opensipsSipUri}`,
      `origination_caller_id_name=${shown.name}`,
      `origination_caller_id_number=${SHOWN_NUMBER.test(shown.number) ? shown.number : '0'}`,
      `originate_timeout=${String(options.ringTimeoutSeconds)}`,
      `cuc_tenant_id=${tenantId}`,
    ];
    const originate = `originate {${vars.join(',')}}sofia/internal/${own}@${domain} &${app}`;
    let done: EslApiResult;
    try {
      done = await esl.sendBgApi(originate, (options.ringTimeoutSeconds + 10) * 1000);
    } catch (error) {
      logger.error({ err: error, tenantId }, 'call operations: originate failed');
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
      logger.warn({ tenantId, cause }, 'call operations: the person’s phone did not answer');
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
    return uuid;
  }

  /** The calls ringing phones within [own]'s pickup groups, oldest first. */
  async function candidates(tenantId: string, own: string): Promise<PickupCandidate[]> {
    const peers = new Set(
      await upstream('pbx-config-service', () => options.pickupPeers(tenantId, own)),
    );
    if (peers.size === 0) return [];
    return (await registry.callsForTenant(tenantId))
      .filter(
        (call) =>
          call.state === 'ringing' &&
          call.extension !== null &&
          call.extension !== own &&
          peers.has(call.extension),
      )
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((call) => ({
        callUuid: call.callUuid,
        extension: call.extension!,
        from: call.from,
        startedAt: new Date(call.startedAt).toISOString(),
      }));
  }

  /** Forgets the ring-back of a waiting caller once they are joined to someone (S9-19). */
  async function cancelRingBack(esl: OperationsEsl, waiting: string): Promise<void> {
    try {
      await esl.sendApi(`sched_del ${ringBackTask(waiting)}`);
    } catch (error) {
      logger.warn({ err: error }, 'call operations: the ring-back could not be cancelled');
    }
  }

  /** The caller's leg a ringing leg was placed for: taking it over stops the ringing. */
  async function callerOf(esl: OperationsEsl, ringing: Leg): Promise<string | undefined> {
    for (const name of ['originating_leg_uuid', 'call_uuid']) {
      let value: string | undefined;
      try {
        value = variableValue(await esl.sendApi(`uuid_getvar ${ringing.uuid} ${name}`));
      } catch (error) {
        logger.warn({ err: error }, 'call operations: the media node could not be asked');
        throw unavailable(NOTHING_DONE, 'media_unavailable');
      }
      if (value !== undefined && CHANNEL_UUID.test(value) && value !== ringing.uuid) return value;
    }
    return undefined;
  }

  /** Rings the person's own phone into `intercept` of the ringing call's caller. */
  async function take(
    command: Base,
    ringing: Leg,
    own: string,
  ): Promise<{ readonly result: 'picked_up'; readonly callUuid: string }> {
    const esl = eslFor(ringing.node);
    const caller = await callerOf(esl, ringing);
    if (caller === undefined) throw notFound();
    await audit(command, 'call.pickup', `call:${caller}`);
    const callUuid = await ringOwnPhone(
      esl,
      command.tenantId,
      own,
      { name: PICKUP_CALLER_NAME, number: ringing.from },
      `intercept(${caller})`,
    );
    return { result: 'picked_up', callUuid };
  }

  function destination(to: string): string {
    // The routes' schemas already refuse anything else; this keeps a stray value out of ESL.
    if (!DIALABLE.test(to)) {
      throw ProblemError.badRequest('That is not a number that can be dialed.', {
        code: 'invalid_destination',
      });
    }
    return to;
  }

  return {
    async hangup(command) {
      const { leg } = await resolve(command);
      const esl = eslFor(leg.node);
      await audit(command, 'call.hangup', `call:${leg.uuid}`);
      await run(esl, `uuid_kill ${leg.uuid} NORMAL_CLEARING`);
      return { result: 'hungup' };
    },

    async transfer(command) {
      const to = destination(command.to);
      const { leg, own } = await resolve(command);
      const moved = own === undefined ? leg : await partnerOf(command.tenantId, leg);
      answered(moved);
      if (own !== undefined && to === own) {
        throw ProblemError.conflict('That is your own number.', { code: 'own_call' });
      }
      const esl = eslFor(moved.node);
      await audit(command, 'call.transfer', `call:${moved.uuid}`, `to ${to}`);
      await intoDialplan(esl, command.tenantId, moved.uuid, to);
      return { result: 'transferred', callUuid: moved.uuid };
    },

    async park(command) {
      const { leg, own } = await resolve(command);
      const moved = own === undefined ? leg : await partnerOf(command.tenantId, leg);
      answered(moved);
      const lot = await upstream('pbx-config-service', () =>
        options.parkingLot(command.tenantId, command.parkingLotId),
      );
      if (lot === undefined) {
        throw ProblemError.notFound('There is no such parking lot.', {
          code: 'parking_lot_not_found',
        });
      }
      // A lot's calls are all on one node (its lease): retrieval reaches that node. A call on
      // another node cannot join them until calls move between nodes (S4-05), as when dialed.
      const leasedTo = await options.parkingLotNode(command.tenantId, lot.id);
      if (leasedTo !== undefined && leasedTo !== moved.node) {
        throw ProblemError.conflict(
          'This call cannot be parked in that lot right now. Try another lot, or transfer it.',
          { code: 'parking_lot_elsewhere' },
        );
      }
      const esl = eslFor(moved.node);
      const domain = await domainOf(command.tenantId);
      let info: EslApiResult;
      try {
        info = await esl.sendApi(`valet_info ${lot.id}@${domain}`);
      } catch (error) {
        logger.error({ err: error }, 'call operations: valet_info failed');
        throw unavailable(NOTHING_DONE, 'media_unavailable');
      }
      const taken = occupiedSlots(info.ok ? info.body : '');
      let slot: number | undefined;
      for (let candidate = lot.slotStart; candidate <= lot.slotEnd; candidate += 1) {
        if (taken.has(candidate)) continue;
        if (
          await registry.reserveParkingSlot(
            command.tenantId,
            lot.id,
            candidate,
            SLOT_RESERVATION_MS,
          )
        ) {
          slot = candidate;
          break;
        }
      }
      if (slot === undefined) {
        throw ProblemError.conflict('Every space in this parking lot is taken.', {
          code: 'parking_lot_full',
        });
      }
      await audit(command, 'call.park', `call:${moved.uuid}`, `lot ${lot.id} slot ${String(slot)}`);
      await intoDialplan(esl, command.tenantId, moved.uuid, String(slot));
      return { result: 'parked', parkingLotId: lot.id, slot };
    },

    async pickup(command) {
      const ringing = await legIn(command.tenantId, command.callUuid);
      if (ringing === undefined) throw notFound();
      if (ringing.ext === undefined || ringing.state !== 'ringing') {
        throw ProblemError.conflict('This call is not ringing a phone.', {
          code: 'call_not_ringing',
        });
      }
      const own = await ownNumber(command);
      if (ringing.ext === own) {
        throw ProblemError.conflict('This call is ringing your own phone.', { code: 'own_call' });
      }
      return take(command, ringing, own);
    },

    async pickupable(command) {
      const own = await ownNumber(command);
      return candidates(command.tenantId, own);
    },

    async pickupMine(command) {
      const own = await ownNumber(command);
      const found = await candidates(command.tenantId, own);
      const chosen =
        command.callUuid === undefined
          ? found[0]
          : found.find((call) => call.callUuid === command.callUuid);
      if (chosen === undefined) {
        throw ProblemError.notFound(
          command.callUuid === undefined
            ? 'No call is ringing in your pickup groups.'
            : 'That call is not ringing in your pickup groups.',
          { code: command.callUuid === undefined ? 'nothing_to_pick_up' : 'call_not_found' },
        );
      }
      const ringing = await legIn(command.tenantId, chosen.callUuid);
      if (ringing === undefined) throw notFound();
      return take(command, ringing, own);
    },

    async pickupTarget(tenantId, extension) {
      if (!EXTENSION_NUMBER.test(extension)) return undefined;
      for (const candidate of await candidates(tenantId, extension)) {
        const ringing = await legIn(tenantId, candidate.callUuid);
        const esl = ringing === undefined ? undefined : options.esl(ringing.node);
        if (ringing === undefined || esl === undefined) continue;
        const caller = await callerOf(esl, ringing);
        if (caller !== undefined) return { callUuid: caller, nodeId: ringing.node };
      }
      return undefined;
    },

    async dial(command) {
      const to = destination(command.to);
      const own = await ownNumber(command);
      if (to === own) {
        throw ProblemError.conflict('That is your own number.', { code: 'own_call' });
      }
      const nodeId = await options.anyNode();
      if (nodeId === undefined) throw unavailable(NOTHING_DONE, 'media_unavailable');
      const esl = eslFor(nodeId);
      await audit(command, 'call.dial', `extension:${own}`, `to ${to}`);
      // The phone shows the number it is about to call. `park` holds the answered leg until it is
      // sent on, so the variables are set on it before the dialplan sees it.
      const callUuid = await ringOwnPhone(
        esl,
        command.tenantId,
        own,
        { name: to, number: to },
        'park()',
      );
      await intoDialplan(esl, command.tenantId, callUuid, to, own);
      return { result: 'dialing', callUuid };
    },

    async consult(command) {
      const to = destination(command.to);
      const { leg, own } = await resolve({ ...command, own: true });
      if (leg.held !== undefined && (await legIn(command.tenantId, leg.held)) !== undefined) {
        throw ProblemError.conflict('A transfer is already under way on this call.', {
          code: 'transfer_in_progress',
        });
      }
      const waiting = await partnerOf(command.tenantId, leg);
      answered(waiting);
      if (to === own) throw ProblemError.conflict('That is your own number.', { code: 'own_call' });
      const esl = eslFor(leg.node);
      if (waiting.node !== leg.node) throw unavailable(NOTHING_DONE, 'media_unavailable');
      await audit(command, 'call.transfer.consult', `call:${waiting.uuid}`, `to ${to}`);
      // The person's leg stays up when the bridge ends. The waiting party hears the tenant's hold
      // music (S9-19) until joined to someone; after HELD_TIMEOUT_SECONDS their call rings the
      // person again, through the dialplan as the tenant's own call, instead of being dropped.
      // The node's own scheduler does it, so it happens whatever becomes of this service.
      await run(esl, `uuid_setvar ${leg.uuid} park_after_bridge true`);
      await registry.updateCall(leg.uuid, { [HELD_FIELD]: waiting.uuid });
      let music: EslApiResult | undefined;
      try {
        music = await esl.sendApi(`uuid_getvar ${waiting.uuid} hold_music`);
      } catch {
        music = undefined;
      }
      if (music === undefined || variableValue(music) === undefined) {
        await run(esl, `uuid_setvar ${waiting.uuid} hold_music ${NEUTRAL_HOLD_TONE}`);
      }
      await run(
        esl,
        `uuid_setvar_multi ${waiting.uuid} sip_h_X-Call-Direction=internal;sip_h_X-Tenant-Id=${command.tenantId}`,
      );
      // `${hold_music}` is expanded when it plays, not here: a tone's commas would split the inline
      // dialplan.
      await run(esl, `uuid_transfer ${waiting.uuid} endless_playback:\${hold_music} inline`);
      await run(
        esl,
        `sched_api +${String(HELD_TIMEOUT_SECONDS)} ${ringBackTask(waiting.uuid)} uuid_transfer ${waiting.uuid} ${own} XML ${CONTEXT}`,
      );
      await intoDialplan(esl, command.tenantId, leg.uuid, to, own);
      return { result: 'consulting', heldCallUuid: waiting.uuid };
    },

    async completeTransfer(command) {
      const { leg } = await resolve({ ...command, own: true });
      const waiting = leg.held === undefined ? undefined : await legIn(command.tenantId, leg.held);
      if (waiting === undefined) {
        throw ProblemError.conflict('There is no transfer under way on this call.', {
          code: 'no_transfer_in_progress',
        });
      }
      // The waiting party may still name the person's leg: whoever else is bridged to it.
      const consultedUuid = await bridgedWith(command.tenantId, leg, waiting.uuid);
      const consulted =
        consultedUuid === undefined ? undefined : await legIn(command.tenantId, consultedUuid);
      if (consulted === undefined || consulted.uuid === waiting.uuid) {
        throw ProblemError.conflict('The person you called has not answered yet.', {
          code: 'consult_not_answered',
        });
      }
      const esl = eslFor(leg.node);
      await audit(
        command,
        'call.transfer.complete',
        `call:${waiting.uuid}`,
        `to ${consulted.uuid}`,
      );
      await run(esl, `uuid_bridge ${waiting.uuid} ${consulted.uuid}`);
      await cancelRingBack(esl, waiting.uuid);
      await run(esl, `uuid_kill ${leg.uuid} NORMAL_CLEARING`).catch(() => undefined);
      return { result: 'transferred' };
    },

    async cancelTransfer(command) {
      const { leg } = await resolve({ ...command, own: true });
      const waiting = leg.held === undefined ? undefined : await legIn(command.tenantId, leg.held);
      if (waiting === undefined) {
        throw ProblemError.conflict('There is no transfer under way on this call.', {
          code: 'no_transfer_in_progress',
        });
      }
      const esl = eslFor(leg.node);
      await audit(command, 'call.transfer.cancel', `call:${waiting.uuid}`);
      // Joining the person back to the waiting party ends the consultation leg.
      await run(esl, `uuid_bridge ${leg.uuid} ${waiting.uuid}`);
      await cancelRingBack(esl, waiting.uuid);
      await run(esl, `uuid_setvar ${leg.uuid} park_after_bridge false`);
      await registry.updateCall(leg.uuid, { [HELD_FIELD]: '' });
      return { result: 'resumed' };
    },
  };
}
