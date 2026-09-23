import 'package:console/core/session.dart';
import 'package:console_api/console_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

ConsoleApi apiReturningLogin(String orgType) {
  final dio = Dio()
    ..httpClientAdapter = FakeAdapter((options) {
      if (options.path == '/v1/auth/login') {
        return jsonBody({
          'status': 'ok',
          'accessToken': fakeJwt({
            'org': 'org-1',
            'ot': orgType,
            'perms': <String>[],
          }),
          'refreshToken': 'r',
          'expiresIn': 900,
        });
      }
      return jsonBody({}, status: 404);
    });
  return ConsoleApi(dio: dio);
}

Future<void> signIn(WidgetTester tester) async {
  await tester.enterText(
    find.widgetWithText(TextField, 'Organization ID'),
    'org-1',
  );
  await tester.enterText(
    find.widgetWithText(TextField, 'Email'),
    'a@example.test',
  );
  await tester.enterText(find.widgetWithText(TextField, 'Password'), 'pw');
  await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('signed-out users land on the login page', (tester) async {
    await pumpApp(tester, appWith());
    expect(find.text('Sign in'), findsNWidgets(2)); // heading and button
  });

  testWidgets('neutral login shows no product label or logo', (tester) async {
    await pumpApp(tester, appWith());
    final texts = tester
        .widgetList<Text>(find.byType(Text))
        .map((t) => t.data)
        .toSet();
    expect(texts, {
      'Sign in',
      'Organization ID',
      'Email',
      'Password',
      'Forgot your password?',
    });
    expect(find.byType(Image), findsNothing);
  });

  testWidgets('a branded login shows the reseller name and footer', (
    tester,
  ) async {
    await pumpApp(tester, appWith(brand: sampleBrand));
    expect(find.text('Sample Reseller'), findsOneWidget);
    expect(find.text('Sample Reseller Ltd.'), findsOneWidget);
  });

  testWidgets('master sign-in lands on Resellers with no header label', (
    tester,
  ) async {
    await pumpApp(tester, appWith(api: apiReturningLogin('master')));
    await signIn(tester);
    expect(find.text('Resellers'), findsWidgets);
    expect(find.text('Platform health'), findsOneWidget);
    expect(find.text('Extensions'), findsNothing);
    final bar = tester.widget<AppBar>(find.byType(AppBar));
    expect((bar.title as dynamic).brand.isNeutral, isTrue);
  });

  testWidgets('a tenant cannot reach a reseller section by URL', (
    tester,
  ) async {
    await pumpApp(tester, appWith(api: apiReturningLogin('tenant')));
    await signIn(tester);
    expect(find.text('Dashboard'), findsWidgets);
    expect(find.text('Resellers'), findsNothing);
  });

  testWidgets('a failed sign-in shows an error and stays on the login page', (
    tester,
  ) async {
    final dio = Dio()
      ..httpClientAdapter = FakeAdapter((_) => jsonBody({}, status: 401));
    await pumpApp(tester, appWith(api: ConsoleApi(dio: dio)));
    await signIn(tester);
    expect(find.text('Those details were not recognized.'), findsOneWidget);
  });

  test('decodeClaims tolerates garbage', () {
    expect(decodeClaims('nope'), isEmpty);
    expect(decodeClaims('a.b.c'), isEmpty);
  });
}
