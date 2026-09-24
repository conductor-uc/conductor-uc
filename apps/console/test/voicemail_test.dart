import 'package:console/core/session.dart';
import 'package:console/features/shell/sections.dart';
import 'package:console/features/voicemail/voicemail_api.dart';
import 'package:console/features/voicemail/voicemail_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show openSection;

/// Opens Voicemail as a tenant user. Recordings a person plays are collected
/// in the returned list instead of opening a browser tab.
Future<List<String>> openVoicemail(WidgetTester tester) async {
  final opened = <String>[];
  await openSection(
    tester,
    'Voicemail',
    overrides: [
      openRecordingProvider.overrideWithValue((url) async => opened.add(url)),
    ],
  );
  // The test font is wide; give the table room so every action is on screen.
  tester.view.physicalSize = const Size(2400, 900);
  await tester.pumpAndSettle();
  return opened;
}

/// Mailboxes are listed in order: Alice's, then Bob's.
const alice = 0;
const bob = 1;

Future<void> openMessages(WidgetTester tester, int mailbox) async {
  await tester.tap(find.byTooltip('Messages').at(mailbox));
  await tester.pumpAndSettle();
}

Future<void> openMailboxAction(
  WidgetTester tester,
  int mailbox,
  String tooltip,
) async {
  await tester.tap(find.byTooltip(tooltip).at(mailbox));
  await tester.pumpAndSettle();
}

