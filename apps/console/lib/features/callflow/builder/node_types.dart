import 'package:flutter/material.dart';

import '../../../canvas/canvas.dart';
import '../../pbx/pbx_api.dart' show Json;

enum ConfigKind { ref, integer, text, timezone, flowEntry }

/// One setting of a node type, matching a property of its IR config schema.
/// Every property of an MVP node's config is required.
class ConfigField {
  const ConfigField(
    this.key,
    this.label,
    this.kind, {
    this.resource,
    this.min,
    this.initial,
    this.help,
  });

  final String key;
  final String label;
  final ConfigKind kind;

  /// For a reference, the tenant resource it picks from.
  final String? resource;
  final int? min;
  final Object? initial;
  final String? help;
}

/// One MVP node type: how it looks in the palette, which ports it has, and
/// the settings its properties panel edits. Kept in step with
/// `@cuc/callflow-ir` by a test against `api/callflow-ir.json`.
class FlowNodeType {
  const FlowNodeType({
    required this.type,
    required this.label,
    required this.icon,
    required this.description,
    required this.fields,
    this.ports = const [],
    this.summaryKey,
    this.terminal = false,
  });

  final String type;
  final String label;
  final IconData icon;
  final String description;
  final List<ConfigField> fields;

  /// The output ports every node of this type has (all required).
  final List<CanvasPort> ports;

  /// The setting shown under the node's name.
  final String? summaryKey;
  final bool terminal;

  Json get defaults => {
    for (final f in fields)
      if (f.initial != null) f.key: f.initial,
  };
}

const menuDigits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

const flowNodeTypes = <FlowNodeType>[
  FlowNodeType(
    type: 'play',
    label: 'Play',
    icon: Icons.volume_up_outlined,
    description: 'Play a recording, then continue.',
    summaryKey: 'mediaAssetId',
    ports: [CanvasPort('next', 'Next')],
    fields: [
      ConfigField(
        'mediaAssetId',
        'Recording',
        ConfigKind.ref,
        resource: 'media-assets',
      ),
    ],
  ),
  FlowNodeType(
    type: 'menu',
    label: 'Menu',
    icon: Icons.dialpad,
    description: 'Play a prompt and route by the digit pressed.',
    summaryKey: 'promptMediaAssetId',
    ports: [
      CanvasPort('timeout', 'No input'),
      CanvasPort('invalid', 'Invalid'),
    ],
    fields: [
      ConfigField(
        'promptMediaAssetId',
        'Prompt',
        ConfigKind.ref,
        resource: 'media-assets',
      ),
      ConfigField(
        'timeoutSeconds',
        'Wait for a digit (seconds)',
        ConfigKind.integer,
        min: 1,
        initial: 5,
      ),
      ConfigField(
        'maxInvalidAttempts',
        'Invalid tries allowed',
        ConfigKind.integer,
        min: 1,
        initial: 3,
      ),
    ],
  ),
  FlowNodeType(
    type: 'time_condition',
    label: 'Time condition',
    icon: Icons.schedule,
    description: 'Route by whether it is open hours.',
    summaryKey: 'timezone',
    ports: [CanvasPort('match', 'Match'), CanvasPort('noMatch', 'No match')],
    fields: [
      ConfigField('timezone', 'Time zone', ConfigKind.timezone, initial: 'UTC'),
    ],
  ),
  FlowNodeType(
    type: 'extension',
    label: 'Extension',
    icon: Icons.phone_in_talk_outlined,
    description: 'Ring one extension.',
    summaryKey: 'extensionId',
    ports: [CanvasPort('noAnswer', 'No answer')],
    fields: [
      ConfigField(
        'extensionId',
        'Extension',
        ConfigKind.ref,
        resource: 'extensions',
      ),
      ConfigField(
        'ringSeconds',
        'Ring for (seconds)',
        ConfigKind.integer,
        min: 1,
        initial: 20,
      ),
    ],
  ),
  FlowNodeType(
    type: 'ring_group',
    label: 'Ring group',
    icon: Icons.groups_outlined,
    description: 'Ring a group of extensions.',
    summaryKey: 'ringGroupId',
    ports: [CanvasPort('noAnswer', 'No answer')],
    fields: [
      ConfigField(
        'ringGroupId',
        'Ring group',
        ConfigKind.ref,
        resource: 'ring-groups',
      ),
    ],
  ),
  FlowNodeType(
    type: 'queue',
    label: 'Queue',
    icon: Icons.queue_outlined,
    description: 'Hold the caller until an agent is free.',
    summaryKey: 'queueId',
    ports: [CanvasPort('next', 'Next')],
    fields: [
      ConfigField('queueId', 'Queue', ConfigKind.ref, resource: 'queues'),
    ],
  ),
  FlowNodeType(
    type: 'voicemail',
    label: 'Voicemail',
    icon: Icons.voicemail,
    description: 'Take a message.',
    summaryKey: 'mailboxId',
    ports: [CanvasPort('next', 'Next')],
    fields: [
      ConfigField(
        'mailboxId',
        'Mailbox',
        ConfigKind.ref,
        resource: 'voicemail/mailboxes',
      ),
    ],
  ),
  FlowNodeType(
    type: 'goto_flow',
    label: 'Go to flow',
    icon: Icons.subdirectory_arrow_right,
    description: 'Continue in another call flow.',
    terminal: true,
    summaryKey: 'flowId',
    fields: [
      ConfigField('flowId', 'Call flow', ConfigKind.ref, resource: 'flows'),
      ConfigField('entryPoint', 'Start at', ConfigKind.flowEntry),
    ],
  ),
  FlowNodeType(
    type: 'hangup',
    label: 'Hang up',
    icon: Icons.call_end_outlined,
    description: 'End the call.',
    terminal: true,
    fields: [],
  ),
];

FlowNodeType? flowNodeType(String type) {
  for (final t in flowNodeTypes) {
    if (t.type == type) return t;
  }
  return null;
}

const timezones = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Athens',
  'Africa/Johannesburg',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
];

String portLabel(String id) => switch (id) {
  'timeout' => 'No input',
  'invalid' => 'Invalid',
  'next' => 'Next',
  'noAnswer' => 'No answer',
  'match' => 'Match',
  'noMatch' => 'No match',
  '*' => 'Press *',
  '#' => 'Press #',
  _ => 'Press $id',
};

/// What the canvas holds in a node's `data`: the node's IR config, plus the
/// editor-only ports a menu shows before anything is wired to them.
extension FlowNodeData on CanvasNode {
  Json get config =>
      ((data['config'] as Map?) ?? const {}).cast<String, dynamic>();

  List<String> get openPorts => [
    ...?(data['openPorts'] as List?)?.cast<String>(),
  ];
}

Map<String, Object?> nodeData(
  Json config, [
  List<String> openPorts = const [],
]) => {'config': config, 'openPorts': openPorts};

/// The output ports of a flow node: the type's own, then a menu's digits.
List<CanvasPort> flowPortsOf(CanvasNode node) {
  final type = flowNodeType(node.type);
  if (type == null) return const [];
  return [
    ...type.ports,
    if (node.type == 'menu')
      for (final d in menuDigits)
        if (node.openPorts.contains(d)) CanvasPort(d, portLabel(d)),
  ];
}
