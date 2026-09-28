import 'dart:convert';
import 'dart:typed_data';

import 'package:console/app/app.dart';
import 'package:console/app/brand.dart';
import 'package:console/core/api_client.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:console/l10n/l10n.dart';
import 'package:console/features/shell/shell_page.dart' show AppNavigation;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_riverpod/misc.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

/// A Dio adapter that answers from a function, so tests drive the real
/// generated client without a network.
class FakeAdapter implements HttpClientAdapter {
  FakeAdapter(this.handler);

  final ResponseBody Function(RequestOptions options) handler;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async => handler(options);

  @override
  void close({bool force = false}) {}
}

ResponseBody jsonBody(Object body, {int status = 200}) =>
    ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

String fakeJwt(Map<String, Object?> claims) {
  String part(Object o) =>
      base64Url.encode(utf8.encode(jsonEncode(o))).replaceAll('=', '');
  return '${part({'alg': 'none'})}.${part(claims)}.sig';
}

const sampleBrand = Brand(
  displayName: 'Sample Reseller',
  primary: Color(0xFF4A148C),
  accent: Color(0xFFFFE082),
  legalFooter: 'Sample Reseller Ltd.',
);

Widget appWith({
  Brand brand = const Brand.neutral(),
  ConsoleApi? api,
  List<Override> overrides = const [],
}) {
  return ProviderScope(
    overrides: [
      brandProvider.overrideWithValue(brand),
      if (api != null) apiProvider.overrideWithValue(api),
      ...overrides,
    ],
    child: const ConsoleApp(),
  );
}

Future<void> pumpApp(WidgetTester tester, Widget app) async {
  tester.view.physicalSize = const Size(1280, 800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(app);
  await tester.pumpAndSettle();
}

/// Signs in to the demo backend the way a person does, including the
/// two-step code that master and reseller users are asked for (`123456`).
Future<void> completeSignIn(
  WidgetTester tester,
  String email, {
  ConsoleApi? api,
}) async {
  await pumpApp(tester, appWith(api: api ?? demoApi()));
  await submitSignIn(tester, email);
}

/// Fills in and submits the sign-in page that is already showing.
Future<void> submitSignIn(WidgetTester tester, String email) async {
  await tester.enterText(find.widgetWithText(TextField, 'Email'), email);
  await tester.enterText(find.widgetWithText(TextField, 'Password'), 'pw');
  await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
  await tester.pumpAndSettle();

  final code = find.widgetWithText(TextField, 'Code');
  if (code.evaluate().isNotEmpty) {
    await tester.enterText(code, '123456');
    await tester.pump();
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
  }
}

/// A bare app around [child] with the console's strings, for widget tests
/// that do not need the whole console.
Widget localizedApp(Widget child) => ProviderScope(
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    home: Scaffold(body: child),
  ),
);

/// Opens [label] from the navigation, scrolling it into view first: the
/// grouped navigation is taller than the test window.
Future<void> tapNav(WidgetTester tester, String label) async {
  final item = find.descendant(
    of: find.byType(AppNavigation),
    matching: find.text(label),
  );
  await tester.ensureVisible(item);
  await tester.pumpAndSettle();
  await tester.tap(item);
  await tester.pumpAndSettle();
}

/// Opens a form's "Advanced settings" (S9-04), where fields most people never
/// change are folded away.
Future<void> openAdvanced(WidgetTester tester) async {
  final heading = find.text('Advanced settings');
  await tester.ensureVisible(heading);
  await tester.tap(heading);
  await tester.pumpAndSettle();
}

/// Sets up a tenant with the new-tenant wizard (S9-16), from the tenants list
/// with its "New tenant" button, and comes back to the list ("Later").
Future<void> createTenantWithWizard(
  WidgetTester tester, {
  required String name,
  String adminName = 'Dee Admin',
  String adminEmail = 'admin@dental.example',
}) async {
  await tester.tap(find.text('New tenant'));
  await tester.pumpAndSettle();
  await tester.enterText(find.byKey(const ValueKey('nt-name')), name);
  await tester.ensureVisible(find.byKey(const ValueKey('nt-next')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('nt-next')));
  await tester.pumpAndSettle();
  await tester.enterText(
    find.byKey(const ValueKey('nt-admin-name')),
    adminName,
  );
  await tester.enterText(
    find.byKey(const ValueKey('nt-admin-email')),
    adminEmail,
  );
  await tester.ensureVisible(find.byKey(const ValueKey('nt-next')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('nt-next')));
  await tester.pumpAndSettle();
  await tester.ensureVisible(find.byKey(const ValueKey('nt-create')));
  await tester.pumpAndSettle();
  await tester.tap(find.byKey(const ValueKey('nt-create')));
  await tester.pumpAndSettle();
  expect(find.text('$name is ready.'), findsOneWidget);
  await tester.tap(find.widgetWithText(TextButton, 'Later'));
  await tester.pumpAndSettle();
}
