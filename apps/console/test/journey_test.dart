import 'package:console/dev/demo_backend.dart';
import 'package:console_api/console_api.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'callflow/builder_test.dart' show addStep, letSave;
import 'pbx_test.dart' show pickFromDropdown;
import 'support.dart';

/// The console's walk through the M2 pilot journey (plan S3-11), against the
/// in-memory demo backend, which keeps state across sign-outs the way the real
/// services do. `tests/e2e` walks the same journey over HTTP against the real
/// services. Each persona signs in the way a person does, so the second
/// factor, the role-based navigation, and acting as a tenant are all exercised.

Finder navItem(String label) => find.descendant(
  of: find.byType(NavigationRail),
  matching: find.text(label),
);

Finder field(String label) => find.widgetWithText(TextFormField, label);

Future<void> openNav(WidgetTester tester, String label) async {
  await tester.tap(navItem(label));
  await tester.pumpAndSettle();
}

Future<void> save(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Save'));
  await tester.pumpAndSettle();
}

Future<void> signOut(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
  await tester.pumpAndSettle();
}

/// The form is taller than the test window.
Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'master creates a reseller; the reseller brands the console and creates a tenant; the tenant is configured and a flow published',
    (tester) async {
      final ConsoleApi api = demoApi();

      // 1. The master signs in with a second factor and creates a reseller.
      await pumpApp(tester, appWith(api: api));
      await submitSignIn(tester, 'master@example.test');
      expect(navItem('Resellers'), findsOneWidget);
      await openNav(tester, 'Resellers');
      await tester.tap(find.text('New reseller'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Short name *'), 'summit');
      await tester.enterText(field('Name *'), 'Summit Voice');
      await tester.enterText(field('Admin email *'), 'admin@summit.example');
      await tester.enterText(field('Admin name *'), 'Sam Admin');
      await tester.enterText(field('Admin password *'), 'a-long-password');
      await save(tester);
      expect(find.text('Summit Voice'), findsOneWidget);
      await signOut(tester);

      // 2. A reseller brands the console and creates a tenant.
      await submitSignIn(tester, 'reseller@example.test');
      expect(navItem('Tenants'), findsOneWidget);
      await openNav(tester, 'Brand');
      final displayName = find.widgetWithText(TextField, 'Display name');
      await tester.enterText(displayName, 'Summit Voice');
      await tester.enterText(
        find.widgetWithText(TextField, 'Primary color'),
        '#4a148c',
      );
      await tester.enterText(
        find.widgetWithText(TextField, 'Accent color'),
        '#ffe082',
      );
      await tapVisible(tester, find.text('Save brand'));
      expect(find.text('Brand saved.'), findsOneWidget);

      await openNav(tester, 'Tenants');
      await tester.tap(find.text('New tenant'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Short name *'), 'bright-dental');
      await tester.enterText(field('Name *'), 'Bright Dental');
      await tester.enterText(field('Admin email *'), 'admin@dental.example');
      await tester.enterText(field('Admin name *'), 'Dee Admin');
      await tester.enterText(field('Admin password *'), 'a-long-password');
      await save(tester);
      expect(find.text('Bright Dental'), findsOneWidget);

      // 3. Trunks: the section is there for a reseller, but it has no screen
      //    yet, so a trunk cannot be added from the console.
      await openNav(tester, 'Trunks');
      expect(find.text('New trunk'), findsNothing);
      await signOut(tester);

      // 4. The tenant admin signs in with no second factor, sees only tenant
      //    sections, and configures extensions, a ring group, a number and a flow.
      await submitSignIn(tester, 'tenant@example.test');
      expect(navItem('Resellers'), findsNothing);
      expect(navItem('Extensions'), findsOneWidget);

      await openNav(tester, 'Extensions');
      await tester.tap(find.text('New extension'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Number *'), '110');
      await tester.enterText(field('Name *'), 'Front Desk');
      await pickFromDropdown(tester, 'Emergency location *', 'Head office');
      await save(tester);
      expect(find.text('Front Desk'), findsOneWidget);

      await openNav(tester, 'Ring groups');
      await tester.tap(find.text('New ring group'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name *'), 'Reception');
      await tester.tap(find.widgetWithText(FilterChip, '110 · Front Desk'));
      await tester.pumpAndSettle();
      await save(tester);
      expect(find.text('Reception'), findsOneWidget);

      await openNav(tester, 'Media');
      expect(find.text('Welcome greeting'), findsOneWidget);

      // A flow, built on the canvas: one hang-up step is where calls start, and
      // it publishes.
      await openNav(tester, 'Call flows');
      await tester.tap(find.text('New call flow'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'After hours');
      await tester.tap(find.widgetWithText(FilledButton, 'Create'));
      await tester.pumpAndSettle();
      await addStep(tester, 'hangup');
      expect(find.byKey(const ValueKey('problem-count')), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Publish'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Publish').last);
      await tester.pumpAndSettle();
      expect(find.text('Published version 1.'), findsOneWidget);
      await letSave(tester);

      // A number that rings the flow.
      await openNav(tester, 'Phone numbers');
      await tester.tap(find.text('New phone number'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Number *'), '+14155550111');
      await pickFromDropdown(tester, 'Trunk *', 'Primary trunk');
      await pickFromDropdown(tester, 'Rings *', 'flow');
      await pickFromDropdown(tester, 'Destination *', 'After hours');
      await save(tester);
      expect(find.text('+14155550111'), findsOneWidget);
    },
  );
}
