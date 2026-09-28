import 'package:console/app/router.dart';
import 'package:console/core/permissions.dart';
import 'package:console/features/platform/operations_api.dart';
import 'package:console/features/platform/operations_page.dart';
import 'package:console/features/platform/operations_widgets.dart';
import 'package:dio/dio.dart';
import 'package:console/features/shell/shell_page.dart' show AppNavigation;
import 'package:console/l10n/l10n.dart';
import 'package:console/features/platform/operations_charts.dart'
    show HistoryLines;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'act_as_test.dart' show navItem;
import 'support.dart';

/// A reading as the gateway sends it (11 §2.2): two nodes, one drained; one
/// service not ready and one unreachable; a consumer behind; the edge up.
Map<String, Object?> overviewFixture() => {
  'checkedAt': '2026-09-27T22:00:00.000Z',
  'services': [
    {
      'name': 'call-control',
      'status': 'up',
      'latencyMs': 4,
      'version': '0.1.0',
      'uptimeSeconds': 273600,
      'checks': [
        {'name': 'redis', 'status': 'pass'},
      ],
      'memory': {'rssBytes': 91234304, 'heapUsedBytes': 40123000},
      'outbox': {'pending': 0, 'oldestPendingSeconds': null, 'failed': 0},
    },
    {
      'name': 'voicemail-service',
      'status': 'degraded',
      'latencyMs': 40,
      'version': '0.1.0',
      'uptimeSeconds': 600,
      'checks': [
        {'name': 'db', 'status': 'pass'},
        {'name': 'storage', 'status': 'fail'},
      ],
      'memory': null,
      'outbox': null,
    },
    {
      'name': 'recording-uploader-fs1',
      'status': 'up',
      'latencyMs': 3,
      'version': '0.1.0',
      'uptimeSeconds': 8000,
      'checks': <Object>[],
      'memory': null,
      'outbox': null,
      'facts': [
        {'label': 'Spool files', 'value': 2, 'unit': 'count'},
        {'label': 'Spool size', 'value': 3250586, 'unit': 'bytes'},
      ],
    },
    {
      'name': 'media-worker',
      'status': 'down',
      'latencyMs': 2000,
      'version': null,
      'uptimeSeconds': null,
      'checks': <Object>[],
      'memory': null,
      'outbox': null,
    },
  ],
  'nodes': [
    {
      'nodeId': 'fs1',
      'status': 'up',
      'draining': false,
      'calls': 12,
      'leases': 3,
      'weight': 2,
      'dispatcher': 'active',
      'uri': 'sip:10.10.0.21:5060',
      'sessions': 24,
      'maxSessions': 1000,
      'cpuIdlePercent': 71.5,
      'sessionsPerSecond': 0.4,
      'uptimeSeconds': 8200,
      'heartbeatAt': '2026-09-27T21:59:58.000Z',
    },
    {
      'nodeId': 'fs2',
      'status': 'draining',
      'draining': true,
      'calls': 3,
      'leases': 0,
      'weight': 1,
      'dispatcher': 'inactive',
      'uri': 'sip:10.10.0.22:5060',
      'sessions': null,
      'maxSessions': null,
      'cpuIdlePercent': null,
      'sessionsPerSecond': null,
      'uptimeSeconds': null,
      'heartbeatAt': null,
    },
  ],
  'signalling': {
    'status': 'up',
    'uptimeSeconds': 8300,
    'registrations': 42,
    'activeDialogs': 5,
    'earlyDialogs': 1,
    'transactions': 7,
    'shmUsedBytes': 12000000,
    'shmTotalBytes': 268435456,
  },
  'events': {
    'streams': [
      {'name': 'CALL', 'messages': 1200, 'bytes': 800000, 'consumers': 1},
    ],
    'consumers': [
      {
        'stream': 'CALL',
        'name': 'telephony-config-nodes',
        'pending': 4,
        'ackPending': 1,
        'redelivered': 0,
      },
    ],
  },
  'dataStores': [
    {
      'name': 'redis',
      'status': 'up',
      'version': '7.4.1',
      'uptimeSeconds': 9000,
      'facts': [
        {'label': 'Memory used', 'value': 2500000, 'unit': 'bytes'},
        {'label': 'Operations per second', 'value': 35, 'unit': 'perSecond'},
      ],
    },
  ],
};

/// Records the node actions instead of sending them.
class RecordingOperationsApi extends OperationsApi {
  RecordingOperationsApi() : super(Dio(), 'token');

  final calls = <String>[];

  @override
  Future<void> drain(String nodeId) async => calls.add('drain $nodeId');

  @override
  Future<void> undrain(String nodeId) async => calls.add('undrain $nodeId');

  @override
  Future<void> setWeight(String nodeId, int weight) async =>
      calls.add('weight $nodeId $weight');
}

