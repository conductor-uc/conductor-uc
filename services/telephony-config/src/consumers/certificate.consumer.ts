import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import type { CertificateSync } from '../certificate-sync.js';
import { telephonyEvents } from '../events.js';
import type { TelephonyConfigDb } from '../schema.js';

interface CertificateIssuedData {
  readonly fqdn: string;
  readonly purpose: 'sip' | 'console';
}

export interface CertificateConsumerOptions {
  readonly pullTimeoutMs?: number;
}

/**
 * The `ORG` stream's `org.certificate.issued` (G-105): a SIP proxy certificate was
 * issued or renewed, so it is fetched from org-service and projected into OpenSIPs'
 * `tls_mgm`, which is then reloaded. Console certificates are the gateway's, not
 * OpenSIPs', and are ignored here. A failure (org-service unreachable, OpenSIPs
 * down) throws, so the event is redelivered; the periodic sync is the backstop.
 */
export function createCertificateConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  sync: CertificateSync,
  options: CertificateConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-certificates',
    subjects: ['org.certificate.issued'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const data = envelope.data as CertificateIssuedData;
      if (data.purpose !== 'sip') return;
      await sync.syncOne(data.fqdn);
    },
  });
}
