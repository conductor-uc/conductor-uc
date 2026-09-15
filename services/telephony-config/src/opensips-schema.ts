import type { Generated } from 'kysely';

/**
 * The two `opensips` schema tables this task projects into (S1-12's own
 * plan line narrows the fuller list in 06's telephony-config section —
 * `address`/`dr_gateways`/`dr_rules`/`dr_groups`/`registrant`/`dispatcher`
 * are trunk-service's projection, S2-02).
 *
 * Column shapes are copied from OpenSIPs' own vendored table definitions
 * (`telephony/opensips/db-schema/domain-create.sql`,
 * `auth_db-create.sql`) — this file describes an existing schema for Kysely,
 * it does not create one. `opensips`'s tables are provisioned by
 * `infra/compose/mariadb/init/02-opensips-schema.sh` (S1-11), not by this
 * service's own migrations: 05 §1.1 says telephony-config *writes* the
 * schema, not that it owns the DDL, and staying byte-identical to what
 * OpenSIPs ships is why S1-11 vendored those files verbatim in the first
 * place.
 */
export interface OpenSipsDb {
  domain: {
    id: Generated<number>;
    domain: string;
    attrs: string | null;
    accept_subdomain: number;
    last_modified: Date;
  };
  subscriber: {
    id: Generated<number>;
    username: string;
    domain: string;
    password: string;
    ha1: string;
    ha1_sha256: string;
    ha1_sha512t256: string;
  };
}
