import { describe, expect, it } from 'vitest';

import { createSerialQueue } from '../src/serial.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSerialQueue', () => {
  it('runs one key in order, even when an earlier task is slower', async () => {
    const done: string[] = [];
    const run = createSerialQueue(() => undefined);
    run('fs-1', async () => {
      await tick(30);
      done.push('create');
    });
    run('fs-1', () => {
      done.push('answer');
      return Promise.resolve();
    });
    run('fs-1', async () => {
      await tick(5);
      done.push('hangup');
    });
    await tick(80);
    expect(done).toEqual(['create', 'answer', 'hangup']);
  });

  it('runs different keys side by side', async () => {
    const done: string[] = [];
    const run = createSerialQueue(() => undefined);
    run('fs-1', async () => {
      await tick(40);
      done.push('fs-1');
    });
    run('fs-2', () => {
      done.push('fs-2');
      return Promise.resolve();
    });
    await tick(80);
    expect(done).toEqual(['fs-2', 'fs-1']);
  });

  it('reports a failed task and carries on with the next', async () => {
    const errors: unknown[] = [];
    const done: string[] = [];
    const run = createSerialQueue((key, error) => errors.push([key, (error as Error).message]));
    run('fs-1', () => Promise.reject(new Error('db down')));
    run('fs-1', () => {
      done.push('next');
      return Promise.resolve();
    });
    await tick(20);
    expect(errors).toEqual([['fs-1', 'db down']]);
    expect(done).toEqual(['next']);
  });
});
