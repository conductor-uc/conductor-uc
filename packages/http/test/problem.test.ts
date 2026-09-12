import { describe, expect, it } from 'vitest';

import { ProblemError, type Problem } from '../src/problem.js';
import { Type } from 'typebox';
import { testServer } from './helpers.js';

const contract = { permission: 'extension.manage', dataClass: 'config' } as const;

describe('problem+json responses', () => {
  it('serves validation failures as problem+json with field errors', async () => {
    const app = await testServer();
    app.post(
      '/v1/extensions',
      {
        config: contract,
        schema: {
          body: Type.Object({
            name: Type.String({ minLength: 1 }),
            number: Type.Integer(),
          }),
        },
      },
      () => ({ ok: true }),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/extensions',
      payload: { number: 'not-a-number' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      type: '/problems/validation',
      title: 'Request validation failed',
      status: 400,
      code: 'validation_failed',
      instance: '/v1/extensions',
    });
    expect(response.json<Problem>().errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: '/name' }),
        expect.objectContaining({ field: '/number' }),
      ]),
    );
  });

  it('reports every field at once rather than the first', async () => {
    const app = await testServer();
    app.post(
      '/v1/x',
      { config: contract, schema: { body: Type.Object({ a: Type.String(), b: Type.String() }) } },
      () => ({}),
    );
    await app.ready();

    const response = await app.inject({ method: 'POST', url: '/v1/x', payload: {} });

    expect(response.json<Problem>().errors).toHaveLength(2);
  });

  it('never echoes the rejected value, because bodies carry credentials', async () => {
    const app = await testServer();
    app.post(
      '/v1/x',
      {
        config: contract,
        schema: { body: Type.Object({ password: Type.String({ minLength: 12 }) }) },
      },
      () => ({}),
    );
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/x',
      payload: { password: 'hunter2' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain('hunter2');
  });

  it('uses a path for type, never a product domain', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/missing' });

    expect(response.json<Problem>().type).toBe('/problems/not-found');
    expect(response.json<Problem>().type).not.toMatch(/^https?:/);
  });

  it('turns a thrown ProblemError into its document', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: contract }, () => {
      throw ProblemError.conflict('That extension number is already assigned.', {
        code: 'extension_number_taken',
      });
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      type: '/problems/conflict',
      title: 'Conflict',
      status: 409,
      code: 'extension_number_taken',
      detail: 'That extension number is already assigned.',
    });
  });

  it('hides internals behind a generic 500', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: contract }, () => {
      throw new Error('connect ECONNREFUSED 10.0.0.5:3306 user=root password=hunter2');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.json()).toMatchObject({
      type: '/problems/internal',
      status: 500,
      code: 'internal_error',
      detail: 'The request could not be completed.',
    });
  });

  it('logs the 500 it hid, with the request id', async () => {
    const { captureLogger } = await import('./helpers.js');
    const { lines, logger } = captureLogger();
    const app = await testServer({ logger });
    app.get('/v1/x', { config: contract }, () => {
      throw new Error('the real cause');
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/v1/x', headers: { 'x-request-id': 'r-1' } });

    const logged = lines.find((line) => line['msg'] === 'request failed');
    expect(logged).toBeDefined();
    expect(logged!['requestId']).toBe('r-1');
    expect(JSON.stringify(logged)).toContain('the real cause');
  });

  it('carries the request id on the problem so a report maps to a log line', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/missing',
      headers: { 'x-request-id': 'r-2' },
    });

    expect(response.json<Problem>().requestId).toBe('r-2');
  });
});

describe('ProblemError', () => {
  it('builds documents for the common statuses', () => {
    expect(ProblemError.unauthorized().toProblem()).toMatchObject({
      status: 401,
      code: 'unauthorized',
    });
    expect(ProblemError.forbidden().toProblem()).toMatchObject({ status: 403, code: 'forbidden' });
    expect(ProblemError.notFound().toProblem()).toMatchObject({ status: 404, code: 'not_found' });
    expect(ProblemError.preconditionRequired().toProblem()).toMatchObject({ status: 428 });
    expect(ProblemError.rateLimited().toProblem()).toMatchObject({ status: 429 });
    expect(ProblemError.unavailable().toProblem()).toMatchObject({ status: 503 });
  });

  it('omits detail when it would only repeat the title', () => {
    expect(ProblemError.notFound().toProblem()).not.toHaveProperty('detail');
    expect(ProblemError.notFound('No such tenant.').toProblem()).toMatchObject({
      detail: 'No such tenant.',
    });
  });
});
