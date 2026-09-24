/**
 * Calls pbx-config-service's internal digest-credential lookup
 * (`GET /internal/v1/tenants/:tenantId/extensions/:id`, S1-12) — how this
 * service learns the username/HA1/realm to project into OpenSIPs'
 * `subscriber` table. `pbx.extension.*` events carry only an id (06: events
 * stay thin), so every `created`/`updated` handler fetches current state
 * here rather than trusting anything in the event payload itself.
 *
 * Gated by the same shared bearer token pbx-config-service's own internal
 * routes expect (07 §1's precedent, `org-client.ts`'s identical shape from
 * S1-09) — real service-to-service auth does not exist yet.
 */

export interface DigestCredential {
  readonly extensionId: string;
  /** The extension's current dialable number — S1-13's `/fs/dialplan` matches on this. */
  readonly number: string;
  readonly username: string;
  readonly ha1: string;
  readonly ha1b: string;
  readonly realm: string;
  /** S2-04's caller-ID precedence, first tier: the extension's own override, if set. */
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  /** S2-06 (G-1) — an `emergency_locations` id in this same tenant, required at extension-creation time. */
  readonly emergencyLocationId: string;
}

/**
 * A dispatchable civic address (S2-06; G-1) — what `findEmergencyLocation`
 * resolves an extension's `emergencyLocationId` to, live, at the moment an
 * emergency call actually needs one (never cached — see this file's own
 * "thin event, re-fetch current state" framing above, the same reasoning).
 */
export interface EmergencyLocationConfig {
  readonly id: string;
  readonly label: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string;
  readonly country: string;
}

/**
 * A media asset's current state (S2-07) — what `/fs/media/:id`'s resolver
 * (`routes/fs.routes.ts`) fetches live, at the moment FS's own `http_cache`
 * module actually asks for it (never mirrored — the same "must reflect the
 * very latest write" reasoning `findEmergencyLocation` above already
 * documents, and this is an even colder path: fetched once per node until
 * that node's own local disk cache expires or the node restarts).
 */
export interface MediaAssetConfig {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  /** Null until `status` is `'ready'`. */
  readonly variant8kKey: string | null;
  readonly variant16kKey: string | null;
}

/**
 * A DID's current state (S2-03) — what `pbx.did.*`'s "thin event, re-fetch
 * current state" projection (`projection.ts`'s `projectDid`) fetches to keep
 * telephony-config's own local `dids` mirror current.
 */
export interface DidConfig {
  readonly id: string;
  readonly e164: string;
  readonly trunkId: string;
  readonly destinationType: string;
  readonly destinationId: string;
}

/**
 * A ring group's current state (S2-08) — what `pbx.ring_group.*`'s "thin
 * event, re-fetch current state" projection (`projection.ts`'s
 * `projectRingGroup`) fetches to keep telephony-config's own local
 * `ring_groups` mirror current.
 */
export interface RingGroupConfig {
  readonly id: string;
  readonly label: string;
  readonly strategy: string;
  readonly memberExtensionIds: readonly string[];
  readonly ringTimeoutSeconds: number;
  readonly noAnswerDestinationType: string | null;
  readonly noAnswerDestinationId: string | null;
}

/**
 * A queue's current state (S2-13) — what `pbx.queue.*`'s "thin event,
 * re-fetch current state" projection (`projection.ts`'s `projectQueue`)
 * fetches to keep telephony-config's own local `queues` mirror current.
 */
export interface QueueConfig {
  readonly id: string;
  readonly label: string;
  readonly strategy: string;
  readonly mohMediaAssetId: string | null;
  readonly maxWaitSeconds: number;
  readonly announcePosition: boolean;
  readonly announceFrequencySeconds: number | null;
  readonly noAgentDestinationType: string | null;
  readonly noAgentDestinationId: string | null;
}

