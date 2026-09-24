import 'dart:convert';
import 'dart:typed_data';

import 'package:console/core/file_pick.dart';
import 'package:console/dev/demo_backend.dart';
import 'package:console/features/orgs/brand_page.dart';
import 'package:console/features/orgs/orgs_api.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Future<void> signInAndOpen(
  WidgetTester tester,
  String email,
  String section,
) async {
  await pumpApp(tester, appWith(api: demoApi()));
  await submitSignIn(tester, email);
  await tester.tap(
    find.descendant(
      of: find.byType(NavigationRail),
      matching: find.text(section),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> tapVisible(WidgetTester tester, Finder finder) async {
  FocusManager.instance.primaryFocus?.unfocus();
  await tester.pumpAndSettle();
  await tester.ensureVisible(finder);
  await tester.pumpAndSettle();
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Finder field(String label) => find.widgetWithText(TextFormField, label);

void main() {
  group('trunks (reseller)', () {
    Future<void> openTrunks(WidgetTester tester) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Trunks');
      await tester.tap(find.byKey(const ValueKey('trunk-tenant')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Acme Dental').last);
      await tester.pumpAndSettle();
    }

    testWidgets('choose a tenant first, then its trunks are listed', (
      tester,
    ) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Trunks');
      expect(
        find.text('Choose a tenant to see and manage its trunks.'),
        findsOneWidget,
      );
      expect(find.text('Primary trunk'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('trunk-tenant')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Acme Dental').last);
      await tester.pumpAndSettle();
      expect(find.text('Primary trunk'), findsOneWidget);
      expect(find.text('sip.carrier.example'), findsOneWidget);
      expect(find.text('PCMU, PCMA'), findsOneWidget);
    });

    testWidgets('adds a trunk, with the defaults a carrier usually wants', (
      tester,
    ) async {
      await openTrunks(tester);
      await tester.tap(find.text('New trunk'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<TextFormField>(field('Port *')).controller!.text,
        '5060',
      );
      expect(
        tester.widget<TextFormField>(field('Codecs *')).controller!.text,
        'PCMU, PCMA',
      );
      await tester.enterText(field('Name *'), 'Backup trunk');
      await tester.enterText(field('Host *'), 'sip.backup.example');
      await tester.enterText(field('Username'), 'acme-backup');
      await tester.enterText(field('Secret'), 'hunter2');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Backup trunk'), findsOneWidget);
      expect(find.text('sip.backup.example'), findsOneWidget);
    });

    testWidgets('a trunk needs a name, a host, and at least one codec', (
      tester,
    ) async {
      await openTrunks(tester);
      await tester.tap(find.text('New trunk'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Codecs *'), ' , ');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Required'), findsNWidgets(3));
    });

    testWidgets('editing changes the codecs, and the secret is never shown', (
      tester,
    ) async {
      await openTrunks(tester);
      await tapVisible(tester, find.byTooltip('Edit'));
      expect(
        tester.widget<TextFormField>(field('Secret')).controller!.text,
        '',
      );
      await tester.enterText(field('Codecs *'), 'G722, PCMU');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('G722, PCMU'), findsOneWidget);
    });

    testWidgets('the IP list shows status, adds, refuses a bad one, removes', (
      tester,
    ) async {
      await openTrunks(tester);
      await tapVisible(tester, find.byTooltip('IP addresses and status'));
      expect(find.text('Status: Registered'), findsOneWidget);
      expect(find.text('203.0.113.0/24'), findsOneWidget);

      await tester.enterText(
        find.widgetWithText(TextField, 'Address or range'),
        'nope!',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      expect(
        find.text("'nope!' is not a valid address or range."),
        findsOneWidget,
      );

      await tester.enterText(
        find.widgetWithText(TextField, 'Address or range'),
        '198.51.100.0/24',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      expect(find.text('198.51.100.0/24'), findsOneWidget);

      await tester.tap(find.byTooltip('Remove 203.0.113.0/24'));
      await tester.pumpAndSettle();
      expect(find.text('203.0.113.0/24'), findsNothing);
    });
  });

  group('base domains (reseller)', () {
    testWidgets('lists domains, with the record a pending one needs', (
      tester,
    ) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Domains');
      expect(find.text('voice.northwind.example'), findsOneWidget);
      expect(find.text('Verified'), findsOneWidget);
      expect(find.text('Waiting for DNS'), findsOneWidget);
      expect(
        find.textContaining('_verify.talk.northwind.example'),
        findsOneWidget,
      );
      expect(find.textContaining('demo-token-2'), findsOneWidget);
    });

    testWidgets('verifying a domain whose record is there activates it', (
      tester,
    ) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Domains');
      await tester.tap(find.text('Verify now'));
      await tester.pumpAndSettle();
      expect(find.text('talk.northwind.example is verified.'), findsOneWidget);
      expect(find.text('Waiting for DNS'), findsNothing);
      expect(find.text('Verified'), findsNWidgets(2));
    });

    testWidgets('adding a domain, then verifying one that is not proved', (
      tester,
    ) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Domains');
      await tester.tap(find.text('Add domain'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Domain'),
        'unverified.example.com',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      expect(find.text('unverified.example.com'), findsOneWidget);

      await tapVisible(tester, find.text('Verify now').last);
      expect(find.text('The TXT record was not found yet.'), findsOneWidget);
      expect(find.text('Waiting for DNS'), findsWidgets);
    });

    testWidgets('a domain someone has is refused', (tester) async {
      await signInAndOpen(tester, 'reseller@example.test', 'Domains');
      await tester.tap(find.text('Add domain'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'Domain'),
        'voice.northwind.example',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Add'));
      await tester.pumpAndSettle();
      expect(
        find.text('voice.northwind.example is already registered.'),
        findsOneWidget,
      );
    });
  });

  testWidgets('a tenant shows the name it was given under the base domain', (
    tester,
  ) async {
    await signInAndOpen(tester, 'reseller@example.test', 'Tenants');
    expect(find.text('acme-dental.voice.northwind.example'), findsOneWidget);
  });

  group('reseller page (master)', () {
    Future<void> openNorthwind(WidgetTester tester) async {
      await signInAndOpen(tester, 'master@example.test', 'Resellers');
      await tester.tap(find.text('Northwind Telecom'));
      await tester.pumpAndSettle();
    }

    testWidgets('shows the reseller and its tenants', (tester) async {
      await openNorthwind(tester);
      expect(find.text('Northwind Telecom'), findsOneWidget);
      expect(find.text('Acme Dental'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'Trunks'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'Domains'), findsOneWidget);
      expect(find.widgetWithText(Tab, 'Brand'), findsOneWidget);
    });

    testWidgets(
      'its Trunks tab does what a reseller can: pick a tenant, see its trunks',
      (tester) async {
        await openNorthwind(tester);
        await tester.tap(find.widgetWithText(Tab, 'Trunks'));
        await tester.pumpAndSettle();
        expect(
          find.text('Choose a tenant to see and manage its trunks.'),
          findsOneWidget,
        );
        await tester.tap(find.byKey(const ValueKey('trunk-tenant')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Acme Dental').last);
        await tester.pumpAndSettle();
        expect(find.text('Primary trunk'), findsOneWidget);
        expect(find.text('New trunk'), findsOneWidget);
      },
    );

    testWidgets('its Domains tab has the base domains', (tester) async {
      await openNorthwind(tester);
      await tester.tap(find.widgetWithText(Tab, 'Domains'));
      await tester.pumpAndSettle();
      expect(find.text('voice.northwind.example'), findsOneWidget);
    });

    testWidgets('it can be suspended and resumed from its own page', (
      tester,
    ) async {
      await openNorthwind(tester);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Suspend'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Suspend'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(OutlinedButton, 'Resume'), findsOneWidget);
      expect(find.textContaining('suspended'), findsWidgets);
    });

    testWidgets('it can be edited from its own page', (tester) async {
      await openNorthwind(tester);
      await tester.tap(find.widgetWithText(OutlinedButton, 'Edit'));
      await tester.pumpAndSettle();
      await tester.enterText(field('Name *'), 'Northwind Voice');
      await tester.tap(find.widgetWithText(FilledButton, 'Save'));
      await tester.pumpAndSettle();
      expect(find.text('Northwind Voice'), findsOneWidget);
    });

    testWidgets(
      'its Brand tab uploads an image, then saves the brand with it',
      (tester) async {
        await pumpApp(
          tester,
          appWith(
            api: demoApi(),
            overrides: [
              imagePickerProvider.overrideWithValue(
                () async => PickedFile(
                  'logo.png',
                  'image/png',
                  Uint8List.fromList([1, 2, 3]),
                ),
              ),
            ],
          ),
        );
        await submitSignIn(tester, 'master@example.test');
        await tester.tap(
          find.descendant(
            of: find.byType(NavigationRail),
            matching: find.text('Resellers'),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('Northwind Telecom'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(Tab, 'Brand'));
        await tester.pumpAndSettle();

        final logo = find.byKey(const ValueKey('image-logoLight'));
        expect(
          find.descendant(of: logo, matching: find.text('None')),
          findsOneWidget,
        );
        await tapVisible(
          tester,
          find.descendant(of: logo, matching: find.text('Upload')),
        );
        expect(
          find.text('Uploaded logo.png. Save the brand to use it.'),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: logo,
            matching: find.textContaining('logoLight-'),
          ),
          findsOneWidget,
        );

        await tapVisible(tester, find.text('Save brand'));
        expect(find.text('Brand saved.'), findsOneWidget);

        // Taking the image off is a change too.
        await tapVisible(
          tester,
          find.byTooltip('Remove Logo (for light backgrounds)'),
        );
        expect(
          find.descendant(of: logo, matching: find.text('None')),
          findsOneWidget,
        );
      },
    );
  });

  group('uploading a brand image', () {
    test(
      'asks for a URL, then sends the bytes there without credentials',
      () async {
        final seen = <RequestOptions>[];
        final dio = Dio()
          ..httpClientAdapter = FakeAdapter((options) {
            seen.add(options);
            if (options.method == 'POST') {
              return jsonBody({
                'uploadUrl': 'https://storage.example/brand/x?sig=1',
                'key': 'brand/rs-1/logoLight-9',
              }, status: 201);
            }
            return ResponseBody.fromString('', 200);
          });
        final key = await OrgsApi(dio, 'tok').uploadBrandAsset(
          'rs-1',
          kind: 'logoLight',
          contentType: 'image/png',
          bytes: [9, 8, 7],
        );

        expect(key, 'brand/rs-1/logoLight-9');
        expect(seen, hasLength(2));
        expect(seen[0].path, '/v1/resellers/rs-1/brand/assets');
        expect(seen[0].headers['Authorization'], 'Bearer tok');
        expect(jsonDecode(jsonEncode(seen[0].data)), {
          'kind': 'logoLight',
          'contentType': 'image/png',
        });
        expect(seen[1].method, 'PUT');
        expect(seen[1].path, 'https://storage.example/brand/x?sig=1');
        expect(seen[1].headers['Content-Type'], 'image/png');
        expect(seen[1].headers.containsKey('Authorization'), isFalse);
        expect(seen[1].extra['withCredentials'], isFalse);
        expect(seen[1].data, [9, 8, 7]);
      },
    );
  });
}
