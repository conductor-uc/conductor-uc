import { ProblemError, Type, type Server } from '@cuc/http';

import { StepUpBodyFields, type StepUp } from '../auth/step-up.js';
import type { SecuritySettings, SecuritySettingsRepo } from '../repo/security-settings.repo.js';

const SettingsSchema = Type.Object({
  /** Whether the master org's users must set up two-step verification at sign-in. */
  requireMasterMfa: Type.Boolean(),
  updatedAt: Type.Union([Type.String(), Type.Null()]),
});

const SaveBodySchema = Type.Object({
  requireMasterMfa: Type.Boolean(),
  ...StepUpBodyFields,
});

function toResponse(settings: SecuritySettings) {
  return {
    requireMasterMfa: settings.requireMasterMfa,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
  };
}

/**
 * The platform's sign-in policy, in the console (D-012 as amended 2026-09-28).
 * A fresh install does not require the master's users to set up two-step
 * verification, so the platform can be configured first; an administrator
 * turns it on here once it is. Reseller users are required regardless.
 *
 * Turning it on needs nothing more: master users who have not enrolled are
 * asked to at their next sign-in, and their sessions stop refreshing. Turning
 * it off weakens every master sign-in, so it takes a step-up code (G-100): a
 * stolen session alone cannot do it.
 */
export function registerSecuritySettingsRoutes(
  app: Server,
  settings: SecuritySettingsRepo,
  stepUp: StepUp,
): void {
  function requireMaster(orgType: string | undefined): void {
    if (orgType !== 'master') {
      throw ProblemError.forbidden(
        "Only the platform operator can see or change the platform's sign-in settings.",
        { code: 'security_settings_master_only' },
      );
    }
  }

  app.get(
    '/v1/platform/security-settings',
    {
      config: { permission: 'platform.observe', dataClass: 'config' },
      schema: { response: { 200: SettingsSchema } },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      return toResponse(await settings.get());
    },
  );

  app.put(
    '/v1/platform/security-settings',
    {
      config: { permission: 'platform.operate', dataClass: 'config' },
      schema: { body: SaveBodySchema, response: { 200: SettingsSchema } },
    },
    async (request) => {
      requireMaster(request.context.orgType);
      const { actorId, orgId } = request.context;
      if (actorId === undefined || orgId === undefined) {
        throw ProblemError.unauthorized('Sign in to continue.', { code: 'sign_in_required' });
      }

      const current = await settings.get();
      const { requireMasterMfa } = request.body;
      if (current.requireMasterMfa === requireMasterMfa) return toResponse(current);
      if (!requireMasterMfa) {
        await stepUp.require(request, {
          action: 'platform.security_settings.updated',
          targetOrgId: orgId,
        });
      }

      return toResponse(
        await settings.save({ ...request.context, actorId, orgId }, { requireMasterMfa }),
      );
    },
  );
}
