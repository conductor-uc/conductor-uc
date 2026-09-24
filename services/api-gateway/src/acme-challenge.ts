import { ProblemError, Type, type Server } from '@cuc/http';

/** Answers an ACME HTTP-01 challenge: the text to serve for a token, or undefined when there is none. */
export type ChallengeLookup = (token: string) => Promise<string | undefined>;

/** The path a CA fetches, and the only shape of token worth asking org-service about. */
export const ACME_CHALLENGE_PREFIX = '/.well-known/acme-challenge/';
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Asks org-service, which holds the answers the certificate worker is waiting on,
 * for the answer to a challenge token (G-105). The token is checked before it is
 * used, so a request for anything else on this path never reaches org-service,
 * and a failure of any kind is simply "no answer": the CA is told the file is not
 * there, and tries again.
 */
export function createChallengeLookup(options: {
  readonly orgServiceUrl: string;
  readonly internalServiceToken: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): ChallengeLookup {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.orgServiceUrl.replace(/\/+$/, '');
  return async (token) => {
    if (options.internalServiceToken === undefined || !TOKEN.test(token)) return undefined;
    try {
      const response = await fetchImpl(
        `${base}/internal/v1/acme/challenges/${encodeURIComponent(token)}`,
        {
          headers: { authorization: `Bearer ${options.internalServiceToken}` },
          signal: AbortSignal.timeout(3_000),
        },
      );
      if (!response.ok) return undefined;
      const body = (await response.json()) as { keyAuthorization?: unknown };
      return typeof body.keyAuthorization === 'string' ? body.keyAuthorization : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * `GET /.well-known/acme-challenge/:token` on the gateway itself, for when it is
 * the server the CA reaches on port 80. Public by nature: the CA is not signed in.
 */
export function registerAcmeChallengeRoute(app: Server, lookup: ChallengeLookup): void {
  app.get(
    `${ACME_CHALLENGE_PREFIX}:token`,
    {
      config: { public: true },
      schema: { params: Type.Object({ token: Type.String({ minLength: 1, maxLength: 200 }) }) },
    },
    async (request, reply) => {
      const answer = await lookup(request.params.token);
      if (answer === undefined) throw ProblemError.notFound('No such challenge.');
      return reply
        .type('text/plain; charset=utf-8')
        .header('cache-control', 'no-store')
        .send(answer);
    },
  );
}
