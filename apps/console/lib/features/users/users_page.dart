import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../widgets/page.dart';
import '../auth/auth_errors.dart';
import '../auth/auth_scaffold.dart' show FormMessage;
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart';
import 'users_api.dart';

/// The people in an organization: invite, name, role, and whether they can
/// sign in. The signed-in user's own, or the tenant they have entered, or, when
/// [org] is given, that organization's (the master looking in on a reseller).
class UsersPage extends ConsumerWidget {
  const UsersPage({super.key, this.org, this.orgName, this.embedded = false});

  /// Whose people to show. Null means the signed-in user's own, or the tenant
  /// entered through "act as".
  final UsersTarget? org;

  /// Names [org] in the subtitle.
  final String? orgName;

  /// Inside another page that already has the title and the way back.
  final bool embedded;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    if (session == null) return const SizedBox.shrink();
    final acting = ref.watch(actingProvider);
    final target = org ?? ref.watch(usersTargetProvider);
    if (target == null) return const SizedBox.shrink();
    final rows = ref.watch(usersForProvider(target));
    final name = orgName ?? acting?.name;
    final canChange = ref.watch(canProvider('user.manage'));
    return PageFrame(
      children: [
        PageHeader(
          title: embedded ? 'People' : 'Users',
          subtitle: name == null
              ? 'People who can sign in. Invite someone by email, then give them a role.'
              : "People who can sign in to $name. Invite someone by email, then give them a role.",
          actions: [
            if (canChange)
              FilledButton.icon(
                onPressed: () => _invite(context, ref, target),
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
                      for (final u in data)
                        _row(context, ref, session, target, u, canChange),
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

  DataRow _row(
    BuildContext context,
    WidgetRef ref,
    Session session,
    UsersTarget target,
    Json u,
    bool canChange,
  ) {
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
              if (canChange)
                IconButton(
                  tooltip: 'Edit',
                  icon: const Icon(Icons.edit_outlined),
                  onPressed: () => _edit(context, ref, target, u),
                ),
              if (canChange && !mine && u['mfaEnrolled'] == true)
                IconButton(
                  tooltip: 'Reset two-step verification',
                  icon: const Icon(Icons.phonelink_erase_outlined),
                  onPressed: () => _confirmResetMfa(context, ref, target, u),
                ),
              if (canChange && !mine)
                IconButton(
                  tooltip: disabled ? 'Allow sign-in' : 'Disable',
                  icon: Icon(
                    disabled ? Icons.lock_open_outlined : Icons.block_outlined,
                  ),
                  onPressed: () => disabled
                      ? _setStatus(context, ref, target, u, 'active')
                      : _confirmDisable(context, ref, target, u),
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
    UsersTarget target,
    Json user,
  ) async {
    final api = ref.read(usersApiForProvider(target));
    if (api == null) return;
    final saved = await showDialog<Json>(
      context: context,
      builder: (_) => ResourceFormDialog(
        def: userEditDef(api.orgType),
        row: user,
        save: (_, body) => api.update(user, body),
      ),
    );
    if (saved != null) ref.invalidate(usersForProvider(target));
  }

  Future<void> _invite(
    BuildContext context,
    WidgetRef ref,
    UsersTarget target,
  ) async {
    final api = ref.read(usersApiForProvider(target));
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
    UsersTarget target,
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
      await _setStatus(context, ref, target, user, 'disabled');
    }
  }

  Future<void> _confirmResetMfa(
    BuildContext context,
    WidgetRef ref,
    UsersTarget target,
    Json user,
  ) async {
    final api = ref.read(usersApiForProvider(target));
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final done = await showDialog<bool>(
      context: context,
      builder: (_) => ResetMfaDialog(
        user: user,
        reset: (code) => api.resetMfa(user, stepUpCode: code),
      ),
    );
    if (done != true) return;
    ref.invalidate(usersForProvider(target));
    messenger.showSnackBar(
      SnackBar(
        content: Text(
          'Two-step verification reset for ${user['displayName']}.',
        ),
      ),
    );
  }

  Future<void> _setStatus(
    BuildContext context,
    WidgetRef ref,
    UsersTarget target,
    Json user,
    String status,
  ) async {
    final api = ref.read(usersApiForProvider(target));
    if (api == null) return;
    try {
      await api.update(user, {'status': status});
      ref.invalidate(usersForProvider(target));
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(problemMessage(e))));
      }
    }
  }
}

/// Confirms resetting someone's two-step verification. The admin enters a
/// current code from their own authenticator app (step-up, G-100): a signed-in
/// session alone is not enough to remove someone's second factor. The dialog
/// stays open on a wrong code, and closes with `true` once the reset is done.
class ResetMfaDialog extends StatefulWidget {
  const ResetMfaDialog({super.key, required this.user, required this.reset});

  final Json user;

  /// Performs the reset with the admin's code; throws on refusal.
  final Future<Object?> Function(String code) reset;

  @override
  State<ResetMfaDialog> createState() => _ResetMfaDialogState();
}

class _ResetMfaDialogState extends State<ResetMfaDialog> {
  final _code = TextEditingController();
  String? _error;
  bool _busy = false;

  /// Nothing to enter a code with: the account has no authenticator of its own.
  bool _cannot = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final code = _code.text.replaceAll(RegExp(r'\s'), '');
    if (!RegExp(r'^\d{6}$').hasMatch(code)) {
      setState(
        () => _error = 'Enter the 6-digit code from your authenticator app.',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.reset(code);
      if (mounted) Navigator.of(context).pop(true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _cannot = problemCode(e) == 'step_up_not_enrolled';
        _error = switch (problemCode(e)) {
          'step_up_required' =>
            'Enter the 6-digit code from your authenticator app.',
          'step_up_invalid' =>
            'That code did not work, or it was already used. Wait for the '
                'next code in your authenticator app and try again.',
          'step_up_locked' =>
            'Too many wrong codes. Wait 15 minutes, then try again.',
          'step_up_not_enrolled' =>
            'Your own account has no two-step verification, so you cannot '
                'confirm this. Ask another administrator to do it.',
          _ => problemMessage(e),
        };
      });
      if (!_cannot) _code.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(
        'Reset two-step verification for ${widget.user['displayName']}?',
      ),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Use this when they have lost their phone. They are signed out '
              'everywhere and asked to set up a new authenticator app the next '
              'time they sign in. We email them to say it happened, and let '
              "the organization's other administrators know.",
            ),
            const SizedBox(height: 16),
            const Text(
              'To confirm, enter the current code from your own authenticator '
              'app.',
            ),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('step-up-code'),
              controller: _code,
              autofocus: true,
              enabled: !_busy && !_cannot,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              decoration: const InputDecoration(labelText: 'Your code'),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            if (_error != null) FormMessage(_error!, isError: true),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy || _cannot ? null : _submit,
          child: const Text('Reset'),
        ),
      ],
    );
  }
}
