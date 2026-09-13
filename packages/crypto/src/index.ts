export { cryptoEnvSchema, fileKekFromConfig } from './config.js';
export {
  decrypt,
  decryptString,
  encrypt,
  isCiphertext,
  keyVersionOf,
  needsRotation,
  rotate,
} from './envelope.js';
export {
  CryptoError,
  DecryptionFailedError,
  InvalidKeyError,
  MalformedCiphertextError,
  UnknownKeyVersionError,
} from './errors.js';
export {
  FileKekProvider,
  KEK_BYTES,
  secretEquals,
  VaultTransitKekProvider,
  type FileKekProviderOptions,
  type KekProvider,
  type WrappedKey,
} from './kek.js';
