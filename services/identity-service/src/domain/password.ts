import { hash, verify } from '@node-rs/argon2';

/**
 * Password policy and hashing (07 §1: argon2id).
 *
 * Hashing is not a pure function — it calls into native code and consumes
 * real randomness — but it lives here rather than in `repo/` because it is a
 * business rule (how a password must be judged and stored), not data access.
 */

const MIN_LENGTH = 12;
const MAX_LENGTH = 256;

export class WeakPasswordError extends Error {
  override readonly name = 'WeakPasswordError';
}

/**
 * The only policy enforced today: a length floor. 07 does not specify a
 * complexity policy beyond "argon2id hashing", and inventing character-class
 * rules here would be a decision this codebase has not made — a real policy
 * (breach-list checks, entropy estimation) is a `docs/decisions.md` candidate,
 * not something to bake in silently.
 */
export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_LENGTH) {
    throw new WeakPasswordError(`Password must be at least ${String(MIN_LENGTH)} characters.`);
  }
  if (password.length > MAX_LENGTH) {
    throw new WeakPasswordError(`Password must be at most ${String(MAX_LENGTH)} characters.`);
  }
}

/** Argon2id hash, using the library's own tuned defaults. */
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Constant-time-equivalent verification (argon2's own verify does this; there
 * is no separate `secretEquals` step needed here, unlike comparing a decrypted
 * secret directly).
 */
export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
