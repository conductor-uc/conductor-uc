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
                     minutes). People are not signed out: the console gets a
                     new access token with its refresh cookie. Someone midway
                     through a two-step sign-in starts it again.
  --help             Show this text.

Reads the same settings as identity-service (database, CRYPTO_KEKS, ...), so
run it with that service's environment, e.g. in its container:
  node dist/src/cli/rotate-signing-key.js --revoke-previous
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
