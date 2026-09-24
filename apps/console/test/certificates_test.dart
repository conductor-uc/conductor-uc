import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem, signInAs;

Future<void> openCertificates(WidgetTester tester) async {
  await signInAs(tester, 'master@example.test');
  await tester.tap(navItem('Certificates'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'the platform operator sees that Let\'s Encrypt is not set up yet',
    (tester) async {
      await openCertificates(tester);
      expect(find.text("Let's Encrypt"), findsOneWidget);
      expect(
        find.textContaining('Not set up. No certificates are requested'),
        findsOneWidget,
      );
      // The platform's own certificates are listed with their state.
      expect(find.text('sip.platform.example'), findsOneWidget);
      expect(find.text('console.platform.example'), findsOneWidget);
      expect(find.text('Active'), findsWidgets);
    },
  );

  testWidgets('saving an address and agreeing makes it ready', (tester) async {
    await openCertificates(tester);
    await tester.enterText(
      find.widgetWithText(TextField, 'Contact email'),
      'certs@example.test',
    );
    await tester.tap(find.byType(CheckboxListTile));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Save'));
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('Ready. Certificates are requested'),
      findsOneWidget,
    );
    expect(find.textContaining('Agreed 2026-'), findsOneWidget);
  });

  testWidgets('an address that is not one is refused, with the reason', (
    tester,
  ) async {
    await openCertificates(tester);
    await tester.enterText(
      find.widgetWithText(TextField, 'Contact email'),
      'not an email',
    );
    await tester.ensureVisible(find.widgetWithText(FilledButton, 'Save'));
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(
      find.text('Enter one email address, such as certs@example.com.'),
      findsOneWidget,
    );
    expect(find.textContaining('Not set up'), findsOneWidget);
  });

  testWidgets(
    'staging warns that its certificates are not trusted, and asks for the agreement again',
    (tester) async {
      await openCertificates(tester);
      await tester.enterText(
        find.widgetWithText(TextField, 'Contact email'),
        'certs@example.test',
      );
      await tester.tap(find.byType(CheckboxListTile));
      await tester.pumpAndSettle();
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isTrue,
      );

      await tester.tap(find.text('Staging (testing)'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Staging certificates are not trusted'),
        findsOneWidget,
      );
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
    },
  );

  testWidgets('a reseller\'s Certificates tab shows what is failing and why', (
    tester,
  ) async {
    await signInAs(tester, 'master@example.test');
    await tester.tap(find.text('Northwind Telecom'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(Tab, 'Certificates'));
    await tester.pumpAndSettle();

    expect(find.text('sip.voice.northwind.example'), findsOneWidget);
    expect(find.text('Failing'), findsOneWidget);
    expect(
      find.textContaining('found no address', findRichText: true),
      findsOneWidget,
    );
    expect(find.text('portal.northwind.example'), findsOneWidget);
  });

  testWidgets('only the platform operator has a Certificates section', (
    tester,
  ) async {
    await signInAs(tester, 'reseller@example.test');
    expect(navItem('Certificates'), findsNothing);
  });
}
