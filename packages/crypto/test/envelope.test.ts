import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CIPHERTEXT_PREFIX,
  currentVersionPrefix,
  decrypt,
  decryptString,
  encrypt,
  isCiphertext,
  kekRewrapper,
  keyVersionOf,
  needsRotation,
  rotate,
} from '../src/envelope.js';
import {
  DecryptionFailedError,
  MalformedCiphertextError,
  UnknownKeyVersionError,
} from '../src/errors.js';
import { FileKekProvider } from '../src/kek.js';

const KEY_1 = randomBytes(32);
const KEY_2 = randomBytes(32);

/** A provider holding v1 only. */
const v1 = () => new FileKekProvider({ keys: { '1': KEY_1 }, currentVersion: '1' });

/** Both versions present, v2 current — a provider mid-rotation. */
const v2 = () => new FileKekProvider({ keys: { '1': KEY_1, '2': KEY_2 }, currentVersion: '2' });

describe('round trip', () => {
  it('returns exactly what was encrypted', async () => {
    const kek = v1();

    expect(await decryptString(kek, await encrypt(kek, 'hunter2'))).toBe('hunter2');
  });

  it('handles the secrets this actually protects', async () => {
    const kek = v1();

    // 07 §5: SIP secrets, trunk credentials, MFA secrets, conference PINs.
    for (const secret of ['s3cr3t-sip-pass', '0000', 'JBSWY3DPEHPK3PXP', 'p@ss:word/with.punct']) {
      expect(await decryptString(kek, await encrypt(kek, secret))).toBe(secret);
    }
  });

  it('round-trips binary, not just text', async () => {
    const kek = v1();
    const bytes = randomBytes(512);

    expect(await decrypt(kek, await encrypt(kek, bytes))).toEqual(bytes);
  });

  it('round-trips an empty value', async () => {
    const kek = v1();

    expect(await decryptString(kek, await encrypt(kek, ''))).toBe('');
  });

  it('round-trips multi-byte characters', async () => {
    const kek = v1();
    const value = 'pin: 一二三 · ümlaut · 🔐';

    expect(await decryptString(kek, await encrypt(kek, value))).toBe(value);
  });

  it('produces a different ciphertext every time', async () => {
    const kek = v1();

    const first = await encrypt(kek, 'same');
    const second = await encrypt(kek, 'same');

    // A fresh data key and IV per record: equal plaintexts must not be
    // recognisable as equal in the database.
    expect(first).not.toBe(second);
    expect(await decryptString(kek, first)).toBe(await decryptString(kek, second));
  });

  it('never contains the plaintext', async () => {
    const kek = v1();

    expect(await encrypt(kek, 'hunter2')).not.toContain('hunter2');
  });

  it('tags the ciphertext with the key version that wrapped it', async () => {
    expect(keyVersionOf(await encrypt(v1(), 'x'))).toBe('1');
    expect(keyVersionOf(await encrypt(v2(), 'x'))).toBe('2');
  });

  it('names no product or codebase in the stored format', async () => {
    // A *_enc column can end up in an export, so the marker stays neutral (02 §5.2).
    const ciphertext = await encrypt(v1(), 'x');

    expect(ciphertext.startsWith('enc1.')).toBe(true);
    expect(ciphertext.toLowerCase()).not.toContain('cuc');
    expect(ciphertext.toLowerCase()).not.toContain('conductor');
  });
});

