import 'dart:io';

import 'package:console/dev/demo_backend.dart';
import 'package:console/features/security/api_keys.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem;
import 'support.dart';

Future<void> openKeys(WidgetTester tester, String email) async {
  resetDemoApiKeys();
  addTearDown(resetDemoApiKeys);
  await pumpApp(tester, appWith(api: demoApi()));
  tester.view.physicalSize = const Size(1400, 1000);
  await submitSignIn(tester, email);
  await tapNav(tester, 'API keys');
  await tester.pumpAndSettle();
  expect(find.byType(ApiKeysPage), findsOneWidget);
}

void main() {
  testWidgets(
    'S1-08: an administrator makes a key, sees it once, and revokes it',
    (tester) async {
      await openKeys(tester, 'tenant@example.test');
      expect(find.text('No API keys yet.'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('api-key-new')));
      await tester.pumpAndSettle();
      // Managing people or access is never offered (H4).
      expect(
        find.byKey(const ValueKey('api-key-permission-user.manage')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('api-key-permission-apikey.manage')),
        findsNothing,
      );

      // Both fields are needed.
      await tester.tap(find.byKey(const ValueKey('api-key-create')));
      await tester.pump();
      expect(find.text('Give the key a name.'), findsOneWidget);
      await tester.enterText(
        find.byKey(const ValueKey('api-key-name')),
        'Billing export',
      );
      await tester.tap(find.byKey(const ValueKey('api-key-create')));
      await tester.pump();
      expect(find.text('Choose at least one thing it may do.'), findsOneWidget);

      final cdr = find.byKey(const ValueKey('api-key-permission-cdr.read'));
      await tester.ensureVisible(cdr);
      await tester.tap(cdr);
      await tester.tap(find.byKey(const ValueKey('api-key-create')));
      await tester.pumpAndSettle();

      expect(find.text('Copy your new key now'), findsOneWidget);
      final secret = tester
          .widget<SelectableText>(find.byKey(const ValueKey('api-key-secret')))
          .data!;
      expect(secret, matches(RegExp(r'^key_[0-9a-f]{12}_')));
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.tap(find.byKey(const ValueKey('api-key-copy')));
      await tester.pumpAndSettle();
      expect(copied, secret);
      await tester.tap(find.byKey(const ValueKey('api-key-done')));
      await tester.pumpAndSettle();

      expect(find.text('Billing export'), findsOneWidget);
      expect(find.text('1 permission'), findsOneWidget);
      // The list never shows the secret again.
      expect(find.text(secret), findsNothing);

      await tester.tap(find.byKey(const ValueKey('api-key-revoke-apikey-1')));
      await tester.pumpAndSettle();
      expect(find.text('Revoke Billing export?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Revoke'));
      await tester.pumpAndSettle();
      expect(find.text('Billing export is revoked.'), findsOneWidget);
      expect(find.text('Revoked'), findsOneWidget);
    },
  );

  testWidgets("a reseller's key is never offered private data (H1)", (
    tester,
  ) async {
    await openKeys(tester, 'reseller@example.test');
    await tester.tap(find.byKey(const ValueKey('api-key-new')));
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('api-key-permission-tenant.manage')),
      findsOneWidget,
    );
    for (final chip in tester.widgetList<FilterChip>(find.byType(FilterChip))) {
      final permission = (chip.key! as ValueKey<String>).value.replaceFirst(
        'api-key-permission-',
        '',
      );
      expect(privatePermission(permission), isFalse, reason: permission);
    }
  });

  testWidgets('a person with only a phone has no API keys page', (
    tester,
  ) async {
    await pumpApp(tester, appWith(api: demoApi()));
    await submitSignIn(tester, 'user@example.test');
    expect(navItem('API keys'), findsNothing);
  });

  test('the private permissions are the ones @cuc/authz files as private', () {
    final source = File('../../packages/authz/src/permissions.ts')
        .readAsStringSync();
    final block = source.substring(
      source.indexOf('export const PERMISSION_CATALOG'),
      source.indexOf('};', source.indexOf('export const PERMISSION_CATALOG')),
    );
    final entries = {
      for (final m in RegExp(r"'([a-z_.]+)': '([a-z]+)'").allMatches(block))
        m.group(1)!: m.group(2)!,
    };
    expect(entries, isNotEmpty);
    for (final MapEntry(key: permission, value: dataClass) in entries.entries) {
      expect(
        privatePermission(permission),
        dataClass == 'private',
        reason: permission,
      );
    }
  });
}
