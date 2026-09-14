import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

import type { SigningKey, VerificationKey } from '../repo/signing-key.repo.js';

/** 07 §2: org, ot, rsl, roles, perms, amr, sid, plus the standard sub/iat/exp. */
export interface AccessTokenClaims extends JWTPayload {
  readonly sub: string;
  /** Org id. */
  readonly org: string;
  readonly ot: 'master' | 'reseller' | 'tenant';
  /** Reseller id, when the org is a tenant with one. */
  readonly rsl?: string;
  /**
   * Empty until `@cuc/authz` (S1-06) exists to populate them. A token minted
   * today carries no roles or permissions — which is correct: nothing in this
   * codebase evaluates them yet, and shipping a token that *looks* authorized
   * would be worse than one that plainly is not.
   */
  readonly roles: readonly string[];
  readonly perms: readonly string[];
  /** Authentication methods used, e.g. `['pwd']` or `['pwd', 'totp']`. */
  readonly amr: readonly string[];
  /** Session id — the row in `sessions` this access token was issued alongside. */
  readonly sid: string;
}

const ALG = 'EdDSA';

/** Signs an access token with the given key, valid for `ttlSeconds`. */
export async function signAccessToken(
  key: SigningKey,
  claims: Omit<AccessTokenClaims, 'sub' | 'iat' | 'exp'> & { sub: string },
  ttlSeconds: number,
): Promise<string> {
  const { sub, ...rest } = claims;
  return new SignJWT(rest)
    .setProtectedHeader({ alg: ALG, kid: key.id })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(key.privateKey);
}

/**
 * Verifies an access token against whichever currently-valid key its `kid`
 * names. Used by this service's own tests; ordinary services verify through
 * api-gateway (S1-08) instead of importing this.
 */
export async function verifyAccessToken(
  token: string,
  keys: readonly VerificationKey[],
): Promise<AccessTokenClaims> {
  const header = decodeHeader(token);
  const key = keys.find((candidate) => candidate.id === header.kid);
  if (key === undefined) throw new Error(`No verification key for kid '${String(header.kid)}'.`);

  const { payload } = await jwtVerify(token, key.publicKey, { algorithms: [ALG] });
  return assertAccessTokenShape(payload);
}

/**
 * A validly signed JWT is not necessarily an access token — an MFA ticket
 * (`tokens/ticket.ts`) is signed by the same key and would pass `jwtVerify`
 * just as cleanly. This is what actually stops one being mistaken for the
 * other: an access token's claims are checked for shape, not just signature,
 * before anything downstream sees them.
 */
function assertAccessTokenShape(payload: JWTPayload): AccessTokenClaims {
  const org = payload['org'];
  const ot = payload['ot'];
  const sid = payload['sid'];
  const roles = payload['roles'];
  const perms = payload['perms'];
  const amr = payload['amr'];

  if (
    typeof payload.sub !== 'string' ||
    typeof org !== 'string' ||
    (ot !== 'master' && ot !== 'reseller' && ot !== 'tenant') ||
    typeof sid !== 'string' ||
    !Array.isArray(roles) ||
    !Array.isArray(perms) ||
    !Array.isArray(amr)
  ) {
    throw new Error('Token does not have the shape of an access token.');
  }
  return payload as AccessTokenClaims;
}

function decodeHeader(token: string): { kid?: string } {
  const [headerPart] = token.split('.');
  if (headerPart === undefined) throw new Error('Malformed token.');
  return JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8')) as { kid?: string };
}
