import { parseArgs } from 'node:util';

import type { SigningKeyRepo } from '../repo/signing-key.repo.js';

export const ROTATE_SIGNING_KEY_USAGE = `Usage: rotate-signing-key [--now | --revoke-previous]

Rotates the login-token signing key (G-116).

By default the rotation is published ahead, like the automatic one: a new key
is added to the JWKS now and starts signing once it has been published for
SIGNING_KEY_PUBLISH_AHEAD_MINUTES (default 15), so every api-gateway has
fetched it first. identity-service promotes it by itself within a few minutes
after that period; running this command again after the period promotes it at
once. If a new key is already published, the command promotes it when its
period has passed and otherwise says when it will be.

The key it replaces is retired: it signs nothing more but stays in the JWKS for
SIGNING_KEY_OVERLAP_DAYS, so access tokens it already signed keep working until
they expire. No restart is needed.

Options:
  --now              Make a new key current immediately, skipping the
                     publish-ahead period. A gateway that fetched the JWKS
                     within the last JWKS_COOLDOWN_MS (default 30 s) can refuse
                     tokens signed with the new key until that time has passed.
  --revoke-previous  For a key that may have leaked. Implies --now, and also
                     removes every earlier key from the JWKS at once, the one
                     just replaced (and any key published ahead) included.
                     Access tokens signed before now stop verifying at
                     identity-service at once and at api-gateway when its key
                     cache refreshes (JWKS_CACHE_MAX_AGE_MS, default 10
                     minutes). Nobody has to sign in again (refresh cookies
                     are not affected), but an open console's requests fail
                     until its next scheduled token refresh (within the
                     access-token lifetime) or a page reload. Someone midway
                     through a two-step sign-in starts it again.
  --help             Show this text.

Reads the same settings as identity-service (database, CRYPTO_KEKS, ...), so
run it with that service's environment, for example:
  docker compose run --rm identity-service dist/src/cli/rotate-signing-key.js
`;

export interface RotateSigningKeyArgs {
  /** Skip publish-ahead: the new key signs at once. */
  readonly now: boolean;
  readonly revokePrevious: boolean;
  readonly help: boolean;
}

/**
 * Parses the command line. Throws on an unknown option or a stray argument.
 * `--revoke-previous` implies `--now`: a key that may have leaked must stop
 * signing at once, not after a publish-ahead period.
 */
export function parseRotateSigningKeyArgs(argv: readonly string[]): RotateSigningKeyArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      now: { type: 'boolean', default: false },
      'revoke-previous': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const revokePrevious = values['revoke-previous'];
  return { now: values.now || revokePrevious, revokePrevious, help: values.help };
}

/** What the command did, as the log line it prints. */
export interface RotateSigningKeyOutcome {
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

/**
 * Does what the arguments ask. Separate from the entry point so tests can run
 * it against a real repository without a process.
 */
export async function runRotateSigningKey(
  signingKeys: Pick<SigningKeyRepo, 'advance' | 'rotateNow'>,
  args: Pick<RotateSigningKeyArgs, 'now' | 'revokePrevious'>,
  settings: { readonly publishAheadMinutes: number; readonly overlapDays: number },
  now = new Date(),
): Promise<RotateSigningKeyOutcome> {
  if (args.now) {
    const result = await signingKeys.rotateNow({ revokePrevious: args.revokePrevious });
    return {
      fields: {
        previousKeyId: result.previousKeyId,
        keyId: result.current.id,
        revoked: result.revoked,
        overlapDays: settings.overlapDays,
      },
      message: args.revokePrevious
        ? 'signing key rotated now; every earlier key is revoked and gone from the JWKS'
        : 'signing key rotated now (no publish-ahead); the previous key stays in the JWKS for SIGNING_KEY_OVERLAP_DAYS',
    };
  }

  const step = await signingKeys.advance({
    stage: 'now',
    publishAheadMinutes: settings.publishAheadMinutes,
    now,
  });
  const promotesAfter = (publishedAt: Date) =>
    new Date(publishedAt.getTime() + settings.publishAheadMinutes * 60 * 1000).toISOString();

  switch (step.action) {
    case 'staged':
      return {
        fields: {
          currentKeyId: step.currentKeyId,
          nextKeyId: step.next.id,
          promotesAfter: promotesAfter(step.next.publishedAt),
        },
        message:
          'next signing key published; it starts signing after SIGNING_KEY_PUBLISH_AHEAD_MINUTES ' +
          '(identity-service promotes it by itself, or run this command again after promotesAfter)',
      };
    case 'waiting':
      return {
        fields: { nextKeyId: step.next.id, promotesAfter: promotesAfter(step.next.publishedAt) },
        message:
          'a next signing key is already published and not due yet; it starts signing after promotesAfter',
      };
    case 'promoted':
      return {
        fields: {
          previousKeyId: step.previousKeyId,
          keyId: step.currentKeyId,
          overlapDays: settings.overlapDays,
        },
        message:
          'published next key promoted: it signs from now; the previous key stays in the JWKS for SIGNING_KEY_OVERLAP_DAYS',
      };
    case 'none':
      return {
        fields: {},
        message: 'no current signing key yet: start identity-service once to create the first one',
      };
  }
}
