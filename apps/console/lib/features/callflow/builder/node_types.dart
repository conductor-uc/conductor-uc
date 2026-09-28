import 'package:flutter/material.dart';

import '../../../canvas/canvas.dart';
import '../../../l10n/l10n.dart';
import '../../pbx/pbx_api.dart' show Json;

enum ConfigKind { ref, integer, text, flowEntry }

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

/// The MVP node types. A getter, not a constant: their words come from the
/// ARB in the viewer's language (D-018), so they are built when asked for.
List<FlowNodeType> get flowNodeTypes {
  final l = currentL10n;
  return [
    FlowNodeType(
      type: 'play',
      label: l.nodePlay,
      icon: Icons.volume_up_outlined,
      description: l.nodePlayDescription,
      summaryKey: 'mediaAssetId',
      ports: [CanvasPort('next', l.nodePortNext)],
      fields: [
        ConfigField(
          'mediaAssetId',
          l.nodeFieldRecording,
          ConfigKind.ref,
          resource: 'media-assets',
        ),
      ],
    ),
    FlowNodeType(
      type: 'menu',
      label: l.nodeMenu,
      icon: Icons.dialpad,
      description: l.nodeMenuDescription,
      summaryKey: 'promptMediaAssetId',
      ports: [
        CanvasPort('timeout', l.nodePortNoInput),
        CanvasPort('invalid', l.nodePortInvalid),
      ],
      fields: [
        ConfigField(
          'promptMediaAssetId',
          l.nodeFieldPrompt,
          ConfigKind.ref,
          resource: 'media-assets',
        ),
        ConfigField(
          'timeoutSeconds',
          l.nodeFieldTimeoutSeconds,
          ConfigKind.integer,
          min: 1,
          initial: 5,
        ),
        ConfigField(
          'maxInvalidAttempts',
          l.nodeFieldMaxInvalidAttempts,
          ConfigKind.integer,
          min: 1,
          initial: 3,
        ),
      ],
    ),
    FlowNodeType(
      type: 'time_condition',
      label: l.nodeTimeCondition,
      icon: Icons.schedule,
      description: l.nodeTimeConditionDescription,
      summaryKey: 'scheduleId',
      ports: [
        CanvasPort('match', l.nodePortOpen),
        CanvasPort('noMatch', l.nodePortClosed),
      ],
      fields: [
        ConfigField(
          'scheduleId',
          l.nodeFieldSchedule,
          ConfigKind.ref,
          resource: 'schedules',
          help: l.nodeFieldScheduleHelp,
        ),
      ],
    ),
    FlowNodeType(
      type: 'extension',
      label: l.nodeExtension,
      icon: Icons.phone_in_talk_outlined,
      description: l.nodeExtensionDescription,
      summaryKey: 'extensionId',
      ports: [CanvasPort('noAnswer', l.nodePortNoAnswer)],
      fields: [
        ConfigField(
          'extensionId',
          l.nodeFieldExtension,
          ConfigKind.ref,
          resource: 'extensions',
        ),
        ConfigField(
          'ringSeconds',
          l.nodeFieldRingSeconds,
          ConfigKind.integer,
          min: 1,
          initial: 20,
        ),
      ],
    ),
    FlowNodeType(
      type: 'ring_group',
      label: l.nodeRingGroup,
      icon: Icons.groups_outlined,
      description: l.nodeRingGroupDescription,
      summaryKey: 'ringGroupId',
      ports: [CanvasPort('noAnswer', l.nodePortNoAnswer)],
      fields: [
        ConfigField(
          'ringGroupId',
          l.nodeFieldRingGroup,
          ConfigKind.ref,
          resource: 'ring-groups',
        ),
      ],
    ),
    FlowNodeType(
      type: 'queue',
      label: l.nodeQueue,
      icon: Icons.queue_outlined,
      description: l.nodeQueueDescription,
      summaryKey: 'queueId',
      ports: [CanvasPort('next', l.nodePortNext)],
      fields: [
        ConfigField(
          'queueId',
          l.nodeFieldQueue,
          ConfigKind.ref,
          resource: 'queues',
        ),
      ],
    ),
    FlowNodeType(
      type: 'voicemail',
      label: l.nodeVoicemail,
      icon: Icons.voicemail,
      description: l.nodeVoicemailDescription,
      summaryKey: 'mailboxId',
      ports: [CanvasPort('next', l.nodePortNext)],
      fields: [
        ConfigField(
          'mailboxId',
          l.nodeFieldMailbox,
          ConfigKind.ref,
          resource: 'voicemail/mailboxes',
        ),
      ],
    ),
    FlowNodeType(
      type: 'goto_flow',
      label: l.nodeGotoFlow,
      icon: Icons.subdirectory_arrow_right,
      description: l.nodeGotoFlowDescription,
      terminal: true,
      summaryKey: 'flowId',
      fields: [
        ConfigField(
          'flowId',
          l.nodeFieldCallFlow,
          ConfigKind.ref,
          resource: 'flows',
        ),
        ConfigField('entryPoint', l.nodeFieldStartAt, ConfigKind.flowEntry),
      ],
    ),
    FlowNodeType(
      type: 'hangup',
      label: l.nodeHangup,
      icon: Icons.call_end_outlined,
      description: l.nodeHangupDescription,
      terminal: true,
      fields: const [],
    ),
  ];
}

FlowNodeType? flowNodeType(String type) {
  for (final t in flowNodeTypes) {
    if (t.type == type) return t;
  }
  return null;
}

String portLabel(String id) {
  final l = currentL10n;
  return switch (id) {
    'timeout' => l.nodePortNoInput,
    'invalid' => l.nodePortInvalid,
    'next' => l.nodePortNext,
    'noAnswer' => l.nodePortNoAnswer,
    'match' => l.nodePortMatch,
    'noMatch' => l.nodePortNoMatch,
    _ => l.nodePortPress(id),
  };
}

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
