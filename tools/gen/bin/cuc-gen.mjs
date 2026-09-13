#!/usr/bin/env node
// Committed shim so pnpm can always create the symlink; see packages/db/bin.
await import('../dist/cli.js');
