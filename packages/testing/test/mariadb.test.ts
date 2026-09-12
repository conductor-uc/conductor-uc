import { describe, expect, it } from 'vitest';

import { DATABASE_URL_ENV, REQUIRE_DB_ENV, parseDatabaseUrl } from '../src/mariadb.js';

describe('parseDatabaseUrl', () => {
  it('reads host, port, user, and password', () => {
    expect(parseDatabaseUrl('mysql://svc:s3cret@db.internal:3307')).toEqual({
      host: 'db.internal',
      port: 3307,
      user: 'svc',
      password: 's3cret',
    });
  });

  it('defaults the port to 3306', () => {
    expect(parseDatabaseUrl('mysql://root@127.0.0.1').port).toBe(3306);
  });

  it('defaults the user to root', () => {
    expect(parseDatabaseUrl('mysql://127.0.0.1:3306').user).toBe('root');
  });

  it('decodes a percent-encoded password', () => {
    expect(parseDatabaseUrl('mysql://svc:p%40ss%3Aword@127.0.0.1').password).toBe('p@ss:word');
  });

  it('ignores any path, because the schema is created per test', () => {
    expect(parseDatabaseUrl('mysql://root@127.0.0.1:3306/ignored').host).toBe('127.0.0.1');
  });
});

describe('environment contract', () => {
  it('names the variables the documentation refers to', () => {
    expect(DATABASE_URL_ENV).toBe('TEST_DATABASE_URL');
    expect(REQUIRE_DB_ENV).toBe('REQUIRE_DB_TESTS');
  });
});
