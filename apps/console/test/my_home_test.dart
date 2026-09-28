import 'dart:typed_data';

import 'package:console/core/audio_recorder.dart';
import 'package:console/features/media/file_source.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/features/media/media_page.dart';
import 'package:console/features/myphone/my_home.dart';
import 'package:console/features/myphone/my_phone_api.dart';
import 'package:console/features/shell/shell_page.dart' show AppNavigation;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'self_service_test.dart' show linked, open, user;
import 'support.dart';

/// Records nothing, and gives back [wav] when stopped.
class _FakeRecorder implements Recorder {
  _FakeRecorder(this.log, {this.refuse = false});

  final List<String> log;
  final bool refuse;
  static final wav = encodeWav(const [0, 0.5, -0.5, 0], 8000);

  @override
  Future<void> start() async {
    if (refuse) throw StateError('Permission denied');
    log.add('start');
  }

  @override
  Future<Uint8List> stop() async {
    log.add('stop');
    return wav;
  }

  @override
  void cancel() => log.add('cancel');
}

/// What the page put in storage: (address, bytes, type).
typedef _Upload = (String, Uint8List, String);

Future<List<_Upload>> _signIn(
  WidgetTester tester, {
  String email = user,
  PickedFile? picked,
  List<String>? recorderLog,
  bool refuseMicrophone = false,
}) async {
  final uploads = <_Upload>[];
  await pumpApp(
    tester,
    appWith(
      api: demoApi(),
      overrides: [
        uploadToStorageProvider.overrideWithValue(
          (url, bytes, type) async => uploads.add((url, bytes, type)),
        ),
        filePickerProvider.overrideWithValue(() async => picked),
        greetingRecorderProvider.overrideWithValue(
          recorderLog == null
              ? null
              : () => _FakeRecorder(recorderLog, refuse: refuseMicrophone),
        ),
      ],
    ),
  );
  await submitSignIn(tester, email);
  await tester.pumpAndSettle();
  return uploads;
}

ProviderContainer _container(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(find.byType(AppNavigation)));

