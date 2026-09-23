import 'dart:convert';
import 'dart:io';

import 'package:console/features/pbx/resource.dart';
import 'package:flutter_test/flutter_test.dart';

/// `api/openapi.json` is dumped from the services' own route schemas
/// (`tool/dump-openapi.mjs`). These tests fail when a screen's fields drift
/// from what the service accepts, which is the drift G-54 warns about.
Map<String, dynamic> _spec() =>
    jsonDecode(File('api/openapi.json').readAsStringSync())
        as Map<String, dynamic>;

Map<String, dynamic> _schema(
  Map<String, dynamic> operation, {
  String? response,
}) {
  final content = response == null
      ? (operation['requestBody'] as Map)['content']
      : ((operation['responses'] as Map)[response] as Map)['content'];
  return ((content as Map)['application/json'] as Map)['schema']
      as Map<String, dynamic>;
}

/// Fields the service accepts that a screen leaves out on purpose.
const _notExposed = {
  // Linking an extension to a user belongs with the Users screen.
  'extensions': {'userId'},
};

void main() {
  final spec = _spec();
  final paths = spec['paths'] as Map<String, dynamic>;

  final editable = allResources.where((r) => !r.readOnly);

  for (final def in editable) {
    group(def.key, () {
      final collection =
          paths['/v1/tenants/{tenantId}/${def.key}'] as Map<String, dynamic>;

      test('form fields are exactly the create body', () {
        final body = _schema(collection['post'] as Map<String, dynamic>);
        final properties = (body['properties'] as Map).keys.toSet();
        expect({
          for (final f in def.fields) f.key,
        }, properties.difference(_notExposed[def.key] ?? {}));
      });

      test('required fields match the create body', () {
        final body = _schema(collection['post'] as Map<String, dynamic>);
        final required = {...?(body['required'] as List?)?.cast<String>()};
        expect({
          for (final f in def.fields.where((f) => f.required)) f.key,
        }, required);
      });

      test('every field the table reads is in the response', () {
        final list = _schema(
          collection['get'] as Map<String, dynamic>,
          response: '200',
        );
        final row =
            ((list['properties'] as Map)['rows'] as Map)['items'] as Map;
        final returned = (row['properties'] as Map).keys.toSet();
        for (final f in def.fields.where((f) => f.showInList && !f.writeOnly)) {
          expect(returned, contains(f.key), reason: f.key);
        }
      });
    });
  }

  test('destination types match what the services accept', () {
    final body = _schema(
      (paths['/v1/tenants/{tenantId}/dids'] as Map)['post']
          as Map<String, dynamic>,
    );
    final union =
        ((body['properties'] as Map)['destinationType'] as Map)['anyOf']
            as List;
    final accepted = {
      for (final u in union) ((u as Map)['enum'] as List).single as String,
    };
    expect(destinationTypes.toSet(), accepted);
  });

  test('every resource with a page has a list route', () {
    for (final def in allResources.where((r) => r.key != 'trunks')) {
      expect(paths, contains('/v1/tenants/{tenantId}/${def.key}'));
    }
  });

  test('the org lists carry the fields the org screens read', () {
    for (final path in ['/v1/resellers', '/v1/resellers/{id}/tenants']) {
      final list = _schema(
        (paths[path] as Map)['get'] as Map<String, dynamic>,
        response: '200',
      );
      final row = ((list['properties'] as Map)['rows'] as Map)['items'] as Map;
      expect(
        (row['properties'] as Map).keys,
        containsAll(['id', 'name', 'slug', 'status']),
        reason: path,
      );
    }
  });
}
