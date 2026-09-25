import { parseArgs } from 'node:util';

export const ROTATE_SIGNING_KEY_USAGE = `Usage: rotate-signing-key [--revoke-previous]

Makes a new login-token signing key current now (G-116). The key it replaces
is retired: it signs nothing more but stays in the JWKS for
SIGNING_KEY_OVERLAP_DAYS, so access tokens it already signed keep working until
they expire. Every running copy of identity-service signs with the new key from
its next token on; no restart is needed. Automatic rotation
(SIGNING_KEY_ROTATION_DAYS) counts the new key's age from now.

Options:
  --revoke-previous  Also remove every retired key from the JWKS at once, the
                     one just replaced included. Use when a key may have
                     leaked. Access tokens signed before now stop verifying at
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
  readonly revokePrevious: boolean;
  readonly help: boolean;
}

/** Parses the command line. Throws on an unknown option or a stray argument. */
export function parseRotateSigningKeyArgs(argv: readonly string[]): RotateSigningKeyArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'revoke-previous': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return { revokePrevious: values['revoke-previous'], help: values.help };
}
