import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Future<void> signInAs(WidgetTester tester, String email) async {
  await completeSignIn(tester, email);
  // Everyone lands on the dashboard; these tests start from the org list.
  final list = email.startsWith('master@')
      ? 'Resellers'
      : email.startsWith('reseller@')
      ? 'Tenants'
      : null;
  if (list == null) return;
  await tester.tap(
    find.descendant(of: find.byType(NavigationRail), matching: find.text(list)),
  );
  await tester.pumpAndSettle();
}

Finder field(String label) => find.widgetWithText(TextFormField, label);

Future<void> fillNewOrg(
  WidgetTester tester, {
  String slug = 'summit',
  String name = 'Summit Voice',
}) async {
  await tester.enterText(field('Short name *'), slug);
  await tester.enterText(field('Name *'), name);
  await tester.enterText(field('Admin email *'), 'admin@summit.example');
  await tester.enterText(field('Admin name *'), 'Sam Admin');
  await tester.enterText(field('Admin password *'), 'a-long-password');
}

Future<void> openMenu(WidgetTester tester, String org, String item) async {
  final tile = find.ancestor(
    of: find.text(org),
    matching: find.byType(ListTile),
  );
  await tester.tap(
    find.descendant(of: tile, matching: find.byType(PopupMenuButton<String>)),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(item));
  await tester.pumpAndSettle();
}

