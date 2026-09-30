import type { Database } from '@cuc/db';
import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { TelephonyConfigDb } from './schema.js';
import type { MailboxLamp, VoicemailClient } from './voicemail-client.js';

/**
 * How long OpenSIPs keeps a published message summary (`pua_publish`'s `expires`). Every mailbox
 * is published again on each renewing pass ({@link MwiPublisher.start}), well inside this, so a
 * summary only lapses when its mailbox is gone. `opensips.cfg.template` lets a publication live
 * this long (`max_expires_publish`).
 */
export const MWI_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

/**
 * The `application/simple-message-summary` body (RFC 3842) for one mailbox: whether the lamp is
 * lit, and the new and saved counts a phone may show beside it. No urgent messages exist here.
 */
export function messageSummary(aor: string, lamp: MailboxLamp): string {
  return [
    `Messages-Waiting: ${lamp.newMessages > 0 ? 'yes' : 'no'}`,
    `Message-Account: sip:${aor}`,
    `Voice-Message: ${String(lamp.newMessages)}/${String(lamp.savedMessages)} (0/0)`,
    '',
  ].join('\r\n');
}

export interface MwiPublisher {
  /**
   * Announces one mailbox's counts. A mailbox that is gone is announced empty for `extensionId`
   * when given (the lamp goes out). Resolves with how many addresses were told (0: none known).
   */
  publishMailbox(tenantId: string, mailboxId: string, extensionId?: string): Promise<number>;
  /** Announces every mailbox of every tenant. Resolves with how many addresses were told. */
  publishAll(): Promise<number>;
  /** Announces every mailbox now, and again every `intervalMs`. */
  start(intervalMs: number): void;
  stop(): void;
}

/**
 * S2-16 (G-42): the message-waiting lamp. A phone subscribes to `message-summary` for its own
 * address at the edge; this tells the edge what to answer.
 *
 * voicemail-service says when a mailbox's unread state changed (`voicemail.mailbox.mwi_changed`,
 * a thin event) and what its counts are now (`GET .../voicemail/mwi`). The mailbox belongs to an
 * extension; the extension's SIP username at its tenant's domain is the address a phone
 * subscribes to (this service's read model). For each, the edge is asked over MI to publish the
 * summary (`pua_publish`): it sends itself a PUBLISH, its presence engine stores it and notifies
 * the subscribed phones. Only this service talks to OpenSIPs (CLAUDE.md rule 4).
 *
 * A publication expires ({@link MWI_EXPIRES_SECONDS}), and a missed event or a presence table
 * lost with its database would leave a lamp wrong, so every mailbox is also announced on a
 * timer. Publishing the same counts again changes nothing a phone sees.
 *
 * Not `scoped(ctx)`: like the presence watcher, the renewing pass runs over every tenant with no
 * tenant request to scope to, and reads only this service's own read model.
 */
export function createMwiPublisher(options: {
  readonly db: Database<TelephonyConfigDb>;
  readonly voicemail: Pick<VoicemailClient, 'mailboxLamps'>;
  readonly mi: OpenSipsMiClient;
  readonly logger: Logger;
}): MwiPublisher {
  const { db, voicemail, mi, logger } = options;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  /** The addresses (`user@domain`) a phone of this extension may subscribe to. */
  async function addressesOf(extensionId: string): Promise<string[]> {
    const rows = await db.kysely
      .selectFrom('extensions')
      .innerJoin('domains', 'domains.tenant_id', 'extensions.tenant_id')
      .select(['extensions.username as username', 'domains.fqdn as fqdn'])
      .where('extensions.id', '=', extensionId)
      .execute();
    return rows.map((row) => `${row.username}@${row.fqdn}`);
  }

  async function publish(lamp: MailboxLamp): Promise<number> {
    const addresses = await addressesOf(lamp.extensionId);
    for (const aor of addresses) {
      await mi.query('pua_publish', {
        presentity_uri: `sip:${aor}`,
        expires: MWI_EXPIRES_SECONDS,
        event_package: 'message-summary',
        content_type: 'application/simple-message-summary',
        body: messageSummary(aor, lamp),
      });
    }
    return addresses.length;
  }

  async function publishAll(): Promise<number> {
    const tenants = await db.kysely
      .selectFrom('extensions')
      .select('tenant_id as tenantId')
      .distinct()
      .execute();
    let told = 0;
    for (const { tenantId } of tenants) {
      for (const lamp of await voicemail.mailboxLamps(tenantId)) told += await publish(lamp);
    }
    return told;
  }

  async function pass(): Promise<void> {
    if (running) return;
    running = true;
    try {
      const told = await publishAll();
      logger.debug({ told }, 'message-waiting summaries renewed');
    } catch (error) {
      // The next pass tries again; a lamp is at worst one interval stale.
      logger.warn({ err: error }, 'could not renew message-waiting summaries');
    } finally {
      running = false;
    }
  }

  return {
    async publishMailbox(tenantId, mailboxId, extensionId) {
      const [lamp] = await voicemail.mailboxLamps(tenantId, mailboxId);
      if (lamp !== undefined) return publish(lamp);
      // The mailbox is gone: its extension's lamp goes out.
      if (extensionId === undefined) return 0;
      return publish({ mailboxId, extensionId, newMessages: 0, savedMessages: 0 });
    },
    publishAll,
    start(intervalMs) {
      void pass();
      timer = setInterval(() => void pass(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}
