import { Secret, TOTP } from 'otpauth';

/**
 * TOTP enrollment and verification (07 §1). Wraps `otpauth`; not pure, since
 * secret generation consumes real randomness, but it is a business rule about
 * how a factor is set up and checked, so it lives in `domain/` rather than
 * `repo/`.
 */

const ALGORITHM = 'SHA1';
const DIGITS = 6;
const PERIOD = 30;
/** One period of clock drift tolerated on either side of "now". */
const VERIFY_WINDOW = 1;

/** A freshly generated secret, in the two forms callers need. */
export interface NewTotpSecret {
  /** For storage: envelope-encrypt this before it reaches a row. */
  readonly base32: string;
  /** For enrollment: render this as a QR code, or let the user type it in. */
  readonly otpauthUri: string;
}

/**
 * Generates a new TOTP secret and its enrollment URI.
 *
 * `issuer` is the org's own display name, never a fixed product name — it is
 * what an authenticator app shows the user, and no operator or codebase name
 * belongs on that screen (02 §5.2). `accountLabel` is the user's email.
 */
export function generateTotpSecret(issuer: string, accountLabel: string): NewTotpSecret {
  const secret = new Secret({ size: 20 });
  const totp = buildTotp(secret, issuer, accountLabel);
  return { base32: secret.base32, otpauthUri: totp.toString() };
}

/**
 * Checks a 6-digit code against a stored base32 secret.
 *
 * Returns whether it matched within one period of drift. The `otpauth`
 * library's own `validate` does the constant-ish time comparison, and it also
 * quietly rejects malformed input rather than throwing, which is what a
 * user-supplied code needs.
 */
export function verifyTotpCode(secretBase32: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;

  const totp = buildTotp(Secret.fromBase32(secretBase32), 'verify', 'verify');
  return totp.validate({ token: code, window: VERIFY_WINDOW }) !== null;
}

function buildTotp(secret: Secret, issuer: string, label: string): TOTP {
  return new TOTP({
    issuer,
    label,
    algorithm: ALGORITHM,
    digits: DIGITS,
    period: PERIOD,
    secret,
  });
}