void main() {
  group('a person\'s home (S9-11)', () {
    testWidgets('is where they land: their number, messages and last calls', (
      tester,
    ) async {
      await _signIn(tester);
      expect(find.text('Your extension is 101.'), findsOneWidget);
      expect(find.text('2 new messages'), findsOneWidget);
      expect(find.text('Callers hear the standard greeting.'), findsOneWidget);
      // Their last calls, the newest first: an outside caller, formatted.
      expect(find.text('Recent calls'), findsOneWidget);
      expect(find.text('(415) 555-1000'), findsOneWidget);

      await tester.tap(find.text('Listen to messages'));
      await tester.pumpAndSettle();
      expect(find.text('My voicemail'), findsWidgets);
    });

    testWidgets(
      'forwards every call to their mobile with one switch, and back',
      (tester) async {
        await _signIn(tester);
        final mobile = find.byKey(const ValueKey('my-mobile'));
        final toggle = find.byKey(const ValueKey('forward-to-mobile'));

        // Without a number there is nowhere to send them.
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(find.text('Your calls now go to your mobile.'), findsNothing);
        expect(
          (await _container(tester)
              .read(myCallHandlingProvider.future))['forwardAlways'],
          isNull,
        );

        await tester.enterText(mobile, '(415) 555-0142');
        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(find.text('Your calls now go to your mobile.'), findsOneWidget);
        expect(
          find.text('Calls ring your mobile instead of your phone here.'),
          findsOneWidget,
        );
        final on = await _container(tester).read(myCallHandlingProvider.future);
        expect(on['forwardAlways'], {
          'type': 'external',
          'e164': '+14155550142',
        });
        // The rest of their call handling is as it was.
        expect(on['dnd'], isFalse);

        await tester.tap(toggle);
        await tester.pumpAndSettle();
        expect(
          find.text('Your calls ring your phone here again.'),
          findsOneWidget,
        );
        expect(
          (await _container(tester)
              .read(myCallHandlingProvider.future))['forwardAlways'],
          isNull,
        );
      },
    );

    testWidgets('a number that is not a phone number is said, not saved', (
      tester,
    ) async {
      await _signIn(tester);
      await tester.enterText(find.byKey(const ValueKey('my-mobile')), '12');
      await tester.tap(find.byKey(const ValueKey('forward-to-mobile')));
      await tester.pumpAndSettle();
      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('my-mobile')),
      );
      expect(field.decoration?.errorText, isNotNull);
      expect(
        (await _container(tester)
            .read(myCallHandlingProvider.future))['forwardAlways'],
        isNull,
      );
    });

    testWidgets('uploads a WAV as their greeting', (tester) async {
      final wav = _FakeRecorder.wav;
      final uploads = await _signIn(
        tester,
        picked: PickedFile('hello.wav', 'audio/wav', wav),
      );
      await tester.tap(find.text('Upload a greeting'));
      await tester.pumpAndSettle();

      expect(uploads, hasLength(1));
      expect(uploads.single.$1, contains('greetings/'));
      expect(uploads.single.$2, wav);
      expect(uploads.single.$3, 'audio/wav');
      expect(find.text('Your greeting is saved.'), findsOneWidget);
      expect(find.text('Callers hear your own greeting.'), findsOneWidget);
    });

    testWidgets('refuses a file that is not a WAV', (tester) async {
      final uploads = await _signIn(
        tester,
        picked: PickedFile('hello.mp3', 'audio/mpeg', Uint8List(4)),
      );
      await tester.tap(find.text('Upload a greeting'));
      await tester.pumpAndSettle();
      expect(uploads, isEmpty);
      expect(find.text('Choose a WAV file.'), findsOneWidget);
    });

    testWidgets('records a greeting from the microphone', (tester) async {
      final log = <String>[];
      final uploads = await _signIn(tester, recorderLog: log);
      await tester.tap(find.text('Record a greeting'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Start'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('0:03'), findsOneWidget);

      await tester.tap(find.text('Stop and save'));
      await tester.pumpAndSettle();
      expect(log, ['start', 'stop']);
      expect(uploads.single.$2, _FakeRecorder.wav);
      expect(find.text('Record a greeting'), findsOneWidget); // dialog closed
      expect(find.text('Callers hear your own greeting.'), findsOneWidget);
    });

    testWidgets('a refused microphone is said, and nothing is saved', (
      tester,
    ) async {
      final uploads = await _signIn(
        tester,
        recorderLog: <String>[],
        refuseMicrophone: true,
      );
      await tester.tap(find.text('Record a greeting'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Start'));
      await tester.pumpAndSettle();
      expect(
        find.textContaining('didn’t allow the microphone'),
        findsOneWidget,
      );
      expect(uploads, isEmpty);
    });

    testWidgets('offers no recording where there is no microphone', (
      tester,
    ) async {
      await _signIn(tester);
      expect(find.text('Record a greeting'), findsNothing);
      expect(find.text('Upload a greeting'), findsOneWidget);
    });

    testWidgets('shows how to connect a phone, and the password on request', (
      tester,
    ) async {
      await _signIn(tester);
      await tester.ensureVisible(find.text('Show me how'));
      await tester.tap(find.text('Show me how'));
      await tester.pumpAndSettle();
      expect(find.text('demo.voice.northwind.example'), findsOneWidget);
      expect(find.text('5060'), findsOneWidget);
      // The password only when asked for, since showing it is audited.
      expect(find.text('Username'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('reveal-my-sign-in')));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('101'),
        ),
        findsOneWidget,
      );
      expect(find.text('demo-101-secret'), findsOneWidget);
    });
  });

  group('searching their call history', () {
    testWidgets('finds a call by part of a number', (tester) async {
      await _signIn(tester);
      await open(tester, 'My call history');
      expect(
        tester.widget<DataTable>(find.byType(DataTable)).rows.length,
        greaterThan(1),
      );

      await tester.enterText(
        find.byKey(const ValueKey('my-calls-search')),
        '5551003',
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      final table = tester.widget<DataTable>(find.byType(DataTable));
      expect(table.rows, hasLength(1));

      await tester.enterText(
        find.byKey(const ValueKey('my-calls-search')),
        'nobody',
      );
      await tester.pump(const Duration(milliseconds: 400));
      await tester.pumpAndSettle();
      expect(find.text('No calls match your search.'), findsOneWidget);
    });
  });

  group('an administrator with a phone', () {
    testWidgets('gets the same home under My phone', (tester) async {
      await _signIn(tester, email: linked);
      await open(tester, 'My phone');
      expect(find.text('Your extension is 101.'), findsOneWidget);
      expect(find.widgetWithText(ChoiceChip, 'Home'), findsOneWidget);
    });
  });
}
