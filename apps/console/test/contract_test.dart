import 'dart:convert';
import 'dart:io';

import 'package:console/features/orgs/brand_page.dart';
import 'package:console/features/orgs/org_defs.dart';
import 'package:console/core/session.dart';
import 'package:console/features/pbx/resource.dart';
import 'package:console/features/users/users_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:yaml/yaml.dart';

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
  // A trunk's caller-ID policy is a nested object with no screen yet.
  'trunks': {'callerIdPolicy'},
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
    for (final def in allResources) {
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

  group('org forms', () {
    Set<String> props(String path, String method) =>
        (_schema(
                  (paths[path] as Map)[method] as Map<String, dynamic>,
                )['properties']
                as Map)
            .keys
            .cast<String>()
            .toSet();

    for (final (def, createPath, editPath) in [
      (resellerDef, '/v1/resellers', '/v1/resellers/{id}'),
      (tenantDef, '/v1/resellers/{id}/tenants', '/v1/tenants/{id}'),
    ]) {
      test('${def.key}: create fields are exactly the create body', () {
        expect({
          for (final f in def.fields.where((f) => f.inScope(editing: false)))
            f.key,
        }, props(createPath, 'post'));
      });

      test('${def.key}: edit fields are accepted by the update route', () {
        expect(
          props(editPath, 'patch'),
          containsAll([
            for (final f in def.fields.where((f) => f.inScope(editing: true)))
              f.key,
          ]),
        );
      });
    }

    test(
      'brand editor sends every field the service takes but the uploads',
      () {
        expect(
          {for (final f in brandFields) f.$1},
          props(
            '/v1/resellers/{id}/brand',
            'put',
          ).difference({'logoLightKey', 'logoDarkKey', 'faviconKey'}),
        );
      },
    );

    test('the session brand route answers with the public brand shape', () {
      expect(paths, contains('/v1/session/brand'));
      final brand = _schema(
        (paths['/v1/session/brand'] as Map)['get'] as Map<String, dynamic>,
        response: '200',
      );
      final shapes = [
        for (final s in (brand['anyOf'] ?? brand['oneOf']) as List)
          ((s as Map)['properties'] as Map).keys.toSet(),
      ];
      expect(
        shapes.expand((k) => k).toSet(),
        containsAll([
          'neutral',
          'displayName',
          'primaryColor',
          'accentColor',
          'logoLightUrl',
          'faviconUrl',
        ]),
      );
    });

    test('console hostname rows carry what the brand page reads', () {
      final list = _schema(
        ((paths['/v1/resellers/{id}/console-hostnames'] as Map)['get'])
            as Map<String, dynamic>,
        response: '200',
      );
      final row = ((list['properties'] as Map)['rows'] as Map)['items'] as Map;
      expect(
        (row['properties'] as Map).keys,
        containsAll(['fqdn', 'tlsStatus']),
      );
    });
  });

  group('generated client description (api/openapi.yaml)', () {
    final seed =
        loadYaml(File('api/openapi.yaml').readAsStringSync()) as YamlMap;
    final seedPaths = seed['paths'] as YamlMap;
    final seedSchemas = (seed['components'] as YamlMap)['schemas'] as YamlMap;

    /// The schema an operation's body or response points at, resolved.
    Map<dynamic, dynamic>? seedBody(YamlMap operation) {
      final content =
          (operation['requestBody'] as YamlMap?)?['content'] as YamlMap?;
      final ref =
          ((content?['application/json'] as YamlMap?)?['schema']
              as YamlMap?)?[r'$ref'];
      return ref == null
          ? null
          : seedSchemas['$ref'.split('/').last] as YamlMap;
    }

    for (final path in seedPaths.keys.cast<String>()) {
      for (final method in (seedPaths[path] as YamlMap).keys.cast<String>()) {
        final operation = (seedPaths[path] as YamlMap)[method] as YamlMap;
        final live = ((paths[path] as Map?)?[method]) as Map<String, dynamic>?;

        test('$method $path exists in the services', () {
          expect(
            live,
            isNotNull,
            reason: 'the services do not serve $method $path',
          );
        });

        test('$method $path: request body matches', () {
          final mine = seedBody(operation);
          if (live == null || mine == null) return;
          final theirs = _schema(live);
          expect(
            (mine['properties'] as Map).keys.toSet(),
            (theirs['properties'] as Map).keys.toSet(),
          );
          expect(
            {...?(mine['required'] as List?)?.cast<String>()},
            {...?(theirs['required'] as List?)?.cast<String>()},
            reason: 'required fields',
          );
        });

        test(
          '$method $path: documented success code is one the service sends',
          () {
            if (live == null) return;
            final codes = (operation['responses'] as YamlMap).keys.map(
              (k) => '$k',
            );
            expect((live['responses'] as Map).keys, containsAll(codes));
          },
        );
      }
    }
  });

  group('users', () {
    Map<String, dynamic> body(String path, String method) =>
        _schema((paths[path] as Map)[method] as Map<String, dynamic>);
    Set<String> props(String path, String method) =>
        (body(path, method)['properties'] as Map).keys.cast<String>().toSet();

    const users = '/v1/orgs/{orgId}/users';
    const one = '/v1/orgs/{orgId}/users/{userId}';

    test('the edit form sends what the update route takes, and the role goes through assignments', () {
      final def = userEditDef(OrgType.tenant);
      expect(
        {for (final f in def.fields) f.key}.difference({'role'}),
        props(one, 'patch'),
      );
      expect(paths, contains('/v1/orgs/{orgId}/roles/{roleId}/assignments'));
      final assign =
          (paths['/v1/orgs/{orgId}/roles/{roleId}/assignments'] as Map);
      expect(assign.keys, containsAll(['post', 'delete']));
    });

    test('the access choices are the statuses the service knows', () {
      final status =
          ((body(one, 'patch')['properties'] as Map)['status'] as Map);
      final values = {
        for (final v in (status['anyOf'] ?? status['oneOf']) as List)
          ...((v as Map)['enum'] as List),
      };
      final def = userEditDef(OrgType.tenant);
      expect(
        def.fields.firstWhere((f) => f.key == 'status').choices.toSet(),
        values,
      );
    });

    test('required fields match', () {
      final required = {...?(body(one, 'patch')['required'] as List?)};
      expect(required, isEmpty);
      final def = userEditDef(OrgType.tenant);
      expect(
        def.fields.where((f) => f.required).map((f) => f.key),
        containsAll(['displayName', 'status']),
      );
    });

    test('the invite form is exactly the invitation body', () {
      final invite = '/v1/orgs/{orgId}/invitations';
      expect({
        for (final f in userInviteDef.fields) f.key,
      }, props(invite, 'post'));
      final required = {
        ...(body(invite, 'post')['required'] as List).cast<String>(),
      };
      expect({
        for (final f in userInviteDef.fields.where((f) => f.required)) f.key,
      }, required);
    });

    test(
      'the two-step reset is a POST on the user with no body, answering a user',
      () {
        const reset = '/v1/orgs/{orgId}/users/{userId}/mfa-reset';
        expect(paths, contains(reset));
        final post = (paths[reset] as Map)['post'] as Map<String, dynamic>;
        expect(post.containsKey('requestBody'), isFalse);
        expect(
          (_schema(post, response: '200')['properties'] as Map).keys,
          containsAll(['id', 'mfaEnrolled']),
        );
      },
    );

    test('every field the table reads is in the list response', () {
      final list = _schema(
        (paths[users] as Map)['get'] as Map<String, dynamic>,
        response: '200',
      );
      final row = ((list['properties'] as Map)['rows'] as Map)['items'] as Map;
      expect(
        (row['properties'] as Map).keys,
        containsAll([
          'id',
          'email',
          'displayName',
          'status',
          'mfaEnrolled',
          'lastLoginAt',
          'roleIds',
        ]),
      );
    });

    test('every role offered is a built-in role of that kind of org', () {
      // The role names live in @cuc/authz; this is the console's copy of the
      // built-in ids (07 §3.3), so a rename there shows up here.
      const builtIn = {
        'master_admin',
        'master_support',
        'reseller_admin',
        'reseller_support',
        'tenant_admin',
        'tenant_supervisor',
        'tenant_user',
      };
      for (final roles in rolesByOrgType.values) {
        expect(builtIn, containsAll(roles));
      }
      expect(roleLabels.keys.toSet(), builtIn);
    });
  });

  group('schedule field shapes', () {
    test('a window and a holiday have the properties the editors send', () {
      final post = _schema(
        (paths['/v1/tenants/{tenantId}/schedules'] as Map)['post']
            as Map<String, dynamic>,
      );
      final properties = post['properties'] as Map;
      final rule =
          ((properties['rules'] as Map)['items'] as Map)['properties'] as Map;
      expect(rule.keys, {'days', 'start', 'end'});
      final holiday =
          ((properties['holidays'] as Map)['items'] as Map)['properties']
              as Map;
      expect(holiday.keys, {'date', 'label'});
      final days = (rule['days'] as Map)['items'] as Map;
      expect(days['minimum'], 0);
      expect(days['maximum'], 6);
    });

    test(
      'the time zone choices are all valid IANA names the service would take',
      () {
        // Every entry is a canonical `Area/Place` name or UTC.
        for (final z in commonTimezones) {
          expect(
            z == 'UTC' || RegExp(r'^[A-Z][A-Za-z_]+/[A-Za-z_]+$').hasMatch(z),
            isTrue,
            reason: z,
          );
        }
      },
    );
  });
}
