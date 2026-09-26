import { decodeRecordingContext, recordingSpoolPath } from '@cuc/api-contracts';
import { ProblemError } from '@cuc/http';
import type { Logger } from '@cuc/logger';

import {
  UpstreamError,
  type RecordingAction,
  type RecordingControlAnswer,
  type RecordingControlClient,
} from './clients.js';
import type { EslApiResult } from './esl/client.js';
import { RECORDING_EVENT_SUBCLASS } from './normalize.js';
import type { CallRegistry } from './redis/registry.js';

/** The part of an ESL client this needs: `api` commands and `sendevent`. */
export interface EslCommands {
  sendApi(command: string): Promise<EslApiResult>;
  sendEvent(name: string, headers: Readonly<Record<string, string>>): Promise<EslApiResult>;
}

export interface RecordingControllerOptions {
  readonly registry: CallRegistry;
  /** The ESL connection to a node, when this service has one up. */
  readonly esl: (nodeId: string) => EslCommands | undefined;
  readonly recording: RecordingControlClient;
  /** The node spool directory, as telephony-config's `RECORDING_SPOOL_DIR` names it. */
  readonly spoolDir: string;
  readonly logger: Logger;
  /**
   * Handles a raw event as if the node had sent it, in the node's own order (`serial.ts`). Used
   * only when the node would not take the pause event (`sendevent` failed), so the live views
   * still learn the state the recording is in.
   */
  readonly injectEvent: (nodeId: string, raw: Record<string, string>) => void;
}

export interface RecordingControlCommand {
  readonly tenantId: string;
  /** The leg the person pressed the button on (either leg of the call). */
  readonly callUuid: string;
  readonly action: RecordingAction;
  /** The person, from the signed request. */
  readonly actor: { readonly id: string; readonly orgId: string };
  readonly ip?: string;
  readonly requestId?: string;
  /**
   * Self-service: the leg must be this extension's (`normalize.ts`'s vouched extension), or the
   * call is treated as not found.
   */
  readonly ownExtension?: string;
}

export interface RecordingControlResult {
  readonly result: 'started' | 'stopped' | 'paused' | 'resumed';
  readonly recordingId: string;
  /** What the call's recording is once the node has done it (the live views follow). */
  readonly recording: 'on' | 'off' | 'paused';
}

export interface RecordingController {
  control(command: RecordingControlCommand): Promise<RecordingControlResult>;
}

/** A channel uuid, as FreeSWITCH makes them. Anything else never reaches an ESL command. */
const CHANNEL_UUID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/** What each answer from recording-service means on the node. */
const NODE_VERB = { started: 'start', stopped: 'stop', paused: 'mask', resumed: 'unmask' } as const;
const RECORDING_AFTER = { started: 'on', stopped: 'off', paused: 'paused', resumed: 'on' } as const;

/**
 * Refusals, as neutral problem codes. The same reasons as the feature codes (recording-service
 * decides both), each a 409: the request was understood and the call is there, but its rules or
 * its state do not allow it.
 */
const REFUSALS: Readonly<Record<string, { code: string; detail: string }>> = {
  not_allowed: {
    code: 'recording_not_allowed',
    detail: "This call's recording rules do not allow that.",
  },
  rule_recording: {
    code: 'rule_recording',
    detail: 'A recording made by a rule cannot be stopped. It can be paused, if the rule allows.',
  },
  not_recording: { code: 'not_recording', detail: 'This call is not being recorded.' },
  stopped: { code: 'not_recording', detail: 'This call is not being recorded.' },
  unknown_recording: { code: 'not_recording', detail: 'This call is not being recorded.' },
  already_recording: { code: 'already_recording', detail: 'This call is already being recorded.' },
  already_paused: { code: 'already_paused', detail: "This call's recording is already paused." },
  not_paused: { code: 'not_paused', detail: "This call's recording is not paused." },
};

function refusal(reason: string | null): ProblemError {
  const known = REFUSALS[reason ?? ''] ?? REFUSALS['not_allowed']!;
  return ProblemError.conflict(known.detail, { code: known.code });
}

