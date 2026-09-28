import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem, signInAs;

Future<void> openSecurity(WidgetTester tester) async {
  await signInAs(tester, 'master@example.test');
  await tester.tap(navItem('Security'));
  await tester.pumpAndSettle();
}

Finder get _switch => find.byKey(const ValueKey('require-two-step'));

void main() {
  testWidgets('a new platform does not require two-step verification yet', (
    tester,
  ) async {
    await openSecurity(tester);
    expect(tester.widget<SwitchListTile>(_switch).value, isFalse);
    expect(find.textContaining('Off. Turn this on once'), findsOneWidget);
  });

  testWidgets('turning it on needs no code', (tester) async {
    await openSecurity(tester);
    await tester.tap(_switch);
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(tester.widget<SwitchListTile>(_switch).value, isTrue);
    expect(
      find.textContaining('On. Administrators who have not'),
      findsOneWidget,
    );
  });

  testWidgets(
    'turning it off asks for your own code, and a wrong one keeps it on',
    (tester) async {
      await openSecurity(tester);
      await tester.tap(_switch);
      await tester.pumpAndSettle();

      await tester.tap(_switch);
      await tester.pumpAndSettle();
      expect(
        find.text('Stop requiring two-step verification?'),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const ValueKey('step-up-code')),
        '000000',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Turn off'));
      await tester.pumpAndSettle();
      expect(find.textContaining('That code did not work'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('step-up-code')),
        '123456',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Turn off'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.widget<SwitchListTile>(_switch).value, isFalse);
    },
  );

  testWidgets('a reseller does not see it', (tester) async {
    await signInAs(tester, 'reseller@example.test');
    expect(navItem('Security'), findsNothing);
  });
}
