import { publishAuditEvent } from '@cuc/audit';
import type { Bus } from '@cuc/events';
import { clientIpOf, ProblemError, Type, type Server } from '@cuc/http';

import type { TermsLookup } from '../acme-terms.js';
import { InvalidContactEmailError } from '../domain/acme.js';
import type { AcmeSettings, AcmeSettingsRepo } from '../repo/acme-settings.repo.js';

const nullableString = Type.Union([Type.String(), Type.Null()]);

const SettingsSchema = Type.Object({
  contactEmail: nullableString,
  directory: Type.Union([Type.Literal('production'), Type.Literal('staging')]),
  /** The subscriber agreement to show, so a person can read what they are agreeing to. */
  termsUrl: Type.String(),
  termsAgreed: Type.Boolean(),
  termsAgreedAt: nullableString,
  /** Whether certificates will be requested: an address is saved and the terms are agreed. */
  ready: Type.Boolean(),
});

const SaveBodySchema = Type.Object({
  contactEmail: Type.Union([Type.String({ maxLength: 254 }), Type.Null()]),
  directory: Type.Union([Type.Literal('production'), Type.Literal('staging')]),
  agreeToTerms: Type.Boolean(),
});

function toResponse(settings: AcmeSettings, currentTermsUrl: string) {
  return {
    contactEmail: settings.contactEmail,
    directory: settings.directory,
    termsUrl: settings.termsUrl ?? currentTermsUrl,
    termsAgreed: settings.termsAgreed,
    termsAgreedAt: settings.termsAgreedAt?.toISOString() ?? null,
    ready: settings.ready,
  };
}

/**
 * The platform's Let's Encrypt settings, in the console (G-105): the address the
 * account is registered to, which Let's Encrypt, and the agreement to its terms.
 * The platform operator's alone, since it is one account for everything.
 */
export function registerAcmeSettingsRoutes(
  app: Server,
  settings: AcmeSettingsRepo,
  terms: TermsLookup,
  bus: Bus,
): void {
  function requireMaster(orgType: string | undefined): void {
    if (orgType !== 'master') {
      throw ProblemError.forbidden(
        "Only the platform operator can see or change the platform's certificate settings.",
      );
    }
  }

  app.get(
    '/v1/platform/acme-settings',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { response: { 200: SettingsSchema } },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      const current = await settings.get();
      return toResponse(current, await terms.termsUrl(current.directory));
    },
  );

  app.put(
    '/v1/platform/acme-settings',
    {
      config: { permission: 'domain.manage', dataClass: 'config' },
      schema: { body: SaveBodySchema, response: { 200: SettingsSchema } },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      const { actorId, actorType, orgId } = request.context;
      if (actorId === undefined || actorType === undefined || orgId === undefined) {
        throw ProblemError.unauthorized(
          'An identified actor is required to change these settings.',
        );
      }

      const termsUrl = await terms.termsUrl(request.body.directory);
      let saved: AcmeSettings;
      try {
        saved = await settings.save({
          contactEmail: request.body.contactEmail,
          directory: request.body.directory,
          agreeToTerms: request.body.agreeToTerms,
          termsUrl,
          actorId,
        });
      } catch (error) {
        if (error instanceof InvalidContactEmailError) {
          throw ProblemError.badRequest(error.message, { code: 'invalid_contact_email' });
        }
        throw error;
      }

      await publishAuditEvent(bus, {
        actorType,
        actorId,
        actorOrgId: orgId,
        action: 'platform.acme_settings.updated',
        resource: `${saved.directory}:${saved.termsAgreed ? 'terms-agreed' : 'terms-not-agreed'}`,
        dataClass: 'config',
        ip: clientIpOf(request),
        requestId: request.context.requestId,
      });

      return toResponse(saved, termsUrl);
    },
  );
}
