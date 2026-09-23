import type { EventTables } from '@cuc/events';

/** This service's own schema (05 §1.1). */
export interface NotificationServiceDb extends EventTables {
  /**
   * One row per email handed to the relay. Records that it was sent and to
   * whom; never the body, and never a token, since those are credentials.
   */
  sent_emails: {
    id: string;
    /** The event that caused it, so a redelivery can be told apart. */
    event_id: string;
    template: string;
    to_address: string;
    org_id: string;
    /** The reseller whose brand it carried, or null for neutral. */
    brand_reseller: string | null;
    sent_at: Date;
  };
}
