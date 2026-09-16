import { Check } from 'typebox/value';

import { isNodeType, NODE_CONFIG_SCHEMAS } from './nodes.js';
import type { FlowGraphInput, NodeConfigFor, NodeType } from './nodes.js';
import { validateGraph, type ValidationIssue } from './validator.js';

/** One compiled node: its config plus its resolved outgoing ports, inline. */
export type CompiledNode = {
  readonly [T in NodeType]: {
    readonly id: string;
    readonly type: T;
    readonly config: NodeConfigFor<T>;
    /** Port name -> target node id. Only ports with a wired edge appear. */
    readonly ports: Readonly<Record<string, string>>;
  };
}[NodeType];

/**
 * The canonical IR: nodes keyed by id with their edges resolved inline, so a
 * consumer (flow_runner.lua) walks the graph by port lookup alone and never
 * needs the separate edge list the graph was authored with.
 */
export interface FlowIR {
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly nodes: Readonly<Record<string, CompiledNode>>;
}

export class CompileError extends Error {
  override readonly name = 'CompileError';
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(
      `Graph failed validation:\n${issues.map((i) => `  - [${i.kind}] ${i.message}`).join('\n')}`,
    );
    this.issues = issues;
  }
}

/**
 * Compiles a raw, editor-shaped graph into the canonical IR.
 *
 * Throws `CompileError` (carrying every issue, not just the first) when
 * `validateGraph` finds anything wrong — a flow only compiles when it is
 * fully valid, matching `:publish`'s all-or-nothing behavior in
 * callflow-service.
 */
export function compileGraph(graph: FlowGraphInput): FlowIR {
  const issues = validateGraph(graph);
  if (issues.length > 0) throw new CompileError(issues);

  const nodes: Record<string, CompiledNode> = {};
  for (const node of graph.nodes) {
    // isNodeType is guaranteed true here: validateGraph would have raised a
    // bad_reference issue (and thus thrown above) for any other type.
    if (!isNodeType(node.type)) continue;

    const schema = NODE_CONFIG_SCHEMAS[node.type];
    if (!Check(schema, node.config)) {
      throw new CompileError([
        {
          kind: 'bad_reference',
          message: `Node '${node.id}' config does not match the '${node.type}' schema.`,
          nodeId: node.id,
        },
      ]);
    }

    const ports: Record<string, string> = {};
    for (const edge of graph.edges) {
      if (edge.from === node.id) ports[edge.port] = edge.to;
    }

    nodes[node.id] = {
      id: node.id,
      type: node.type,
      config: node.config,
      ports,
    } as CompiledNode;
  }

  return { entryPoints: graph.entryPoints, nodes };
}
