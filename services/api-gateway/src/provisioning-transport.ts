import { ProblemError, type Server } from '@cuc/http';

/** The public route a desk phone fetches its settings from (pbx-config-service). */
export const PROVISIONING_PREFIX = '/v1/public/provision/';

/**
 * Refuses to serve provisioning over plain HTTP. The file a phone gets holds
 * the extension's SIP password and its request holds the platform's
 * credentials, so an unencrypted fetch would put both on the wire. A phone told
 * an `http://` address gets a clear refusal instead of working insecurely.
 *
 * "Plain" is what the gateway sees: the connection itself, or the
 * `X-Forwarded-Proto` a trusted load balancer sets when it terminates TLS.
 */
export function registerProvisioningTransport(
  app: Server,
  options: { readonly requireHttps: boolean },
): void {
  if (!options.requireHttps) return;
  app.addHook('onRequest', (request, _reply, done) => {
    if (!request.url.startsWith(PROVISIONING_PREFIX) || request.protocol === 'https') {
      done();
      return;
    }
    done(
      ProblemError.forbidden(
        'Phone provisioning is only served over HTTPS. Use an https:// address.',
        { code: 'https_required' },
      ),
    );
  });
}
