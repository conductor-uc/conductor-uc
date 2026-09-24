import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/api_client.dart';
import '../../core/session.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart';

/// The built-in roles a user of each kind of org can be given, and what to
/// call them. Custom roles are managed elsewhere; this screen only sets one
/// of these.
const rolesByOrgType = <OrgType, List<String>>{
  OrgType.master: ['master_admin', 'master_support'],
  OrgType.reseller: ['reseller_admin', 'reseller_support'],
  OrgType.tenant: ['tenant_admin', 'tenant_supervisor', 'tenant_user'],
};

const roleLabels = {
  'master_admin': 'Administrator',
  'master_support': 'Support',
  'reseller_admin': 'Administrator',
  'reseller_support': 'Support',
  'tenant_admin': 'Administrator',
  'tenant_supervisor': 'Supervisor',
  'tenant_user': 'User',
};

/// The edit form for a person: their name, role, and whether they can sign in.
ResourceDef userEditDef(OrgType orgType) => ResourceDef(
  key: 'users',
  singular: 'User',
  plural: 'Users',
  icon: Icons.people_outline,
  fields: [
    const Field('displayName', 'Name', FieldKind.text, required: true),
    Field(
      'role',
      'Role',
      FieldKind.choice,
      choices: rolesByOrgType[orgType]!,
      choiceLabels: roleLabels,
      help: 'What they can do. Without a role they can sign in but not much else.',
    ),
    const Field(
      'status',
      'Access',
      FieldKind.choice,
      required: true,
      choices: ['active', 'disabled'],
      choiceLabels: {'active': 'Can sign in', 'disabled': 'Disabled'},
    ),
  ],
);

/// The invite form. The person chooses their own password when they accept.
const userInviteDef = ResourceDef(
  key: 'invitations',
  singular: 'Invitation',
  plural: 'Invitations',
  icon: Icons.people_outline,
  fields: [
    Field('email', 'Email', FieldKind.text, required: true),
    Field('displayName', 'Name', FieldKind.text, required: true),
  ],
);

/// The people of one organization (`/v1/orgs/{id}/users`), their invitations,
/// and the role assignments. That is the signed-in user's own organization, or,
/// for a master or reseller who has entered a tenant, that tenant: the service
/// lets them manage the organizations beneath them.
class UsersApi {
  UsersApi(this._dio, this._token, this.orgId, this.orgType);

  final Dio _dio;
  final String _token;
  final String orgId;
  final OrgType orgType;

  Options get _options => Options(headers: {'Authorization': 'Bearer $_token'});

  List<String> get _roles => rolesByOrgType[orgType]!;

  Json _row(Map<Object?, Object?> raw) {
    final row = raw.cast<String, dynamic>();
    final ids = [...?(row['roleIds'] as List?)?.cast<String>()];
    final mine = ids.where(_roles.contains);
    return {...row, 'role': mine.isEmpty ? null : mine.first};
  }

  Future<List<Json>> list() async {
    final response = await _dio.get<Object?>(
      '/v1/orgs/$orgId/users',
      options: _options,
    );
    return [
      for (final r in (response.data as Map)['rows'] as List) _row(r as Map),
    ];
  }

  /// Saves an edit: the name and access through one call, then the role
  /// through the assignment routes, so nothing is changed that was not asked.
  Future<Json> update(Json existing, Json body) async {
    final id = '${existing['id']}';
    final profile = {
      for (final k in const ['displayName', 'status'])
        if (body.containsKey(k) && body[k] != existing[k]) k: body[k],
    };
    var saved = existing;
    if (profile.isNotEmpty) {
      final response = await _dio.patch<Object?>(
        '/v1/orgs/$orgId/users/$id',
        data: profile,
        options: _options,
      );
      saved = _row((response.data as Map).cast<Object?, Object?>());
    }
    if (body.containsKey('role') && body['role'] != existing['role']) {
      await _setRole(id, existing, body['role'] as String?);
      final ids = [
        ...(existing['roleIds'] as List).cast<String>().where(
          (r) => !_roles.contains(r),
        ),
        ?body['role'] as String?,
      ];
      saved = {...saved, 'roleIds': ids, 'role': body['role']};
    }
    return saved;
  }

  Future<void> _setRole(String userId, Json existing, String? role) async {
    final held = (existing['roleIds'] as List).cast<String>();
    for (final r in held.where((r) => _roles.contains(r) && r != role)) {
      await _dio.delete<Object?>(
        '/v1/orgs/$orgId/roles/$r/assignments',
        data: {'userId': userId},
        options: _options,
      );
    }
    if (role != null && !held.contains(role)) {
      await _dio.post<Object?>(
        '/v1/orgs/$orgId/roles/$role/assignments',
        data: {'userId': userId},
        options: _options,
      );
    }
  }

  Future<Json> invite(Json body) async {
    final response = await _dio.post<Object?>(
      '/v1/orgs/$orgId/invitations',
      data: body,
      options: _options,
    );
    return (response.data as Map).cast<String, dynamic>();
  }
}

/// Whose people the Users screen shows: the tenant entered through "act as",
/// else the signed-in user's own organization.
final usersApiProvider = Provider<UsersApi?>((ref) {
  final session = ref.watch(sessionProvider);
  if (session == null) return null;
  final tenant = ref.watch(actingProvider);
  return UsersApi(
    ref.watch(apiProvider).dio,
    session.accessToken,
    tenant?.id ?? session.orgId,
    tenant == null ? session.orgType : OrgType.tenant,
  );
});

final usersProvider = FutureProvider<List<Json>>((ref) async {
  return await ref.watch(usersApiProvider)?.list() ?? const [];
});
