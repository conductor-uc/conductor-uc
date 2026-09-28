import '../../l10n/l10n.dart';
import '../pbx/pbx_api.dart';
import 'builder/node_types.dart';

/// A starting point for a new call flow (S9-10): the shape of a common
/// setup, with the choices it needs (which schedule, which group, whose
/// voicemail) left for the builder to ask for.
class FlowTemplate {
  const FlowTemplate({
    required this.id,
    required this.title,
    required this.description,
    this.graph,
  });

  final String id;
  final String title;
  final String description;

  /// The draft to start from; null starts empty.
  final Json? graph;
}

/// A step of [type] at [x], [y], with the type's own defaults filled in.
Json _node(
  String id,
  String type,
  double x,
  double y, [
  List<String> openPorts = const [],
]) => {
  'id': id,
  'type': type,
  'config': {...?flowNodeType(type)?.defaults},
  'position': {'x': x, 'y': y},
  if (openPorts.isNotEmpty) 'openPorts': openPorts,
};

Json _edge(String from, String port, String to) => {
  'from': from,
  'port': port,
  'to': to,
};

/// The templates offered when a flow is created, in the viewer's language.
List<FlowTemplate> flowTemplates(AppLocalizations l) => [
  FlowTemplate(
    id: 'blank',
    title: l.flowTemplateBlank,
    description: l.flowTemplateBlankHelp,
  ),
  FlowTemplate(
    id: 'hours',
    title: l.flowTemplateHours,
    description: l.flowTemplateHoursHelp,
    graph: {
      'entryPoints': {'main': 'hours'},
      'nodes': [
        _node('hours', 'time_condition', 40, 120),
        _node('answer', 'ring_group', 360, 40),
        _node('closed', 'voicemail', 680, 200),
      ],
      'edges': [
        _edge('hours', 'match', 'answer'),
        _edge('hours', 'noMatch', 'closed'),
        _edge('answer', 'noAnswer', 'closed'),
      ],
    },
  ),
  FlowTemplate(
    id: 'menu',
    title: l.flowTemplateMenu,
    description: l.flowTemplateMenuHelp,
    graph: {
      'entryPoints': {'main': 'menu'},
      'nodes': [
        _node('menu', 'menu', 40, 120, const ['1', '2']),
        _node('option1', 'extension', 360, 20),
        _node('option2', 'extension', 360, 200),
        _node('messages', 'voicemail', 680, 120),
      ],
      'edges': [
        _edge('menu', '1', 'option1'),
        _edge('menu', '2', 'option2'),
        _edge('menu', 'timeout', 'messages'),
        _edge('menu', 'invalid', 'messages'),
        _edge('option1', 'noAnswer', 'messages'),
        _edge('option2', 'noAnswer', 'messages'),
      ],
    },
  ),
];
