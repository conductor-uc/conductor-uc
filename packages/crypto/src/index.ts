export { cryptoEnvSchema, fileKekFromConfig } from './config.js';
export {
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
  type KekRewrapper,
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
