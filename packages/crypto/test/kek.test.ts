import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { fileKekFromConfig } from '../src/config.js';
import { DecryptionFailedError, InvalidKeyError, UnknownKeyVersionError } from '../src/errors.js';
import { FileKekProvider, KEK_BYTES, secretEquals, VaultTransitKekProvider } from '../src/kek.js';

const KEY_1 = randomBytes(KEK_BYTES);
const KEY_2 = randomBytes(KEK_BYTES);

describe('FileKekProvider', () => {
  it('wraps and unwraps a data key', async () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });
    const dataKey = randomBytes(32);

    const wrapped = await kek.wrap(dataKey);

    expect(wrapped.keyVersion).toBe('1');
    expect(wrapped.wrapped).not.toEqual(dataKey);
    expect(await kek.unwrap(wrapped)).toEqual(dataKey);
  });

  it('wraps under the current version, not an older one', async () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1, '2': KEY_2 }, currentVersion: '2' });

    expect((await kek.wrap(randomBytes(32))).keyVersion).toBe('2');
  });

  it('lists the versions it can still unwrap', () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1, '2': KEY_2 }, currentVersion: '2' });

    expect(kek.versions()).toEqual(['1', '2']);
    expect(kek.currentVersion()).toBe('2');
  });

  it('produces a different wrapping each time', async () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });
    const dataKey = randomBytes(32);

    const first = await kek.wrap(dataKey);
    const second = await kek.wrap(dataKey);

    expect(first.wrapped).not.toEqual(second.wrapped);
  });

  it('refuses to unwrap with the wrong key', async () => {
    const wrapped = await new FileKekProvider({
      keys: { '1': KEY_1 },
      currentVersion: '1',
    }).wrap(randomBytes(32));

    const other = new FileKekProvider({ keys: { '1': KEY_2 }, currentVersion: '1' });

    await expect(other.unwrap(wrapped)).rejects.toThrow(DecryptionFailedError);
  });

  it('names the versions it holds when asked for one it does not', async () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });

    await expect(kek.unwrap({ wrapped: Buffer.alloc(64), keyVersion: '7' })).rejects.toThrow(
      UnknownKeyVersionError,
    );
    await expect(kek.unwrap({ wrapped: Buffer.alloc(64), keyVersion: '7' })).rejects.toThrow(
      /This provider holds: 1/,
    );
  });

  it('rejects a truncated wrapped key rather than reading past it', async () => {
    const kek = new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });

    await expect(kek.unwrap({ wrapped: Buffer.alloc(8), keyVersion: '1' })).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  describe('construction', () => {
    it('requires at least one key', () => {
      expect(() => new FileKekProvider({ keys: {}, currentVersion: '1' })).toThrow(
        /at least one key/,
      );
    });

    it('requires the current version to be present', () => {
      expect(() => new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '2' })).toThrow(
        /'2' is not among the supplied keys/,
      );
    });

    it('requires AES-256 key material', () => {
      expect(
        () => new FileKekProvider({ keys: { '1': randomBytes(16) }, currentVersion: '1' }),
      ).toThrow(/is 16 bytes; AES-256 needs 32/);
    });

    it('rejects an empty version label', () => {
      expect(() => new FileKekProvider({ keys: { '': KEY_1 }, currentVersion: '' })).toThrow(
        /cannot be empty/,
      );
    });
  });
});

describe('fileKekFromConfig', () => {
  const encoded = (key: Buffer) => key.toString('base64');

  it('builds a provider from version:key pairs', async () => {
    const kek = fileKekFromConfig({
      CRYPTO_KEKS: `1:${encoded(KEY_1)},2:${encoded(KEY_2)}`,
      CRYPTO_KEK_CURRENT: '2',
    });

    expect(kek.versions()).toEqual(['1', '2']);
    expect(kek.currentVersion()).toBe('2');
    expect(await kek.unwrap(await kek.wrap(Buffer.alloc(32, 7)))).toEqual(Buffer.alloc(32, 7));
  });

  it('tolerates spacing around the pairs', () => {
    expect(
      fileKekFromConfig({
        CRYPTO_KEKS: ` 1 : ${encoded(KEY_1)} , 2 : ${encoded(KEY_2)} `,
        CRYPTO_KEK_CURRENT: '1',
      }).versions(),
    ).toEqual(['1', '2']);
  });

  it('rejects a malformed entry without echoing key material', () => {
    const secret = encoded(KEY_1);

    try {
      fileKekFromConfig({ CRYPTO_KEKS: secret, CRYPTO_KEK_CURRENT: '1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeyError);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('rejects a key of the wrong length without echoing it', () => {
    const short = randomBytes(16).toString('base64');

    try {
      fileKekFromConfig({ CRYPTO_KEKS: `1:${short}`, CRYPTO_KEK_CURRENT: '1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('AES-256 needs 32');
      expect((error as Error).message).not.toContain(short);
    }
  });
});

describe('VaultTransitKekProvider', () => {
  it('refuses to pretend it works', () => {
    // A half-built client that silently fell back to local keys would be worse
    // than an honest gap.
    expect(
      () => new VaultTransitKekProvider({ address: 'https://vault', keyName: 'k', token: 't' }),
    ).toThrow(/not implemented yet/);
  });

  it('points at what to do instead', () => {
    expect(
      () => new VaultTransitKekProvider({ address: 'https://vault', keyName: 'k', token: 't' }),
    ).toThrow(/FileKekProvider/);
  });
});

describe('secretEquals', () => {
  it('compares equal values', () => {
    expect(secretEquals('hunter2', 'hunter2')).toBe(true);
    expect(secretEquals(Buffer.from('a'), Buffer.from('a'))).toBe(true);
  });

  it('rejects different values, including different lengths', () => {
    expect(secretEquals('hunter2', 'hunter3')).toBe(false);
    expect(secretEquals('short', 'much longer value')).toBe(false);
  });
});