/** An agent's current state (S2-13) — same "thin event, re-fetch" projection (`projection.ts`'s `projectAgent`). */
export interface AgentConfig {
  readonly id: string;
  readonly extensionId: string;
  readonly maxNoAnswer: number;
  readonly wrapUpSeconds: number;
  readonly rejectDelaySeconds: number;
}

/** One queue's tier list (S2-13) — `projection.ts`'s `projectQueueTiers` replaces the whole local list with this. */
export interface QueueTierConfig {
  readonly id: string;
  readonly queueId: string;
  readonly agentId: string;
  readonly level: number;
  readonly position: number;
}

/**
 * A parking lot's current state (S2-14) — what `pbx.parking_lot.*`'s "thin
 * event, re-fetch current state" projection (`projection.ts`'s
 * `projectParkingLot`) fetches to keep telephony-config's own local
 * `parking_lots` mirror current.
 */
export interface ParkingLotConfig {
  readonly id: string;
  readonly label: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  readonly timeoutSeconds: number;
  readonly returnDestinationType: string | null;
  readonly returnDestinationId: string | null;
}

/**
 * A conference room's current state (S2-15) — what `pbx.conference_room.*`'s
 * "thin event, re-fetch current state" projection (`projection.ts`'s
 * `projectConferenceRoom`) fetches to keep telephony-config's own local
 * `conference_rooms` mirror current. No PIN field: `pinRequired` is all the
 * dialplan-building side needs (`read-model.repo.ts`'s own comment on why).
 */
export interface ConferenceRoomConfig {
  readonly id: string;
  readonly label: string;
  readonly number: string;
  readonly pinRequired: boolean;
  readonly maxMembers: number;
}

export class PbxConfigClientError extends Error {
  override readonly name = 'PbxConfigClientError';
}

export interface PbxConfigClientOptions {
  /** e.g. http://pbx-config-service:8080. No trailing slash required. */
  readonly baseUrl: string;
  readonly internalServiceToken: string;
  /** Injected in tests; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

export interface PbxConfigClient {
  /** Undefined when the extension does not exist in that tenant (a 404). */
  findCredential(tenantId: string, extensionId: string): Promise<DigestCredential | undefined>;
  /** Undefined when the DID does not exist in that tenant (a 404). */
  findDid(tenantId: string, didId: string): Promise<DidConfig | undefined>;
  /** Undefined when the location does not exist in that tenant (a 404). */
  findEmergencyLocation(
    tenantId: string,
    locationId: string,
  ): Promise<EmergencyLocationConfig | undefined>;
  /** Undefined when the asset does not exist in that tenant (a 404). */
  findMediaAsset(tenantId: string, id: string): Promise<MediaAssetConfig | undefined>;
  /** Undefined when the ring group does not exist in that tenant (a 404). */
  findRingGroup(tenantId: string, ringGroupId: string): Promise<RingGroupConfig | undefined>;
  /** Undefined when the queue does not exist in that tenant (a 404). */
  findQueue(tenantId: string, queueId: string): Promise<QueueConfig | undefined>;
  /** Undefined when the agent does not exist in that tenant (a 404). */
  findAgent(tenantId: string, agentId: string): Promise<AgentConfig | undefined>;
  /** A queue's full current tier list. */
  findQueueTiers(tenantId: string, queueId: string): Promise<QueueTierConfig[]>;
  /** Undefined when the parking lot does not exist in that tenant (a 404). */
  findParkingLot(tenantId: string, parkingLotId: string): Promise<ParkingLotConfig | undefined>;
  /** Undefined when the conference room does not exist in that tenant (a 404). */
  findConferenceRoom(
    tenantId: string,
    conferenceRoomId: string,
  ): Promise<ConferenceRoomConfig | undefined>;
  /**
   * Whether `pin` matches the room's stored PIN — what `conference.lua` calls
   * after collecting DTMF digits (S2-15). The decrypted PIN itself never
   * leaves pbx-config-service (`conference-room.repo.ts`'s own `verifyPin`);
   * this only ever sees the boolean result.
   */
  verifyConferencePin(tenantId: string, conferenceRoomId: string, pin: string): Promise<boolean>;
  /**
   * Whether a schedule is open right now (S3-10, G-59), evaluated by
   * pbx-config-service in the schedule's own time zone on every call, never
   * cached here (an edit to the hours or holidays applies to the next call).
   * Undefined when the schedule does not exist in that tenant (a 404).
   */
  isScheduleOpen(tenantId: string, scheduleId: string): Promise<boolean | undefined>;
}

