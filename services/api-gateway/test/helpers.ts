import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';

import { createServer, type CreateServerOptions, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';

const ALGORITHM = 'EdDSA';
const CURVE = 'Ed25519';
const KID = 'test-key';

export interface FakeIdentityKeys {
  readonly jwksUrl: string;
  readonly privateKey: CryptoKey;
  stop(): Promise<void>;
}

/**
 * A real JWKS HTTP endpoint (plain `node:http`, not `@cuc/http` — it serves
 * one public document and needs none of a service's machinery) backed by a
 * freshly generated EdDSA key. Access tokens minted with the matching private
 * key verify against it exactly as they would against identity-service's own,
 * over a real socket rather than a stubbed verifier.
 */
export async function startFakeJwks(): Promise<FakeIdentityKeys> {
  const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, {
    crv: CURVE,
    extractable: true,
  });
  const jwk = await exportJWK(publicKey);
  const document = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: 'sig', alg: ALGORITHM }] });

  const server = createHttpServer((request, response) => {
    if (request.url === '/.well-known/jwks.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(document);
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    jwksUrl: `http://127.0.0.1:${String(port)}/.well-known/jwks.json`,
    privateKey,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface MintTokenFields {
  readonly sub?: string;
  readonly org: string;
  readonly ot: 'master' | 'reseller' | 'tenant';
  readonly rsl?: string;
  readonly roles?: readonly string[];
  readonly perms?: readonly string[];
  readonly amr?: readonly string[];
  readonly sid?: string;
  readonly expiresInSeconds?: number;
}

/** Signs an access token shaped exactly like identity-service's (07 §2). */
export async function mintAccessToken(
  privateKey: CryptoKey,
  fields: MintTokenFields,
): Promise<string> {
  const { sub = 'user-1', expiresInSeconds = 600, ...rest } = fields;
  return new SignJWT({
    org: rest.org,
    ot: rest.ot,
    ...(rest.rsl === undefined ? {} : { rsl: rest.rsl }),
    roles: rest.roles ?? [],
    perms: rest.perms ?? [],
    amr: rest.amr ?? ['pwd'],
    sid: rest.sid ?? 'session-1',
  })
    .setProtectedHeader({ alg: ALGORITHM, kid: KID })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(privateKey);
}

export interface FakeDownstream {
  readonly url: string;
  readonly app: Server;
  stop(): Promise<void>;
}

/**
 * A real downstream service standing in for org-service/identity-service:
 * `@cuc/http`'s own `createServer`, with `trustInternalHeaders` on, listening
 * on a real port. This is what lets the proxy tests assert the gateway's
 * signed headers are accepted by the exact verification code a real service
 * runs, not a hand-rolled stand-in for it.
 *
 * `registerRoutes` runs before the server starts listening — Fastify refuses
 * new routes once `ready()`/`listen()` has run, so this is the only point a
 * caller can add them.
 */
export async function startFakeDownstream(
  secret: string,
  registerRoutes: (app: Server) => void,
): Promise<FakeDownstream> {
  const app = await createServer({
    serviceName: 'fake-downstream',
    logger: silentLogger(),
    context: { trustInternalHeaders: true, internalHeaderSigningSecret: secret },
  });
  registerRoutes(app);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    app,
    stop: () => app.close(),
  };
}

export function baseServerOptions(): Pick<CreateServerOptions, 'logger'> {
  return { logger: silentLogger() };
}
