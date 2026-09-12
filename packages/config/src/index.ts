export { baseEnvSchema } from './base-schema.js';
export { Env, SECRET_KEYWORD } from './env.js';
export { ConfigError, type ConfigIssue } from './errors.js';
export { loadConfig, type LoadConfigOptions } from './load.js';
export { isSecret, redactConfig, secretVariables } from './redact.js';

// Re-exported so services declare their schema without a direct TypeBox
// dependency, and so the whole workspace stays on one TypeBox version.
export { Type } from 'typebox';
export type { Static, TObject, TSchema } from 'typebox';
