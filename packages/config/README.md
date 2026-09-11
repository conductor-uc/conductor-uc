# @cuc/config

Environment configuration validated by a TypeBox schema, applied once at startup.
A service that is misconfigured refuses to start (09 §1).

```ts
import { Env, Type, baseEnvSchema, loadConfig, redactConfig } from '@cuc/config';

const schema = Type.Object({
  ...baseEnvSchema.properties,
  DB_URL: Env.string(),
  DB_PASSWORD: Env.secret(),
  CONSOLE_HOSTNAMES: Env.list({ default: [] }),
});

export const config = loadConfig(schema);          // throws ConfigError, frozen on success
logger.info(redactConfig(schema, config), 'config'); // secrets masked
```

## Behaviour worth knowing

- **Only declared variables are read.** Anything else in the environment is ignored.
- **An empty string counts as unset**, so a variable an orchestrator leaves blank falls back to its default rather than failing as a zero-length string.
- **Every problem is reported at once.** A `ConfigError` lists each offending variable, so a bad deployment is not fixed one restart at a time.
- **Values never appear in the error.** Environment variables hold secrets (07 §5), and a startup crash ends up in a log aggregator.
- `Env.bool()` accepts `true`, `false`, `1`, and `0`, case-insensitive. Anything else fails.
- `Env.list()` splits on commas and trims entries.
- `Env.secret()` marks a variable for masking by `redactConfig`; `secretVariables(schema)` lists them.
