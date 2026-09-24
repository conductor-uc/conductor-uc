import * as acme from 'acme-client';

/** What the issuer needs to obtain one certificate. */
export interface IssueRequest {
  readonly fqdn: string;
  readonly directoryUrl: string;
  /** The address the ACME account is registered to. */
  readonly contactEmail: string;
  readonly accountKeyPem: string;
  /** Set once the account exists, so it is reused and not registered again. */
  readonly accountUrl: string | null;
  /** Publish the answer to an HTTP-01 challenge where the edge will serve it on port 80. */
  readonly publishChallenge: (token: string, keyAuthorization: string) => Promise<void>;
  readonly removeChallenge: (token: string) => Promise<void>;
}

export interface IssuedCertificate {
  /** The certificate and its chain, as PEM. */
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  /** The account's address at the ACME server, to keep for next time. */
  readonly accountUrl: string;
}

/**
 * Obtains certificates over ACME. A seam so the worker can be tested without a
 * CA, and so the one place that speaks to one is small.
 */
export interface AcmeIssuer {
  /** A new key for the ACME account. Made here so it never needs to leave this module unencrypted. */
  newAccountKey(): Promise<string>;
  issue(request: IssueRequest): Promise<IssuedCertificate>;
}

/**
 * The real issuer, on `acme-client`. Certificates use RSA 2048 rather than
 * elliptic-curve keys: it is what every desk phone's firmware can be counted on
 * to verify. The only challenge offered is HTTP-01, which is what the edge
 * serves on port 80 (G-105).
 */
export function createAcmeIssuer(): AcmeIssuer {
  return {
    async newAccountKey() {
      return (await acme.crypto.createPrivateKey()).toString('utf8');
    },

    async issue(request) {
      const client = new acme.Client({
        directoryUrl: request.directoryUrl,
        accountKey: request.accountKeyPem,
        ...(request.accountUrl === null ? {} : { accountUrl: request.accountUrl }),
      });
      const [privateKey, csr] = await acme.crypto.createCsr({
        commonName: request.fqdn,
        altNames: [request.fqdn],
      });
      const certificate = await client.auto({
        csr,
        email: request.contactEmail,
        // The worker only runs once someone has agreed to the terms in the console.
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        // The library would first fetch the challenge itself, from wherever this runs.
        // That is a private network more often than not, where the public name may not
        // reach the edge (or reaches it the wrong way round), so a healthy setup would fail
        // its own check. The CA's answer, which is what matters, says exactly why it
        // could not validate, and that message is what is recorded.
        skipChallengeVerification: true,
        challengeCreateFn: (_authz, challenge, keyAuthorization) =>
          request.publishChallenge(challenge.token, keyAuthorization),
        challengeRemoveFn: (_authz, challenge) => request.removeChallenge(challenge.token),
      });
      return {
        certificatePem: certificate,
        privateKeyPem: privateKey.toString('utf8'),
        accountUrl: client.getAccountUrl(),
      };
    },
  };
}
