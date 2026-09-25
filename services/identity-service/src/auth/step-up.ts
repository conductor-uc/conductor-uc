import { decryptString, type KekProvider } from '@cuc/crypto';
import { clientIpOf, ProblemError, Type, type RequestContext } from '@cuc/http';

import { matchTotpStep } from '../domain/totp.js';
import { mfaSecretAssociatedData, type MfaRepo } from '../repo/mfa.repo.js';

/**
 * Step-up confirmation (G-100): at the moment of a sensitive action, the
 * acting person proves they hold their own second factor by sending a current
 * code from their authenticator app. A stolen session (a token lifted from a
 * browser, a laptop left unlocked) is then not enough on its own to remove
 * someone's two-step verification, reveal a credential, or rotate a key.
 *
 * A route opts in by adding {@link StepUpBodyFields} to its body schema and
 * calling `stepUp.require(request, { action })` before it changes anything.
 * The code travels in the body as `stepUpCode`, never in a header or query
 * string, so it does not end up in access logs.
 *
 * Answers, as RFC 9457 problems:
 * - 401 `step_up_required`: no code was sent. The console asks for one.
 * - 401 `step_up_invalid`: the code is wrong, or its time step was already
 *   spent on a step-up (a replay). Audited.
 * - 403 `step_up_not_enrolled`: the actor has no confirmed authenticator of
 *   their own, so there is nothing to step up with, and the action is refused
 *   rather than allowed through. Master and reseller users always have one
 *   (they cannot sign in without it); a tenant user does not (D-012, O-17), so
 *   a tenant admin cannot take a step-up action until tenants can enrol.
 *   API keys and services are refused the same way: the confirmation is a
 *   person's.
 * - 429 `step_up_locked`: {@link STEP_UP_MAX_FAILURES} wrong codes within
 *   {@link STEP_UP_LOCKOUT_MS}. Every step-up action is refused until the
 *   window has passed since the last wrong code, even with a right one.
 *   Audited.
 *
 * Replay protection: each accepted code spends its TOTP time step, and only a
 * later step is accepted next time (`mfa_factors.last_step_up_step`), in one
 * conditional update so two racing requests cannot both use one code.
 * Sign-in verification does not record steps, so a code used to sign in can
 * still confirm one step-up in the same half minute, but never two.
 */

/** Wrong codes allowed within {@link STEP_UP_LOCKOUT_MS} before step-up is refused. */
export const STEP_UP_MAX_FAILURES = 5;
/** How long a run of wrong codes counts, and how long the lockout lasts after the last one. */
export const STEP_UP_LOCKOUT_MS = 15 * 60 * 1000;

/** Spread into a sensitive route's body schema: `Type.Object({ ...StepUpBodyFields, ... })`. */
export const StepUpBodyFields = {
  stepUpCode: Type.Optional(
    Type.String({
      maxLength: 16,
      description:
        'A current code from the acting person’s own authenticator app, confirming this action (G-100).',
    }),
  ),
};

/**
 * A route-level `preValidation` hook for a step-up route whose body holds
 * nothing else: a request with no body at all is read as `{}`, so it is
 * answered 401 `step_up_required` (and the console asks for a code) rather
 * than a 400 about the body's shape.
 */
export function missingBodyAsEmpty(request: { body: unknown }): Promise<void> {
  if (request.body === undefined || request.body === null) request.body = {};
  return Promise.resolve();
}

/** Which sensitive action is being confirmed, for the audit trail. */
export interface StepUpAction {
  /** The action as the audit trail names it, e.g. `user.mfa_reset`. */
  readonly action: string;
  /** The org the action is aimed at, so its trail records a failed attempt too. */
  readonly targetOrgId?: string;
}

export interface StepUp {
  /** Resolves when the request carries a valid, unspent code of the acting person's; otherwise throws a ProblemError. */
  require(
    request: { readonly context: RequestContext; readonly ip: string; readonly body?: unknown },
    action: StepUpAction,
  ): Promise<void>;
}

export interface StepUpOptions {
  readonly mfa: MfaRepo;
  readonly kek: KekProvider;
  /** For tests: the clock the code is checked against. */
  readonly now?: () => number;
}

export function createStepUp(options: StepUpOptions): StepUp {
  const { mfa, kek } = options;
  const now = options.now ?? Date.now;

  const notEnrolled = () =>
    ProblemError.forbidden(
      'This needs a code from your own authenticator app, and your account has no two-step verification set up.',
      { code: 'step_up_not_enrolled' },
    );

  return {
    async require(request, { action, targetOrgId }) {
      const { actorId, actorType, orgId: actorOrgId } = request.context;
      const code = codeFrom(request.body);
      if (actorType !== 'user' || actorId === undefined || actorOrgId === undefined) {
        throw notEnrolled();
      }

      const factor = await mfa.findStepUpFactor(actorId);
      if (factor === undefined) throw notEnrolled();

      if (code === undefined) {
        throw ProblemError.unauthorized(
          'Enter the current code from your authenticator app to confirm.',
          { code: 'step_up_required' },
        );
      }

      const failure = {
        actorId,
        actorOrgId,
        action,
        ...(targetOrgId === undefined ? {} : { targetOrgId }),
        requestId: request.context.requestId,
        ip: clientIpOf(request),
      };

      const at = now();
      const locked =
        factor.stepUpFailures >= STEP_UP_MAX_FAILURES &&
        factor.stepUpFailedAt !== null &&
        at - factor.stepUpFailedAt.getTime() < STEP_UP_LOCKOUT_MS;
      if (locked) {
        await mfa.recordStepUpFailure(factor.id, new Date(at), STEP_UP_LOCKOUT_MS, {
          ...failure,
          why: 'locked',
        });
        throw ProblemError.rateLimited('Too many wrong codes. Wait 15 minutes, then try again.', {
          code: 'step_up_locked',
        });
      }

      const secret = await decryptString(kek, factor.secretEnc, mfaSecretAssociatedData(actorId));
      const step = matchTotpStep(secret, code, at);
      const spent = step !== null && (await mfa.spendStepUpStep(factor.id, step));
      if (!spent) {
        await mfa.recordStepUpFailure(factor.id, new Date(at), STEP_UP_LOCKOUT_MS, {
          ...failure,
          why: step === null ? 'invalid_code' : 'replayed_code',
        });
        throw ProblemError.unauthorized(
          'That code is not right, or it was already used. Wait for the next code and try again.',
          { code: 'step_up_invalid' },
        );
      }
    },
  };
}

function codeFrom(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { stepUpCode?: unknown }).stepUpCode;
  if (typeof code !== 'string') return undefined;
  const trimmed = code.replace(/\s+/g, '');
  return trimmed === '' ? undefined : trimmed;
}
