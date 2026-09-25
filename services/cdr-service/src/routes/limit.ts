import { ProblemError, Type } from '@cuc/http';

/**
 * A page size arrives in the query string, and the server does not coerce query
 * types (`@cuc/http` sets `coerceTypes: false`), so a `Type.Number` would refuse
 * every real request ("must be number"). It is a digit string, checked here.
 */
export const LimitQuerySchema = Type.String({ pattern: '^[0-9]{1,3}$' });

/** The page size to use, or a 400 when it is outside 1 to 200. */
export function parseLimit(value: string): number {
  const limit = Number(value);
  if (limit < 1 || limit > 200) {
    throw ProblemError.badRequest('limit must be between 1 and 200.', { code: 'invalid_limit' });
  }
  return limit;
}
