import { Type, type Static } from '@cuc/api-contracts';

/**
 * MVP node types (S2-10's flow runner implements exactly these).
 *
 * Each type's `config` holds its own data; the edges leaving a node (its
 * "ports") are declared separately in the graph, not embedded here — see
 * `REQUIRED_PORTS` in validator.ts. Keeping ports out of the node body is what
 * lets the validator and compiler reason about the graph shape (reachability,
 * missing ports, duplicate edges) without walking into node-specific config.
 */
export const NODE_TYPES = [
  'play',
  'menu',
  'time_condition',
  'extension',
  'ring_group',
  'queue',
  'voicemail',
  'goto_flow',
  'hangup',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

const PlayConfig = Type.Object({
  mediaAssetId: Type.String({ minLength: 1 }),
});

const MenuConfig = Type.Object({
  promptMediaAssetId: Type.String({ minLength: 1 }),
  timeoutSeconds: Type.Number({ minimum: 1 }),
  maxInvalidAttempts: Type.Number({ minimum: 1 }),
});

const TimeConditionConfig = Type.Object({
  timezone: Type.String({ minLength: 1 }),
});

const ExtensionConfig = Type.Object({
  extensionId: Type.String({ minLength: 1 }),
  ringSeconds: Type.Number({ minimum: 1 }),
});

const RingGroupConfig = Type.Object({
  ringGroupId: Type.String({ minLength: 1 }),
});

const QueueConfig = Type.Object({
  queueId: Type.String({ minLength: 1 }),
});

const VoicemailConfig = Type.Object({
  mailboxId: Type.String({ minLength: 1 }),
});

const GotoFlowConfig = Type.Object({
  flowId: Type.String({ minLength: 1 }),
  entryPoint: Type.String({ minLength: 1 }),
});

const HangupConfig = Type.Object({});

/** One JSON Schema per node type, keyed the same way as `NodeType`. */
export const NODE_CONFIG_SCHEMAS = {
  play: PlayConfig,
  menu: MenuConfig,
  time_condition: TimeConditionConfig,
  extension: ExtensionConfig,
  ring_group: RingGroupConfig,
  queue: QueueConfig,
  voicemail: VoicemailConfig,
  goto_flow: GotoFlowConfig,
  hangup: HangupConfig,
} as const;

export type NodeConfigFor<T extends NodeType> = Static<(typeof NODE_CONFIG_SCHEMAS)[T]>;

/**
 * A node as authored, before it is known to be well-formed: `type` is a bare
 * string and `config` is unparsed JSON, because this is what arrives over
 * HTTP (or from a not-yet-validated draft in storage). The validator and
 * compiler are what establish that `type` is one of `NODE_TYPES` and `config`
 * matches that type's schema — nothing upstream may assume it already.
 */
export interface NodeInput {
  readonly id: string;
  readonly type: string;
  readonly config: unknown;
}

/** An authored edge: one outgoing connection from a node's named port. */
export interface EdgeInput {
  readonly from: string;
  readonly port: string;
  readonly to: string;
}

/**
 * The raw, editor-shaped graph a flow is authored as: nodes plus a separate
 * edge list, plus one or more named entry points (S2-09's "entry points" —
 * other services and flow_runner start execution at a named entry rather than
 * a single implicit root, so one flow can serve e.g. both a "main" and an
 * "after_hours" DID destination).
 */
export interface FlowGraphInput {
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly nodes: readonly NodeInput[];
  readonly edges: readonly EdgeInput[];
}

/** True when `type` is one of the MVP node types. */
export function isNodeType(type: string): type is NodeType {
  return (NODE_TYPES as readonly string[]).includes(type);
}

/** DTMF digit ports a `menu` node may wire, plus its two fixed ports. */
export const MENU_DIGIT_PORTS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'] as const;
export const MENU_FIXED_PORTS = ['timeout', 'invalid'] as const;

/**
 * Ports every node of a given type must have exactly one outgoing edge for.
 * `menu`'s digit ports are optional (an option with no edge just isn't
 * offered) so they are not listed here — only its two fixed ports are
 * required. Terminal node types (`goto_flow`, `hangup`) require none.
 */
export const REQUIRED_PORTS: Readonly<Record<NodeType, readonly string[]>> = {
  play: ['next'],
  menu: [...MENU_FIXED_PORTS],
  time_condition: ['match', 'noMatch'],
  extension: ['noAnswer'],
  ring_group: ['noAnswer'],
  queue: ['next'],
  voicemail: ['next'],
  goto_flow: [],
  hangup: [],
};

/** Every port name a node of a given type is allowed to have an edge from. */
export function allowedPorts(type: NodeType): readonly string[] {
  if (type === 'menu') return [...MENU_FIXED_PORTS, ...MENU_DIGIT_PORTS];
  return REQUIRED_PORTS[type];
}
