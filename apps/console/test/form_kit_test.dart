import 'package:console/features/pbx/resource.dart';
import 'package:console/features/pbx/resource_form.dart';
import 'package:console/forms/validators.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'pbx_test.dart' show field, openSection, pickFromDropdown;
import 'support.dart';

/// S9-04: the form kit. Values typed the way people write them, checked as
/// each field is left, advanced settings folded away, choices explained, and
/// pickers that can make what they are missing.
void main() {
  group('phone numbers', () {
    test('are read the way people write them', () {
      for (final typed in [
        '(415) 555-0100',
        '415.555.0100',
        '415 555 0100',
        '1 415 555 0100',
        '+1 415 555 0100',
      ]) {
        expect(parsePhone(typed).value, '+14155550100', reason: typed);
      }
      expect(parsePhone('+44 20 7946 0958').value, '+442079460958');
      expect(parsePhone('0044 20 7946 0958').value, '+442079460958');
    });

    test('need a country code outside North America', () {
      expect(
        parsePhone('020 7946 0958', country: 'GB').error,
        startsWith('Include the country code'),
      );
    });

    test('that cannot be one are refused', () {
      expect(parsePhone('555-0100').error, isNotNull);
      expect(parsePhone('(015) 555-0100').error, isNotNull);
      expect(parsePhone('call me').error, isNotNull);
    });

    test('are shown the way people read them', () {
      expect(formatPhone('+14155550100'), '(415) 555-0100');
      expect(formatPhone('+442079460958'), '+442079460958');
      expect(formatPhone('+14155550100', country: 'GB'), '+14155550100');
    });
  });

  test('a MAC address can be typed with or without separators', () {
    expect(parseMac('00:15:65:AA:BB:CC').ok, isTrue);
    expect(parseMac('00-15-65-aa-bb-cc').ok, isTrue);
    expect(parseMac('001565aabbcc').ok, isTrue);
    expect(parseMac('00:15:65:AA:BB').error, contains('12 characters'));
  });

  test('digits only, within a length', () {
    expect(parseDigits('1234', min: 4, max: 8).ok, isTrue);
    expect(parseDigits('12a4').error, 'Use digits only.');
    expect(parseDigits('12', min: 4, max: 8).error, 'Use 4 to 8 digits.');
  });

  Future<Map<String, dynamic>?> fillAndSave(
    WidgetTester tester,
    ResourceDef def,
    Future<void> Function() fill,
  ) async {
    Map<String, dynamic>? sent;
    await tester.pumpWidget(
      localizedApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => ResourceFormDialog(
                def: def,
                save: (_, body) async {
                  sent = body;
                  return {'id': '1', ...body};
                },
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await fill();
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();
    return sent;
  }

  const numbers = ResourceDef(
    key: 'things',
    singular: 'Thing',
    plural: 'Things',
    icon: Icons.phone,
    fields: [
      Field(
        'e164',
        'Number',
        FieldKind.text,
        required: true,
        format: FieldFormat.phone,
      ),
      Field(
        'strategy',
        'How it rings',
        FieldKind.choice,
        required: true,
        choices: ['simultaneous', 'sequential'],
        choiceLabels: {
          'simultaneous': 'All at once',
          'sequential': 'One after another',
        },
        choiceHelp: {
          'simultaneous': 'Every phone rings; the first to answer gets it.',
          'sequential': 'Each phone rings in turn until one answers.',
        },
        initial: 'simultaneous',
      ),
      Field(
        'retries',
        'Retries',
        FieldKind.integer,
        advanced: true,
        min: 0,
        max: 5,
      ),
    ],
  );

  testWidgets('a number typed as people write it is sent in E.164', (
    tester,
  ) async {
    final sent = await fillAndSave(tester, numbers, () async {
      await tester.enterText(field('Number *'), '(415) 555-0100');
    });
    expect(sent?['e164'], '+14155550100');
  });

  testWidgets('a field is checked as soon as it is left, not only on Save', (
    tester,
  ) async {
    await tester.pumpWidget(
      localizedApp(const ResourceFormDialog(def: numbers, row: null)),
    );
    await tester.enterText(field('Number *'), 'call me');
    // Leaving the field: focus moves on.
    await tester.testTextInput.receiveAction(TextInputAction.next);
    FocusManager.instance.primaryFocus?.unfocus();
    await tester.pumpAndSettle();
    expect(find.textContaining('Enter a phone number'), findsOneWidget);
  });

  testWidgets('the chosen option explains itself', (tester) async {
    await tester.pumpWidget(
      localizedApp(const ResourceFormDialog(def: numbers, row: null)),
    );
    expect(
      find.text('Every phone rings; the first to answer gets it.'),
      findsOneWidget,
    );
  });

  testWidgets('advanced settings are folded away, and open on a problem', (
    tester,
  ) async {
    await fillAndSave(tester, numbers, () async {
      await tester.enterText(field('Number *'), '(415) 555-0100');
      expect(find.text('Advanced settings'), findsOneWidget);
      expect(field('Retries'), findsNothing);
      await tester.tap(find.text('Advanced settings'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Retries'), '9');
      await tester.tap(find.text('Advanced settings'));
      await tester.pumpAndSettle();
    });
    // Save refused, and the folded section opened to show why.
    expect(find.text('Use 5 or less.'), findsOneWidget);
  });

  testWidgets('a rule across fields is checked', (tester) async {
    final parking = resourceByKey('parking-lots');
    final sent = await fillAndSave(tester, parking, () async {
      await tester.enterText(field('Name *'), 'Lobby');
      await tester.enterText(field('First slot *'), '720');
      await tester.enterText(field('Last slot *'), '701');
    });
    expect(sent, isNull);
    expect(
      find.text("The last slot can't come before the first."),
      findsOneWidget,
    );
  });

  testWidgets('a picker makes what it is missing, and picks it', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1280, 1400);
    addTearDown(tester.view.resetPhysicalSize);
    await openSection(tester, 'Extensions');
    await tester.tap(find.text('New extension'));
    await tester.pumpAndSettle();
    await pickFromDropdown(tester, 'Emergency location *', 'Create new…');
    expect(find.text('New emergency location'), findsOneWidget);
    await tester.enterText(field('Name *').last, 'Warehouse');
    await tester.enterText(field('Address *'), '1 Dock Road');
    await tester.enterText(field('City *'), 'Oakland');
    await tester.enterText(field('State *'), 'CA');
    await tester.enterText(field('Postal code *'), '94607');
    await tester.tap(find.text('Save').last);
    await tester.pumpAndSettle();
    // Back in the extension form, with the new location chosen.
    expect(find.text('New emergency location'), findsNothing);
    expect(
      find.descendant(
        of: find.widgetWithText(
          DropdownButtonFormField<String?>,
          'Emergency location *',
        ),
        matching: find.text('Warehouse'),
      ),
      findsOneWidget,
    );
  });
}
