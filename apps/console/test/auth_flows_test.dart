import 'package:console/app/app.dart';
import 'package:console/app/brand.dart';
import 'package:console/app/router.dart';
import 'package:console/core/api_client.dart';
import 'package:console/core/session.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:qr_flutter/qr_flutter.dart';

import 'support.dart';

/// Opens [path] the way a followed link would.
Future<void> goTo(WidgetTester tester, String path) async {
  final container = ProviderScope.containerOf(
    tester.element(find.byType(Scaffold).first),
  );
  container.read(routerProvider).go(path);
  await tester.pumpAndSettle();
}

Finder field(String label) => find.widgetWithText(TextField, label);

Future<void> signInStep(WidgetTester tester, String email) async {
  await tester.enterText(field('Organization ID'), 'demo');
  await tester.enterText(field('Email'), email);
  await tester.enterText(field('Password'), 'pw');
  await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
  await tester.pumpAndSettle();
}

Finder navItem(String label) => find.descendant(
  of: find.byType(NavigationRail),
  matching: find.text(label),
);

void main() {
  group('two-step verification', () {
    testWidgets(
      'a master user is asked for a code, and a wrong one is refused',
      (tester) async {
        await pumpApp(tester, appWith(api: demoApi()));
        await signInStep(tester, 'master@example.test');

        expect(find.text('Two-step verification'), findsOneWidget);
        // No access is given before the second step.
        expect(navItem('Resellers'), findsNothing);

        await tester.enterText(field('Code'), '000000');
        await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining('That code was not accepted'),
          findsOneWidget,
        );
        expect(navItem('Resellers'), findsNothing);

        await tester.enterText(field('Code'), '123456');
        await tester.tap(find.widgetWithText(FilledButton, 'Verify'));
        await tester.pumpAndSettle();
        expect(navItem('Resellers'), findsOneWidget);
      },
    );

    testWidgets('a reseller user first sets up an authenticator', (
      tester,
    ) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await signInStep(tester, 'reseller@example.test');

      expect(find.text('Set up two-step verification'), findsOneWidget);
      expect(find.byType(QrImageView), findsOneWidget);
      expect(find.text('JBSWY3DPEHPK3PXP'), findsOneWidget); // the key, by hand

      await tester.enterText(field('Code'), '123456');
      await tester.tap(find.widgetWithText(FilledButton, 'Confirm'));
      await tester.pumpAndSettle();
      expect(navItem('Tenants'), findsOneWidget);
    });

    testWidgets('a tenant user is not asked for one', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await signInStep(tester, 'tenant@example.test');
      expect(find.text('Two-step verification'), findsNothing);
      expect(navItem('Extensions'), findsOneWidget);
    });

    testWidgets('going back returns to the first step', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await signInStep(tester, 'master@example.test');
      await tester.tap(find.text('Back to sign in'));
      await tester.pumpAndSettle();
      expect(field('Email'), findsOneWidget);
    });

    testWidgets('the code page cannot be opened directly', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/login/mfa');
      expect(field('Email'), findsOneWidget); // bounced to sign in
      expect(find.text('Two-step verification'), findsNothing);
    });
  });

  group('session from the refresh cookie', () {
    test('requests ask for cookie-only transport and send cookies', () {
      final dio = createApi().dio;
      expect(dio.options.headers['x-refresh-transport'], 'cookie');
      expect(dio.options.extra['withCredentials'], isTrue);
    });

    testWidgets('a reload keeps a signed-in user signed in', (tester) async {
      final api = demoApi(); // one "browser": its cookie outlives the app
      await pumpApp(tester, appWith(api: api));
      await signInStep(tester, 'tenant@example.test');
      expect(navItem('Extensions'), findsOneWidget);

      // A reload: a brand-new app and state, the same cookie.
      final container = ProviderContainer(
        overrides: [
          brandProvider.overrideWithValue(const Brand.neutral()),
          apiProvider.overrideWithValue(api),
        ],
      );
      addTearDown(container.dispose);
      expect(
        await tester.runAsync(
          () => container.read(sessionProvider.notifier).restore(),
        ),
        isTrue,
      );
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const ConsoleApp(),
        ),
      );
      await tester.pumpAndSettle();

      expect(field('Email'), findsNothing); // never saw the sign-in page
      expect(navItem('Extensions'), findsOneWidget);
    });

    testWidgets('with no cookie, restoring finds nothing and shows sign-in', (
      tester,
    ) async {
      final api = demoApi();
      final container = ProviderContainer(
        overrides: [
          brandProvider.overrideWithValue(const Brand.neutral()),
          apiProvider.overrideWithValue(api),
        ],
      );
      addTearDown(container.dispose);
      expect(
        await tester.runAsync(
          () => container.read(sessionProvider.notifier).restore(),
        ),
        isFalse,
      );
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const ConsoleApp(),
        ),
      );
      await tester.pumpAndSettle();
      expect(field('Email'), findsOneWidget);
    });

    testWidgets(
      'signing out ends the cookie session, so a reload does not restore it',
      (tester) async {
        final api = demoApi();
        await pumpApp(tester, appWith(api: api));
        await signInStep(tester, 'tenant@example.test');
        await tester.tap(find.widgetWithText(TextButton, 'Sign out'));
        await tester.pumpAndSettle();

        final container = ProviderContainer(
          overrides: [apiProvider.overrideWithValue(api)],
        );
        addTearDown(container.dispose);
        expect(
          await tester.runAsync(
            () => container.read(sessionProvider.notifier).restore(),
          ),
          isFalse,
        );
      },
    );
  });

  group('silent refresh', () {
    /// A backend whose refresh answers with [refreshStatus], counting calls.
    ConsoleApi counting({
      required int refreshStatus,
      required List<int> calls,
    }) {
      final dio = Dio()
        ..httpClientAdapter = FakeAdapter((options) {
          switch (options.path) {
            case '/v1/auth/login':
              return jsonBody({
                'status': 'ok',
                'accessToken': fakeJwt({'org': 'o', 'ot': 'tenant'}),
                'expiresIn': 120,
              });
            case '/v1/auth/refresh':
              calls.add(1);
              return refreshStatus == 200
                  ? jsonBody({
                      'accessToken': fakeJwt({'org': 'o', 'ot': 'tenant'}),
                      'expiresIn': 120,
                    })
                  : jsonBody({}, status: refreshStatus);
          }
          return jsonBody({'rows': <Object>[]});
        });
      return ConsoleApi(dio: dio);
    }

    testWidgets('renews the session before the access token expires', (
      tester,
    ) async {
      final calls = <int>[];
      await pumpApp(
        tester,
        appWith(api: counting(refreshStatus: 200, calls: calls)),
      );
      await signInStep(tester, 'tenant@example.test');
      expect(calls, isEmpty);

      await tester.pump(const Duration(seconds: 59)); // 120s token, 60s lead
      expect(calls, isEmpty);
      await tester.pump(const Duration(seconds: 2));
      await tester.pump();
      expect(calls, hasLength(1));
      expect(navItem('Extensions'), findsOneWidget); // still signed in

      // ...and it keeps going.
      await tester.pump(const Duration(seconds: 61));
      await tester.pump();
      expect(calls, hasLength(2));
    });

    testWidgets('a rejected refresh signs the user out', (tester) async {
      final calls = <int>[];
      await pumpApp(
        tester,
        appWith(api: counting(refreshStatus: 401, calls: calls)),
      );
      await signInStep(tester, 'tenant@example.test');

      await tester.pump(const Duration(seconds: 61));
      await tester.pumpAndSettle();
      expect(calls, hasLength(1));
      expect(field('Email'), findsOneWidget);
    });
  });

  group('password reset', () {
    testWidgets('is reachable from sign-in and answers the same for anyone', (
      tester,
    ) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await tester.tap(find.text('Forgot your password?'));
      await tester.pumpAndSettle();
      expect(find.text('Reset your password'), findsOneWidget);

      await tester.tap(find.text('Send reset link'));
      await tester.pumpAndSettle();
      expect(
        find.text('Enter your organization ID and email.'),
        findsOneWidget,
      );

      await tester.enterText(field('Organization ID'), 'demo');
      await tester.enterText(field('Email'), 'nobody@example.test');
      await tester.tap(find.text('Send reset link'));
      await tester.pumpAndSettle();
      expect(find.text('Check your email'), findsOneWidget);
      expect(find.textContaining('If there is an account'), findsOneWidget);
    });

    testWidgets('a link without a token says so', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/reset/confirm');
      expect(
        find.text('This link is incomplete. Request a new one.'),
        findsOneWidget,
      );
    });

    testWidgets('a new password is checked before it is sent', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/reset/confirm?token=abc');

      await tester.enterText(field('New password'), 'short');
      await tester.enterText(field('Confirm new password'), 'short');
      await tester.tap(find.text('Change password'));
      await tester.pumpAndSettle();
      expect(find.text('Use at least 12 characters.'), findsOneWidget);

      await tester.enterText(field('New password'), 'a long enough passphrase');
      await tester.enterText(
        field('Confirm new password'),
        'a different passphrase',
      );
      await tester.tap(find.text('Change password'));
      await tester.pumpAndSettle();
      expect(find.text('The two passwords do not match.'), findsOneWidget);
    });

    testWidgets('an expired link is explained', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/reset/confirm?token=expired');
      await tester.enterText(field('New password'), 'a long enough passphrase');
      await tester.enterText(
        field('Confirm new password'),
        'a long enough passphrase',
      );
      await tester.tap(find.text('Change password'));
      await tester.pumpAndSettle();
      expect(find.textContaining('invalid or has expired'), findsOneWidget);
    });

    testWidgets('success returns to sign-in with a note', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/reset/confirm?token=good');
      await tester.enterText(field('New password'), 'a long enough passphrase');
      await tester.enterText(
        field('Confirm new password'),
        'a long enough passphrase',
      );
      await tester.tap(find.text('Change password'));
      await tester.pumpAndSettle();

      expect(find.text('Sign in'), findsWidgets);
      expect(
        find.text('Password changed. Sign in with your new password.'),
        findsOneWidget,
      );
    });
  });

  group('invitations', () {
    testWidgets('shows who it is for, then creates the account', (
      tester,
    ) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/invite?token=good');
      expect(find.text('Welcome, New Person'), findsOneWidget);
      expect(
        find.text('Choose a password for new.person@example.test.'),
        findsOneWidget,
      );

      await tester.enterText(field('Password'), 'a long enough passphrase');
      await tester.enterText(
        field('Confirm password'),
        'a long enough passphrase',
      );
      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();

      expect(
        find.text('Account created. Sign in to continue.'),
        findsOneWidget,
      );
      // The organization is filled in for them.
      final org = tester.widget<TextField>(field('Organization ID'));
      expect(org.controller!.text, 'demo-org');
    });

    testWidgets('a short password is refused before sending', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/invite?token=good');
      await tester.enterText(field('Password'), 'short');
      await tester.enterText(field('Confirm password'), 'short');
      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      expect(find.text('Use at least 12 characters.'), findsOneWidget);
    });

    testWidgets('an expired invitation is explained', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/invite?token=expired');
      expect(find.textContaining('invalid or has expired'), findsOneWidget);
      expect(find.text('Create account'), findsNothing);
    });

    testWidgets('a link without a token is invalid', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/invite');
      expect(find.textContaining('invalid or has expired'), findsOneWidget);
    });

    testWidgets('an email that already has an account is a conflict', (
      tester,
    ) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await goTo(tester, '/invite?token=taken');
      await tester.enterText(field('Password'), 'a long enough passphrase');
      await tester.enterText(
        field('Confirm password'),
        'a long enough passphrase',
      );
      await tester.tap(find.text('Create account'));
      await tester.pumpAndSettle();
      expect(find.textContaining('already has an account'), findsOneWidget);
    });
  });
}
