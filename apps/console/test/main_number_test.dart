import 'package:console/features/callflow/builder/flow_graph.dart';
import 'package:console/features/callflow/builder/local_validation.dart';
import 'package:console/features/pbx/main_number_graph.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;

/// S9-09: the main number set up without the call flow editor.
/// Picks [option] from the page's dropdown labeled [label].
Future<void> pick(WidgetTester tester, String label, String option) async {
  final field = find.widgetWithText(DropdownButtonFormField<String>, label);
  await tester.ensureVisible(field);
  await tester.pumpAndSettle();
  await tester.tap(field);
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

Future<void> press(WidgetTester tester, Finder target) async {
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
  await tester.tap(target);
  await tester.pumpAndSettle();
}

void main() {
  List<String> problems(MainNumberPlan plan) => [
    for (final i in validateFlow(FlowGraph.fromJson(mainNumberGraph(plan))))
      i.message,
  ];

  group('the call flow it builds validates', () {
    test('one person, always open, no voicemail', () {
      expect(
        problems(const MainNumberPlan(answer: PersonAnswer('ext-1'))),
        isEmpty,
      );
    });

    test('a group in open hours, a message when closed', () {
      final graph = mainNumberGraph(
        const MainNumberPlan(
          answer: GroupAnswer('rg-1'),
          scheduleId: 'sch-1',
          mailboxId: 'mb-1',
        ),
      );
      expect(validateFlow(FlowGraph.fromJson(graph)), isEmpty);
      expect((graph['entryPoints'] as Map)['main'], 'hours');
    });

    test('a menu of a person and a group, with voicemail', () {
      expect(
        problems(
          const MainNumberPlan(
            answer: MenuAnswer('media-1', {
              '1': PersonAnswer('ext-1'),
              '2': GroupAnswer('rg-1'),
            }),
            scheduleId: 'sch-1',
            mailboxId: 'mb-1',
          ),
        ),
        isEmpty,
      );
    });
  });

  testWidgets(
    'a number routes to a menu in business hours and voicemail after hours, '
    'without the editor, and the result is an ordinary flow',
    (tester) async {
      tester.view.physicalSize = const Size(1600, 2600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await openSection(tester, 'Phone numbers');
      await tester.tap(find.text('Set up main number'));
      await tester.pumpAndSettle();
      expect(find.text('Set up your main number'), findsOneWidget);

      await press(tester, find.byKey(const ValueKey('hours-new')));
      await press(tester, find.byKey(const ValueKey('who-menu')));
      await pick(tester, 'Greeting to play', 'Welcome greeting');
      await press(tester, find.byKey(const ValueKey('option-1-true')));
      await tester.tap(find.text('101 · Alice Kim').last);
      await tester.pumpAndSettle();
      await press(tester, find.text('Finish'));

      for (final e in find.byType(Text).evaluate()) {
        final t = (e.widget as Text).data;
        if (t != null) debugPrint('TEXT: $t');
      }
      // In the call flow editor, with the flow it made.
      expect(find.text('Validate'), findsOneWidget);
      expect(find.textContaining('is set up'), findsOneWidget);
      expect(find.text('Menu'), findsWidgets);
      expect(find.text('Time condition'), findsWidgets);
    },
  );
}
