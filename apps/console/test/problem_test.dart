import 'package:console/core/problem.dart';
import 'package:console/features/pbx/resource.dart';
import 'package:console/features/pbx/resource_form.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

DioException failure(Object? data, [int status = 400]) => DioException(
  requestOptions: RequestOptions(path: '/x'),
  response: Response(
    requestOptions: RequestOptions(path: '/x'),
    statusCode: status,
    data: data,
  ),
);

/// What `@cuc/http` sends for a body that failed its schema (S9-02).
Map<String, Object> schemaFailure(List<Map<String, Object>> errors) => {
  'code': 'validation_failed',
  'detail': 'The body failed validation.',
  'errors': errors,
};

void main() {
  test('a code the console knows is said in its own words', () {
    expect(
      problemMessage(
        failure({'code': 'step_up_locked', 'detail': 'Locked.'}, 429),
      ),
      'Too many wrong codes. Wait 15 minutes, then try again.',
    );
  });

  test("a code it doesn't know yet falls back to the service's detail", () {
    expect(
      problemMessage(
        failure({'code': 'slug_taken', 'detail': 'Slug taken.'}, 409),
      ),
      'Slug taken.',
    );
  });

  test('a refused field is worded from its rule, not the English message', () {
    expect(
      problemMessage(
        failure(
          schemaFailure([
            {
              'field': '/adminPassword',
              'message': 'must NOT have fewer than 12 characters',
              'keyword': 'minLength',
              'params': {'limit': 12},
            },
          ]),
        ),
      ),
      'Some details need fixing. admin password: Use at least 12 characters.',
    );
  });

  test("a rule the console doesn't know keeps the service's message", () {
    expect(
      problemMessage(
        failure(
          schemaFailure([
            {'field': '/x', 'message': 'is odd', 'keyword': 'somethingNew'},
          ]),
        ),
      ),
      'Some details need fixing. x: is odd',
    );
  });

  test('field problems are keyed by the top-level field', () {
    expect(
      problemFieldMessages(
        failure(
          schemaFailure([
            {'field': '/number', 'message': '', 'keyword': 'required'},
            {'field': '/rules/0/start', 'message': '', 'keyword': 'pattern'},
          ]),
        ),
      ),
      {
        'number': 'This is required.',
        'rules': "This isn't in the expected format.",
      },
    );
  });

  test('no response means the server could not be reached', () {
    expect(
      problemMessage(DioException(requestOptions: RequestOptions(path: '/x'))),
      'Could not reach the server.',
    );
  });

  testWidgets('a refused field shows its problem under itself, until edited', (
    tester,
  ) async {
    const def = ResourceDef(
      key: 'things',
      singular: 'Thing',
      plural: 'Things',
      icon: Icons.widgets_outlined,
      fields: [
        Field('name', 'Name', FieldKind.text, required: true),
        Field('number', 'Number', FieldKind.integer),
      ],
    );
    await tester.pumpWidget(
      localizedApp(
        Builder(
          builder: (context) => TextButton(
            onPressed: () => showDialog<void>(
              context: context,
              builder: (_) => ResourceFormDialog(
                def: def,
                save: (_, _) => Future.error(
                  failure(
                    schemaFailure([
                      {
                        'field': '/number',
                        'message': 'must be <= 99',
                        'keyword': 'maximum',
                        'params': {'comparison': '<=', 'limit': 99},
                      },
                    ]),
                  ),
                ),
              ),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    await tester.enterText(find.widgetWithText(TextFormField, 'Name *'), 'A');
    await tester.enterText(find.widgetWithText(TextFormField, 'Number'), '100');
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    // Under the field, and not repeated in the message below the form.
    expect(find.text('Use 99 or less.'), findsOneWidget);
    expect(find.text('Some details need fixing.'), findsOneWidget);

    await tester.enterText(find.widgetWithText(TextFormField, 'Number'), '9');
    await tester.pump();
    expect(find.text('Use 99 or less.'), findsNothing);
  });
}
