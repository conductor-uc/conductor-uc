import 'package:console/core/local_store.dart';
import 'package:console/core/realtime.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/dev/demo_realtime.dart';
import 'package:console/features/attendant/attendant_page.dart';
import 'package:console/features/monitoring/live_calls.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem;
import 'support.dart';

/// A tenant administrator linked to extension 101: they hold `call.control`,
/// and their own phone is the one a pickup rings.
const receptionist = 'linked@example.test';

Future<void> openAttendant(
  WidgetTester tester, {
  String email = receptionist,
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
      ],
    ),
  );
  tester.view.physicalSize = const Size(1600, 1100);
  await submitSignIn(tester, email);
  await tapNav(tester, 'Attendant');
  await tester.pumpAndSettle();
  expect(find.byType(AttendantPage), findsOneWidget);
}

Finder call(String id) => find.byKey(ValueKey('attendant-call-$id'));

/// Lets the demo hub's change arrive (it answers after 300 ms).
Future<void> settle(WidgetTester tester) async {
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pumpAndSettle();
}

/// Drags [from] onto [to], as a mouse would.
Future<void> dragOnto(WidgetTester tester, Finder from, Finder to) async {
  final gesture = await tester.startGesture(tester.getCenter(from));
  await tester.pump(const Duration(milliseconds: 50));
  await gesture.moveBy(const Offset(20, 0));
  await tester.pump();
  await gesture.moveTo(tester.getCenter(to));
  await tester.pump();
  await gesture.up();
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'sorts the calls into incoming, waiting and in progress, and says which phone is theirs',
    (tester) async {
      await openAttendant(tester);
      expect(find.text('Incoming (2)'), findsOneWidget);
      expect(find.text('Waiting in a queue (1)'), findsOneWidget);
      expect(find.text('In progress (2)'), findsOneWidget);
      expect(find.textContaining('extension 101'), findsOneWidget);
      // Every extension, with its state and name.
      expect(find.byKey(const ValueKey('attendant-ext-105')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('attendant-ext-106')),
          matching: find.text('Do not disturb'),
        ),
        findsOneWidget,
      );
      // The queue: one caller waiting, its agent signed in.
      expect(find.textContaining('1 waiting'), findsOneWidget);
      expect(find.text('103 · signed in'), findsOneWidget);
    },
  );

  testWidgets(
    'dragging a waiting caller onto an extension sends the call there',
    (tester) async {
      await openAttendant(tester);
      await dragOnto(
        tester,
        call('demo-q1'),
        find.byKey(const ValueKey('attendant-ext-105')),
      );
      expect(find.text('Sent to 105.'), findsOneWidget);
      await settle(tester);
      expect(find.text('Waiting in a queue (1)'), findsNothing);
      expect(
        find.descendant(of: call('demo-q1'), matching: find.text('to 105')),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'from the keyboard: choose a call, park it with P, and take it back',
    (tester) async {
      await openAttendant(tester);
      // The first call in the column is the first incoming one.
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.keyP);
      await tester.pumpAndSettle();
      expect(find.text('Parked in Main lot.'), findsOneWidget);
      await settle(tester);
      expect(find.text('Parked (1)'), findsOneWidget);
      expect(find.textContaining('Parked in space 701'), findsOneWidget);
      expect(find.text('Main lot (1)'), findsOneWidget);

      await tester.tap(find.widgetWithText(TextButton, 'Take back'));
      await settle(tester);
      expect(find.text('Parked (1)'), findsNothing);
      expect(find.text('Main lot (0)'), findsOneWidget);
    },
  );

  testWidgets('picks up a call ringing someone else on their own phone', (
    tester,
  ) async {
    await openAttendant(tester);
    final pickUp = find.descendant(
      of: call('demo-b2'),
      matching: find.byTooltip('Pick up on my phone'),
    );
    expect(pickUp, findsOneWidget);
    // A caller not ringing any phone yet cannot be picked up.
    expect(
      find.descendant(
        of: call('demo-b1'),
        matching: find.byTooltip('Pick up on my phone'),
      ),
      findsNothing,
    );
    await tester.tap(pickUp);
    await tester.pumpAndSettle();
    expect(find.text('Your phone is taking the call.'), findsOneWidget);
    await settle(tester);
    expect(find.text('Incoming (2)'), findsNothing);
  });

  testWidgets('T asks where to send the chosen call, finding people by name', (
    tester,
  ) async {
    await openAttendant(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.keyT);
    await tester.pumpAndSettle();
    expect(find.text('Send this call to'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('attendant-transfer-to')),
      'nonsense',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Send to…'));
    await tester.pump();
    expect(find.text('Enter an extension or a phone number.'), findsOneWidget);

    await tester.enterText(
      find.byKey(const ValueKey('attendant-transfer-to')),
      'bob',
    );
    await tester.pump();
    await tester.tap(find.text('102 · Bob Osei'));
    await tester.pumpAndSettle();
    expect(find.text('Sent to 102 · Bob Osei.'), findsOneWidget);
  });

  testWidgets('search, then Enter sends the chosen call to the first match', (
    tester,
  ) async {
    await openAttendant(tester);
    await tester.tap(call('demo-q1'));
    await tester.pump();
    await tester.enterText(
      find.byKey(const ValueKey('attendant-search')),
      '110',
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('attendant-ext-105')), findsNothing);
    await tester.testTextInput.receiveAction(TextInputAction.done);
    await tester.pumpAndSettle();
    expect(find.text('Sent to 110.'), findsOneWidget);
  });

  testWidgets('hangs up only after asking', (tester) async {
    await openAttendant(tester);
    final hangUp = find.descendant(
      of: call('demo-q1'),
      matching: find.byTooltip('Hang up'),
    );
    await tester.tap(hangUp);
    await tester.pumpAndSettle();
    expect(find.text('Hang up this call?'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Hang up'));
    await tester.pumpAndSettle();
    expect(find.text('Call ended.'), findsOneWidget);
    await settle(tester);
    expect(call('demo-q1'), findsNothing);
  });

  testWidgets('signs a queue agent out, and the queue shows it', (
    tester,
  ) async {
    await openAttendant(tester);
    await tester.tap(find.byKey(const ValueKey('attendant-agent-103')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign out').last);
    await settle(tester);
    expect(find.text('103 · signed out'), findsOneWidget);
  });

  testWidgets('? shows the keyboard shortcuts', (tester) async {
    await openAttendant(tester);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.slash);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.pumpAndSettle();
    expect(find.text('Keyboard shortcuts'), findsWidgets);
    expect(find.text('Park the chosen call'), findsOneWidget);
  });

  group('talking to someone first (S9-21, G-127)', () {
    testWidgets(
      'a call on their own phone waits while they talk, then is put through',
      (tester) async {
        await openAttendant(tester);
        // demo-a1 is 101 (their phone) talking to 102; others have no button.
        expect(
          find.byKey(const ValueKey('attendant-talk-first-demo-q1')),
          findsNothing,
        );
        await tester.tap(
          find.byKey(const ValueKey('attendant-talk-first-demo-a1')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Who do you want to talk to first?'), findsOneWidget);
        await tester.enterText(
          find.byKey(const ValueKey('attendant-transfer-to')),
          '103',
        );
        await tester.tap(find.widgetWithText(FilledButton, 'Call them'));
        await tester.pumpAndSettle();
        expect(
          find.text('Calling 103 · Carol Diaz. The caller is waiting.'),
          findsOneWidget,
        );
        await settle(tester);
        final banner = find.byKey(const ValueKey('attendant-consult'));
        expect(
          find.descendant(
            of: banner,
            matching: find.text(
              'You are talking to 103 · Carol Diaz. 102 · Bob Osei is waiting and hears music.',
            ),
          ),
          findsOneWidget,
        );
        // One transfer at a time.
        expect(
          find.byKey(const ValueKey('attendant-talk-first-demo-a1')),
          findsNothing,
        );

        await tester.tap(
          find.byKey(const ValueKey('attendant-consult-complete')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Put through to 103 · Carol Diaz.'), findsOneWidget);
        await settle(tester);
        expect(banner, findsNothing);
      },
    );

    testWidgets(
      'with "talk to them first" chosen, a drop talks first; going back resumes the caller',
      (tester) async {
        addTearDown(() => writeLocal('console.attendant.drop', null));
        await openAttendant(tester);
        await tester.tap(find.byKey(const ValueKey('attendant-drop-menu')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Talk to them first (calls on my phone)'));
        await tester.pumpAndSettle();
        expect(readLocal('console.attendant.drop'), 'talk');

        await dragOnto(
          tester,
          call('demo-a1'),
          find.byKey(const ValueKey('attendant-ext-105')),
        );
        await settle(tester);
        expect(find.byKey(const ValueKey('attendant-consult')), findsOneWidget);

        await tester.tap(
          find.byKey(const ValueKey('attendant-consult-cancel')),
        );
        await tester.pumpAndSettle();
        expect(find.text('You are back with the caller.'), findsOneWidget);
        await settle(tester);
        expect(find.byKey(const ValueKey('attendant-consult')), findsNothing);

        // A call not on their phone is still sent at once.
        await dragOnto(
          tester,
          call('demo-q1'),
          find.byKey(const ValueKey('attendant-ext-105')),
        );
        expect(find.text('Sent to 105.'), findsOneWidget);
      },
    );

    testWidgets('a receptionist has the attendant console', (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await submitSignIn(tester, 'receptionist@example.test');
      expect(navItem('Attendant'), findsOneWidget);
    });
  });

  testWidgets(
    'is offered to a supervisor, and not to a person with only a phone',
    (tester) async {
      await pumpApp(tester, appWith(api: demoApi()));
      await submitSignIn(tester, 'supervisor@example.test');
      expect(navItem('Attendant'), findsOneWidget);
    },
  );

  testWidgets('a person with only a phone has no attendant screen', (
    tester,
  ) async {
    await pumpApp(tester, appWith(api: demoApi()));
    await submitSignIn(tester, 'user@example.test');
    expect(navItem('Attendant'), findsNothing);
  });
}
