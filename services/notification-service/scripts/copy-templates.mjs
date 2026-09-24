// tsc does not copy the .mjml/.hbs templates; the compiled service loads them
// from beside its own code, so copy them next to it.
import { cp } from 'node:fs/promises';
import { URL } from 'node:url';

await cp(
  new URL('../src/templates', import.meta.url),
  new URL('../dist/src/templates', import.meta.url),
  {
    recursive: true,
  },
);