void main() {
  group('resellers (master)', () {
    testWidgets('creating one adds it and names the admin sign-in', (
      tester,
    ) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('New reseller'));
      await tester.pumpAndSettle();
      await fillNewOrg(tester);
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();

      expect(find.text('Summit Voice'), findsOneWidget);
      expect(find.textContaining('admin@summit.example'), findsOneWidget);
    });

    testWidgets('the admin password is hidden while typed', (tester) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('New reseller'));
      await tester.pumpAndSettle();
      final password = tester.widget<TextField>(
        find.descendant(
          of: field('Admin password *'),
          matching: find.byType(TextField),
        ),
      );
      expect(password.obscureText, isTrue);
    });

    testWidgets('required fields are checked, and a taken name is rejected', (
      tester,
    ) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('New reseller'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Required'), findsWidgets);

      await fillNewOrg(tester, slug: 'northwind');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('The short name northwind is taken.'), findsOneWidget);
    });

    testWidgets('editing changes the name and cannot change the short name', (
      tester,
    ) async {
      await signInAs(tester, 'master@example.test');
      await openMenu(tester, 'Harbor Voice', 'Edit');
      expect(field('Short name *'), findsNothing);
      expect(find.text('Admin password *'), findsNothing);
      await tester.enterText(field('Name *'), 'Harbor Telecom');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Harbor Telecom'), findsOneWidget);
      expect(find.text('Harbor Voice'), findsNothing);
    });
  });

  group('tenants', () {
    testWidgets('a reseller creates a tenant', (tester) async {
      await signInAs(tester, 'reseller@example.test');
      await tester.tap(find.text('New tenant'));
      await tester.pumpAndSettle();
      await fillNewOrg(tester, slug: 'summit', name: 'Summit Dental');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Summit Dental'), findsOneWidget);
    });

    testWidgets('editing shows the current time zone and country', (
      tester,
    ) async {
      await signInAs(tester, 'reseller@example.test');
      await openMenu(tester, 'Acme Dental', 'Edit');
      await tester.enterText(field('Time zone'), 'America/Chicago');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      await openMenu(tester, 'Acme Dental', 'Edit');
      expect(find.text('America/Chicago'), findsOneWidget);
      expect(find.text('US'), findsOneWidget);
    });

    testWidgets(
      'suspending asks first, then blocks entering; resume restores it',
      (tester) async {
        await signInAs(tester, 'reseller@example.test');
        await openMenu(tester, 'Acme Dental', 'Suspend');
        expect(find.text('Suspend Acme Dental?'), findsOneWidget);
        await tester.tap(find.widgetWithText(FilledButton, 'Suspend'));
        await tester.pumpAndSettle();

        final tile = find.ancestor(
          of: find.text('Acme Dental'),
          matching: find.byType(ListTile),
        );
        expect(
          find.descendant(
            of: tile,
            matching: find.text('acme-dental · suspended'),
          ),
          findsOneWidget,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.descendant(of: tile, matching: find.byType(FilledButton)),
              )
              .onPressed,
          isNull,
        );

        await openMenu(tester, 'Acme Dental', 'Resume');
        await tester.tap(find.widgetWithText(FilledButton, 'Resume'));
        await tester.pumpAndSettle();
        expect(find.text('acme-dental'), findsOneWidget);
      },
    );
  });

  group('brand editor (reseller)', () {
    Future<void> openBrand(WidgetTester tester) async {
      await signInAs(tester, 'reseller@example.test');
      await tester.tap(
        find.descendant(
          of: find.byType(NavigationRail),
          matching: find.text('Brand'),
        ),
      );
      await tester.pumpAndSettle();
    }

    Finder brandField(String label) => find.widgetWithText(TextField, label);

    /// The form is taller than the test window, so bring a control into view
    /// before tapping it.
    Future<void> tapVisible(WidgetTester tester, Finder finder) async {
      // A focused field scrolls itself back into view; let go of it first.
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      await tester.ensureVisible(finder);
      await tester.pumpAndSettle();
      await tester.tap(finder);
      await tester.pumpAndSettle();
    }

    testWidgets('a draft shows in the preview and saves', (tester) async {
      await openBrand(tester);
      await tester.enterText(brandField('Display name'), 'Sample Reseller');
      await tester.enterText(brandField('Primary color'), '#4a148c');
      await tester.pumpAndSettle();
      // Once in the field, once drawn in the preview header.
      expect(find.text('Sample Reseller'), findsWidgets);

      await tapVisible(tester, find.text('Save brand'));
      expect(find.text('Brand saved.'), findsOneWidget);
    });

    testWidgets('a malformed color is rejected before sending', (tester) async {
      await openBrand(tester);
      await tester.enterText(brandField('Primary color'), 'purple');
      await tapVisible(tester, find.text('Save brand'));
      expect(
        find.text('Colors are six-digit hex values, like #4a148c.'),
        findsOneWidget,
      );
      expect(find.text('Brand saved.'), findsNothing);
    });

    testWidgets(
      'colors that do not contrast enough are refused with the reason',
      (tester) async {
        await openBrand(tester);
        await tester.enterText(brandField('Primary color'), '#4a148c');
        await tester.enterText(brandField('Accent color'), '#5e35b1');
        await tester.pumpAndSettle();
        await tapVisible(tester, find.text('Save brand'));
        expect(
          find.textContaining('WCAG AA requires at least 4.5:1'),
          findsOneWidget,
        );
        expect(find.text('Brand saved.'), findsNothing);
      },
    );

    testWidgets('a saved brand is there when the page is opened again', (
      tester,
    ) async {
      await openBrand(tester);
      await tester.enterText(brandField('Display name'), 'Kept Name');
      await tester.pumpAndSettle();
      await tapVisible(tester, find.text('Save brand'));
      await tester.tap(
        find.descendant(
          of: find.byType(NavigationRail),
          matching: find.text('Users'),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(NavigationRail),
          matching: find.text('Brand'),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Kept Name'), findsWidgets);
    });

    testWidgets('a console hostname can be added, and not twice', (
      tester,
    ) async {
      await openBrand(tester);
      expect(find.text('None yet.'), findsOneWidget);
      Future<void> add() async {
        await tapVisible(tester, find.text('Add hostname'));
        await tester.enterText(
          find.widgetWithText(TextField, 'Hostname'),
          'portal.example.com',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Add'));
        await tester.pumpAndSettle();
      }

      await add();
      expect(find.text('portal.example.com'), findsOneWidget);
      expect(find.text('TLS: pending'), findsOneWidget);

      await add();
      expect(
        find.text('portal.example.com is already a console hostname.'),
        findsOneWidget,
      );
    });
  });
}
