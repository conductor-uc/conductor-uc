import 'package:console/core/acting.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/features/dashboard/tenant_home.dart';
import 'package:console/features/orgs/new_tenant_page.dart';
import 'package:console/features/security/security_page.dart';
import 'package:console/features/shell/shell_page.dart' show AppNavigation;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Future<void> signIn(WidgetTester tester, String email) async {
  await pumpApp(tester, appWith(api: demoApi()));
  tester.view.physicalSize = const Size(1280, 1100);
  await submitSignIn(tester, email);
}

Future<void> tapKey(WidgetTester tester, String key) async {
  final finder = find.byKey(ValueKey(key));
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

void main() {
  group('the new-tenant wizard (S9-16)', () {
    testWidgets(
      'starts from the reseller home, and checks each step before the next',
      (tester) async {
        await signIn(tester, 'reseller@example.test');
        await tapKey(tester, 'org-home-create');
        expect(find.byType(NewTenantPage), findsOneWidget);

        // Nothing entered: said, and not moved on.
        await tapKey(tester, 'nt-next');
        expect(find.text('Enter their name.'), findsOneWidget);

        // The short name follows the name, until it is edited.
        await tester.enterText(
          find.byKey(const ValueKey('nt-name')),
          'Summit Dental & Co.',
        );
        await tester.pump();
        expect(
          tester
              .widget<TextField>(find.byKey(const ValueKey('nt-slug')))
              .controller!
              .text,
          'summit-dental-co',
        );
        await tapKey(tester, 'nt-next');
        expect(find.text('Who looks after their phones'), findsOneWidget);

        await tester.enterText(
          find.byKey(const ValueKey('nt-admin-name')),
          'Pat Admin',
        );
        await tester.enterText(
          find.byKey(const ValueKey('nt-admin-email')),
          'not-an-address',
        );
        await tapKey(tester, 'nt-next');
        expect(
          find.text('Enter an email address, like name@example.com.'),
          findsOneWidget,
        );
        // A password was made up; it is long enough.
        final password = tester
            .widget<TextField>(find.byKey(const ValueKey('nt-password')))
            .controller!
            .text;
        expect(password.length, 16);
      },
    );

    testWidgets('a taken short name sends them back to it', (tester) async {
      await signIn(tester, 'reseller@example.test');
      await tapKey(tester, 'org-home-create');
      await tester.enterText(
        find.byKey(const ValueKey('nt-name')),
        'Acme Dental',
      );
      await tapKey(tester, 'nt-next');
      await tester.enterText(
        find.byKey(const ValueKey('nt-admin-name')),
        'Pat Admin',
      );
      await tester.enterText(
        find.byKey(const ValueKey('nt-admin-email')),
        'pat@acme.example',
      );
      await tapKey(tester, 'nt-next');
      await tapKey(tester, 'nt-create');
      expect(
        find.text('That short name is taken. Choose another.'),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('nt-slug')), findsOneWidget);
    });

    testWidgets('ends with the sign-in details and a way into their setup', (
      tester,
    ) async {
      await signIn(tester, 'reseller@example.test');
      await tapKey(tester, 'org-home-create');
      await tester.enterText(
        find.byKey(const ValueKey('nt-name')),
        'Harbor Clinic',
      );
      await tapKey(tester, 'nt-next');
      await tester.enterText(
        find.byKey(const ValueKey('nt-admin-name')),
        'Sam Admin',
      );
      await tester.enterText(
        find.byKey(const ValueKey('nt-admin-email')),
        'sam@harbor.example',
      );
      await tapKey(tester, 'nt-next');
      expect(find.text('harbor-clinic'), findsWidgets);
      await tapKey(tester, 'nt-create');

      expect(find.text('Harbor Clinic is ready.'), findsOneWidget);
      final details = tester
          .widget<SelectableText>(find.byKey(const ValueKey('nt-details')))
          .data!;
      expect(details, contains('Email: sam@harbor.example'));
      expect(details, contains('Password: '));

      await tapKey(tester, 'nt-set-up');
      final container = ProviderScope.containerOf(
        tester.element(find.byType(AppNavigation)),
      );
      expect(container.read(actingProvider)?.name, 'Harbor Clinic');
      expect(find.byType(TenantHome), findsOneWidget);
    });
  });

  group('homes that say what needs attention (S9-16)', () {
    testWidgets(
      'the master is told two-step verification is off, and taken to it',
      (tester) async {
        await signIn(tester, 'master@example.test');
        expect(find.byKey(const ValueKey('attention-mfa')), findsOneWidget);
        await tapKey(tester, 'attention-mfa');
        expect(find.byType(SecurityPage), findsOneWidget);
      },
    );

    testWidgets('a reseller sees their attention items and main action', (
      tester,
    ) async {
      await signIn(tester, 'reseller@example.test');
      expect(find.byKey(const ValueKey('org-home-attention')), findsOneWidget);
      expect(find.text('Set up a new tenant'), findsOneWidget);
      expect(find.text('At a glance'), findsOneWidget);
    });
  });
}
