import { describe, expect, it } from 'vitest';

import type { EdgeInput, FlowGraphInput, NodeInput } from '../src/nodes.js';
import { validateGraph } from '../src/validator.js';

function graph(nodes: NodeInput[], edges: EdgeInput[], entryPoints: Record<string, string> = { main: nodes[0]?.id ?? '' }): FlowGraphInput {
  return { entryPoints, nodes, edges };
}

describe('validateGraph', () => {
  it('accepts a minimal valid graph', () => {
    const g = graph(
      [{ id: 'n1', type: 'hangup', config: {} }],
      [],
      { main: 'n1' },
    );
    expect(validateGraph(g)).toEqual([]);
  });

  it('flags a graph with no entry points', () => {
    const g: FlowGraphInput = { entryPoints: {}, nodes: [{ id: 'n1', type: 'hangup', config: {} }], edges: [] };
    expect(validateGraph(g).map((i) => i.kind)).toContain('missing_entry_point');
  });

  it('flags an entry point pointing to an unknown node', () => {
    const g: FlowGraphInput = {
      entryPoints: { main: 'ghost' },
      nodes: [{ id: 'n1', type: 'hangup', config: {} }],
      edges: [],
    };
    const issues = validateGraph(g);
    expect(issues.some((i) => i.kind === 'bad_reference' && i.message.includes('ghost'))).toBe(true);
  });

  it('flags an unreachable node', () => {
    const g = graph(
      [
        { id: 'n1', type: 'hangup', config: {} },
        { id: 'n2', type: 'hangup', config: {} },
      ],
      [],
      { main: 'n1' },
    );
    const issues = validateGraph(g);
    expect(issues.some((i) => i.kind === 'unreachable_node' && i.nodeId === 'n2')).toBe(true);
  });

  it('flags a duplicate node id', () => {
    const g = graph(
      [
        { id: 'n1', type: 'hangup', config: {} },
        { id: 'n1', type: 'hangup', config: {} },
      ],
      [],
    );
    expect(validateGraph(g).some((i) => i.kind === 'duplicate_node_id')).toBe(true);
  });

  it('flags an edge from/to an unknown node', () => {
    const g = graph(
      [{ id: 'n1', type: 'play', config: { mediaAssetId: 'm1' } }],
      [{ from: 'n1', port: 'next', to: 'ghost' }],
    );
    expect(validateGraph(g).some((i) => i.kind === 'bad_reference')).toBe(true);
  });

  it('flags an edge from an unknown source node', () => {
    const g = graph(
      [{ id: 'n1', type: 'hangup', config: {} }],
      [{ from: 'ghost', port: 'next', to: 'n1' }],
    );
    expect(validateGraph(g).some((i) => i.kind === 'bad_reference')).toBe(true);
  });

  describe('missing_port, one per MVP node type', () => {
    const cases: [NodeInput['type'], unknown][] = [
      ['play', { mediaAssetId: 'm1' }],
      ['menu', { promptMediaAssetId: 'm1', timeoutSeconds: 5, maxInvalidAttempts: 3 }],
      ['time_condition', { timezone: 'UTC' }],
      ['extension', { extensionId: 'e1', ringSeconds: 20 }],
      ['ring_group', { ringGroupId: 'rg1' }],
      ['queue', { queueId: 'q1' }],
      ['voicemail', { mailboxId: 'mb1' }],
    ];

    for (const [type, config] of cases) {
      it(`requires ${type}'s ports to all be wired`, () => {
        const g = graph([{ id: 'n1', type, config }], [], { main: 'n1' });
        const issues = validateGraph(g);
        expect(issues.some((i) => i.kind === 'missing_port' && i.nodeId === 'n1')).toBe(true);
      });
    }

    it('goto_flow and hangup require no ports', () => {
      const g = graph(
        [
          { id: 'n1', type: 'goto_flow', config: { flowId: 'f2', entryPoint: 'main' } },
          { id: 'n2', type: 'hangup', config: {} },
        ],
        [],
        { a: 'n1', b: 'n2' },
      );
      expect(validateGraph(g)).toEqual([]);
    });
  });

  it('accepts a fully-wired menu node with digit and fixed ports', () => {
    const g = graph(
      [
        { id: 'menu1', type: 'menu', config: { promptMediaAssetId: 'm1', timeoutSeconds: 5, maxInvalidAttempts: 3 } },
        { id: 'sales', type: 'hangup', config: {} },
        { id: 'to', type: 'hangup', config: {} },
        { id: 'inv', type: 'hangup', config: {} },
      ],
      [
        { from: 'menu1', port: '1', to: 'sales' },
        { from: 'menu1', port: 'timeout', to: 'to' },
        { from: 'menu1', port: 'invalid', to: 'inv' },
      ],
      { main: 'menu1' },
    );
    expect(validateGraph(g)).toEqual([]);
  });

  it('flags a digit conflict: two edges wired to the same menu digit', () => {
    const g = graph(
      [
        { id: 'menu1', type: 'menu', config: { promptMediaAssetId: 'm1', timeoutSeconds: 5, maxInvalidAttempts: 3 } },
        { id: 'a', type: 'hangup', config: {} },
        { id: 'b', type: 'hangup', config: {} },
        { id: 'to', type: 'hangup', config: {} },
        { id: 'inv', type: 'hangup', config: {} },
      ],
      [
        { from: 'menu1', port: '1', to: 'a' },
        { from: 'menu1', port: '1', to: 'b' },
        { from: 'menu1', port: 'timeout', to: 'to' },
        { from: 'menu1', port: 'invalid', to: 'inv' },
      ],
      { main: 'menu1' },
    );
    const issues = validateGraph(g);
    expect(issues.some((i) => i.kind === 'digit_conflict')).toBe(true);
  });

  it('flags an invalid port name for a node type', () => {
    const g = graph(
      [
        { id: 'n1', type: 'play', config: { mediaAssetId: 'm1' } },
        { id: 'n2', type: 'hangup', config: {} },
      ],
      [{ from: 'n1', port: 'notaport', to: 'n2' }],
      { main: 'n1' },
    );
    expect(validateGraph(g).some((i) => i.kind === 'invalid_port')).toBe(true);
  });

  it('flags an unknown node type', () => {
    const g: FlowGraphInput = {
      entryPoints: { main: 'n1' },
      nodes: [{ id: 'n1', type: 'not_a_real_type', config: {} }],
      edges: [],
    };
    expect(validateGraph(g).some((i) => i.kind === 'bad_reference')).toBe(true);
  });
});