export function createPbxConfigClient(options: PbxConfigClientOptions): PbxConfigClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    async findCredential(
      tenantId: string,
      extensionId: string,
    ): Promise<DigestCredential | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/extensions/${encodeURIComponent(extensionId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the credential lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as DigestCredential;
    },

    async findDid(tenantId: string, didId: string): Promise<DidConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/dids/${encodeURIComponent(didId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the DID lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as DidConfig;
    },

    async findEmergencyLocation(
      tenantId: string,
      locationId: string,
    ): Promise<EmergencyLocationConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/emergency-locations/${encodeURIComponent(locationId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the emergency location lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as EmergencyLocationConfig;
    },

    async findMediaAsset(tenantId: string, id: string): Promise<MediaAssetConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/media-assets/${encodeURIComponent(id)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the media asset lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as MediaAssetConfig;
    },

    async findRingGroup(
      tenantId: string,
      ringGroupId: string,
    ): Promise<RingGroupConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/ring-groups/${encodeURIComponent(ringGroupId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the ring group lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as RingGroupConfig;
    },

    async findQueue(tenantId: string, queueId: string): Promise<QueueConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/queues/${encodeURIComponent(queueId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the queue lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as QueueConfig;
    },

    async findAgent(tenantId: string, agentId: string): Promise<AgentConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(agentId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the agent lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as AgentConfig;
    },

    async findQueueTiers(tenantId: string, queueId: string): Promise<QueueTierConfig[]> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/queues/${encodeURIComponent(queueId)}/tiers`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the queue tiers lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { rows: QueueTierConfig[] };
      return body.rows;
    },

    async findParkingLot(
      tenantId: string,
      parkingLotId: string,
    ): Promise<ParkingLotConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/parking-lots/${encodeURIComponent(parkingLotId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the parking lot lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as ParkingLotConfig;
    },

    async findConferenceRoom(
      tenantId: string,
      conferenceRoomId: string,
    ): Promise<ConferenceRoomConfig | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/conference-rooms/${encodeURIComponent(conferenceRoomId)}`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the conference room lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      return (await response.json()) as ConferenceRoomConfig;
    },

    async verifyConferencePin(
      tenantId: string,
      conferenceRoomId: string,
      pin: string,
    ): Promise<boolean> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/conference-rooms/${encodeURIComponent(conferenceRoomId)}/verify-pin`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${options.internalServiceToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ pin }),
          },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the conference PIN verification (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { valid: boolean };
      return body.valid;
    },

    async isScheduleOpen(tenantId: string, scheduleId: string): Promise<boolean | undefined> {
      let response: Response;
      try {
        response = await fetchImpl(
          `${baseUrl}/internal/v1/tenants/${encodeURIComponent(tenantId)}/schedules/${encodeURIComponent(scheduleId)}/open`,
          { headers: { authorization: `Bearer ${options.internalServiceToken}` } },
        );
      } catch (error) {
        throw new PbxConfigClientError(
          `Could not reach pbx-config-service: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new PbxConfigClientError(
          `pbx-config-service rejected the schedule lookup (${String(response.status)}): ` +
            (await responseDetail(response)),
        );
      }

      const body = (await response.json()) as { open: boolean };
      return body.open;
    },
  };
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { title?: string; detail?: string };
    return body.detail ?? body.title ?? response.statusText;
  } catch {
    return response.statusText;
  }
}
