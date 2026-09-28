import 'package:console/app/router.dart';
import 'package:console/features/shell/shell_page.dart' show AppNavigation;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'support.dart';

/// The app's router, to read or change the address.
GoRouter routerOf(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(AppNavigation)))
        .read(routerProvider);

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
    find.descendant(of: find.byType(AppNavigation), matching: find.text(list)),
  );
  await tester.pumpAndSettle();
}

Finder navItem(String label) =>
    find.descendant(of: find.byType(AppNavigation), matching: find.text(label));

Future<void> actAs(WidgetTester tester, String tenant) async {
  final tile = find.ancestor(
    of: find.text(tenant),
    matching: find.byType(ListTile),
  );
  await tester.tap(find.descendant(of: tile, matching: find.text('Act as')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('master: resellers, then tenants, then act as one', (
    tester,
  ) async {
    await signInAs(tester, 'master@example.test');
    expect(find.text('Northwind Telecom'), findsOneWidget);
    expect(find.text('Harbor Voice'), findsOneWidget);

    await tester.tap(find.text('Northwind Telecom'));
    await tester.pumpAndSettle();
    expect(find.text('Acme Dental'), findsOneWidget);
    expect(find.text('Lakeside Realty'), findsNothing); // another reseller's

    await actAs(tester, 'Acme Dental');
    expect(find.text('Acting as Acme Dental'), findsOneWidget);
    // S9-05: a visit starts at the tenant's home.
    expect(find.text('Dashboard'), findsWidgets);
    expect(navItem('Extensions'), findsOneWidget);
    await tapNav(tester, 'Extensions');
    expect(find.text('Alice Kim'), findsOneWidget); // the tenant's own screen
    // Master can see private-data sections.
    expect(navItem('Recordings'), findsOneWidget);
    expect(navItem('Resellers'), findsNothing);
  });

  testWidgets('exiting returns to the user\'s own sections', (tester) async {
    await signInAs(tester, 'master@example.test');
    await tester.tap(find.text('Northwind Telecom'));
    await tester.pumpAndSettle();
    await actAs(tester, 'Acme Dental');

    await tester.tap(find.widgetWithText(TextButton, 'Exit'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Acting as'), findsNothing);
    expect(navItem('Resellers'), findsOneWidget);
    await tapNav(tester, 'Resellers');
    await tester.pumpAndSettle();
    expect(find.text('Northwind Telecom'), findsOneWidget);
  });

  testWidgets('a reseller acting as a tenant cannot reach private data (H1)', (
    tester,
  ) async {
    await signInAs(tester, 'reseller@example.test');
    expect(find.text('Acme Dental'), findsOneWidget);
    await actAs(tester, 'Acme Dental');

    expect(navItem('Extensions'), findsOneWidget);
    expect(navItem('Recordings'), findsNothing);
    expect(navItem('Voicemail'), findsNothing);

    // Nor by typing the URL.
    final container = ProviderScope.containerOf(
      tester.element(find.byType(AppNavigation)),
    );
    container.read(routerProvider).go('/recordings');
    await tester.pumpAndSettle();
    final router = container.read(routerProvider);
    expect(router.state.uri.path, '/forbidden');
    expect(find.text('Not available to you'), findsOneWidget);
    expect(navItem('Recordings'), findsNothing);
  });

  testWidgets('a suspended tenant cannot be entered', (tester) async {
    await signInAs(tester, 'reseller@example.test');
    final tile = find.ancestor(
      of: find.text('Old Company'),
      matching: find.byType(ListTile),
    );
    final button = tester.widget<FilledButton>(
      find.descendant(of: tile, matching: find.byType(FilledButton)),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('a tenant user has no banner and no org browsing', (
    tester,
  ) async {
    await signInAs(tester, 'tenant@example.test');
    expect(find.textContaining('Acting as'), findsNothing);
    expect(navItem('Tenants'), findsNothing);
    expect(navItem('Extensions'), findsOneWidget);
  });

  testWidgets('signing out ends the visit', (tester) async {
    await signInAs(tester, 'reseller@example.test');
    await actAs(tester, 'Acme Dental');
    await tester.tap(find.byKey(const ValueKey('account-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign out'));
    await tester.pumpAndSettle();
    await submitSignIn(tester, 'reseller@example.test');
    expect(find.textContaining('Acting as'), findsNothing);
    expect(navItem('Tenants'), findsOneWidget);
  });

  testWidgets(
    'the tenant being visited is in the address, and stays there (S9-05)',
    (tester) async {
      await signInAs(tester, 'master@example.test');
      await tester.tap(find.text('Northwind Telecom'));
      await tester.pumpAndSettle();
      await actAs(tester, 'Acme Dental');
      final router = routerOf(tester);
      expect(router.state.uri.queryParameters['as'], 't-1');

      await tapNav(tester, 'Extensions');
      expect(router.state.uri.queryParameters['as'], 't-1');

      await tester.tap(find.text('Exit'));
      await tester.pumpAndSettle();
      expect(find.text('Acting as Acme Dental'), findsNothing);
      expect(router.state.uri.queryParameters, isNot(contains('as')));
    },
  );

  testWidgets(
    'a link with a tenant in it opens the visit (a reload, a shared link)',
    (tester) async {
      await signInAs(tester, 'master@example.test');
      routerOf(tester).go('/extensions?as=t-2');
      await tester.pumpAndSettle();
      expect(find.text('Acting as Blue Bottle Cafe'), findsOneWidget);
      expect(navItem('Resellers'), findsNothing);
    },
  );

  testWidgets('Switch moves the visit to another tenant of the same reseller', (
    tester,
  ) async {
    await signInAs(tester, 'master@example.test');
    await tester.tap(find.text('Northwind Telecom'));
    await tester.pumpAndSettle();
    await actAs(tester, 'Acme Dental');
    await tester.tap(find.text('Switch'));
    await tester.pumpAndSettle();
    // Not the one already visited, nor a suspended one, nor another reseller's.
    expect(find.text('Blue Bottle Cafe'), findsOneWidget);
    expect(find.text('Old Company'), findsNothing);
    expect(find.text('Lakeside Realty'), findsNothing);
    await tester.tap(find.text('Blue Bottle Cafe'));
    await tester.pumpAndSettle();
    expect(find.text('Acting as Blue Bottle Cafe'), findsOneWidget);
  });
}
