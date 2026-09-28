import 'package:console/app/app.dart';
import 'package:console/app/router.dart';
import 'package:console/core/theme_mode.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/dev/demo_realtime.dart';
import 'package:console/core/realtime.dart';
import 'package:console/features/monitoring/live_calls.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// The screens a person meets most, by who meets them.
const screens = [
  (
    'tenant@example.test',
    ['/dashboard', '/people', '/phone-numbers', '/monitoring', '/attendant'],
  ),
  (
    'user@example.test',
    ['/my-phone/home', '/my-phone/call-handling', '/my-phone/voicemail'],
  ),
  ('master@example.test', ['/dashboard', '/resellers']),
];

/// Opens [path] as a person would, whatever the width (at 400 px the
/// navigation is in a drawer).
Future<void> go(WidgetTester tester, String path) async {
  containerOfApp(tester).read(routerProvider).go(path);
  await tester.pumpAndSettle();
}

Future<void> open(
  WidgetTester tester,
  String email, {
  ThemeMode mode = ThemeMode.light,
  TextDirection? direction,
  Size size = const Size(1280, 900),
}) async {
  resetDemoRecordings();
  addTearDown(resetDemoRecordings);
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        realtimeConnectorProvider.overrideWithValue(demoRealtimeConnector),
        clockProvider.overrideWith((ref) => Stream.value(DateTime.now())),
        if (direction != null)
          forcedTextDirectionProvider.overrideWithValue(direction),
      ],
    ),
  );
  tester.view.physicalSize = size;
  await tester.pumpAndSettle();
  final container = containerOfApp(tester);
  container.read(themeModeProvider.notifier).choose(mode);
  await tester.pumpAndSettle();
  await submitSignIn(tester, email);
}

ProviderContainer containerOfApp(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(ConsoleApp)));

void main() {
  for (final mode in [ThemeMode.light, ThemeMode.dark]) {
    for (final (email, pages) in screens) {
      testWidgets(
        'S9-17: $email, ${mode.name}: labeled controls and readable text',
        (tester) async {
          final handle = tester.ensureSemantics();
          await open(tester, email, mode: mode);
          for (final page in pages) {
            await go(tester, page);
            await expectLater(
              tester,
              meetsGuideline(labeledTapTargetGuideline),
              reason: page,
            );
            await expectLater(
              tester,
              meetsGuideline(textContrastGuideline),
              reason: page,
            );
          }
          handle.dispose();
        },
      );
    }
  }

  for (final width in [1280.0, 400.0]) {
    for (final (email, pages) in screens) {
      testWidgets(
        'S9-17: right to left at ${width.toInt()} px, $email: every screen lays out without overflow',
        (tester) async {
          await open(
            tester,
            email,
            direction: TextDirection.rtl,
            size: Size(width, 900),
          );
          for (final page in pages) {
            await go(tester, page);
            expect(tester.takeException(), isNull, reason: page);
            expect(
              Directionality.of(tester.element(find.byType(Scaffold).first)),
              TextDirection.rtl,
            );
          }
        },
      );
    }
  }

  testWidgets(
    'S9-17: the account menu switches to dark, and back to the device setting',
    (tester) async {
      await open(tester, 'tenant@example.test');
      Brightness brightness() =>
          Theme.of(tester.element(find.byType(Scaffold).first)).brightness;
      expect(brightness(), Brightness.light);
      await tester.tap(find.byKey(const ValueKey('account-menu')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('theme-menu')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('theme-dark')));
      await tester.pumpAndSettle();
      expect(brightness(), Brightness.dark);
      expect(containerOfApp(tester).read(themeModeProvider), ThemeMode.dark);
      containerOfApp(tester)
          .read(themeModeProvider.notifier)
          .choose(ThemeMode.system);
      await tester.pumpAndSettle();
      // The test's device is set to light.
      expect(brightness(), Brightness.light);
    },
  );
}
