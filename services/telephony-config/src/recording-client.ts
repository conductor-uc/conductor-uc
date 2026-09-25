import type { Logger } from '@cuc/logger';

/**
 * Asks recording-service whether one call is to be recorded (S5-02), and if so registers the
 * recording so the node uploader can later find it. This service never reads recording-service's
 * database (05 §1.1) and never decides policy itself.
 *
 * ## Failure policy: fail open, loudly
 *
 * An unreachable or slow recording-service must never stop a call, so a lookup that fails yields
 * `{ kind: 'unavailable' }` and the call proceeds **unrecorded**. That is a deliberate choice of
 * availability over completeness (a phone system that drops calls because a policy lookup timed
 * out is worse than one that misses a recording), made visible three ways: an error log line
 * (`recording_policy_unavailable`), a channel variable on the call (`cuc_recording_status=
 * unavailable`, so it reaches the CDR), and the counters below. A tenant that must never miss a
 * recording turns on "recording required" (S5-12, G-111): `/fs/dialplan` then refuses the call
 * instead. That flag is read from this service's own copy (`recording_settings`, projected from
 * `recording.settings.updated`), never from recording-service, so it holds while it is down.
 *
 * To keep an outage from adding a timeout to every call, and to keep recording through a short
 * one:
 * - a decision is cached for `ttlMs` (a policy edit therefore takes effect within that time);
 * - when a refresh fails, a decision up to `maxStaleMs` old is still used (recording continues under
 *   the last known policy), with a warning;
 * - after a failure with nothing usable in the cache, further lookups are skipped for
 *   `breakerMs`, so calls in that window go straight to "unavailable" without waiting.
 *
 * `register` is never cached: each call needs its own recording id. If it fails the call is
 * unrecorded and flagged, exactly like a failed lookup.
 */

export type RecordingDirection = 'inbound' | 'outbound' | 'internal';

export interface RecordingCall {
  readonly tenantId: string;
  readonly direction: RecordingDirection;
  /** Every extension on the call (caller and callee of an internal call). */
  readonly extensionIds: readonly string[];
  readonly queueId?: string | undefined;
  readonly didId?: string | undefined;
  readonly callUuid: string;
  readonly nodeId?: string | undefined;
}

export type RecordingDirective =
  /** No policy asks for a recording. */
  | { readonly kind: 'none' }
  /** Record to `fileName` in the spool directory, first playing the announcement if `announce`. */
  | {
      readonly kind: 'record';
      readonly recordingId: string;
      readonly fileName: string;
      readonly announce: boolean;
      /** A media asset to play; null plays the neutral default tone. */
      readonly consentAssetId: string | null;
    }
  /** The policy could not be determined or the recording could not be registered: no recording, flagged. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface RecordingClient {
  decide(call: RecordingCall): Promise<RecordingDirective>;
  /** How many calls went unrecorded because recording-service was unavailable, since start. */
  unavailableCount(): number;
  /**
   * S5-12: every tenant that requires recording (fail closed), for the reconciliation pass that
   * repairs this service's own copy of the flag. Throws when recording-service cannot answer:
   * the caller then leaves its copy as it is.
   */
  listFailClosedTenants(): Promise<string[]>;
}

interface Decision {
  readonly record: boolean;
  readonly announce: boolean;
  readonly consentAssetId: string | null;
  readonly policyId: string | null;
}

export interface RecordingClientOptions {
  /** e.g. http://recording-service:8080. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  readonly logger: Logger;
  /** Per request; recording-service must answer within this or the call goes unrecorded. */
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly maxStaleMs?: number;
  readonly breakerMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export function createRecordingClient(options: RecordingClientOptions): RecordingClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 800;
  const ttlMs = options.ttlMs ?? 30_000;
  const maxStaleMs = options.maxStaleMs ?? 10 * 60_000;
  const breakerMs = options.breakerMs ?? 5_000;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const logger = options.logger;

