import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

/**
 * The claims identity-service's access token carries (07 §2). Deliberately a
 * standalone copy of identity-service's own `AccessTokenClaims` rather than an
 * import from it: services do not depend on each other's internals, and a
 * token is a public contract between the issuer and every verifier of it, not
 * a shared TypeScript type.
 */
export interface AccessTokenClaims extends JWTPayload {
  readonly sub: string;
  readonly org: string;
  readonly ot: 'master' | 'reseller' | 'tenant';
  readonly rsl?: string;
  readonly roles: readonly string[];
  readonly perms: readonly string[];
  readonly amr: readonly string[];
  readonly sid: string;
}

export class InvalidAccessTokenError extends Error {
  override readonly name = 'InvalidAccessTokenError';
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface CreateAccessTokenVerifierOptions {
  /** e.g. `http://identity-service:8080/.well-known/jwks.json`. */
  readonly jwksUrl: string | URL;
  readonly algorithm: string;
  readonly cacheMaxAgeMs: number;
  readonly cooldownMs: number;
}

/**
 * Verifies an access token against identity-service's published JWKS.
 *
 * `createRemoteJWKSet` does the caching itself: a `kid` already in the cache
 * verifies with no network call, and an unrecognised one triggers at most one
 * refetch per `cooldownMs` — so key rotation on identity-service's side needs
 * no coordination with the gateway.
 */
export function createAccessTokenVerifier(
  options: CreateAccessTokenVerifierOptions,
): AccessTokenVerifier {
  const jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(options.jwksUrl), {
    cacheMaxAge: options.cacheMaxAgeMs,
    cooldownDuration: options.cooldownMs,
  });

  return {
    async verify(token: string): Promise<AccessTokenClaims> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { algorithms: [options.algorithm] }));
      } catch (error) {
        throw new InvalidAccessTokenError(
          error instanceof Error ? error.message : 'Token verification failed.',
        );
      }
      return assertAccessTokenShape(payload);
    },
  };
}

/**
 * A validly signed token is not necessarily an access token — identity-service
 * signs MFA tickets with the same key family. Shape, not just signature, is
 * what tells them apart.
 */
function assertAccessTokenShape(payload: JWTPayload): AccessTokenClaims {
  const org = payload['org'];
  const ot = payload['ot'];
  const sid = payload['sid'];
  const roles = payload['roles'];
  const perms = payload['perms'];
  const amr = payload['amr'];
  const rsl = payload['rsl'];

  if (
    typeof payload.sub !== 'string' ||
    typeof org !== 'string' ||
    (ot !== 'master' && ot !== 'reseller' && ot !== 'tenant') ||
    typeof sid !== 'string' ||
    !Array.isArray(roles) ||
    !Array.isArray(perms) ||
    !Array.isArray(amr) ||
    (rsl !== undefined && typeof rsl !== 'string')
  ) {
    throw new InvalidAccessTokenError('Token does not have the shape of an access token.');
  }
  return payload as AccessTokenClaims;
}
