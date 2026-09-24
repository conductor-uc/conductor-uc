import 'package:console/features/pbx/call_handling_dialog.dart';
import 'package:console/features/pbx/pbx_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;
import 'users_test.dart' show tapIn;

Finder _key(String key) => find.byKey(Key('call-handling-$key'));

/// Opens the "Call handling" dialog of the extension numbered [number].
Future<void> _open(WidgetTester tester, String number) async {
  await openSection(tester, 'Extensions');
  // The dialog is long; leave room so nothing needs scrolling to reach.
  tester.view.physicalSize = const Size(1280, 2000);
  await tapIn(tester, number, find.byTooltip('Call handling'));
  expect(find.text('Call handling for $number'), findsOneWidget);
}

Future<void> _pick(WidgetTester tester, String key, String option) async {
  await tester.tap(_key(key));
  await tester.pumpAndSettle();
  await tester.tap(find.text(option).last);
  await tester.pumpAndSettle();
}

Future<void> _save(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Save'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('starts with everything off for an extension with nothing set', (
    tester,
  ) async {
    await _open(tester, '101');

    expect(
      tester.widget<SwitchListTile>(_key('dnd')).value,
      isFalse,
      reason: 'do not disturb is off',
    );
    // Four forwards, all "Not set", and no extra rings.
    expect(find.text('Not set'), findsNWidgets(4));
    expect(_key('ring-0-type'), findsNothing);
    expect(find.text('Also ring at the same time'), findsOneWidget);
    // Never lists the extension being edited as somewhere to send calls.
    await tester.tap(_key('always-type'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('An extension').last);
    await tester.pumpAndSettle();
    await tester.tap(_key('always-extension'));
    await tester.pumpAndSettle();
    expect(find.text('102 · Bob Osei'), findsOneWidget);
    expect(find.text('101 · Alice Kim'), findsNothing);
  });

  testWidgets('saves forwards, a no-answer time and extra rings, and shows '
      'them again next time', (tester) async {
    await _open(tester, '101');

    await _pick(tester, 'always-type', 'An outside number');
    await tester.enterText(_key('always-number'), '+14155552671');

    await _pick(tester, 'busy-type', 'An extension');
    await _pick(tester, 'busy-extension', '103 · Carol Diaz');

    await _pick(tester, 'no-answer-type', 'A voicemail');
    await tester.enterText(_key('seconds'), '35');

    await tester.tap(_key('ring-add'));
    await tester.pumpAndSettle();
    await _pick(tester, 'ring-0-type', 'An outside number');
    await tester.enterText(_key('ring-0-number'), '+14155552672');

    await _save(tester);
    expect(find.text('Call handling for 101'), findsNothing);

    // Reopen: everything is as it was saved.
    await tapIn(tester, '101', find.byTooltip('Call handling'));
    expect(
      tester.widget<TextFormField>(_key('always-number')).controller!.text,
      '+14155552671',
    );
    expect(find.text('103 · Carol Diaz'), findsOneWidget);
    expect(find.text('This extension'), findsOneWidget); // own voicemail
    expect(
      tester.widget<TextFormField>(_key('seconds')).controller!.text,
      '35',
    );
    expect(
      tester.widget<TextFormField>(_key('ring-0-number')).controller!.text,
      '+14155552672',
    );
  });

  testWidgets('another extension keeps its own settings', (tester) async {
    await _open(tester, '101');
    await _pick(tester, 'always-type', 'An outside number');
    await tester.enterText(_key('always-number'), '+14155552671');
    await _save(tester);

    await tapIn(tester, '102', find.byTooltip('Call handling'));
    expect(find.text('Call handling for 102'), findsOneWidget);
    expect(_key('always-number'), findsNothing);
    expect(find.text('Not set'), findsNWidgets(4));
  });

  testWidgets('do not disturb offers voicemail or a busy signal', (
    tester,
  ) async {
    await _open(tester, '101');
    expect(_key('dnd-action'), findsNothing);

    await tester.tap(_key('dnd'));
    await tester.pumpAndSettle();
    expect(find.text('Send callers to'), findsOneWidget);
    await _pick(tester, 'dnd-action', 'A busy signal');
    await _save(tester);

    await tapIn(tester, '101', find.byTooltip('Call handling'));
    expect(tester.widget<SwitchListTile>(_key('dnd')).value, isTrue);
    expect(find.text('A busy signal'), findsOneWidget);
  });

  testWidgets('a number that is not E.164 is refused before anything is sent', (
    tester,
  ) async {
    await _open(tester, '101');
    await _pick(tester, 'busy-type', 'An outside number');
    await tester.enterText(_key('busy-number'), '415-555-2671');
    await _save(tester);

    expect(
      find.textContaining(
        'Forward when busy: enter the number with a leading +',
      ),
      findsOneWidget,
    );
    // Still open, nothing saved.
    expect(find.text('Call handling for 101'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    await tapIn(tester, '101', find.byTooltip('Call handling'));
    expect(find.text('Not set'), findsNWidgets(4));
  });

  testWidgets('a forward to an extension needs the extension chosen', (
    tester,
  ) async {
    await _open(tester, '101');
    await _pick(tester, 'unreachable-type', 'An extension');
    await _save(tester);
    expect(
      find.text('Forward when unreachable: choose an extension.'),
      findsOneWidget,
    );
  });

  testWidgets('no-answer seconds must be 5 to 120', (tester) async {
    await _open(tester, '101');
    await _pick(tester, 'no-answer-type', 'A voicemail');
    await tester.enterText(_key('seconds'), '3');
    await _save(tester);
    expect(find.textContaining('from 5 to 120'), findsOneWidget);
  });

  testWidgets('at most five extra rings, and one can be removed', (
    tester,
  ) async {
    await _open(tester, '101');
    for (var i = 0; i < 5; i++) {
      await tester.tap(_key('ring-add'));
      await tester.pumpAndSettle();
    }
    expect(_key('ring-4-type'), findsOneWidget);
    expect(tester.widget<TextButton>(_key('ring-add')).onPressed, isNull);

    await tester.tap(_key('ring-0-remove'));
    await tester.pumpAndSettle();
    expect(_key('ring-4-type'), findsNothing);
    expect(tester.widget<TextButton>(_key('ring-add')).onPressed, isNotNull);
  });

  testWidgets('offers only the extensions that exist now', (tester) async {
    await _open(tester, '101');
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    await tapIn(tester, '103', find.byTooltip('Delete'));
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();

    await tapIn(tester, '101', find.byTooltip('Call handling'));
    await _pick(tester, 'always-type', 'An extension');
    await tester.tap(_key('always-extension'));
    await tester.pumpAndSettle();
    expect(find.text('103 · Carol Diaz'), findsNothing);
    expect(find.text('102 · Bob Osei'), findsOneWidget);
  });

  testWidgets('a rejection from the service is shown, and nothing is saved', (
    tester,
  ) async {
    await _open(tester, '101');
    await _pick(tester, 'always-type', 'An extension');
    await _pick(tester, 'always-extension', '103 · Carol Diaz');

    // The extension goes away while the dialog is open.
    final container = ProviderScope.containerOf(
      tester.element(find.byType(CallHandlingDialog)),
    );
    await tester.runAsync(
      () => container.read(pbxApiProvider)!.delete('extensions', 'ext-3'),
    );

    await _save(tester);
    expect(
      find.text("Extension 'ext-3' does not exist in this tenant."),
      findsOneWidget,
    );
    expect(find.text('Call handling for 101'), findsOneWidget);
    final stored = await tester.runAsync(
      () => container.read(pbxApiProvider)!.callHandling('ext-1'),
    );
    expect(stored, containsPair('forwardAlways', null));
  });
}
