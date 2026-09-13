import type { EventTables } from '@cuc/events';

export type UserStatus = 'active' | 'disabled';
export type UserOrgType = 'master' | 'reseller' | 'tenant';
export type MfaFactorType = 'totp';
export type SigningKeyAlgorithm = 'EdDSA';

/**
 * This service's own schema (05 §1.1). No cross-schema joins.
 *
 * None of these tables are tenant-owned in the `@cuc/db` sense: `users` is
 * scoped by `org_id`, which can name a master, reseller, *or* tenant org, not
 * only a tenant, so it is not a `TenantOwnedTable` and does not go through
 * `scoped(ctx)`. `sessions`, `mfa_factors`, and `signing_keys` are keyed off
 * `users`/nothing at all. Queries stay inside one org's boundary because the
 * repository adds `WHERE org_id = ?` explicitly (05 §2.5), the same pattern
 * org-service uses for `orgs` and for the identical reason — see the comment
 * on `OrgServiceDb` in org-service's `src/schema.ts`.
 */
export interface IdentityServiceDb extends EventTables {
  users: {
    id: string;
    org_id: string;
    /**
     * A snapshot of the owning org's type and reseller, supplied by the
     * caller when the user is created (today, only org-service's bootstrap,
     * through the internal admin-creation endpoint). This is a deliberate
     * denormalization rather than a cross-schema join (05 §1.1) or an
     * org-service read model this task does not otherwise need: orgs cannot
     * be re-parented or change type in v1 (02 §1), so the snapshot cannot go
     * stale. `org.jwt` claims (07 §2) are built straight from these columns.
     */
    org_type: UserOrgType;
    reseller_id: string | null;
    /** Unique per org, not globally (05 §3.2). Stored lowercase. */
    email: string;
    display_name: string;
    /** Argon2id, via @node-rs/argon2. Never the plaintext, ever. */
    password_hash: string;
    status: UserStatus;
    /** True once a confirmed `mfa_factors` row exists. Denormalized for a cheap login check. */
    mfa_enrolled: boolean;
    last_login_at: Date | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };

  mfa_factors: {
    id: string;
    user_id: string;
    type: MfaFactorType;
    /** Envelope-encrypted TOTP secret (07 §5: MFA secrets). */
    secret_enc: string;
    /**
     * Null until the holder proves possession with a valid code. An
     * unconfirmed factor authenticates nobody — see `mfa.repo.ts`.
     */
    confirmed_at: Date | null;
    created_at: Date;
  };

  sessions: {
    id: string;
    user_id: string;
    /** SHA-256 of the opaque refresh token. The raw token is never stored. */
    refresh_hash: string;
    /**
     * Shared by every session produced from one login by rotation. A reuse of
     * an already-rotated token revokes every row with this family_id (07 §2).
     */
    family_id: string;
    /** Sliding: reset to now + REFRESH_TOKEN_TTL_DAYS on every rotation. */
    expires_at: Date;
    revoked_at: Date | null;
    ip: string | null;
    ua: string | null;
    created_at: Date;
  };

  /**
   * EdDSA keypairs for signing access tokens, published via JWKS. `id` is the
   * JWK `kid` (a JWK thumbprint, so it is derived from the public key rather
   * than assigned, and two different keys can never collide on it).
   */
  signing_keys: {
    id: string;
    algorithm: SigningKeyAlgorithm;
    /** Raw public key bytes. Not a secret; published as-is in the JWKS. */
    public_key: Buffer;
    /** Envelope-encrypted PKCS8 private key (07 §5). */
    private_key_enc: string;
    created_at: Date;
    /**
     * Null while this is the key new tokens are signed with. Set the moment a
     * newer key becomes current, which starts this key's overlap countdown —
     * it keeps verifying tokens already issued but signs no new ones.
     */
    retired_at: Date | null;
  };
}
