import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import {
  BootstrapAdminError,
  bootstrapMaster,
  BootstrapUsageError,
  readAdminPassword,
  validateAdmin,
  type PasswordInput,
} from '../src/bootstrap-master.js';
import {
  AdminUserCreationError,
  AdminUserEmailTakenError,
  OrgHasUsersError,
  type AdminUserCreator,
} from '../src/identity-client.js';
import { MasterAlreadyExistsError, type Org, type OrgRepo } from '../src/repo/org.repo.js';

const MASTER: Org = {
  id: 'master-1',
  type: 'master',
  parentId: null,
  resellerId: null,
  slug: 'master',
  name: 'Master',
  status: 'active',
  timezone: 'UTC',
  country: 'US',
  limits: {},
};

const ADMIN = {
  email: 'ops@example.net',
  displayName: 'Platform administrator',
  password: 'correct horse battery staple',
};

/** An org repo that has the master already, or creates it on first call. */
function fakeRepo(existing: boolean): Pick<OrgRepo, 'createMaster' | 'findMaster'> & {
  createMaster: ReturnType<typeof vi.fn>;
} {
  let exists = existing;
  return {
    createMaster: vi.fn(() => {
      if (exists) return Promise.reject(new MasterAlreadyExistsError());
      exists = true;
      return Promise.resolve(MASTER);
    }),
    findMaster: () => Promise.resolve(exists ? MASTER : undefined),
  };
}

function creator(impl: AdminUserCreator): AdminUserCreator & ReturnType<typeof vi.fn> {
  return vi.fn(impl);
}

describe('bootstrapMaster', () => {
  it('creates the master and, when asked, its first administrator as a master user', async () => {
    const repo = fakeRepo(false);
    const createAdminUser = creator(() => Promise.resolve({ id: 'u-1', email: ADMIN.email }));

    const result = await bootstrapMaster(
      { repo, createAdminUser },
      { slug: 'master', name: 'Master', admin: ADMIN },
    );

    expect(result).toEqual({
      orgId: 'master-1',
      masterCreated: true,
      admin: { status: 'created', userId: 'u-1' },
    });
    expect(repo.createMaster).toHaveBeenCalledWith({ slug: 'master', name: 'Master' });
    expect(createAdminUser).toHaveBeenCalledWith({
      orgId: 'master-1',
      orgType: 'master',
      resellerId: null,
      email: ADMIN.email,
      displayName: ADMIN.displayName,
      password: ADMIN.password,
      firstUserOnly: true,
    });
  });

  it('creates only the org without --admin-email, and never calls identity-service', async () => {
    const createAdminUser = creator(() => Promise.reject(new Error('must not be called')));

    const result = await bootstrapMaster(
      { repo: fakeRepo(false), createAdminUser },
      { slug: 'master', name: 'Master' },
    );

    expect(result).toEqual({
      orgId: 'master-1',
      masterCreated: true,
      admin: { status: 'not_requested' },
    });
    expect(createAdminUser).not.toHaveBeenCalled();
  });

  it('re-run: keeps the existing master and creates its administrator if it has none', async () => {
    const createAdminUser = creator(() => Promise.resolve({ id: 'u-2', email: ADMIN.email }));

    const result = await bootstrapMaster(
      { repo: fakeRepo(true), createAdminUser },
      { slug: 'master', name: 'Master', admin: ADMIN },
    );

    expect(result).toEqual({
      orgId: 'master-1',
      masterCreated: false,
      admin: { status: 'created', userId: 'u-2' },
    });
  });

  it('re-run: a master that already has users is a no-op, whatever email is given', async () => {
    for (const error of [new OrgHasUsersError('has users'), new AdminUserEmailTakenError('dup')]) {
      const result = await bootstrapMaster(
        { repo: fakeRepo(true), createAdminUser: creator(() => Promise.reject(error)) },
        { slug: 'master', name: 'Master', admin: { ...ADMIN, email: 'someone-else@example.net' } },
      );

      expect(result).toEqual({
        orgId: 'master-1',
        masterCreated: false,
        admin: { status: 'already_present' },
      });
    }
  });

  it('fails with the org id when identity-service cannot create the administrator', async () => {
    const createAdminUser = creator(() =>
      Promise.reject(new AdminUserCreationError('Could not reach identity-service: refused')),
    );

    const failure = bootstrapMaster(
      { repo: fakeRepo(false), createAdminUser },
      { slug: 'master', name: 'Master', admin: ADMIN },
    );

    await expect(failure).rejects.toBeInstanceOf(BootstrapAdminError);
    await expect(failure).rejects.toMatchObject({ orgId: 'master-1' });
    await expect(failure).rejects.toThrow(/run the same command again/);
    await expect(failure).rejects.not.toThrow(ADMIN.password);
  });

  it('passes through a database error that is not "master already exists"', async () => {
    const repo = {
      createMaster: () => Promise.reject(new Error('db down')),
      findMaster: () => Promise.resolve(undefined),
    };

    await expect(
      bootstrapMaster(
        { repo, createAdminUser: creator(() => Promise.reject(new Error('unused'))) },
        { slug: 'master', name: 'Master', admin: ADMIN },
      ),
    ).rejects.toThrow('db down');
  });
});

