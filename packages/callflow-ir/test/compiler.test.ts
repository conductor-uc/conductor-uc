import { describe, expect, it } from 'vitest';

import { compileGraph, CompileError } from '../src/compiler.js';
import type { FlowGraphInput } from '../src/nodes.js';

/**
 * A graph that wires every MVP node type at least once, so `compileGraph`
 * exercises the full node-type table in one pass. Terminal nodes
 * (`goto_flow`, `hangup`) end each branch.
 */
function fullGraph(): FlowGraphInput {
  return {
    entryPoints: { main: 'menu1' },
    nodes: [
      { id: 'menu1', type: 'menu', config: { promptMediaAssetId: 'greeting', timeoutSeconds: 5, maxInvalidAttempts: 3 } },
      { id: 'play1', type: 'play', config: { mediaAssetId: 'hours' } },
      { id: 'tc1', type: 'time_condition', config: { timezone: 'America/Chicago' } },
      { id: 'ext1', type: 'extension', config: { extensionId: 'ext-100', ringSeconds: 20 } },
      { id: 'rg1', type: 'ring_group', config: { ringGroupId: 'rg-sales' } },
      { id: 'q1', type: 'queue', config: { queueId: 'q-support' } },
      { id: 'vm1', type: 'voicemail', config: { mailboxId: 'mb-100' } },
      { id: 'gf1', type: 'goto_flow', config: { flowId: 'other-flow', entryPoint: 'main' } },
      { id: 'hu1', type: 'hangup', config: {} },
    ],
    edges: [
      { from: 'menu1', port: '1', to: 'ext1' },
      { from: 'menu1', port: '2', to: 'rg1' },
      { from: 'menu1', port: '3', to: 'q1' },
      { from: 'menu1', port: 'timeout', to: 'play1' },
      { from: 'menu1', port: 'invalid', to: 'play1' },
      { from: 'play1', port: 'next', to: 'tc1' },
      { from: 'tc1', port: 'match', to: 'gf1' },
      { from: 'tc1', port: 'noMatch', to: 'vm1' },
      { from: 'ext1', port: 'noAnswer', to: 'vm1' },
      { from: 'rg1', port: 'noAnswer', to: 'vm1' },
      { from: 'q1', port: 'next', to: 'hu1' },
      { from: 'vm1', port: 'next', to: 'hu1' },
    ],
  };
}

describe('compileGraph', () => {
  it('compiles every MVP node type into an IR keyed by node id, ports resolved inline', () => {
    const ir = compileGraph(fullGraph());

    expect(ir.entryPoints).toEqual({ main: 'menu1' });
    expect(Object.keys(ir.nodes).sort()).toEqual(
      ['ext1', 'gf1', 'hu1', 'menu1', 'play1', 'q1', 'rg1', 'tc1', 'vm1'].sort(),
    );

    expect(ir.nodes['menu1']).toEqual({
      id: 'menu1',
      type: 'menu',
      config: { promptMediaAssetId: 'greeting', timeoutSeconds: 5, maxInvalidAttempts: 3 },
      ports: { '1': 'ext1', '2': 'rg1', '3': 'q1', timeout: 'play1', invalid: 'play1' },
    });
    expect(ir.nodes['hu1']).toEqual({ id: 'hu1', type: 'hangup', config: {}, ports: {} });
    expect(ir.nodes['gf1']).toEqual({
      id: 'gf1',
      type: 'goto_flow',
      config: { flowId: 'other-flow', entryPoint: 'main' },
      ports: {},
    });
  });

  it('throws CompileError carrying every issue when the graph is invalid, not just the first', () => {
    const invalid: FlowGraphInput = {
      entryPoints: {},
      nodes: [
        { id: 'n1', type: 'hangup', config: {} },
        { id: 'n2', type: 'play', config: { mediaAssetId: 'm1' } },
      ],
      edges: [],
    };

    let caught: unknown;
    try {
      compileGraph(invalid);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(CompileError);
    const issues = (caught as CompileError).issues;
    expect(issues.some((i) => i.kind === 'missing_entry_point')).toBe(true);
    expect(issues.some((i) => i.kind === 'missing_port' && i.nodeId === 'n2')).toBe(true);
  });

  it('refuses to compile a graph that fails digit-conflict validation', () => {
    const invalid: FlowGraphInput = {
      entryPoints: { main: 'menu1' },
      nodes: [
        { id: 'menu1', type: 'menu', config: { promptMediaAssetId: 'm1', timeoutSeconds: 5, maxInvalidAttempts: 3 } },
        { id: 'a', type: 'hangup', config: {} },
        { id: 'b', type: 'hangup', config: {} },
        { id: 'to', type: 'hangup', config: {} },
        { id: 'inv', type: 'hangup', config: {} },
      ],
      edges: [
        { from: 'menu1', port: '1', to: 'a' },
        { from: 'menu1', port: '1', to: 'b' },
        { from: 'menu1', port: 'timeout', to: 'to' },
        { from: 'menu1', port: 'invalid', to: 'inv' },
      ],
    };

    expect(() => compileGraph(invalid)).toThrow(CompileError);
  });
});