  const cache = new Map<string, { decision: Decision; fetchedAt: number }>();
  let breakerOpenUntil = 0;
  let unavailable = 0;

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}/internal/v1/recordings/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.internalServiceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`recording-service answered ${String(response.status)}`);
    return response.json();
  }

  function cacheKey(call: RecordingCall): string {
    return [
      call.tenantId,
      call.direction,
      [...call.extensionIds].sort().join(','),
      call.queueId ?? '',
      call.didId ?? '',
    ].join('|');
  }

  /** The decision for this call, or the reason there is none. */
  async function evaluate(
    call: RecordingCall,
  ): Promise<{ decision: Decision } | { failure: string }> {
    const key = cacheKey(call);
    const cached = cache.get(key);
    const current = now();
    if (cached !== undefined && current - cached.fetchedAt < ttlMs) {
      return { decision: cached.decision };
    }

    const staleUsable =
      cached !== undefined && current - cached.fetchedAt < maxStaleMs ? cached.decision : undefined;

    if (current < breakerOpenUntil) {
      return staleUsable === undefined
        ? { failure: 'recording-service is unavailable (not retried yet)' }
        : { decision: staleUsable };
    }

    try {
      const decision = (await post('evaluate', {
        tenantId: call.tenantId,
        direction: call.direction,
        extensionIds: call.extensionIds,
        ...(call.queueId === undefined ? {} : { queueId: call.queueId }),
        ...(call.didId === undefined ? {} : { didId: call.didId }),
      })) as Decision;
      cache.set(key, { decision, fetchedAt: current });
      breakerOpenUntil = 0;
      return { decision };
    } catch (error) {
      breakerOpenUntil = current + breakerMs;
      const reason = error instanceof Error ? error.message : String(error);
      if (staleUsable !== undefined) {
        logger.warn(
          { tenantId: call.tenantId, err: reason },
          'recording: policy refresh failed; using the last known decision',
        );
        return { decision: staleUsable };
      }
      return { failure: reason };
    }
  }

  function unavailableResult(call: RecordingCall, reason: string): RecordingDirective {
    unavailable += 1;
    logger.error(
      {
        alert: 'recording_policy_unavailable',
        tenantId: call.tenantId,
        direction: call.direction,
        err: reason,
      },
      'recording: could not decide or register; the call proceeds without recording',
    );
    return { kind: 'unavailable', reason };
  }

  return {
    unavailableCount: () => unavailable,

    async listFailClosedTenants() {
      const response = await fetchImpl(`${baseUrl}/internal/v1/recordings/fail-closed-tenants`, {
        headers: { authorization: `Bearer ${options.internalServiceToken}` },
        signal: AbortSignal.timeout(Math.max(timeoutMs, 5_000)),
      });
      if (!response.ok) throw new Error(`recording-service answered ${String(response.status)}`);
      const body = (await response.json()) as { tenantIds?: unknown };
      if (!Array.isArray(body.tenantIds)) {
        throw new Error('recording-service answered without a tenant list');
      }
      return body.tenantIds.filter((id): id is string => typeof id === 'string');
    },

    async decide(call) {
      const outcome = await evaluate(call);
      if ('failure' in outcome) return unavailableResult(call, outcome.failure);
      const { decision } = outcome;
      if (!decision.record) return { kind: 'none' };

      try {
        const registered = (await post('register', {
          tenantId: call.tenantId,
          callUuid: call.callUuid,
          direction: call.direction,
          extensionId: call.extensionIds[0] ?? null,
          peerExtensionId: call.extensionIds[1] ?? null,
          queueId: call.queueId ?? null,
          didId: call.didId ?? null,
          policyId: decision.policyId,
          nodeId: call.nodeId ?? null,
          announced: decision.announce,
        })) as { recordingId: string; fileName: string };
        return {
          kind: 'record',
          recordingId: registered.recordingId,
          fileName: registered.fileName,
          announce: decision.announce,
          consentAssetId: decision.consentAssetId,
        };
      } catch (error) {
        return unavailableResult(call, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