describe('validateAdmin', () => {
  it('trims the email and name but keeps the password exactly', () => {
    expect(
      validateAdmin({
        email: ' ops@example.net ',
        displayName: ' Ops ',
        password: ' twelve chars ',
      }),
    ).toEqual({ email: 'ops@example.net', displayName: 'Ops', password: ' twelve chars ' });
  });

  it('refuses a password shorter than identity-service accepts, with a clear message', () => {
    expect(() => validateAdmin({ ...ADMIN, password: 'short' })).toThrow(
      new BootstrapUsageError("The administrator's password must be at least 12 characters."),
    );
    expect(() => validateAdmin({ ...ADMIN, password: 'x'.repeat(12) })).not.toThrow();
  });

  it('refuses something that is not an email address, and an empty name', () => {
    expect(() => validateAdmin({ ...ADMIN, email: 'not-an-email' })).toThrow(BootstrapUsageError);
    expect(() => validateAdmin({ ...ADMIN, displayName: '   ' })).toThrow(BootstrapUsageError);
  });
});

describe('readAdminPassword', () => {
  function pipedStdin(text: string | undefined): PassThrough {
    const stream = new PassThrough();
    if (text !== undefined) stream.end(text);
    return stream;
  }

  it('prefers BOOTSTRAP_ADMIN_PASSWORD and leaves stdin alone', async () => {
    const stdin = pipedStdin(undefined);
    const read = vi.spyOn(stdin, 'read');

    await expect(
      readAdminPassword({
        env: { BOOTSTRAP_ADMIN_PASSWORD: 'from the environment' },
        stdin,
        prompt: new PassThrough(),
      }),
    ).resolves.toBe('from the environment');
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the first line of piped stdin, without the line ending', async () => {
    await expect(
      readAdminPassword({
        env: { BOOTSTRAP_ADMIN_PASSWORD: '' },
        stdin: pipedStdin('first line pw\r\nsecond line\n'),
        prompt: new PassThrough(),
      }),
    ).resolves.toBe('first line pw');
  });

  it('refuses empty input with a message naming both sources', async () => {
    await expect(
      readAdminPassword({ env: {}, stdin: pipedStdin(''), prompt: new PassThrough() }),
    ).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD.*standard input/);
  });

  it('on a terminal, prompts twice without echo and handles backspace', async () => {
    const stdin = new PassThrough() as PassThrough & PasswordInput & { isTTY: boolean };
    stdin.isTTY = true;
    const rawModes: boolean[] = [];
    stdin.setRawMode = (mode: boolean) => rawModes.push(mode);
    const prompt = new PassThrough();
    let shown = '';
    prompt.on('data', (chunk: Buffer) => (shown += chunk.toString()));

    const password = readAdminPassword({ env: {}, stdin, prompt });
    stdin.write('long enough passwordX\u007f\r');
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('long enough password\r');

    await expect(password).resolves.toBe('long enough password');
    expect(rawModes).toEqual([true, false, true, false]);
    expect(shown).toContain('Administrator password: ');
    expect(shown).toContain('Repeat the password: ');
    expect(shown).not.toContain('long enough');
  });

  it('on a terminal, refuses two different entries', async () => {
    const stdin = new PassThrough() as PassThrough & PasswordInput & { isTTY: boolean };
    stdin.isTTY = true;
    stdin.setRawMode = () => undefined;

    const password = readAdminPassword({ env: {}, stdin, prompt: new PassThrough() });
    stdin.write('first password here\r');
    await new Promise((resolve) => setImmediate(resolve));
    stdin.write('second password here\r');

    await expect(password).rejects.toThrow('The two passwords do not match.');
  });
});
