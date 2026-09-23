import 'dart:convert';
import 'dart:typed_data';

import 'package:console/app/app.dart';
import 'package:console/app/brand.dart';
import 'package:console/core/api_client.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
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
  primary: Color(0xFF6A1B9A),
  accent: Color(0xFF00695C),
  legalFooter: 'Sample Reseller Ltd.',
);

Widget appWith({Brand brand = const Brand.neutral(), ConsoleApi? api}) {
  return ProviderScope(
    overrides: [
      brandProvider.overrideWithValue(brand),
      if (api != null) apiProvider.overrideWithValue(api),
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
  await tester.enterText(
    find.widgetWithText(TextField, 'Organization ID'),
    'demo',
  );
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
