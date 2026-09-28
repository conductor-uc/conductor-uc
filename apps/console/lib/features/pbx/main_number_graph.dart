import 'pbx_api.dart';

/// Who picks up: one person, a group of phones, or a menu of either (S9-09).
sealed class Answer {
  const Answer();
}

/// One person's extension rings.
class PersonAnswer extends Answer {
  const PersonAnswer(this.extensionId);

  final String extensionId;
}

/// A ring group's phones ring.
class GroupAnswer extends Answer {
  const GroupAnswer(this.ringGroupId);

  final String ringGroupId;
}

/// A recording asks the caller to press a digit, and each digit rings a
/// person or a group.
class MenuAnswer extends Answer {
  const MenuAnswer(this.promptMediaAssetId, this.options);

  final String promptMediaAssetId;

  /// Digit ("1") to who answers it; never another menu.
  final Map<String, Answer> options;
}

/// Everything the "Set up your main number" page asks, as the call flow it
/// becomes (S9-09): open hours (or always open), who answers, and where a
/// call goes when you're closed or no one answers: a message, or goodbye.
class MainNumberPlan {
  const MainNumberPlan({required this.answer, this.scheduleId, this.mailboxId});

  final Answer answer;

  /// The open hours; null answers the same way at any time.
  final String? scheduleId;

  /// Whose voicemail takes a message; null hangs up instead.
  final String? mailboxId;
}

/// The call flow graph for [plan]: an ordinary draft, so the flow opens in
/// the builder like any other and can be changed there later. Every step's
/// required exits are joined (a person who doesn't answer goes to the
/// message; the message ends the call), so it validates and publishes.
Json mainNumberGraph(MainNumberPlan plan) {
  final nodes = <Json>[];
  final edges = <Json>[];
  var column = 0;

  Json node(String id, String type, Json config, double x, double y) {
    final n = {
      'id': id,
      'type': type,
      'config': config,
      'position': {'x': x, 'y': y},
    };
    nodes.add(n);
    return n;
  }

  void edge(String from, String port, String to) =>
      edges.add({'from': from, 'port': port, 'to': to});

  // Where every unanswered or closed call ends up.
  node('end', 'hangup', const {}, 1360, 240);
  final String closed;
  if (plan.mailboxId != null) {
    node('message', 'voicemail', {'mailboxId': plan.mailboxId}, 1040, 240);
    edge('message', 'next', 'end');
    closed = 'message';
  } else {
    closed = 'end';
  }

  /// The step(s) for [answer], starting at [id]; returns [id].
  String answerNode(String id, Answer answer, double x, double y) {
    switch (answer) {
      case PersonAnswer(:final extensionId):
        node(
          id,
          'extension',
          {'extensionId': extensionId, 'ringSeconds': 20},
          x,
          y,
        );
        edge(id, 'noAnswer', closed);
      case GroupAnswer(:final ringGroupId):
        node(id, 'ring_group', {'ringGroupId': ringGroupId}, x, y);
        edge(id, 'noAnswer', closed);
      case MenuAnswer(:final promptMediaAssetId, :final options):
        final menu = node(
          id,
          'menu',
          {
            'promptMediaAssetId': promptMediaAssetId,
            'timeoutSeconds': 5,
            'maxInvalidAttempts': 3,
          },
          x,
          y,
        );
        menu['openPorts'] = options.keys.toList();
        edge(id, 'timeout', closed);
        edge(id, 'invalid', closed);
        var row = 0;
        for (final MapEntry(key: digit, value: option) in options.entries) {
          final target = answerNode(
            '$id-$digit',
            option,
            x + 320,
            y - 120 + 160.0 * row++,
          );
          edge(id, digit, target);
        }
    }
    return id;
  }

  final String start;
  if (plan.scheduleId != null) {
    node(
      'hours',
      'time_condition',
      {'scheduleId': plan.scheduleId},
      40.0 + 320 * column++,
      240,
    );
    final open = answerNode('answer', plan.answer, 40.0 + 320 * column, 160);
    edge('hours', 'match', open);
    edge('hours', 'noMatch', closed);
    start = 'hours';
  } else {
    start = answerNode('answer', plan.answer, 40, 160);
  }

  return {
    'entryPoints': {'main': start},
    'nodes': nodes,
    'edges': edges,
  };
}