function notFound(): ProblemError {
  return ProblemError.notFound('There is no such call in progress.', { code: 'call_not_found' });
}

function unavailable(detail: string, code: string): ProblemError {
  return ProblemError.unavailable(detail, { code });
}

/** A channel variable's value, or undefined when unset (`_undef_`), empty, or the command failed. */
function variableValue(result: EslApiResult): string | undefined {
  if (!result.ok) return undefined;
  const value = result.body.trim();
  return value === '' || value === '_undef_' || value.startsWith('-ERR') ? undefined : value;
}

/**
 * S5-15 (G-111 (3), G-120): the console's and the self-service portal's record, stop, pause and
 * resume buttons for a live call. It does what `recording_control.lua` does for a feature code,
 * from here instead of from the node, and decides nothing itself:
 *
 * 1. Finds the leg in the registry, in the tenant the URL names (and, for self-service, on the
 *    person's own extension); anything else is "no such call".
 * 2. Reads the call's recording state from the channel that owns the recording, over ESL on the
 *    node that holds the call (`uuid_getvar`): `cuc_rec_owner` (either leg names it), then on the
 *    owner `cuc_tenant_id` (must be this tenant), `cuc_rec_ctx` (the call context telephony-config
 *    set; none means no rule allows on demand) and `cuc_recording_id`. Nothing about the call is
 *    taken from the client but its uuid.
 * 3. Asks recording-service with an explicit action and the person as actor. It checks the call's
 *    rules (the same as the feature codes'), and writes the change and its audit event in one
 *    transaction before answering, so nothing happens on the node that was not audited first; if
 *    it cannot be asked, nothing happens at all (503).
 * 4. Carries out the answer on the owner: `uuid_record <owner> start|stop|mask|unmask <path>`,
 *    the path built like telephony-config's, then `uuid_setvar` of `cuc_recording_id` (so the
 *    next action, or feature code, finds the recording), or, for a pause or a resume, fires
 *    `CUSTOM cuc::recording` (`sendevent`), which is how the live views learn of it.
 *
 * One action at a time per call in this process, so two quick presses see each other's result.
 */
