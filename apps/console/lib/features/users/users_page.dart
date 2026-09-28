import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/acting.dart';
import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../auth/auth_errors.dart';
import '../auth/auth_scaffold.dart' show FormMessage;
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart';
import 'users_api.dart';
import '../../core/format.dart';

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
          title: embedded ? context.l10n.navPeople : context.l10n.navUsers,
          subtitle: name == null
              ? context.l10n.usrSubtitle
              : context.l10n.usrSubtitleNamed(name),
          actions: [
            if (canChange)
              FilledButton.icon(
                onPressed: () => _invite(context, ref, target),
                icon: const Icon(Icons.person_add_alt_outlined),
                label: Text(context.l10n.usrInvite),
              ),
          ],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody(
            value: rows,
            emptyText: context.l10n.usrEmpty,
            builder: (data) => SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    minWidth: MediaQuery.sizeOf(context).width - 320,
                  ),
                  child: DataTable(
                    columns: [
                      DataColumn(label: Text(context.l10n.fieldName)),
                      DataColumn(label: Text(context.l10n.authEmail)),
                      DataColumn(label: Text(context.l10n.usrRole)),
                      DataColumn(label: Text(context.l10n.usrAccess)),
                      DataColumn(label: Text(context.l10n.usrTwoStep)),
                      DataColumn(label: Text(context.l10n.usrLastSignIn)),
                      const DataColumn(label: Text('')),
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
        DataCell(
          Text(
            mine
                ? context.l10n.usrNameYou('${u['displayName']}')
                : '${u['displayName']}',
          ),
        ),
        DataCell(Text('${u['email']}')),
        DataCell(
          Text(
            role == null ? context.l10n.usrNoRole : roleLabels[role] ?? role,
          ),
        ),
        DataCell(
          Text(
            disabled
                ? context.l10n.usrStatusDisabled
                : context.l10n.usrStatusActive,
          ),
        ),
        DataCell(
          Icon(u['mfaEnrolled'] == true ? Icons.check : Icons.remove, size: 18),
        ),
        DataCell(Text(_when(context, u['lastLoginAt']))),
        DataCell(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (canChange)
                IconButton(
                  tooltip: context.l10n.commonEdit,
                  icon: const Icon(Icons.edit_outlined),
                  onPressed: () => _edit(context, ref, target, u),
                ),
              if (canChange && !mine && u['mfaEnrolled'] == true)
                IconButton(
                  tooltip: context.l10n.usrResetMfa,
                  icon: const Icon(Icons.phonelink_erase_outlined),
                  onPressed: () => _confirmResetMfa(context, ref, target, u),
                ),
              if (canChange && !mine)
                IconButton(
                  tooltip: disabled
                      ? context.l10n.usrAllowSignIn
                      : context.l10n.usrDisable,
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

  String _when(BuildContext context, Object? iso) {
    if (iso == null || DateTime.tryParse('$iso') == null) {
      return context.l10n.commonNever;
    }
    return formatDateTime(iso);
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
      SnackBar(
        content: Text(context.l10n.usrInvitationSent('${sent['email']}')),
      ),
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
        title: Text(context.l10n.usrDisableTitle('${user['displayName']}')),
        content: Text(context.l10n.usrDisableBody),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: Text(context.l10n.commonCancel),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(context.l10n.usrDisable),
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
    final l10n = context.l10n;
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
      SnackBar(content: Text(l10n.usrMfaResetDone('${user['displayName']}'))),
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
      setState(() => _error = context.l10n.authMfaEnterCode);
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
          'step_up_required' => context.l10n.authMfaEnterCode,
          'step_up_invalid' => context.l10n.problemStepUpInvalid,
          'step_up_locked' => context.l10n.problemStepUpLocked,
          'step_up_not_enrolled' => context.l10n.usrStepUpNotEnrolled,
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
        context.l10n.usrResetMfaTitle('${widget.user['displayName']}'),
      ),
      content: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(context.l10n.usrResetMfaBody),
            const SizedBox(height: 16),
            Text(context.l10n.usrResetMfaConfirm),
            const SizedBox(height: 8),
            TextField(
              key: const ValueKey('step-up-code'),
              controller: _code,
              autofocus: true,
              enabled: !_busy && !_cannot,
              keyboardType: TextInputType.number,
              autofillHints: const [AutofillHints.oneTimeCode],
              decoration: InputDecoration(labelText: context.l10n.usrYourCode),
              onSubmitted: (_) => _busy ? null : _submit(),
            ),
            if (_error != null) FormMessage(_error!, isError: true),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.of(context).pop(false),
          child: Text(context.l10n.commonCancel),
        ),
        FilledButton(
          onPressed: _busy || _cannot ? null : _submit,
          child: Text(context.l10n.usrResetButton),
        ),
      ],
    );
  }
}
