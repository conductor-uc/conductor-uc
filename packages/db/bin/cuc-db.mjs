#!/usr/bin/env node
// A committed shim so pnpm can always create the `cuc-db` symlink. Pointing the
// bin straight at dist/ makes every fresh `pnpm install` warn, because the build
// has not run yet.
await import('../dist/cli.js');
