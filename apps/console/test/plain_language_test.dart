import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;
import 'users_test.dart' show tapIn;

/// S9-08: the configuration screens in plain words, and never a delete that
/// quietly breaks something else.
void main() {
  Future<void> wide(WidgetTester tester) async {
    tester.view.physicalSize = const Size(2400, 1800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('deleting something says what else uses it', (tester) async {
    await wide(tester);
    await openSection(tester, 'Extensions');
    await tapIn(tester, 'Alice Kim', find.byTooltip('Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Delete this extension?'), findsOneWidget);
    expect(find.text('This also affects:'), findsOneWidget);
    expect(find.text('Ring group: Sales'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
  });

  testWidgets('editing something says what uses it', (tester) async {
    await wide(tester);
    await openSection(tester, 'Extensions');
    await tapIn(tester, 'Alice Kim', find.byTooltip('Edit'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Used by: '), findsOneWidget);
    expect(find.textContaining('Ring group: Sales'), findsOneWidget);
  });

  testWidgets('choices are in plain words, each explained', (tester) async {
    await wide(tester);
    await openSection(tester, 'Ring groups');
    await tester.tap(find.text('New ring group').first);
    await tester.pumpAndSettle();
    // The default, explained under the field (and Sales, behind, says it too).
    expect(find.text('All at once'), findsWidgets);
    expect(
      find.text('Every phone rings; the first to answer takes the call.'),
      findsOneWidget,
    );
    await tester.tap(
      find.widgetWithText(DropdownButtonFormField<String?>, 'How they ring *'),
    );
    await tester.pumpAndSettle();
    expect(find.text('Taking turns'), findsWidgets);
    expect(
      find.text(
        'Starts with the next person each time, so calls are shared out.',
      ),
      findsOneWidget,
    );
  });

  testWidgets('a phone number says who answers, as people write it', (
    tester,
  ) async {
    await wide(tester);
    await openSection(tester, 'Phone numbers');
    expect(find.text('(415) 555-0100'), findsOneWidget);
    expect(find.text('Who answers'), findsOneWidget);
    expect(find.text('A call flow'), findsOneWidget);
  });
}
