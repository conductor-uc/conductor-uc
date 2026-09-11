import { describe, expect, it } from 'vitest';

import { packageName } from '../src/index.js';

describe('packageName', () => {
  it('identifies the example package', () => {
    expect(packageName()).toBe('@cuc/example');
  });
});
