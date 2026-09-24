import { verifyPassword } from '../domain/password.js';
import type { UserRepo } from '../repo/user.repo.js';

/**
 * Sign-in at a reseller's console finds people by email across the reseller
 * and all its tenants, and the password tells apart an address that exists in
 * more than one (G-56, G-61). Two accounts with the same email *and* the same
 * password cannot be told apart, so the second is refused rather than made
 * unable to sign in without naming an org.
 *
 * Only a password that already opens the other account trips this, so it
 * tells the caller nothing they could not do by signing in as that account.
 */
export class PasswordInUseError extends Error {
  override readonly name = 'PasswordInUseError';

  constructor() {
    super(
      'That password already signs in to another account with this email address. Choose a different password.',
    );
  }
}

/** Most other accounts checked, matching the sign-in cap. */
const MAX_CHECKED = 25;

/**
 * Throws [PasswordInUseError] when [password] opens another active account
 * that shares [email] under the same sign-in scope as [org]. [exceptUserId] is
 * the account whose password is being set, if it exists already.
 */
export async function assertPasswordDistinct(
  users: Pick<UserRepo, 'findByScopeAndEmail'>,
  org: {
    readonly orgId: string;
    readonly orgType: 'master' | 'reseller' | 'tenant';
    readonly resellerId: string | null;
  },
  email: string,
  password: string,
  exceptUserId?: string,
): Promise<void> {
  // A tenant user signs in at their reseller's console, so that is the scope
  // that must keep them distinct; the master's console reaches only its own.
  const scope =
    org.orgType === 'tenant'
      ? org.resellerId === null
        ? undefined
        : ({ orgId: org.resellerId, type: 'reseller' } as const)
      : ({ orgId: org.orgId, type: org.orgType } as const);
  if (scope === undefined) return;

  const others = (await users.findByScopeAndEmail(scope, email))
    .filter((u) => u.status === 'active' && u.id !== exceptUserId)
    .slice(0, MAX_CHECKED);
  for (const other of others) {
    if (await verifyPassword(other.passwordHash, password)) throw new PasswordInUseError();
  }
}
