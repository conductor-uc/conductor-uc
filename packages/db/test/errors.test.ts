import { describe, expect, it } from 'vitest';

import { isDuplicateKeyError } from '../src/errors.js';

describe('isDuplicateKeyError', () => {
  it('recognizes the MariaDB duplicate-entry code', () => {
    expect(isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true);
  });

  it('recognizes the MariaDB duplicate-entry errno', () => {
    expect(isDuplicateKeyError({ errno: 1062 })).toBe(true);
  });

  it('rejects an unrelated error', () => {
    expect(isDuplicateKeyError({ code: 'ER_ACCESS_DENIED_ERROR' })).toBe(false);
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
  });

  it('rejects non-error values without throwing', () => {
    expect(isDuplicateKeyError(undefined)).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
    expect(isDuplicateKeyError('a string')).toBe(false);
    expect(isDuplicateKeyError(42)).toBe(false);
  });

  it('walks error.cause, since Kysely wraps driver errors', () => {
    const driverError = { code: 'ER_DUP_ENTRY' };
    const wrapped = new Error('insert failed', { cause: driverError });

    expect(isDuplicateKeyError(wrapped)).toBe(true);
  });

  it('walks multiple levels of cause', () => {
    const driverError = { errno: 1062 };
    const wrapped = new Error('outer', { cause: new Error('inner', { cause: driverError }) });

    expect(isDuplicateKeyError(wrapped)).toBe(true);
  });

  it('does not loop forever on a cause that is not present', () => {
    expect(isDuplicateKeyError(new Error('plain'))).toBe(false);
  });
});
