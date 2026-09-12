import { Env, Type } from '@cuc/config';

/**
 * Database configuration every service shares (05 §1.1: one schema and one DB
 * user per service, with grants only on its own schema).
 *
 * Spread it into the service's own schema:
 *
 * ```ts
 * const schema = Type.Object({ ...baseEnvSchema.properties, ...dbEnvSchema.properties });
 * ```
 */
export const dbEnvSchema = Type.Object({
  DB_HOST: Env.string({ default: '127.0.0.1', description: 'MariaDB host.' }),
  DB_PORT: Env.port({ default: 3306, description: 'MariaDB port.' }),
  DB_USER: Env.string({ description: "The service's own DB user." }),
  DB_PASSWORD: Env.secret({ description: 'From the orchestrator secret store, never the repo.' }),
  DB_NAME: Env.string({ description: "The service's own schema. No cross-schema joins." }),
  DB_POOL_SIZE: Env.int({
    minimum: 1,
    maximum: 200,
    default: 10,
    description: 'Maximum pooled connections per service instance.',
  }),
  DB_CONNECT_TIMEOUT_MS: Env.int({ minimum: 100, default: 10_000 }),
});