Future<void> pumpOperations(
  WidgetTester tester, {
  Set<String> permissions = const {'platform.observe', 'platform.operate'},
  Size size = const Size(1280, 900),
  OperationsApi? api,
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        operationsOverviewProvider.overrideWith(
          (ref) async => Overview.fromJson(overviewFixture()),
        ),
        knownPermissionsProvider.overrideWithValue(permissions),
        if (api != null) operationsApiProvider.overrideWithValue(api),
      ],
      child: const MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: Scaffold(body: OperationsPage()),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> openTab(WidgetTester tester, String label) async {
  final tab = find.descendant(
    of: find.byType(TabBar),
    matching: find.text(label),
  );
  // On a phone the tab bar scrolls; bring the tab into view first.
  await tester.ensureVisible(tab);
  await tester.pumpAndSettle();
  await tester.tap(tab);
  await tester.pumpAndSettle();
}

void main() {
  group('formatting', () {
    test(
      'bytes, durations, percentages and counts read as people read them',
      () {
        expect(formatBytes(null), noValue);
        expect(formatBytes(512), '512 B');
        expect(formatBytes(1536), '1.5 KB');
        expect(formatBytes(91234304), '87.0 MB');
        expect(formatSpan(42), '42 s');
        expect(formatSpan(600), '10 min');
        expect(formatSpan(8200), '2 h 16 min');
        expect(formatSpan(273600), '3 d 4 h');
        expect(formatPercent(28.5), '29%');
        expect(formatPercent(4.25), '4.3%');
        expect(formatCount(18240), '18,240');
        expect(formatFact(35, 'perSecond'), '35/s');
      },
    );

    test('a weight is a whole number from 1 to 999', () {
      expect(weightError('1'), isNull);
      expect(weightError(' 999 '), isNull);
      expect(weightError('0'), 'Enter a weight from 1 to 999.');
      expect(weightError('1000'), 'Enter a weight from 1 to 999.');
      expect(weightError(''), 'Enter a whole number.');
      expect(weightError('2.5'), 'Enter a whole number.');
    });
  });

  group('Operations page', () {
    testWidgets('the Overview leads with the headline figures and charts', (
      tester,
    ) async {
      await pumpOperations(tester);
      expect(find.text('Operations'), findsOneWidget);
      expect(
        find.text('Read at 22:00:00 UTC. Refreshes every 5 seconds.'),
        findsOneWidget,
      );
      expect(find.text('2 of 4'), findsOneWidget); // services ready
      expect(find.text('1 of 2'), findsOneWidget); // nodes in service
      expect(find.text('15'), findsWidgets); // live calls
      expect(find.text('Calls per media node'), findsOneWidget);
      expect(find.text('Media node CPU'), findsOneWidget);
      expect(find.text('29%'), findsOneWidget); // fs1 busy: 100 - 71.5
      expect(find.text('1 consumers behind'), findsOneWidget);
    });

    testWidgets('Services lists problems first, with what is failing', (
      tester,
    ) async {
      await pumpOperations(tester);
      await openTab(tester, 'Services');
      expect(find.text('Unreachable'), findsOneWidget);
      expect(find.text('Not ready'), findsWidgets);
      expect(find.text('storage'), findsOneWidget);
      expect(find.text('87.0 MB'), findsOneWidget);
      expect(find.text('3 d 4 h'), findsOneWidget);
      final table = tester.widget<DataTable>(find.byType(DataTable));
      final order = [
        for (final row in table.rows) (row.cells.first.child as Text).data,
      ];
      expect(order, [
        'media-worker',
        'voicemail-service',
        'call-control',
        'recording-uploader-fs1',
      ]);
      // A service's own figures, such as an uploader's spool.
      expect(find.text('Spool files 2  ·  Spool size 3.1 MB'), findsOneWidget);
    });

    testWidgets('a media node card shows its state and its actions', (
      tester,
    ) async {
      final api = RecordingOperationsApi();
      await pumpOperations(tester, api: api);
      await openTab(tester, 'Media nodes');
      expect(find.text('fs1'), findsOneWidget);
      expect(find.text('In rotation'), findsOneWidget);
      expect(find.text('Out of rotation'), findsOneWidget);
      expect(find.text('24 of 1,000'), findsOneWidget);
      expect(find.text('No heartbeat reported yet.'), findsOneWidget);
      expect(find.text('Drain'), findsOneWidget); // fs1
      expect(find.text('Return to service'), findsOneWidget); // fs2

      await tester.tap(find.text('Drain'));
      await tester.pumpAndSettle();
      expect(find.text('Drain fs1?'), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Drain'));
      await tester.pumpAndSettle();
      expect(api.calls, ['drain fs1']);
      expect(find.text('fs1 is draining.'), findsOneWidget);
    });

    testWidgets('nobody without platform.operate is offered the actions', (
      tester,
    ) async {
      await pumpOperations(tester, permissions: {'platform.observe'});
      await openTab(tester, 'Media nodes');
      expect(find.text('fs1'), findsOneWidget);
      expect(find.text('Drain'), findsNothing);
      expect(find.text('Return to service'), findsNothing);
      expect(find.text('Set weight'), findsNothing);
    });

    testWidgets('the weight dialog refuses anything but 1 to 999', (
      tester,
    ) async {
      final api = RecordingOperationsApi();
      await pumpOperations(tester, api: api);
      await openTab(tester, 'Media nodes');
      await tester.tap(find.text('Set weight').first);
      await tester.pumpAndSettle();
      expect(find.text('Set the weight of fs1'), findsOneWidget);

      final field = find.widgetWithText(TextField, 'Weight');
      await tester.enterText(field, '0');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a weight from 1 to 999.'), findsOneWidget);
      expect(api.calls, isEmpty);

      await tester.enterText(field, '1000');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a weight from 1 to 999.'), findsOneWidget);

      await tester.enterText(field, '5');
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(api.calls, ['weight fs1 5']);
      expect(find.text('fs1 now has weight 5.'), findsOneWidget);
    });

    testWidgets('Signalling, Events and Data stores show their sources', (
      tester,
    ) async {
      await pumpOperations(tester);
      await openTab(tester, 'Signalling');
      expect(find.text('42'), findsOneWidget);
      // fs2 is out of rotation, so fs1 takes every new call.
      expect(find.text('100%'), findsOneWidget);
      expect(find.text('0%'), findsOneWidget);
      await openTab(tester, 'Events');
      expect(find.text('telephony-config-nodes'), findsOneWidget);
      await openTab(tester, 'Data stores');
      expect(find.text('Redis'), findsOneWidget);
      expect(find.text('35/s'), findsOneWidget);
    });

    for (final (tab, width, marker) in [
      ('Overview', 360.0, 'Calls per media node'),
      ('Services', 360.0, 'media-worker'),
      ('Media nodes', 360.0, '24 of 1,000'),
      ('Signalling', 360.0, 'Media nodes at the edge'),
      ('Events', 360.0, 'telephony-config-nodes'),
      ('Data stores', 360.0, 'Redis'),
      ('History', 360.0, 'Over the last'),
      ('Overview', 1920.0, 'Calls per media node'),
      ('Media nodes', 1920.0, '24 of 1,000'),
    ]) {
      testWidgets('$tab lays out without overflow at ${width.round()} px', (
        tester,
      ) async {
        await pumpOperations(tester, size: Size(width, 800));
        if (tab != 'Overview') await openTab(tester, tab);
        expect(find.text(marker), findsWidgets);
        expect(tester.takeException(), isNull);
      });
    }
  });

  group('against the demo backend', () {
    testWidgets('the master opens Operations and drains a node', (
      tester,
    ) async {
      await completeSignIn(tester, 'master@example.test');
      await tapNav(tester, 'Operations');
      await tester.pumpAndSettle();
      expect(find.text('Services ready'), findsWidgets);
      await openTab(tester, 'Media nodes');
      await tester.tap(find.text('Drain'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Drain'));
      await tester.pumpAndSettle();
      expect(find.text('fs1 is draining.'), findsOneWidget);
      expect(find.text('Return to service'), findsNWidgets(2));
    });

    testWidgets('S4-13: History charts the catalog, and changes range', (
      tester,
    ) async {
      await completeSignIn(tester, 'master@example.test');
      await tapNav(tester, 'Operations');
      await tester.pumpAndSettle();
      await openTab(tester, 'History');
      expect(find.text('Calls on each media node'), findsOneWidget);
      expect(find.byType(HistoryLines), findsWidgets);
      // A per-node chart has a legend naming each node.
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('history-calls-by-node')),
          matching: find.text('fs-2'),
        ),
        findsOneWidget,
      );
      await tester.tap(find.text('week'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<SegmentedButton<String>>(
              find.byKey(const ValueKey('history-range')),
            )
            .selected,
        {'7d'},
      );
      expect(find.byType(HistoryLines), findsWidgets);
    });

    testWidgets('S4-13: without a metrics store, History says so once', (
      tester,
    ) async {
      await completeSignIn(tester, 'master-nohistory@example.test');
      await tapNav(tester, 'Operations');
      await tester.pumpAndSettle();
      await openTab(tester, 'History');
      expect(find.byKey(const ValueKey('history-unavailable')), findsOneWidget);
      expect(find.byType(HistoryLines), findsNothing);
    });

    testWidgets('master support sees Operations but cannot act', (
      tester,
    ) async {
      await completeSignIn(tester, 'master-support@example.test');
      await tapNav(tester, 'Operations');
      await tester.pumpAndSettle();
      await openTab(tester, 'Media nodes');
      expect(find.text('fs1'), findsOneWidget);
      expect(find.text('Drain'), findsNothing);
      expect(find.text('Set weight'), findsNothing);
    });

    testWidgets('the old Platform health address opens Operations', (
      tester,
    ) async {
      await completeSignIn(tester, 'master@example.test');
      final container = ProviderScope.containerOf(
        tester.element(find.byType(AppNavigation)),
      );
      container.read(routerProvider).go('/platform-health');
      await tester.pumpAndSettle();
      expect(container.read(routerProvider).state.uri.path, '/operations');
    });

    testWidgets('no reseller or tenant is offered Operations', (tester) async {
      await completeSignIn(tester, 'reseller@example.test');
      expect(navItem('Operations'), findsNothing);
    });
  });
}
