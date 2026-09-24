#!/usr/bin/env node
// Dumps what the call-flow builder must agree with `@cuc/callflow-ir` on: each
// node type's config schema and ports, and the validator's verdict on a set of
// graphs. The console's tests hold its node definitions and its local
// validator to this file, so a change to the IR that the builder has not
// followed fails a test instead of failing at publish.
//
//   node apps/console/tool/dump-callflow-ir.mjs
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ir = await import(pathToFileURL(resolve(root, 'packages/callflow-ir/dist/index.js')).href);

const nodeTypes = Object.fromEntries(
  ir.NODE_TYPES.map((type) => [
    type,
    {
      config: JSON.parse(JSON.stringify(ir.NODE_CONFIG_SCHEMAS[type])),
      requiredPorts: [...ir.REQUIRED_PORTS[type]],
      allowedPorts: [...ir.allowedPorts(type)],
    },
  ]),
);

const menuConfig = { promptMediaAssetId: 'p', timeoutSeconds: 5, maxInvalidAttempts: 3 };
const hangup = (id) => ({ id, type: 'hangup', config: {} });
const menu = (id) => ({ id, type: 'menu', config: menuConfig });
const edge = (from, port, to) => ({ from, port, to });
const main = (id) => ({ main: id });

const graphs = {
  valid_menu: {
    entryPoints: main('m'),
    nodes: [menu('m'), hangup('h')],
    edges: [edge('m', 'timeout', 'h'), edge('m', 'invalid', 'h'), edge('m', '1', 'h')],
  },
  empty: { entryPoints: {}, nodes: [], edges: [] },
  no_entry_points: { entryPoints: {}, nodes: [hangup('h')], edges: [] },
  unreachable: {
    entryPoints: main('h'),
    nodes: [hangup('h'), hangup('lonely')],
    edges: [],
  },
  missing_port: {
    entryPoints: main('m'),
    nodes: [menu('m'), hangup('h')],
    edges: [edge('m', 'timeout', 'h')],
  },
  edge_to_nowhere: {
    entryPoints: main('m'),
    nodes: [menu('m')],
    edges: [edge('m', 'timeout', 'gone'), edge('m', 'invalid', 'gone')],
  },
  entry_to_nowhere: { entryPoints: main('gone'), nodes: [hangup('h')], edges: [] },
  digit_conflict: {
    entryPoints: main('m'),
    nodes: [menu('m'), hangup('a'), hangup('b')],
    edges: [
      edge('m', 'timeout', 'a'),
      edge('m', 'invalid', 'a'),
      edge('m', '1', 'a'),
      edge('m', '1', 'b'),
    ],
  },
  invalid_port: {
    entryPoints: main('p'),
    nodes: [{ id: 'p', type: 'play', config: { mediaAssetId: 'x' } }, hangup('h')],
    edges: [edge('p', 'next', 'h'), edge('p', 'sideways', 'h')],
  },
  duplicate_id: {
    entryPoints: main('h'),
    nodes: [hangup('h'), hangup('h')],
    edges: [],
  },
  unknown_type: {
    entryPoints: main('x'),
    nodes: [{ id: 'x', type: 'teleport', config: {} }],
    edges: [],
  },
  time_condition: {
    entryPoints: main('t'),
    nodes: [{ id: 't', type: 'time_condition', config: { scheduleId: 's1' } }, hangup('h')],
    edges: [edge('t', 'match', 'h'), edge('t', 'noMatch', 'h')],
  },
  // Saved before schedules existed: a time zone and no schedule.
  time_condition_legacy_timezone: {
    entryPoints: main('t'),
    nodes: [{ id: 't', type: 'time_condition', config: { timezone: 'UTC' } }, hangup('h')],
    edges: [edge('t', 'match', 'h'), edge('t', 'noMatch', 'h')],
  },
};

const cases = Object.entries(graphs).map(([name, graph]) => ({
  name,
  graph,
  issues: ir
    .validateGraph(graph)
    .map((i) => ({ kind: i.kind, ...(i.nodeId === undefined ? {} : { nodeId: i.nodeId }) })),
}));

const out = resolve(root, 'apps/console/api/callflow-ir.json');
await writeFile(
  out,
  `${JSON.stringify({ nodeTypes, menuDigitPorts: [...ir.MENU_DIGIT_PORTS], cases }, null, 2)}\n`,
);
console.log(`${cases.length} cases -> ${out}`);
