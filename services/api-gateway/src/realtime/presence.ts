import type { CallTopicEvent, LiveCall } from './calls.js';

/**
 * Extension presence for the `tenant:{t}:presence` topic, derived from the
 * tenant's live calls (S5-08).
 *
 * There is no other presence source a service can read yet. OpenSIPs keeps BLF
 * dialog state (`presence`/`pua_dialoginfo`, S2-17) and registrations
 * (`usrloc`) in its own tables, which no service reads, and do-not-disturb
 * lives in each extension's call handling (docs/decisions.md G-119). So an
 * extension here is `ringing`, `on_call`, or `idle`, where idle means "not on
 * a call we can see": it does not say the phone is registered.
 *
 * Which extension a channel belongs to: a channel that called in to the media
 * node was placed by its caller (`from`), and one the node placed rings its
 * callee (`to`). That party counts only when it has an extension number's shape
 * (2-6 digits, pbx-config-service's `numbering.ts`), so an outside number never
 * appears here: presence is config-class (07 §3.3), and outside numbers are
 * private. A channel carries no extension id yet, so this is a number match.
 */
export type PresenceState = 'idle' | 'ringing' | 'on_call';

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

const EXTENSION_NUMBER = /^[0-9]{2,6}$/;

interface Channel {
  readonly extension: string;
  readonly direction: LiveCall['direction'];
  state: LiveCall['state'];
}

/** Presence for one tenant, kept only while someone on this gateway watches it. */
export class TenantPresence {
  private readonly channels = new Map<string, Channel>();

  /** Replaces everything known with a snapshot of the tenant's live calls. */
  load(calls: readonly LiveCall[]): void {
    this.channels.clear();
    for (const call of calls) this.track(call);
  }

  /** Extensions that are not idle. An extension not listed is idle. */
  snapshot(): PresenceEntry[] {
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
    return ringing ? 'ringing' : 'idle';
  }
}

/** The extension a channel belongs to, or undefined when that party is not an extension. */
export function extensionOf(call: Pick<LiveCall, 'direction' | 'from' | 'to'>): string | undefined {
  const party = call.direction === 'inbound' ? call.from : call.to;
  return EXTENSION_NUMBER.test(party) ? party : undefined;
}
