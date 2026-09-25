import 'package:console/features/users/users_page.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// A refusal as the service sends it: problem+json with a `code`.
DioException refusal(int status, String code) {
  final request = RequestOptions(path: '/mfa-reset');
  return DioException(
    requestOptions: request,
    response: Response(
      requestOptions: request,
      statusCode: status,
      data: {'status': status, 'code': code, 'detail': 'Refused.'},
    ),
  );
}

Future<List<String>> pumpDialog(
  WidgetTester tester,
  Future<Object?> Function(String code) reset,
) async {
  final sent = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      home: ResetMfaDialog(
        user: const {'id': 'u2', 'displayName': 'Sam Support'},
        reset: (code) {
          sent.add(code);
          return reset(code);
        },
      ),
    ),
  );
  return sent;
}

Future<void> submit(WidgetTester tester, String code) async {
  await tester.enterText(find.byKey(const ValueKey('step-up-code')), code);
  await tester.tap(find.widgetWithText(FilledButton, 'Reset'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('sends the admin’s own code, spaces removed', (tester) async {
    final sent = await pumpDialog(tester, (_) async => null);
    await submit(tester, '123 456');
    expect(sent, ['123456']);
  });

  testWidgets('an admin with no authenticator of their own is told why, '
      'and cannot try again', (tester) async {
    await pumpDialog(
      tester,
      (_) async => throw refusal(403, 'step_up_not_enrolled'),
    );
    await submit(tester, '123456');
    expect(find.textContaining('no two-step verification'), findsOneWidget);
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Reset'),
    );
    expect(button.onPressed, isNull);
  });

  testWidgets('too many wrong codes say how long to wait', (tester) async {
    await pumpDialog(tester, (_) async => throw refusal(429, 'step_up_locked'));
    await submit(tester, '123456');
    expect(find.textContaining('Wait 15 minutes'), findsOneWidget);
  });

  testWidgets('any other refusal shows the server’s own words', (tester) async {
    await pumpDialog(
      tester,
      (_) async => throw refusal(409, 'mfa_not_enrolled'),
    );
    await submit(tester, '123456');
    expect(find.text('Refused.'), findsOneWidget);
  });
}
