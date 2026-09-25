import 'dart:typed_data';

import 'package:console/features/media/file_source.dart';
import 'package:console/features/media/media_page.dart';
import 'package:console/features/voicemail/voicemail_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;

/// One upload the page sent to storage.
typedef Sent = ({String url, int bytes, String contentType});

Future<List<Sent>> openMedia(
  WidgetTester tester, {
  PickedFile? picks,
  Future<void> Function(String, Uint8List, String)? upload,
  List<String>? opened,
}) async {
  final sent = <Sent>[];
  await openSection(
    tester,
    'Media',
    overrides: [
      filePickerProvider.overrideWithValue(() async => picks),
      openRecordingProvider.overrideWithValue((url) async => opened?.add(url)),
      uploadToStorageProvider.overrideWithValue((url, bytes, type) async {
        if (upload != null) await upload(url, bytes, type);
        sent.add((url: url, bytes: bytes.length, contentType: type));
      }),
    ],
  );
  return sent;
}

PickedFile audio(String name, {String type = 'audio/wav'}) =>
    PickedFile(name, type, Uint8List(2048));

Future<void> openUpload(WidgetTester tester) async {
  await tester.tap(find.text('Upload recording'));
  await tester.pumpAndSettle();
  await tester.tap(find.text('Choose a file'));
  await tester.pumpAndSettle();
}

