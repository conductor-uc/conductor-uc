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
      {
        id: 'menu1',
        type: 'menu',
        config: { promptMediaAssetId: 'greeting', timeoutSeconds: 5, maxInvalidAttempts: 3 },
      },
      { id: 'play1', type: 'play', config: { mediaAssetId: 'hours' } },
      { id: 'tc1', type: 'time_condition', config: { scheduleId: 'sched-hours' } },
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
        {
          id: 'menu1',
          type: 'menu',
          config: { promptMediaAssetId: 'm1', timeoutSeconds: 5, maxInvalidAttempts: 3 },
        },
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

  describe('time_condition', () => {
    function withTimeCondition(config: unknown): FlowGraphInput {
      return {
        entryPoints: { main: 'tc' },
        nodes: [
          { id: 'tc', type: 'time_condition', config },
          { id: 'open', type: 'hangup', config: {} },
          { id: 'closed', type: 'hangup', config: {} },
        ],
        edges: [
          { from: 'tc', port: 'match', to: 'open' },
          { from: 'tc', port: 'noMatch', to: 'closed' },
        ],
      };
    }

    it('keeps the schedule id in the IR, not the schedule itself', () => {
      const ir = compileGraph(withTimeCondition({ scheduleId: 'sched-1' }));
      expect(ir.nodes['tc']).toMatchObject({ config: { scheduleId: 'sched-1' } });
      expect(JSON.stringify(ir)).not.toContain('timezone');
    });

    it('refuses a draft saved with a time zone and no schedule, and says why', () => {
      const attempt = () => compileGraph(withTimeCondition({ timezone: 'America/Chicago' }));
      expect(attempt).toThrow(CompileError);
      try {
        attempt();
      } catch (error) {
        const issues = (error as CompileError).issues;
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ kind: 'invalid_config', nodeId: 'tc' });
        expect(issues[0]?.message).toContain('Choose a schedule');
      }
    });

    it('refuses a time condition with no schedule id at all', () => {
      expect(() => compileGraph(withTimeCondition({}))).toThrow(CompileError);
      expect(() => compileGraph(withTimeCondition({ scheduleId: '' }))).toThrow(CompileError);
    });

    it('ignores the editor layout, which never reaches the IR', () => {
      const graph = withTimeCondition({ scheduleId: 's' });
      const positioned: FlowGraphInput = {
        ...graph,
        nodes: graph.nodes.map((n) => ({ ...n, position: { x: 1, y: 2 }, openPorts: ['1'] })),
      };
      const ir = compileGraph(positioned);
      expect(JSON.stringify(ir)).not.toContain('position');
      expect(JSON.stringify(ir)).not.toContain('openPorts');
    });
  });
});
