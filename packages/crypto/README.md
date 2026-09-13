# @cuc/crypto

Envelope encryption for the secrets in 07 §5: SIP passwords, trunk credentials, MFA secrets, and
conference PINs — everything stored in a `*_enc` column.

```ts
import { encrypt, decryptString, fileKekFromConfig } from '@cuc/crypto';

const kek = fileKekFromConfig(config);
const aad = `${tenantId}:sip_credentials.secret_enc:${credentialId}`;

const secret_enc = await encrypt(kek, sipPassword, aad);
const sipPassword = await decryptString(kek, row.secret_enc, aad);
```

## How it is put together

Each record gets its **own data key**, and that key is wrapped by the KEK. A compromised record's
key is worth exactly one record, and rotating the KEK rewraps keys without touching any ciphertext.

Both layers are AES-256-GCM, so both are authenticated. The stored form is:

```
enc1.<key version>.<wrapped data key>.<iv|tag|ciphertext>
```

The marker is neutral: a `*_enc` value can end up in an export, and no codebase or operator name
may appear on a surface that leaves the platform (02 §5.2). The key version is base64url-encoded
rather than embedded raw, so a version containing a `.` cannot split the value into the wrong
fields.

## Bind the ciphertext to where it lives

`associatedData` is optional but you should almost always pass it:

```ts
await encrypt(kek, secret, `${tenantId}:trunks.secret_enc:${trunkId}`);
```

Without it, a ciphertext is valid anywhere — someone with write access to the database could move
one tenant's trunk password into another tenant's row and it would decrypt cleanly. With it, that
fails. The context is not stored; the decrypting caller must reconstruct the same string.

## Rotation

```ts
if (needsRotation(kek, row.secret_enc)) {
  await repo.update(id, { secret_enc: await rotate(kek, row.secret_enc) });
}
```

`rotate` rewraps the data key and **leaves the encrypted payload byte-for-byte unchanged**. Rotating
a large table is one KMS call per row rather than a full read-modify-write, and a crash mid-rotation
leaves every row readable — some under the old version, some under the new.

**A retired KEK must stay loaded until nothing is wrapped under it.** Drop it early and `rotate`
throws `UnknownKeyVersionError` rather than silently losing the value. `keyVersionOf` reports what a
row is on without decrypting it, so a rotation job can find work with a plain `SELECT`.

## Providers

| Provider | Use |
|---|---|
| `FileKekProvider` | **Local development only.** Key material lives in the process. |
| `VaultTransitKekProvider` | Production. **Not implemented** — it throws. |

The Vault adapter is deliberately a stub that refuses rather than a half-built client that might
silently fall back to local keys. Choosing between Vault Transit and a cloud KMS is a deployment
decision that has not been made (07 §5); when it is, only this class changes.

`FileKekProvider` is not production-grade and is not meant to be: a KMS keeps the key somewhere the
application cannot read it, lets an operator rotate without a deploy, and logs its use outside the
service. None of that is true here.

## What errors do and do not say

`DecryptionFailedError` does not say whether the key, the associated data, or the ciphertext was
wrong. A caller cannot act differently on those, and distinguishing them out loud tells an attacker
which half of the envelope to keep working on.

Key material never reaches an error message — `fileKekFromConfig` reports a bad entry by version,
never by value.