/// Lets requests and animations move on a little. Not `pumpAndSettle`: a
/// recording being processed shows a spinner that never stops, so the clock
/// would run on and fire every poll at once.
Future<void> tick(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// Presses Upload in the dialog and lets the three requests finish.
Future<void> submitUpload(WidgetTester tester) async {
  await tester.tap(find.widgetWithText(FilledButton, 'Upload'));
  await tick(tester);
}

/// Lets the page look at the list again, as it does every few seconds.
Future<void> poll(WidgetTester tester) async {
  await tester.pump(mediaPollDelay);
  await tick(tester);
}

const mediaPollDelay = Duration(seconds: 3);

void main() {
  group('audioContentType', () {
    test('trusts what the browser reported for audio', () {
      expect(audioContentType('a.bin', 'audio/x-custom'), 'audio/x-custom');
    });

    test('falls back to the extension when the browser said nothing', () {
      expect(audioContentType('Greeting.WAV', ''), 'audio/wav');
      expect(audioContentType('a.mp3', ''), 'audio/mpeg');
      expect(
        audioContentType('a.m4a', 'application/octet-stream'),
        'audio/mp4',
      );
    });

    test('refuses what is not audio', () {
      expect(audioContentType('notes.txt', 'text/plain'), isNull);
      expect(audioContentType('noextension', ''), isNull);
    });
  });

  testWidgets('a recording is uploaded, converted, and becomes ready', (
    tester,
  ) async {
    final sent = await openMedia(tester, picks: audio('welcome.wav'));
    expect(find.text('Ready'), findsNWidgets(2));

    await openUpload(tester);
    // Named after the file, and the size is shown.
    expect(find.widgetWithText(TextField, 'Name'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.widgetWithText(TextField, 'Name'))
          .controller!
          .text,
      'welcome',
    );
    expect(find.text('2 KB'), findsOneWidget);

    await submitUpload(tester);

    // The bytes went to the address the service gave, not through the API.
    expect(sent, hasLength(1));
    expect(sent.single.url, startsWith('https://storage.demo.invalid/upload/'));
    expect(sent.single.bytes, 2048);
    expect(sent.single.contentType, 'audio/wav');

    // The dialog is gone and the new recording is being processed.
    expect(find.text('Upload recording'), findsOneWidget); // the button
    expect(find.text('welcome'), findsOneWidget);
    expect(find.text('Processing…'), findsOneWidget);

    // Still processing a poll later, then done.
    await poll(tester);
    expect(find.text('Processing…'), findsOneWidget);
    await poll(tester);
    expect(find.text('Processing…'), findsNothing);
    expect(find.text('Ready'), findsNWidgets(3));
  });

  testWidgets('the kind of recording is sent', (tester) async {
    await openMedia(tester, picks: audio('hold.mp3', type: 'audio/mpeg'));
    await openUpload(tester);
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Hold music').last);
    await tester.pumpAndSettle();
    await submitUpload(tester);
    await poll(tester);
    await poll(tester);
    // The table's Kind column reads the stored kind.
    expect(find.text('moh'), findsNWidgets(2));
  });

  testWidgets(
    'a recording that cannot be converted shows as failed, with why',
    (tester) async {
      await openMedia(tester, picks: audio('bad-line.wav'));
      await openUpload(tester);
      await submitUpload(tester);
      await poll(tester);
      await poll(tester);
      expect(find.text('Failed'), findsOneWidget);
      expect(find.byTooltip('The audio could not be read.'), findsOneWidget);
    },
  );

  testWidgets('something that is not audio is refused before any request', (
    tester,
  ) async {
    final sent = await openMedia(
      tester,
      picks: PickedFile('notes.txt', 'text/plain', Uint8List(10)),
    );
    await openUpload(tester);
    expect(
      find.textContaining('does not look like an audio file'),
      findsOneWidget,
    );
    await submitUpload(tester);
    expect(find.text('Upload recording'), findsNWidgets(2)); // dialog stays
    expect(sent, isEmpty);
  });

  testWidgets('uploading with no file chosen asks for one', (tester) async {
    await openMedia(tester);
    await tester.tap(find.text('Upload recording'));
    await tester.pumpAndSettle();
    await submitUpload(tester);
    expect(find.text('Choose an audio file first.'), findsOneWidget);
  });

  testWidgets('a recording needs a name', (tester) async {
    final sent = await openMedia(tester, picks: audio('welcome.wav'));
    await openUpload(tester);
    await tester.enterText(find.widgetWithText(TextField, 'Name'), '  ');
    await submitUpload(tester);
    expect(find.text('Give the recording a name.'), findsOneWidget);
    expect(sent, isEmpty);
  });

  testWidgets('if storage refuses the bytes, the recording is not finalized', (
    tester,
  ) async {
    await openMedia(
      tester,
      picks: audio('welcome.wav'),
      upload: (_, _, _) async => throw DioException(
        requestOptions: RequestOptions(),
        response: Response(requestOptions: RequestOptions(), statusCode: 403),
      ),
    );
    await openUpload(tester);
    await submitUpload(tester);
    expect(find.textContaining('Could not upload'), findsOneWidget);
    // Still in the dialog, so the person can try again or cancel.
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.pump(mediaPollDelay);
    // The row the service created is waiting for an upload that never came.
    expect(find.text('Waiting for upload'), findsOneWidget);
    expect(find.text('Processing…'), findsNothing);
  });

  testWidgets('cancelling the file chooser leaves nothing chosen', (
    tester,
  ) async {
    await openMedia(tester);
    await openUpload(tester);
    expect(find.text('Choose a file'), findsOneWidget);
  });

  testWidgets('a recording can still be deleted', (tester) async {
    await openMedia(tester);
    await tester.tap(find.byTooltip('Delete').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Hold music'), findsNothing);
  });

  testWidgets('a ready recording plays from a short-lived address', (
    tester,
  ) async {
    final opened = <String>[];
    await openMedia(tester, opened: opened);
    expect(find.byTooltip('Play'), findsNWidgets(2));

    await tester.tap(find.byTooltip('Play').first);
    await tester.pumpAndSettle();

    // The converted copy, from storage, not the upload or the API.
    expect(opened, hasLength(1));
    expect(opened.single, startsWith('https://storage.demo.invalid/media/'));
    expect(opened.single, contains('16k.wav'));
  });

  testWidgets('a recording that is not ready has nothing to play', (
    tester,
  ) async {
    await openMedia(
      tester,
      picks: audio('welcome.wav'),
      upload: (_, _, _) async => throw DioException(
        requestOptions: RequestOptions(),
        response: Response(requestOptions: RequestOptions(), statusCode: 403),
      ),
    );
    await openUpload(tester);
    await submitUpload(tester);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    await tester.pump(mediaPollDelay);
    expect(find.text('Waiting for upload'), findsOneWidget);
    // Only the two ready ones can be played.
    expect(find.byTooltip('Play'), findsNWidgets(2));
  });
}