export function createRecordingController(
  options: RecordingControllerOptions,
): RecordingController {
  const { registry, recording, spoolDir, logger } = options;
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function api(esl: EslCommands, command: string): Promise<EslApiResult> {
    try {
      return await esl.sendApi(command);
    } catch (error) {
      logger.warn({ err: error }, 'recording control: the media node could not be asked');
      throw unavailable(
        'The call could not be reached right now. Nothing was changed. Try again shortly.',
        'media_unavailable',
      );
    }
  }

  async function getVar(esl: EslCommands, uuid: string, name: string): Promise<string | undefined> {
    return variableValue(await api(esl, `uuid_getvar ${uuid} ${name}`));
  }

  return {
    async control(command) {
      const { tenantId, callUuid, action } = command;
      if (!CHANNEL_UUID.test(callUuid)) throw notFound();

      const leg = await registry.getCall(callUuid);
      if (leg === undefined || leg['tenant'] !== tenantId) throw notFound();
      if (command.ownExtension !== undefined && leg['ext'] !== command.ownExtension) {
        throw notFound();
      }
      const nodeId = leg['node'] ?? '';
      const esl = options.esl(nodeId);
      if (esl === undefined) {
        throw unavailable(
          'The call could not be reached right now. Nothing was changed. Try again shortly.',
          'media_unavailable',
        );
      }

      // The recording belongs to the call's owner channel, whichever leg was pressed.
      const named = await getVar(esl, callUuid, 'cuc_rec_owner');
      const owner = named !== undefined && CHANNEL_UUID.test(named) ? named : callUuid;
      if (owner !== callUuid) {
        const ownerLeg = await registry.getCall(owner);
        if (ownerLeg !== undefined && ownerLeg['tenant'] !== tenantId) throw notFound();
      }

      return withLock(owner, async () => {
        if ((await getVar(esl, owner, 'cuc_tenant_id')) !== tenantId) throw notFound();
        const token = await getVar(esl, owner, 'cuc_rec_ctx');
        const context = token === undefined ? undefined : decodeRecordingContext(token);
        if (context === undefined || context.tenantId !== tenantId) {
          // telephony-config puts a context on a call only when a rule allows on demand.
          throw refusal('not_allowed');
        }
        const recordingId = await getVar(esl, owner, 'cuc_recording_id');

        let answer: RecordingControlAnswer;
        try {
          answer = await recording({
            tenantId,
            action,
            callUuid: owner,
            ...(recordingId === undefined ? {} : { recordingId }),
            nodeId,
            context: {
              direction: context.direction,
              extensionIds: context.extensionIds,
              queueId: context.queueId,
              didId: context.didId,
            },
            actor: command.actor,
            ...(command.ip === undefined ? {} : { ip: command.ip }),
            ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
          });
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          logger.error(
            { err: error, tenantId, callUuid: owner, action },
            'recording control: recording-service could not be asked; nothing done',
          );
          throw unavailable(
            'Recording could not be changed right now, so nothing was done. Try again shortly.',
            'recording_unavailable',
          );
        }
        if (answer.result === 'refused' || answer.recordingId === null) {
          throw refusal(answer.reason);
        }
        // The id goes on an ESL command line (the spool path, `uuid_setvar`): never anything but
        // an id, whoever answered.
        if (!CHANNEL_UUID.test(answer.recordingId)) {
          logger.error(
            { tenantId, callUuid: owner, action },
            'recording control: recording-service answered with a malformed recording id; nothing done on the node',
          );
          throw unavailable(
            'Recording could not be changed right now. Try again shortly.',
            'media_node_failed',
          );
        }

        const verb = NODE_VERB[answer.result];
        const path = recordingSpoolPath(spoolDir, answer.recordingId);
        const done = await api(esl, `uuid_record ${owner} ${verb} ${path}`);
        if (!done.ok || !done.body.trim().startsWith('+OK')) {
          // Already recorded and audited upstream; the node did not do it. A started recording
          // that never ran is marked failed by recording-service's pending sweep.
          logger.error(
            { tenantId, callUuid: owner, verb, recordingId: answer.recordingId, reply: done.body },
            'recording control: uuid_record failed on the node',
          );
          throw unavailable(
            'The call did not carry out the change. Try again shortly.',
            'media_node_failed',
          );
        }

        if (answer.result === 'started') {
          await api(esl, `uuid_setvar ${owner} cuc_recording_id ${answer.recordingId}`);
        } else if (answer.result === 'stopped') {
          // No value unsets it: the next Start (or *1) starts a new on-demand recording.
          await api(esl, `uuid_setvar ${owner} cuc_recording_id`);
        } else {
          await announcePause(esl, nodeId, owner, answer.result);
        }
        logger.info(
          { tenantId, callUuid: owner, result: answer.result, recordingId: answer.recordingId },
          'recording control: done',
        );
        return {
          result: answer.result,
          recordingId: answer.recordingId,
          recording: RECORDING_AFTER[answer.result],
        };
      });
    },
  };

  /**
   * A mask raises no event of its own. Fires the same `CUSTOM cuc::recording` event
   * `recording_control.lua` does, so it comes back through this service's own event path like
   * one from a feature code. When the node will not take it, the event is handled here directly,
   * so the live views still show the pause.
   */
  async function announcePause(
    esl: EslCommands,
    nodeId: string,
    owner: string,
    result: 'paused' | 'resumed',
  ): Promise<void> {
    const headers = {
      'Event-Subclass': RECORDING_EVENT_SUBCLASS,
      'Recording-Call-UUID': owner,
      'Recording-Action': result,
    };
    try {
      const sent = await esl.sendEvent('CUSTOM', headers);
      if (sent.ok) return;
      logger.warn({ owner, reply: sent.body }, 'recording control: sendevent refused');
    } catch (error) {
      logger.warn({ err: error, owner }, 'recording control: sendevent failed');
    }
    options.injectEvent(nodeId, { 'Event-Name': 'CUSTOM', ...headers });
  }
}
