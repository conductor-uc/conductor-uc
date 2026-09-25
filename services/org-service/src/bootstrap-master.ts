/**
 * What `cli/bootstrap-master.ts` does, kept apart from argument parsing,
 * config loading and the database so it can be tested with fakes (G-115).
 *
 * Creates the single master org and, when asked, its first administrator
 * through identity-service — the same internal call org-service makes for a
 * reseller's or tenant's first admin. Re-running is a no-op:
 *
 * - the master org is created once; afterwards the existing one is used;
 * - the administrator is created only while the master has no users at all
 *   (identity-service's `firstUserOnly`). Once anyone exists, a re-run with
 *   the same or a different email creates nobody and succeeds; further people
 *   are invited from the console.
 *
 * The org and its administrator live in two services' databases, so they
 * cannot be created in one transaction. If creating the administrator fails,
 * the master stays and the command fails; running it again creates only the
 * missing administrator.
 */
import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

import {
  AdminUserEmailTakenError,
  OrgHasUsersError,
  type AdminUserCreator,
} from './identity-client.js';
import { MasterAlreadyExistsError, type OrgRepo } from './repo/org.repo.js';

/** identity-service's own minimum (its admin-user body schema). */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/** The environment variable the administrator's password is read from. */
export const PASSWORD_ENV = 'BOOTSTRAP_ADMIN_PASSWORD';

/** Bad input: the CLI prints the message and exits 2. */
export class BootstrapUsageError extends Error {
  override readonly name = 'BootstrapUsageError';
}

/** The master exists but its administrator could not be created. */
export class BootstrapAdminError extends Error {
  override readonly name = 'BootstrapAdminError';

  constructor(
    readonly orgId: string,
    cause: unknown,
  ) {
    super(
      `The master org ${orgId} exists, but its administrator was not created: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        'Fix the cause and run the same command again; it creates only what is missing.',
    );
  }
}

export interface BootstrapAdmin {
  readonly email: string;
  readonly displayName: string;
  readonly password: string;
}

export interface BootstrapResult {
  readonly orgId: string;
  readonly masterCreated: boolean;
  readonly admin:
    | { readonly status: 'not_requested' }
    | { readonly status: 'created'; readonly userId: string }
    /** The master already has users, so nobody was created. */
    | { readonly status: 'already_present' };
}

export async function bootstrapMaster(
  deps: {
    readonly repo: Pick<OrgRepo, 'createMaster' | 'findMaster'>;
    readonly createAdminUser: AdminUserCreator;
  },
  input: { readonly slug: string; readonly name: string; readonly admin?: BootstrapAdmin },
): Promise<BootstrapResult> {
  let orgId: string;
  let masterCreated: boolean;
  try {
    orgId = (await deps.repo.createMaster({ slug: input.slug, name: input.name })).id;
    masterCreated = true;
  } catch (error) {
    if (!(error instanceof MasterAlreadyExistsError)) throw error;
    const existing = await deps.repo.findMaster();
    if (existing === undefined) throw error;
    orgId = existing.id;
    masterCreated = false;
  }

  if (input.admin === undefined)
    return { orgId, masterCreated, admin: { status: 'not_requested' } };

  try {
    const user = await deps.createAdminUser({
      orgId,
      orgType: 'master',
      resellerId: null,
      email: input.admin.email,
      displayName: input.admin.displayName,
      password: input.admin.password,
      firstUserOnly: true,
    });
    return { orgId, masterCreated, admin: { status: 'created', userId: user.id } };
  } catch (error) {
    // firstUserOnly means identity checks for existing users before the email,
    // so a taken email implies someone exists too: either way, nothing to do.
    if (error instanceof OrgHasUsersError || error instanceof AdminUserEmailTakenError) {
      return { orgId, masterCreated, admin: { status: 'already_present' } };
    }
    throw new BootstrapAdminError(orgId, error);
  }
}

/** Checks the administrator's details before anything is created. */
export function validateAdmin(admin: BootstrapAdmin): BootstrapAdmin {
  const email = admin.email.trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
    throw new BootstrapUsageError(`--admin-email '${admin.email}' is not an email address.`);
  }
  const displayName = admin.displayName.trim();
  if (displayName === '') throw new BootstrapUsageError('--admin-name must not be empty.');
  if ([...admin.password].length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new BootstrapUsageError(
      `The administrator's password must be at least ${String(MIN_ADMIN_PASSWORD_LENGTH)} characters.`,
    );
  }
  return { email, displayName, password: admin.password };
}

/** A terminal on standard input, as far as reading a password needs one. */
export interface PasswordInput extends Readable {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
}

/**
 * The administrator's password, never from argv (it would show in `ps` and
 * shell history):
 *
 * 1. `BOOTSTRAP_ADMIN_PASSWORD`, when set and not empty;
 * 2. otherwise, when standard input is a terminal, a prompt that does not
 *    echo, asked twice;
 * 3. otherwise the first line of standard input (`printf '%s\n' "$pw" | ...`).
 *
 * The password is used exactly as given, apart from the line ending.
 */
export async function readAdminPassword(io: {
  readonly env: Record<string, string | undefined>;
  readonly stdin: PasswordInput;
  /** Where prompts go: standard error, so standard output stays the log. */
  readonly prompt: Writable;
}): Promise<string> {
  const fromEnv = io.env[PASSWORD_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  if (io.stdin.isTTY === true && io.stdin.setRawMode !== undefined) {
    const first = await readHidden(io.stdin, io.prompt, 'Administrator password: ');
    if (first === '') throw new BootstrapUsageError('No password entered.');
    const second = await readHidden(io.stdin, io.prompt, 'Repeat the password: ');
    if (first !== second) throw new BootstrapUsageError('The two passwords do not match.');
    return first;
  }

  const line = await readFirstLine(io.stdin);
  if (line === undefined || line === '') {
    throw new BootstrapUsageError(
      `No password: set ${PASSWORD_ENV}, or give it as one line on standard input.`,
    );
  }
  return line;
}

async function readFirstLine(input: Readable): Promise<string | undefined> {
  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false });
  try {
    for await (const line of lines) return line;
    return undefined;
  } finally {
    lines.close();
  }
}

/** Reads one line in raw mode, echoing nothing. Ctrl-C and Ctrl-D cancel. */
function readHidden(input: PasswordInput, output: Writable, prompt: string): Promise<string> {
  output.write(prompt);
  input.setRawMode?.(true);
  input.setEncoding('utf8');
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = '';

    const finish = (): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
    };

    function onData(chunk: string | Buffer): void {
      for (const ch of chunk.toString()) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003' || ch === '\u0004') {
          finish();
          reject(new BootstrapUsageError('Cancelled.'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = [...value].slice(0, -1).join('');
          continue;
        }
        value += ch;
      }
    }

    input.on('data', onData);
  });
}
