import type { CallTopicEvent, LiveCall } from './calls.js';

/**
 * One person's own live calls, for their `user:{u}:calls` topic (S5-15): what of the tenant's
 * legs they are shown, and how each change to those legs reads to them.
 *
 * A leg is theirs when its `extension` (the extension call-control vouches the leg belongs to:
 * a registered phone that called in, or the extension a leg rang) is their extension's number.
 * They are also shown the legs bridged to theirs, since those carry the other half of the same
 * call, including the recording state: the recording runs on the call's owner channel, which on
 * a call they receive is the caller's leg, not theirs. Nothing else of the tenant's calls, and
 * never a leg because of a caller ID.
 *
 * Once shown, a leg stays shown until it ends, so the view never loses half of a call mid-way.
 * A leg that becomes theirs (or bridged to theirs) after it started is announced then, as a
 * `call.started` with its state at that moment.
 */
export class UserCalls {
  private readonly shown = new Set<string>();

  constructor(readonly number: string) {}

  /** Their legs among `legs` now, for the snapshot. Replaces whatever was shown. */
  load(legs: ReadonlyMap<string, LiveCall>): LiveCall[] {
    this.shown.clear();
    for (const leg of legs.values()) {
      if (!this.owns(leg)) continue;
      this.shown.add(leg.callUuid);
      if (leg.bridgedTo !== null && legs.has(leg.bridgedTo)) this.shown.add(leg.bridgedTo);
    }
    // A leg bridged to theirs, where only the other leg says so.
    for (const leg of legs.values()) {
      const partner = leg.bridgedTo === null ? undefined : legs.get(leg.bridgedTo);
      if (partner !== undefined && this.owns(partner)) this.shown.add(leg.callUuid);
    }
    return [...legs.values()].filter((leg) => this.shown.has(leg.callUuid));
  }

  /**
   * What `event` (already applied to `legs`) means for them: nothing, the event itself, or a leg
   * newly shown.
   */
  apply(legs: ReadonlyMap<string, LiveCall>, event: CallTopicEvent): CallTopicEvent[] {
    const out: CallTopicEvent[] = [];
    const show = (leg: LiveCall | undefined) => {
      if (leg === undefined || this.shown.has(leg.callUuid)) return;
      this.shown.add(leg.callUuid);
      out.push({ type: 'call.started', call: leg });
    };

    switch (event.type) {
      case 'call.started': {
        const leg = event.call;
        const partner = leg.bridgedTo === null ? undefined : legs.get(leg.bridgedTo);
        if (
          this.owns(leg) ||
          (partner !== undefined && this.shown.has(partner.callUuid) && this.owns(partner))
        ) {
          this.shown.add(leg.callUuid);
          out.push(event);
          if (this.owns(leg)) show(partner);
        }
        break;
      }
      case 'call.updated': {
        if (this.shown.has(event.callUuid)) out.push(event);
        const bridgedTo = event.changes.bridgedTo;
        if (bridgedTo !== undefined && bridgedTo !== null) {
          const leg = legs.get(event.callUuid);
          const partner = legs.get(bridgedTo);
          if (leg !== undefined && partner !== undefined) {
            if (this.owns(leg)) show(partner);
            if (this.owns(partner)) show(leg);
          }
        }
        break;
      }
      case 'call.ended':
        if (this.shown.delete(event.callUuid)) out.push(event);
        break;
    }
    return out;
  }

  private owns(leg: LiveCall): boolean {
    return leg.extension === this.number;
  }
}
