#!/usr/bin/env node
// Merges per-service OpenAPI documents (files or URLs, JSON) into one, the
// document the console client is generated from (08 §1).
//
//   node tool/merge-openapi.mjs api/openapi.json http://identity:3000/openapi.json ...
//
// Paths and component schemas are unioned. A collision on a path+method or on
// a schema name with a different definition is an error, not a silent override.
import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const [out, ...inputs] = process.argv.slice(2);
if (out === undefined || inputs.length === 0) {
  console.error('usage: merge-openapi.mjs <out.json> <spec.json|url>...');
  process.exit(2);
}

async function load(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

const merged = {
  openapi: '3.1.0',
  info: { title: 'Console API', version: '0.1.0' },
  servers: [{ url: '/' }],
  paths: {},
  components: { schemas: {} },
};

for (const source of inputs) {
  const spec = await load(source);
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    const target = (merged.paths[path] ??= {});
    for (const [method, operation] of Object.entries(item)) {
      if (method in target) throw new Error(`${source}: duplicate ${method.toUpperCase()} ${path}`);
      target[method] = operation;
    }
  }
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    const existing = merged.components.schemas[name];
    if (existing !== undefined && !isDeepStrictEqual(existing, schema)) {
      throw new Error(`${source}: schema '${name}' conflicts with an earlier definition`);
    }
    merged.components.schemas[name] = schema;
  }
}

await writeFile(out, `${JSON.stringify(merged, null, 2)}\n`);