describe('associated data', () => {
  const aad = 'tenant-a:sip_credentials.secret_enc:row-1';

  it('round-trips when the same context is supplied', async () => {
    const kek = v1();

    expect(await decryptString(kek, await encrypt(kek, 'hunter2', aad), aad)).toBe('hunter2');
  });

  it('refuses a value moved to another row', async () => {
    const kek = v1();
    const ciphertext = await encrypt(kek, 'hunter2', aad);

    await expect(
      decrypt(kek, ciphertext, 'tenant-a:sip_credentials.secret_enc:row-2'),
    ).rejects.toThrow(DecryptionFailedError);
  });

  it('refuses a value moved to another tenant', async () => {
    const kek = v1();
    const ciphertext = await encrypt(kek, 'hunter2', aad);

    await expect(
      decrypt(kek, ciphertext, 'tenant-b:sip_credentials.secret_enc:row-1'),
    ).rejects.toThrow(DecryptionFailedError);
  });

  it('refuses when the context is omitted on decryption', async () => {
    const kek = v1();

    await expect(decrypt(kek, await encrypt(kek, 'hunter2', aad))).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  it('refuses when a context is supplied for a value encrypted without one', async () => {
    const kek = v1();

    await expect(decrypt(kek, await encrypt(kek, 'hunter2'), aad)).rejects.toThrow(
      DecryptionFailedError,
    );
  });
});

/** Flips the last byte of a base64url field, leaving the rest intact. */
function corruptField(ciphertext: string, index: number): string {
  const parts = ciphertext.split('.');
  const bytes = Buffer.from(parts[index]!, 'base64url');
  const last = bytes.length - 1;
  bytes.writeUInt8(bytes.readUInt8(last) ^ 0xff, last);
  parts[index] = bytes.toString('base64url');
  return parts.join('.');
}

describe('tampering', () => {
  it('rejects a modified ciphertext body', async () => {
    const kek = v1();

    const corrupted = corruptField(await encrypt(kek, 'hunter2'), 3);

    await expect(decrypt(kek, corrupted)).rejects.toThrow(DecryptionFailedError);
  });

  it('rejects a modified wrapped key', async () => {
    const kek = v1();

    const corrupted = corruptField(await encrypt(kek, 'hunter2'), 2);

    await expect(decrypt(kek, corrupted)).rejects.toThrow(DecryptionFailedError);
  });

  it('rejects a wrapped key relabelled as another version', async () => {
    const kek = v2();
    const parts = (await encrypt(kek, 'hunter2')).split('.');
    // Claim v1 wrapped it, when v2 did. The version is authenticated as
    // associated data during wrapping, so this cannot pass.
    parts[1] = Buffer.from('1', 'utf8').toString('base64url');

    await expect(decrypt(kek, parts.join('.'))).rejects.toThrow(DecryptionFailedError);
  });

  it('rejects a body from one record splice onto another record’s key', async () => {
    const kek = v1();
    const first = (await encrypt(kek, 'secret-one')).split('.');
    const second = (await encrypt(kek, 'secret-two')).split('.');

    const spliced = [first[0], first[1], first[2], second[3]].join('.');

    await expect(decrypt(kek, spliced)).rejects.toThrow(DecryptionFailedError);
  });

  it('rejects a value encrypted under a key this provider does not hold', async () => {
    const other = new FileKekProvider({ keys: { '9': randomBytes(32) }, currentVersion: '9' });
    const ciphertext = await encrypt(other, 'hunter2');

    await expect(decrypt(v1(), ciphertext)).rejects.toThrow(UnknownKeyVersionError);
  });

  it('does not say which part failed', async () => {
    const kek = v1();

    const error = await decrypt(kek, await encrypt(kek, 'x'), 'wrong-context').catch(
      (caught: unknown) => caught,
    );

    // A caller cannot act differently on "wrong key" than on "tampered payload",
    // and saying which would tell an attacker where to keep working.
    expect((error as Error).message).not.toMatch(/tag|wrapped key|data key/i);
  });
});

describe('malformed input', () => {
  it.each([
    ['', 'empty'],
    ['not-a-ciphertext', 'not the format'],
    ['enc1.MQ.abc', 'too few parts'],
    ['enc1.MQ.abc.def.ghi', 'too many parts'],
    ['enc2.MQ.abc.def', 'unknown format version'],
    ['enc1..abc.def', 'empty key version'],
    ['enc1.MQ.!!!.def', 'wrapped key is not base64url'],
  ])('rejects %j (%s)', async (value) => {
    await expect(decrypt(v1(), value)).rejects.toThrow(MalformedCiphertextError);
  });

  it('rejects a body too short to hold an IV and tag', async () => {
    await expect(decrypt(v1(), 'enc1.MQ.abcd.AAAA')).rejects.toThrow(
      /too short to hold an IV and tag/,
    );
  });

  it('recognises its own format without decrypting', async () => {
    expect(isCiphertext(await encrypt(v1(), 'x'))).toBe(true);
    expect(isCiphertext('plain text')).toBe(false);
    expect(isCiphertext('')).toBe(false);
  });
});

describe('rotation', () => {
  it('rewraps a value under the new current version', async () => {
    const before = v1();
    const ciphertext = await encrypt(before, 'hunter2');
    expect(keyVersionOf(ciphertext)).toBe('1');

    const after = v2();
    const rotated = await rotate(after, ciphertext);

    expect(keyVersionOf(rotated)).toBe('2');
    expect(await decryptString(after, rotated)).toBe('hunter2');
  });

  it('leaves the encrypted payload byte-for-byte unchanged', async () => {
    const ciphertext = await encrypt(v1(), 'hunter2');
    const rotated = await rotate(v2(), ciphertext);

    // Only the wrapped key changes. Rotating a large table is therefore one KMS
    // call per row, not a full re-encrypt, and a crash mid-rotation leaves every
    // row readable under one version or the other.
    expect(rotated.split('.')[3]).toBe(ciphertext.split('.')[3]);
    expect(rotated.split('.')[2]).not.toBe(ciphertext.split('.')[2]);
  });

  it('is a no-op for a value already on the current version', async () => {
    const kek = v2();
    const ciphertext = await encrypt(kek, 'hunter2');

    expect(await rotate(kek, ciphertext)).toBe(ciphertext);
  });

  it('preserves associated data across rotation', async () => {
    const aad = 'tenant-a:trunks.secret_enc:row-1';
    const ciphertext = await encrypt(v1(), 'trunk-pass', aad);

    const rotated = await rotate(v2(), ciphertext);

    expect(await decryptString(v2(), rotated, aad)).toBe('trunk-pass');
    await expect(decrypt(v2(), rotated, 'tenant-b:trunks.secret_enc:row-1')).rejects.toThrow(
      DecryptionFailedError,
    );
  });

  it('reports what still needs rotating', async () => {
    const old = await encrypt(v1(), 'x');
    const current = await encrypt(v2(), 'x');

    expect(needsRotation(v2(), old)).toBe(true);
    expect(needsRotation(v2(), current)).toBe(false);
  });

  it('can still read old values while rotation is in progress', async () => {
    const kek = v2();
    const old = await encrypt(v1(), 'old-secret');
    const fresh = await encrypt(kek, 'new-secret');

    // The retired key stays loaded, so a partly rotated table is fully readable.
    expect(await decryptString(kek, old)).toBe('old-secret');
    expect(await decryptString(kek, fresh)).toBe('new-secret');
  });

  it('rotates a whole batch idempotently', async () => {
    const values = await Promise.all(['a', 'b', 'c'].map((value) => encrypt(v1(), value)));
    const kek = v2();

    const once = await Promise.all(values.map((value) => rotate(kek, value)));
    const twice = await Promise.all(once.map((value) => rotate(kek, value)));

    expect(twice).toEqual(once);
    expect(await Promise.all(twice.map((value) => decryptString(kek, value)))).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('fails rather than silently dropping a value whose old key is gone', async () => {
    const ciphertext = await encrypt(v1(), 'hunter2');
    // v1 retired before everything under it was rotated.
    const only2 = new FileKekProvider({ keys: { '2': KEY_2 }, currentVersion: '2' });

    await expect(rotate(only2, ciphertext)).rejects.toThrow(UnknownKeyVersionError);
    await expect(rotate(only2, ciphertext)).rejects.toThrow(/must stay available/);
  });
});

describe('re-wrap prefixes (G-116)', () => {
  it('every value starts with the format prefix, whatever its version', async () => {
    expect((await encrypt(v1(), 'x')).startsWith(CIPHERTEXT_PREFIX)).toBe(true);
    expect((await encrypt(v2(), 'x')).startsWith(CIPHERTEXT_PREFIX)).toBe(true);
  });

  it('only values under the current version start with the current prefix', async () => {
    const old = await encrypt(v1(), 'x');
    const current = await encrypt(v2(), 'x');

    expect(current.startsWith(currentVersionPrefix(v2()))).toBe(true);
    expect(old.startsWith(currentVersionPrefix(v2()))).toBe(false);
  });

  it('a version whose name is a prefix of another is not mistaken for it', async () => {
    const kek10 = new FileKekProvider({ keys: { '1': KEY_1, '10': KEY_2 }, currentVersion: '10' });
    const underOne = await encrypt(v1(), 'x');

    expect(underOne.startsWith(currentVersionPrefix(kek10))).toBe(false);
  });

  it('the rewrapper rotates, keeping the associated data valid', async () => {
    const aad = 'tenant-a:mailboxes.pin_enc:row-1';
    const old = await encrypt(v1(), '1234', aad);
    const rewrapper = kekRewrapper(v2());

    const rewrapped = await rewrapper.rewrap(old);

    expect(rewrapper.formatPrefix).toBe(CIPHERTEXT_PREFIX);
    expect(rewrapped.startsWith(rewrapper.currentPrefix())).toBe(true);
    expect(await decryptString(v2(), rewrapped, aad)).toBe('1234');
  });
});