void main() {
  group('formatting', () {
    test('a length is minutes and seconds', () {
      expect(formatLength(42000), '0:42');
      expect(formatLength(95000), '1:35');
      expect(formatLength(3605000), '60:05');
      expect(formatLength(null), '—');
    });

    test('a time is day, month, year and clock', () {
      expect(formatWhen(DateTime(2026, 9, 4, 7, 5)), '4 Sep 2026, 07:05');
    });

    test('settings round-trip the mailbox fields', () {
      final settings = EmailSettings.fromMailbox({
        'notifyEmail': 'a@example.test',
        'emailAttachAudio': true,
        'emailAfter': 'delete',
      });
      expect(settings.toJson(), {
        'notifyEmail': 'a@example.test',
        'attachAudio': true,
        'afterEmail': 'delete',
      });
      expect(EmailSettings.fromMailbox({}).toJson(), {
        'notifyEmail': null,
        'attachAudio': false,
        'afterEmail': 'keep',
      });
    });
  });

  test('a reseller acting as a tenant is not offered Voicemail (rule H1)', () {
    final tenant = sectionsByOrgType[OrgType.tenant]!;
    final voicemail = tenant.firstWhere((s) => s.path == '/voicemail');
    expect(voicemail.privateData, isTrue);
    expect(voicemail.requires, contains('voicemail.access'));
  });

  testWidgets('lists the mailboxes with new messages and where they email', (
    tester,
  ) async {
    await openVoicemail(tester);

    expect(find.text('101 · Alice Kim'), findsOneWidget);
    expect(find.text('102 · Bob Osei'), findsOneWidget);
    expect(find.text('alice@acme-dental.example'), findsOneWidget);
    expect(find.text('Off'), findsOneWidget);
    expect(find.text('Custom'), findsOneWidget);
    expect(find.text('Default'), findsOneWidget);
    // Alice has two unread of three; Bob none.
    expect(find.text('2'), findsOneWidget);
    expect(find.text('0'), findsOneWidget);
  });

  testWidgets('shows a mailbox\'s messages: caller, time, length, read state', (
    tester,
  ) async {
    await openVoicemail(tester);
    await openMessages(tester, alice);

    expect(find.text('Voicemail: 101 · Alice Kim'), findsOneWidget);
    expect(find.text('Pat Caller · +15005550123'), findsOneWidget);
    // No caller name: the number alone. Neither: unknown.
    expect(find.text('+15005550188'), findsOneWidget);
    expect(find.text('Dr. Lee · +15005550199'), findsOneWidget);
    expect(find.text('0:42'), findsOneWidget);
    expect(find.text('1:35'), findsOneWidget);
    expect(find.text('New'), findsNWidgets(2));
    expect(find.text('Read'), findsOneWidget);
    expect(
      find.text(formatWhen(DateTime.utc(2026, 9, 24, 17, 20))),
      findsOneWidget,
    );

    await tester.tap(find.byTooltip('Back to mailboxes'));
    await tester.pumpAndSettle();
    expect(find.text('Email to'), findsOneWidget);
  });

  testWidgets('an empty mailbox says so', (tester) async {
    await openVoicemail(tester);
    await openMessages(tester, bob);
    expect(find.text('No messages.'), findsOneWidget);
  });

  testWidgets('Play asks for a presigned address and opens it', (tester) async {
    final opened = await openVoicemail(tester);
    await openMessages(tester, alice);

    // Oldest first: the first row is Pat Caller's.
    await tester.tap(find.byTooltip('Play').first);
    await tester.pumpAndSettle();

    expect(opened, ['https://storage.demo.invalid/voicemail/vm-1.wav']);
  });

  testWidgets('Delete asks first, and then removes the message', (
    tester,
  ) async {
    await openVoicemail(tester);
    await openMessages(tester, alice);
    // Dr. Lee's is the last row.
    await tester.tap(find.byTooltip('Delete').last);
    await tester.pumpAndSettle();
    expect(find.text('Delete message?'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(find.text('Dr. Lee · +15005550199'), findsOneWidget);

    await tester.tap(find.byTooltip('Delete').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Delete'));
    await tester.pumpAndSettle();
    expect(find.text('Dr. Lee · +15005550199'), findsNothing);
    expect(find.text('Pat Caller · +15005550123'), findsOneWidget);
  });

  testWidgets('email settings start as saved and can be changed', (
    tester,
  ) async {
    await openVoicemail(tester);
    await openMailboxAction(tester, bob, 'Email settings');

    // Bob has no email set up: the address and options are off.
    expect(find.text('Email settings'), findsOneWidget);
    expect(
      tester
          .widget<TextField>(find.widgetWithText(TextField, 'Email address'))
          .enabled,
      isFalse,
    );

    await tester.tap(find.widgetWithText(SwitchListTile, 'Email new messages'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, 'Email address'),
      'bob@acme-dental.example',
    );
    await tester.tap(
      find.widgetWithText(SwitchListTile, 'Attach the recording'),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    // Back on the list, which now shows the address.
    expect(find.text('Email settings'), findsNothing);
    expect(find.text('bob@acme-dental.example'), findsOneWidget);

    // Reopened, the saved choices are there.
    await openMailboxAction(tester, bob, 'Email settings');
    expect(
      tester
          .widget<SwitchListTile>(
            find.widgetWithText(SwitchListTile, 'Attach the recording'),
          )
          .value,
      isTrue,
    );
  });

  testWidgets('a bad address is refused before anything is sent', (
    tester,
  ) async {
    await openVoicemail(tester);
    await openMailboxAction(tester, alice, 'Email settings');

    await tester.enterText(
      find.widgetWithText(TextField, 'Email address'),
      'not an address',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('Enter one email address.'), findsOneWidget);
    expect(find.text('Email settings'), findsOneWidget);
  });

  testWidgets('switching email off clears the address', (tester) async {
    await openVoicemail(tester);
    await openMailboxAction(tester, alice, 'Email settings');
    await tester.tap(find.widgetWithText(SwitchListTile, 'Email new messages'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();

    expect(find.text('alice@acme-dental.example'), findsNothing);
    expect(find.text('Off'), findsNWidgets(2));
  });

  testWidgets('turning the attachment off takes Delete back to Keep', (
    tester,
  ) async {
    await openVoicemail(tester);
    // Alice: attach on, mark as read. Choose delete, then remove the attachment.
    await openMailboxAction(tester, alice, 'Email settings');
    await tester.tap(find.byType(DropdownButtonFormField<String>));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Delete it').last);
    await tester.pumpAndSettle();
    await tester.tap(
      find.widgetWithText(SwitchListTile, 'Attach the recording'),
    );
    await tester.pumpAndSettle();

    expect(find.text('Keep it as a new message'), findsOneWidget);
    expect(find.text('Deleting needs the recording attached.'), findsOneWidget);
  });

  testWidgets('a PIN must be 4 to 8 digits, and a good one is accepted', (
    tester,
  ) async {
    await openVoicemail(tester);
    await openMailboxAction(tester, alice, 'Reset PIN');

    await tester.enterText(find.widgetWithText(TextField, 'New PIN'), '12');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('The PIN must be 4 to 8 digits.'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextField, 'New PIN'), '482913');
    await tester.tap(find.widgetWithText(FilledButton, 'Save'));
    await tester.pumpAndSettle();
    expect(find.text('Reset PIN'), findsNothing);
    expect(find.text('PIN changed.'), findsOneWidget);
  });
}
