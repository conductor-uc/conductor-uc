import type { DbContext } from '@cuc/db';
import { ProblemError, Type, type Server } from '@cuc/http';

import {
  parseBasicAuth,
  parseYealinkFile,
  renderYealinkCommonConfig,
  renderYealinkConfig,
  tokenMatches,
} from '../domain/provisioning.js';
import type { TenantDomainLookup } from '../org-client.js';
import type { DeviceRepo } from '../repo/device.repo.js';
import type { ExtensionRepo } from '../repo/extension.repo.js';
import type { SipEdgeConfig } from './sip-endpoint.routes.js';

const ParamsSchema = Type.Object({ file: Type.String({ minLength: 1, maxLength: 128 }) });

/** Shown by a phone that is asked for credentials; says nothing about who runs the platform. */
const CHALLENGE = 'Basic realm="provisioning"';

/**
 * `GET /v1/public/provision/yealink/:file`: what a Yealink phone fetches to set
 * itself up. Public at the route contract because the phone has no session; it
 * authenticates with HTTP Basic (device id and provisioning password), and every
 * failure looks the same whether the device exists or not.
 *
 * The phone's own file (`<mac>.cfg`) is served only when its MAC matches the
 * authenticated device, so a leaked password cannot be used to pull another
 * phone's settings.
 */
export function registerProvisionRoutes(
  app: Server,
  devices: DeviceRepo,
  extensions: ExtensionRepo,
  primaryDomain: TenantDomainLookup,
  edge: SipEdgeConfig,
): void {
  app.get(
    '/v1/public/provision/yealink/:file',
    {
      config: { public: true },
      schema: { params: ParamsSchema },
    },
    async (request, reply) => {
      const denied = () =>
        reply
          .status(401)
          .header('www-authenticate', CHALLENGE)
          .type('text/plain; charset=utf-8')
          .send('Unauthorized\n');

      const credentials = parseBasicAuth(request.headers.authorization);
      if (credentials === undefined) return denied();
      const target = await devices.findProvisioningTarget(credentials.username);
      if (target === undefined || !tokenMatches(target.tokenHash, credentials.password)) {
        return denied();
      }

      const file = parseYealinkFile(request.params.file);
      if (file === undefined) throw ProblemError.notFound('No such file.');

      if (file.kind === 'common') {
        return reply.type('text/plain; charset=utf-8').send(renderYealinkCommonConfig());
      }
      if (file.mac !== target.mac) throw ProblemError.notFound('No such file.');

      const ctx: DbContext = { tenantId: target.tenantId };
      const extension = await extensions.findById(ctx, target.extensionId);
      if (extension === undefined) throw ProblemError.notFound('No such file.');
      const credential = await extensions.reveal(ctx, target.extensionId);
      const server = await primaryDomain(target.tenantId);
      if (server === undefined) {
        throw ProblemError.conflict(
          'This tenant has no domain yet, so there is nothing to register to.',
        );
      }

      const transport = edge.transports[0] ?? 'udp';
      await devices.recordFetch(ctx, target.id, {
        ...(request.ip === undefined ? {} : { ip: request.ip }),
        ...(typeof request.headers['user-agent'] === 'string'
          ? { userAgent: request.headers['user-agent'] }
          : {}),
      });

      return reply.type('text/plain; charset=utf-8').send(
        renderYealinkConfig({
          number: extension.number,
          displayName: extension.displayName,
          username: credential.username,
          password: credential.password,
          server,
          port: edge.port,
          transport,
        }),
      );
    },
  );
}
