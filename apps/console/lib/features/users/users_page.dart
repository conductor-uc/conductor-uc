import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/session.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart';
import 'users_api.dart';

/// The people in the signed-in user's own organization: invite, name, role,
/// and whether they can sign in.
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session == null) return const SizedBox.shrink();
    if (ref.watch(actingProvider) != null) {
      // Each organization's people are managed from inside it.
      return const PageFrame(
        children: [
          PageHeader(title: 'Users'),
          SizedBox(height: 16),
          Text(
            "A tenant's people are managed by the tenant's own administrators, "
            'not from here. Leave this tenant to manage your own users.',
          ),
        ],
      );
    }
    final rows = ref.watch(usersProvider);
    return PageFrame(
      children: [
        PageHeader(
          title: 'Users',
          subtitle: 'People who can sign in. Invite someone by email, then give them a role.',
          actions: [
            FilledButton.icon(
              onPressed: () => _invite(context, ref),
              icon: const Icon(Icons.person_add_alt_outlined),
              label: const Text('Invite user'),
            ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: 'No users yet.',
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minWidth: MediaQuery.sizeOf(context).width - 320,
                  ),
                  child: DataTable(
                    columns: const [
                      DataColumn(label: Text('Name')),
                      DataColumn(label: Text('Email')),
                      DataColumn(label: Text('Role')),
                      DataColumn(label: Text('Access')),
                      DataColumn(label: Text('Two-step')),
                      DataColumn(label: Text('Last sign-in')),
                      DataColumn(label: Text('')),
                    ],
                    rows: [
                      for (final u in data) _row(context, ref, session, u),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  DataRow _row(BuildContext context, WidgetRef ref, Session session, Json u) {
    final mine = u['id'] == session.userId;
    final disabled = u['status'] == 'disabled';
    final role = u['role'] as String?;
    return DataRow(
      key: ValueKey('user-${u['id']}'),
      cells: [
        DataCell(Text('${u['displayName']}${mine ? ' (you)' : ''}')),
        DataCell(Text('${u['email']}')),
        DataCell(Text(role == null ? 'No role' : roleLabels[role] ?? role)),
        DataCell(Text(disabled ? 'Disabled' : 'Can sign in')),
        DataCell(
          Icon(u['mfaEnrolled'] == true ? Icons.check : Icons.remove, size: 18),
        ),
        DataCell(Text(_when(u['lastLoginAt']))),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                tooltip: 'Edit',
                icon: const Icon(Icons.edit_outlined),
                onPressed: () => _edit(context, ref, session, u),
              ),
              if (!mine)
                IconButton(
                  tooltip: disabled ? 'Allow sign-in' : 'Disable',
                  icon: Icon(
                    disabled ? Icons.lock_open_outlined : Icons.block_outlined,
                  ),
                  onPressed: () => disabled
                      ? _setStatus(context, ref, u, 'active')
                      : _confirmDisable(context, ref, u),
                ),
            ],
          ),
        ),
      ],
    );
  }

  String _when(Object? iso) {
    final t = iso == null ? null : DateTime.tryParse('$iso')?.toLocal();
    if (t == null) return 'Never';
    String two(int n) => n.toString().padLeft(2, '0');
    return '${t.year}-${two(t.month)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}';
  }

  Future<void> _edit(
    BuildContext context,
    WidgetRef ref,
    Session session,
    Json user,
  ) async {
    final api = ref.read(usersApiProvider);
    if (api == null) return;
    final saved = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(
        def: userEditDef(session.orgType),
        row: user,
        save: (_, body) => api.update(user, body),
      ),
    );
    if (saved != null) ref.invalidate(usersProvider);
  }

  Future<void> _invite(BuildContext context, WidgetRef ref) async {
    final api = ref.read(usersApiProvider);
    if (api == null) return;
    final sent = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(
        def: userInviteDef,
        save: (_, body) => api.invite(body),
      ),
    );
    if (sent == null || !context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Invitation sent to ${sent['email']}.')),
    );
  }

  Future<void> _confirmDisable(
    BuildContext context,
    WidgetRef ref,
    Json user,
  ) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disable ${user['displayName']}?'),
        content: const Text(
          'They are signed out now and cannot sign in until you allow it again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Disable'),
          ),
        ],
      ),
    );
    if (ok == true && context.mounted) {
      await _setStatus(context, ref, user, 'disabled');
    }
  }

  Future<void> _setStatus(
    BuildContext context,
    WidgetRef ref,
    Json user,
    String status,
  ) async {
    final api = ref.read(usersApiProvider);
    if (api == null) return;
    try {
      await api.update(user, {'status': status});
      ref.invalidate(usersProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(problemMessage(e))));
      }
    }
  }
}
