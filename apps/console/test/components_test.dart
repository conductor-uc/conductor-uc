import 'package:console/widgets/data_table.dart';
import 'package:console/widgets/editor_page.dart';
import 'package:console/widgets/feedback.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

/// S9-03: the shared table, empty state, confirmation, and editor page.
void main() {
  final people = [
    for (var i = 1; i <= 30; i++)
      (id: '$i', name: 'Person ${i.toString().padLeft(2, '0')}', ext: 100 + i),
  ];

  Widget table({
    List<({String id, String name, int ext})>? rows,
    void Function(List<({String id, String name, int ext})>)? onBulk,
  }) => localizedApp(
    SingleChildScrollView(
      child: AppTable<({String id, String name, int ext})>(
        rows: rows ?? people,
        rowKey: (r) => r.id,
        pageSize: 10,
        columns: [
          AppColumn(
            label: 'Name',
            cell: (r) => Text(r.name),
            text: (r) => r.name,
          ),
          AppColumn(
            label: 'Extension',
            cell: (r) => Text('${r.ext}'),
            text: (r) => '${r.ext}',
            sortValue: (r) => r.ext,
            numeric: true,
          ),
        ],
        bulkActions: onBulk == null
            ? null
            : (selected, clear) => [
                TextButton(
                  onPressed: () {
                    onBulk(selected);
                    clear();
                  },
                  child: const Text('Act'),
                ),
              ],
      ),
    ),
  );

  testWidgets('pages through rows, ten at a time', (tester) async {
    await tester.pumpWidget(table());
    expect(find.text('Person 01'), findsOneWidget);
    expect(find.text('Person 11'), findsNothing);
    expect(find.text('1–10 of 30'), findsOneWidget);
    await tester.ensureVisible(find.byTooltip('Next page'));
    await tester.tap(find.byTooltip('Next page'));
    await tester.pump();
    expect(find.text('Person 11'), findsOneWidget);
    expect(find.text('11–20 of 30'), findsOneWidget);
  });

  testWidgets('searches every column, and says when nothing matches', (
    tester,
  ) async {
    await tester.pumpWidget(table());
    await tester.enterText(find.byKey(const ValueKey('table-search')), '125');
    await tester.pump();
    expect(find.text('Person 25'), findsOneWidget);
    expect(find.text('Person 01'), findsNothing);
    await tester.enterText(
      find.byKey(const ValueKey('table-search')),
      'nobody',
    );
    await tester.pump();
    expect(find.text('Nothing matches “nobody”.'), findsOneWidget);
    await tester.tap(find.byTooltip('Clear search'));
    await tester.pump();
    expect(find.text('Person 01'), findsOneWidget);
  });

  testWidgets('sorts by a column, and again the other way', (tester) async {
    await tester.pumpWidget(table());
    await tester.tap(find.text('Extension'));
    await tester.pump();
    await tester.tap(find.text('Extension'));
    await tester.pump();
    expect(find.text('Person 30'), findsOneWidget);
    expect(find.text('Person 01'), findsNothing);
  });

  testWidgets('a short list has no search box to get in the way', (
    tester,
  ) async {
    await tester.pumpWidget(table(rows: people.take(3).toList()));
    expect(find.byKey(const ValueKey('table-search')), findsNothing);
  });

  testWidgets('selected rows are acted on together', (tester) async {
    List<({String id, String name, int ext})>? acted;
    await tester.pumpWidget(table(onBulk: (rows) => acted = rows));
    await tester.tap(find.byType(Checkbox).at(1));
    await tester.tap(find.byType(Checkbox).at(2));
    await tester.pump();
    expect(find.text('2 selected'), findsOneWidget);
    await tester.tap(find.text('Act'));
    await tester.pump();
    expect(acted?.map((r) => r.name), ['Person 01', 'Person 02']);
    expect(find.text('2 selected'), findsNothing);
  });

  testWidgets('an empty state says what to do first', (tester) async {
    await tester.pumpWidget(
      localizedApp(
        EmptyState(
          icon: Icons.dialpad_outlined,
          title: 'No extensions yet.',
          message: 'Every phone needs one.',
          action: FilledButton(onPressed: () {}, child: const Text('Add one')),
        ),
      ),
    );
    expect(find.text('Every phone needs one.'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Add one'), findsOneWidget);
  });

  testWidgets('a confirmation lists what else is affected', (tester) async {
    bool? answer;
    await tester.pumpWidget(
      localizedApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () async => answer = await confirmAction(
              context,
              title: 'Delete Reception?',
              impact: const ['Phone number +1 415 555 0100 rings it'],
              confirmLabel: 'Delete',
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    expect(find.text('This also affects:'), findsOneWidget);
    expect(find.text('Phone number +1 415 555 0100 rings it'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    expect(answer, isFalse);
  });

  testWidgets('an editor page keeps Save and Cancel in reach, with the error', (
    tester,
  ) async {
    var saved = false;
    await tester.pumpWidget(
      localizedApp(
        EditorPage(
          title: 'Maria Lopez',
          sections: const [
            EditorSection(title: 'Basics', children: [Text('Name')]),
            EditorSection(
              title: 'Advanced',
              collapsible: true,
              initiallyExpanded: false,
              children: [Text('Codecs')],
            ),
          ],
          error: 'Some details need fixing.',
          onSave: () => saved = true,
          onCancel: () {},
        ),
      ),
    );
    expect(find.text('Name'), findsOneWidget);
    expect(find.text('Codecs'), findsNothing);
    await tester.tap(find.text('Advanced'));
    await tester.pumpAndSettle();
    expect(find.text('Codecs'), findsOneWidget);
    expect(find.text('Some details need fixing.'), findsOneWidget);
    await tester.tap(find.text('Save'));
    expect(saved, isTrue);
  });
}
