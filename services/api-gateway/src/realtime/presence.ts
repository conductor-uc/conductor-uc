import type { CallTopicEvent, LiveCall } from './calls.js';

/**
 * Extension presence for the `tenant:{t}:presence` topic.
 *
 * Two sources (G-122). Call state comes from the tenant's live calls (S5-08): a channel that
 * called in to the media node was placed by its caller (`from`), and one the node placed rings
 * its callee (`to`); that party counts when it has an extension number's shape (2-6 digits,
 * pbx-config-service's `numbering.ts`). Registration and do not disturb come from
 * telephony-config (S5-10): its snapshot lists every extension of the tenant with `registered`
 * and `dnd`, and `call.presence.changed` follows each change.
 *
 * An extension is, in this order: `on_call`, `ringing`, `offline` (no phone registered), `dnd`,
 * or `idle` (registered, not on a call, not do not disturb). With telephony-config's list, only
 * the tenant's real extensions appear, so an outside caller ID that looks like one never does.
 *
 * Without that list (the gateway has no `TELEPHONY_CONFIG_URL`), presence is calls only, as in
 * S5-08: `ringing`, `on_call`, or `idle`, where idle does not say the phone is registered, and
 * the snapshot lists only the extensions that are not idle.
 *
 * Presence is config-class (07 §3.3): only extension numbers and states, never a caller.
 */
export type PresenceState = 'idle' | 'ringing' | 'on_call' | 'dnd' | 'offline';

export interface PresenceEntry {
  readonly extension: string;
  readonly state: PresenceState;
}

/** One change on the `presence` topic. */
export interface PresenceTopicEvent {
  readonly type: 'presence.changed';
  readonly extension: string;
  readonly state: PresenceState;
}

/** An extension's registration and do not disturb, from telephony-config. */
export interface ExtensionStatus {
  readonly extension: string;
  readonly registered: boolean;
  readonly dnd: boolean;
}

const EXTENSION_NUMBER = /^[0-9]{2,6}$/;

interface Channel {
  readonly extension: string;
  readonly direction: LiveCall['direction'];
  state: LiveCall['state'];
}

const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });

/** Presence for one tenant, kept only while someone on this gateway watches it. */
export class TenantPresence {
  private readonly channels = new Map<string, Channel>();
  /** Every extension's registration and do not disturb; undefined when presence is calls only. */
  private statuses: Map<string, { registered: boolean; dnd: boolean }> | undefined;

  /**
   * Replaces everything known with a snapshot of the tenant's live calls, and (when there is a
   * status source) every extension's registration and do not disturb.
   */
  load(calls: readonly LiveCall[], statuses?: readonly ExtensionStatus[]): void {
    this.channels.clear();
    this.statuses =
      statuses === undefined
        ? undefined
        : new Map(statuses.map((s) => [s.extension, { registered: s.registered, dnd: s.dnd }]));
    for (const call of calls) this.track(call);
  }

  /**
   * With a status source, every extension of the tenant, in number order. Calls only, the
   * extensions that are not idle (an extension not listed is idle).
   */
  snapshot(): PresenceEntry[] {
    if (this.statuses !== undefined) {
      return [...this.statuses.keys()]
        .sort(byNumber)
        .map((extension) => ({ extension, state: this.stateOf(extension) }));
    }
    const extensions = new Set([...this.channels.values()].map((c) => c.extension));
    return [...extensions]
      .sort()
      .map((extension) => ({ extension, state: this.stateOf(extension) }));
  }

  /** Applies one call change; returns the extensions whose presence it changed. */
  apply(event: CallTopicEvent): PresenceTopicEvent[] {
    const extension = this.extensionAffectedBy(event);
    if (extension === undefined) return [];
    const before = this.stateOf(extension);

    switch (event.type) {
      case 'call.started':
        this.track(event.call);
        break;
      case 'call.updated': {
        const channel = this.channels.get(event.callUuid);
        if (channel !== undefined && event.changes.state !== undefined) {
          channel.state = event.changes.state;
        }
        break;
      }
      case 'call.ended':
        this.channels.delete(event.callUuid);
        break;
    }

    return this.changed(extension, before);
  }

  /**
   * Applies one `call.presence.changed` (registration or do not disturb). A new extension joins
   * the list. Does nothing when presence is calls only.
   */
  applyStatus(status: ExtensionStatus): PresenceTopicEvent[] {
    if (this.statuses === undefined || !EXTENSION_NUMBER.test(status.extension)) return [];
    const known = this.statuses.has(status.extension);
    const before = known ? this.stateOf(status.extension) : undefined;
    this.statuses.set(status.extension, { registered: status.registered, dnd: status.dnd });
    return this.changed(status.extension, before);
  }

  private changed(extension: string, before: PresenceState | undefined): PresenceTopicEvent[] {
    if (this.statuses !== undefined && !this.statuses.has(extension)) return [];
    const after = this.stateOf(extension);
    return after === before ? [] : [{ type: 'presence.changed', extension, state: after }];
  }

  private extensionAffectedBy(event: CallTopicEvent): string | undefined {
    if (event.type === 'call.started') return extensionOf(event.call);
    return this.channels.get(event.callUuid)?.extension;
  }

  private track(call: LiveCall): void {
    const extension = extensionOf(call);
    if (extension === undefined) return;
    this.channels.set(call.callUuid, { extension, direction: call.direction, state: call.state });
  }

  private stateOf(extension: string): PresenceState {
    let ringing = false;
    let busy = false;
    for (const channel of this.channels.values()) {
      if (channel.extension !== extension) continue;
      if (channel.state !== 'ringing') busy = true;
      // The node ringing the extension's phone. A phone that is itself dialling
      // (an inbound channel not answered yet) is already busy.
      else if (channel.direction === 'outbound') ringing = true;
      else busy = true;
    }
    if (busy) return 'on_call';
    if (ringing) return 'ringing';
    const status = this.statuses?.get(extension);
    if (status !== undefined && !status.registered) return 'offline';
    if (status?.dnd === true) return 'dnd';
    return 'idle';
  }
}

/** The extension a channel belongs to, or undefined when that party is not an extension. */
export function extensionOf(call: Pick<LiveCall, 'direction' | 'from' | 'to'>): string | undefined {
  const party = call.direction === 'inbound' ? call.from : call.to;
  return EXTENSION_NUMBER.test(party) ? party : undefined;
}
