import 'package:console/canvas/canvas.dart';
import 'package:console/features/callflow/builder/node_header.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../pbx_test.dart' show openSection;

Future<void> openBuilder(WidgetTester tester) async {
  await openSection(tester, 'Call flows');
  await tester.tap(find.text('Main menu'));
  await tester.pumpAndSettle();
}

/// Waits out the autosave delay and the save.
Future<void> letSave(WidgetTester tester) async {
  await tester.pump(const Duration(seconds: 2));
  await tester.pumpAndSettle();
}

Finder headerOf(String label) =>
    find.descendant(of: find.byType(NodeHeader), matching: find.text(label));

Future<void> addStep(WidgetTester tester, String type) async {
  final tile = find.byKey(ValueKey('palette-$type'));
  await tester.ensureVisible(tile);
  await tester.pumpAndSettle();
  await tester.tap(tile);
  await tester.pumpAndSettle();
}

Future<void> select(WidgetTester tester, String label) async {
  await tester.tapAt(tester.getCenter(headerOf(label).first));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('golden: the builder with a flow open', (tester) async {
    await openBuilder(tester);
    await select(tester, 'Menu');
    await expectLater(
      find.byType(MaterialApp),
      matchesGoldenFile('../goldens/flow_builder.png'),
    );
  });

  testWidgets('opens a flow with its steps, laid out, and no problems', (
    tester,
  ) async {
    await openBuilder(tester);
    expect(find.text('Main menu'), findsWidgets);
    for (final label in ['Menu', 'Ring group', 'Voicemail', 'Hang up']) {
      expect(headerOf(label), findsOneWidget, reason: label);
    }
    // The pickers' names show under each step, not their ids.
    expect(
      find.descendant(
        of: find.byType(NodeHeader),
        matching: find.text('Welcome greeting'),
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('problem-count')), findsNothing);
    expect(find.byKey(const ValueKey('save-status')), findsOneWidget);
    expect(find.text('Saved'), findsOneWidget);
  });

  testWidgets('a step from the palette is added, flagged, and autosaved', (
    tester,
  ) async {
    await openBuilder(tester);
    await addStep(tester, 'queue');
    expect(headerOf('Queue'), findsOneWidget);
    expect(find.text('Unsaved changes'), findsOneWidget);
    // It is not connected, not set up, and cannot be reached.
    expect(find.byKey(const ValueKey('problem-count')), findsOneWidget);
    // Selecting it shows its form, with what is wrong.
    expect(find.text('Queue: choose queue.'), findsOneWidget);

    await letSave(tester);
    expect(find.text('Saved'), findsOneWidget);
  });

  testWidgets('a step dragged from the palette lands where it is dropped', (
    tester,
  ) async {
    await openBuilder(tester);
    final tile = find.byKey(const ValueKey('palette-extension'));
    final gesture = await tester.startGesture(tester.getCenter(tile));
    await gesture.moveBy(const Offset(20, 0));
    await gesture.moveTo(const Offset(600, 500));
    await tester.pump();
    await gesture.moveTo(const Offset(620, 520));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();
    expect(headerOf('Extension'), findsOneWidget);
    await letSave(tester);
  });

  testWidgets('editing a step is one undo step and reflected on the node', (
    tester,
  ) async {
    await openBuilder(tester);
    await select(tester, 'Menu');
    final field = find.widgetWithText(TextField, 'Wait for a digit (seconds)');
    expect(field, findsOneWidget);
    expect(tester.widget<TextField>(field).controller!.text, '5');
    await tester.enterText(field, '9');
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).controller!.text, '9');

    await tester.tap(find.byTooltip('Undo'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).controller!.text, '5');
    await tester.tap(find.byTooltip('Redo'));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(field).controller!.text, '9');
    await letSave(tester);
  });

  testWidgets('a number below its minimum is flagged', (tester) async {
    await openBuilder(tester);
    await select(tester, 'Menu');
    await tester.enterText(
      find.widgetWithText(TextField, 'Wait for a digit (seconds)'),
      '0',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('At least 1'), findsOneWidget);
    expect(find.byKey(const ValueKey('problem-count')), findsOneWidget);
    await letSave(tester);
  });

  testWidgets(
    'menu keys add and remove exits, and removing drops the connection',
    (tester) async {
      await openBuilder(tester);
      await select(tester, 'Menu');
      expect(find.text('Press 1'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('digit-2')));
      await tester.pumpAndSettle();
      expect(find.text('Press 2'), findsOneWidget);

      // Key 1 led to the ring group; without it that step is unreachable.
      await tester.tap(find.byKey(const ValueKey('digit-1')));
      await tester.pumpAndSettle();
      expect(find.text('Press 1'), findsNothing);
      expect(find.byKey(const ValueKey('problem-count')), findsOneWidget);
      await tester.tap(find.byTooltip('Undo'));
      await tester.pumpAndSettle();
      expect(find.text('Press 1'), findsOneWidget);
      expect(find.byKey(const ValueKey('problem-count')), findsNothing);
      await letSave(tester);
    },
  );

  testWidgets('the Flow tab lists starts and can add one', (tester) async {
    await openBuilder(tester);
    expect(find.byKey(const ValueKey('start-main')), findsOneWidget);
    await tester.tap(find.text('Add a start'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('start-start2')), findsOneWidget);
    await tester.tap(find.byTooltip('Remove this start').last);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('start-start2')), findsNothing);
    await letSave(tester);
  });

  testWidgets('a step can be made a start, with a name', (tester) async {
    await openBuilder(tester);
    await select(tester, 'Hang up');
    await tester.tap(find.text('Start a call here'));
    await tester.pumpAndSettle();
    expect(find.text('Name this start'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 'main');
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pumpAndSettle();
    expect(find.text('That name is already a start'), findsOneWidget);
    await tester.enterText(find.byType(TextField).last, 'after-hours');
    await tester.tap(find.widgetWithText(FilledButton, 'Add'));
    await tester.pumpAndSettle();
    expect(find.text('Start: after-hours'), findsOneWidget);
    await letSave(tester);
  });

  testWidgets('Validate asks the service and reports', (tester) async {
    await openBuilder(tester);
    await tester.tap(find.widgetWithText(OutlinedButton, 'Validate'));
    await tester.pumpAndSettle();
    expect(find.text('The service says this flow is valid.'), findsOneWidget);
  });

  testWidgets('publish shows what changed, then publishes', (tester) async {
    await openBuilder(tester);
    await addStep(tester, 'hangup');
    // A lone new step is unreachable, so publishing is blocked...
    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();
    expect(find.text('Fix these before publishing'), findsOneWidget);
    await tester.tap(find.text('Close'));
    await tester.pumpAndSettle();

    // ...until it is removed again.
    await tester.tap(find.byTooltip('Delete this step'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();
    expect(find.text('Publish this flow?'), findsOneWidget);
    expect(find.text('Nothing has changed since version 1.'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Publish').last);
    await tester.pumpAndSettle();
    expect(find.text('Published version 2.'), findsOneWidget);

    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('version-2')), findsOneWidget);
    expect(find.text('Live'), findsOneWidget);
    await letSave(tester);
  });

  testWidgets('the publish summary names what was added and changed', (
    tester,
  ) async {
    await openBuilder(tester);
    await select(tester, 'Menu');
    await tester.enterText(
      find.widgetWithText(TextField, 'Wait for a digit (seconds)'),
      '8',
    );
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Changes since version 1'), findsOneWidget);
    expect(find.text('• Menu (greet)'), findsOneWidget);
    await letSave(tester);
  });

  testWidgets('roll back and open an older version as the draft', (
    tester,
  ) async {
    await openBuilder(tester);
    await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Publish').last);
    await tester.pumpAndSettle();

    await tester.tap(find.text('History'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Roll back to this'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Roll back'));
    await tester.pumpAndSettle();
    expect(find.text('Rolled back to version 1.'), findsOneWidget);

    await tester.tap(find.text('Open as draft').first);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Replace draft'));
    await tester.pumpAndSettle();
    expect(find.text('Draft replaced with version 2.'), findsOneWidget);
    await letSave(tester);
  });

  testWidgets(
    'a new empty flow shows nothing to publish, and adding the first step starts calls there',
    (tester) async {
      await openSection(tester, 'Call flows');
      await tester.tap(find.text('New call flow'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'After hours');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();
      expect(find.text('After hours'), findsOneWidget);
      expect(
        find.text('No start yet. A call has nowhere to go.'),
        findsOneWidget,
      );

      await addStep(tester, 'hangup');
      await tester.tap(find.text('Flow'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('start-main')), findsOneWidget);
      // The one step is a start and needs nothing else.
      expect(find.byKey(const ValueKey('problem-count')), findsNothing);
      await letSave(tester);
    },
  );

  testWidgets('the canvas is the generic engine, not telephony', (
    tester,
  ) async {
    await openBuilder(tester);
    expect(find.byType(CanvasView), findsOneWidget);
  });
}
