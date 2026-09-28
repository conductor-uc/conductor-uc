import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../core/session.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/data_table.dart';
import '../../widgets/editor_page.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart' show tenantCountryProvider;
import '../users/users_api.dart';

/// One person in a tenant, as the People screen shows them (S9-07, D-019):
/// their extension, with the voicemail box, desk phone and sign-in that go
/// with it. Extensions with no one's name on them are still people here:
/// "Front desk" is a person to a small business.
class Person {
  const Person({
    required this.extension,
    this.user,
    this.mailbox,
    this.phones = const [],
  });

  final Json extension;
  final Json? user;
  final Json? mailbox;
  final List<Json> phones;

  String get id => '${extension['id']}';
  String get name => '${extension['displayName'] ?? ''}';
  String get number => '${extension['number'] ?? ''}';
}

/// The rows the People screen is built from, whichever of them this person
/// may read: voicemail boxes are the tenant's private data (a reseller never
/// sees them, rule H1), and people's accounts need `user.read`.
class PeopleRows {
  const PeopleRows({
    required this.extensions,
    required this.phones,
    this.mailboxes,
    this.users,
  });

  final List<Json> extensions;
  final List<Json> phones;

  /// Null when this person may not see voicemail.
  final List<Json>? mailboxes;

  /// Null when this person may not see accounts.
  final List<Json>? users;

  List<Person> get people => [
    for (final e in extensions)
      Person(
        extension: e,
        user: users?.where((u) => u['id'] == e['userId']).firstOrNull,
        mailbox: mailboxes
            ?.where((m) => m['extensionId'] == e['id'])
            .firstOrNull,
        phones: [
          for (final p in phones)
            if (p['extensionId'] == e['id']) p,
        ],
      ),
  ];
}

/// Whether voicemail and sign-in are this person's to see and set here: not
/// for a reseller visiting a tenant (H1), who manages extensions only.
final _privateAllowedProvider = Provider<bool>(
  (ref) => ref.watch(sessionProvider)?.orgType != OrgType.reseller,
);

final peopleRowsProvider = FutureProvider.autoDispose<PeopleRows>((ref) async {
  final private = ref.watch(_privateAllowedProvider);
  final extensions = await ref.watch(rowsProvider('extensions').future);
  final phones = ref.watch(canProvider('extension.read'))
      ? await ref.watch(rowsProvider('devices').future)
      : const <Json>[];
  List<Json>? mailboxes;
  if (private && ref.watch(canProvider('voicemail.access'))) {
    try {
      mailboxes = await ref.watch(rowsProvider('voicemail/mailboxes').future);
    } catch (_) {
      mailboxes = null;
    }
  }
  List<Json>? users;
  if (private && ref.watch(canProvider('user.read'))) {
    try {
      users = await ref.watch(usersProvider.future);
    } catch (_) {
      users = null;
    }
  }
  return PeopleRows(
    extensions: extensions,
    phones: phones,
    mailboxes: mailboxes,
    users: users,
  );
});

void _refresh(WidgetRef ref) {
  ref.invalidate(rowsProvider('extensions'));
  ref.invalidate(rowsProvider('devices'));
  ref.invalidate(rowsProvider('voicemail/mailboxes'));
  ref.invalidate(usersProvider);
  ref.invalidate(peopleRowsProvider);
}

/// The People screen: everyone with a phone number in the company, with what
/// they have (voicemail, a desk phone, a sign-in), and one button to add the
/// next person with all of it.
class PeoplePage extends ConsumerWidget {
  const PeoplePage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final rows = ref.watch(peopleRowsProvider);
    final canChange = ref.watch(canProvider('extension.manage'));
    final addButton = FilledButton.icon(
      onPressed: () => context.go('/people/new'),
      icon: const Icon(Icons.person_add_alt_1),
      label: Text(l10n.peopleAdd),
    );
    return PageFrame(
      children: [
        PageHeader(
          title: l10n.peopleTitle,
          subtitle: l10n.peopleSubtitle,
          actions: [if (canChange) addButton],
        ),
        const SizedBox(height: 16),
        Expanded(
          child: AsyncBody<PeopleRows>(
            value: rows,
            isEmpty: (r) => r.extensions.isEmpty,
            empty: EmptyState(
              icon: Icons.people_outline,
              title: l10n.peopleEmptyTitle,
              message: l10n.peopleEmptyBody,
              action: canChange ? addButton : null,
            ),
            builder: (data) => SingleChildScrollView(
              child: AppTable<Person>(
                rows: data.people,
                rowKey: (p) => p.id,
                initialSort: 0,
                columns: [
                  AppColumn(
                    label: l10n.peopleColumnName,
                    cell: (p) => Text(p.name),
                    text: (p) => p.name,
                  ),
                  AppColumn(
                    label: l10n.peopleColumnExtension,
                    cell: (p) => Text(p.number),
                    text: (p) => p.number,
                    sortValue: (p) => int.tryParse(p.number) ?? 1 << 30,
                  ),
                  AppColumn(
                    label: l10n.peopleColumnPhone,
                    cell: (p) => Text(_phoneSummary(l10n, p)),
                    text: (p) => _phoneSummary(l10n, p),
                  ),
                  if (data.mailboxes != null)
                    AppColumn(
                      label: l10n.peopleColumnVoicemail,
                      cell: (p) => _Check(on: p.mailbox != null),
                      text: (p) =>
                          p.mailbox == null ? '' : l10n.peopleColumnVoicemail,
                    ),
                  if (data.users != null)
                    AppColumn(
                      label: l10n.peopleColumnSignIn,
                      cell: (p) => Text(
                        p.user == null
                            ? l10n.peopleNoSignIn
                            : '${p.user!['email']}',
                      ),
                      text: (p) => p.user == null ? '' : '${p.user!['email']}',
                    ),
                ],
                actions: (p) => [
                  IconButton(
                    tooltip: l10n.commonEdit,
                    icon: const Icon(Icons.edit_outlined),
                    onPressed: () => context.go('/people/${p.id}'),
                  ),
                  if (canChange)
                    IconButton(
                      tooltip: l10n.commonDelete,
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () => _delete(context, ref, p),
                    ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  static String _phoneSummary(AppLocalizations l10n, Person p) {
    if (p.phones.isEmpty) return l10n.peopleNoDeskPhone;
    final model = p.phones.first['model'];
    return model is String && model.isNotEmpty ? model : l10n.peopleDeskPhone;
  }

  Future<void> _delete(BuildContext context, WidgetRef ref, Person p) async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final api = ref.read(pbxApiProvider);
    final confirmed = await confirmAction(
      context,
      title: l10n.peopleDeleteTitle(p.name),
      message: l10n.peopleDeleteBody(p.number),
      impact: [
        if (p.phones.isNotEmpty) l10n.peopleDeleteImpactPhone,
        if (p.mailbox != null) l10n.peopleDeleteImpactVoicemail,
      ],
      confirmLabel: l10n.commonDelete,
    );
    if (!confirmed || api == null) return;
    try {
      await api.delete('extensions', p.id);
      _refresh(ref);
      showToast(messenger, currentL10n.commonDeleted);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }
}

class _Check extends StatelessWidget {
  const _Check({required this.on});

  final bool on;

  @override
  Widget build(BuildContext context) =>
      Icon(on ? Icons.check : Icons.remove, size: 18);
}

/// A part of adding a person, done in order: each is a separate call to a
/// separate service, so a failure part-way stops there, keeps what was made,
/// and Save picks up from the step that failed.
enum _Part { extension, voicemail, phone, invite }

enum _PartState { waiting, working, done, failed }

/// Adds a person, or changes one: who they are, their extension, voicemail,
/// desk phone and sign-in, on one page (S9-07).
class PersonEditorPage extends ConsumerStatefulWidget {
  const PersonEditorPage({super.key, this.extensionId});

  /// The person's extension; null adds a new person.
  final String? extensionId;

  @override
  ConsumerState<PersonEditorPage> createState() => _PersonEditorPageState();
}

class _PersonEditorPageState extends ConsumerState<PersonEditorPage> {
  final _form = GlobalKey<FormState>();
  final _name = TextEditingController();
  final _email = TextEditingController();
  final _number = TextEditingController();
  final _pin = TextEditingController(
    text: (1000 + Random.secure().nextInt(9000)).toString(),
  );
  final _mac = TextEditingController();
  final _model = TextEditingController();
  final _callerIdNumber = TextEditingController();
  bool _voicemail = true;
  bool _deskPhone = false;
  bool _invite = false;
  String? _locationId;

  bool _loaded = false;
  bool _busy = false;
  String? _error;
  Map<String, String> _fieldErrors = const {};
  final Map<_Part, _PartState> _parts = {};
  final Map<_Part, String> _partErrors = {};

  /// What was made so far, so a retry does not make it twice.
  String? _extensionId;

  bool get _adding => widget.extensionId == null;

  @override
  void initState() {
    super.initState();
    _extensionId = widget.extensionId;
  }

  @override
  void dispose() {
    for (final c in [
      _name,
      _email,
      _number,
      _pin,
      _mac,
      _model,
      _callerIdNumber,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Fills the form once the rows are in: an existing person's details, or
  /// for a new one the next free number and the usual emergency location.
  void _load(PeopleRows rows, List<Json> locations) {
    if (_loaded) return;
    _loaded = true;
    _locationId = locations.isEmpty ? null : '${locations.first['id']}';
    if (_adding) {
      final used = [
        for (final e in rows.extensions) ?int.tryParse('${e['number']}'),
      ];
      final next = used.isEmpty ? 100 : used.reduce(max) + 1;
      _number.text = '${max(next, 100)}';
      return;
    }
    final person = rows.people
        .where((p) => p.id == widget.extensionId)
        .firstOrNull;
    if (person == null) return;
    _name.text = person.name;
    _number.text = person.number;
    _callerIdNumber.text = formatPhone(
      person.extension['callerIdNumber'] as String?,
      country: ref.read(tenantCountryProvider),
    );
    _locationId = '${person.extension['emergencyLocationId']}';
    _voicemail = person.mailbox != null;
    _deskPhone = person.phones.isNotEmpty;
    if (person.user != null) _email.text = '${person.user!['email']}';
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final rows = ref.watch(peopleRowsProvider);
    final locations = ref.watch(rowsProvider('emergency-locations'));
    final private = ref.watch(_privateAllowedProvider);
    if (!rows.hasValue || !locations.hasValue) {
      return rows.hasError || locations.hasError
          ? Center(child: Text(problemMessage(rows.error ?? locations.error!)))
          : const Center(child: CircularProgressIndicator());
    }
    _load(rows.requireValue, locations.requireValue);
    final person = rows.requireValue.people
        .where((p) => p.id == _extensionId)
        .firstOrNull;
    final hasMailbox = person?.mailbox != null;
    final hasPhone = person?.phones.isNotEmpty ?? false;
    final hasSignIn = person?.user != null;
    final canVoicemail = private && rows.requireValue.mailboxes != null;
    final canInvite = private && rows.requireValue.users != null;

    return Form(
      key: _form,
      autovalidateMode: AutovalidateMode.onUnfocus,
      child: EditorPage(
        title: _adding ? l10n.peopleAddTitle : person?.name ?? '',
        subtitle: _adding ? l10n.peopleAddSubtitle : null,
        busy: _busy,
        error: _error,
        saveLabel: _adding && _parts.values.contains(_PartState.failed)
            ? l10n.peopleTryAgain
            : null,
        onCancel: () => context.go('/people'),
        onSave: _save,
        sections: [
          EditorSection(
            title: l10n.peopleWhoTitle,
            children: [
              TextFormField(
                key: const ValueKey('person-name'),
                controller: _name,
                decoration: InputDecoration(
                  labelText: '${l10n.peopleName} *',
                  hintText: l10n.peopleNameHint,
                  errorText: _fieldErrors['displayName'],
                ),
                validator: (v) =>
                    (v ?? '').trim().isEmpty ? l10n.fieldRequired : null,
              ),
            ],
          ),
          EditorSection(
            title: l10n.peopleExtensionTitle,
            description: l10n.peopleExtensionDescription,
            children: [
              TextFormField(
                key: const ValueKey('person-number'),
                controller: _number,
                keyboardType: TextInputType.number,
                decoration: InputDecoration(
                  labelText: '${l10n.peopleExtensionNumber} *',
                  helperText: l10n.peopleExtensionNumberHelp,
                  errorText: _fieldErrors['number'],
                ),
                validator: (v) => parseDigits(v ?? '', min: 2, max: 6).error,
              ),
            ],
          ),
          if (canVoicemail)
            EditorSection(
              title: l10n.peopleVoicemailTitle,
              children: [
                SwitchListTile(
                  key: const ValueKey('person-voicemail'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(l10n.peopleVoicemailOn),
                  subtitle: Text(l10n.peopleVoicemailOnHelp),
                  value: _voicemail,
                  onChanged: _busy
                      ? null
                      : (v) => setState(() => _voicemail = v),
                ),
                if (_voicemail && !hasMailbox)
                  TextFormField(
                    key: const ValueKey('person-pin'),
                    controller: _pin,
                    keyboardType: TextInputType.number,
                    decoration: InputDecoration(
                      labelText: l10n.peopleVoicemailPin,
                      helperText: l10n.peopleVoicemailPinHelp,
                      helperMaxLines: 3,
                    ),
                    validator: (v) =>
                        parseDigits(v ?? '', min: 4, max: 8).error,
                  ),
                _partStatus(_Part.voicemail),
              ],
            ),
          EditorSection(
            title: l10n.peoplePhoneTitle,
            description: l10n.peoplePhoneDescription,
            children: [
              if (hasPhone)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: const Icon(Icons.phone_android_outlined),
                  title: Text(
                    '${person!.phones.first['model'] ?? l10n.peopleDeskPhone}',
                  ),
                  subtitle: Text(formatMac('${person.phones.first['mac']}')),
                  trailing: TextButton(
                    onPressed: _busy
                        ? null
                        : () => _removePhone(person.phones.first),
                    child: Text(l10n.peopleRemovePhone),
                  ),
                )
              else ...[
                SwitchListTile(
                  key: const ValueKey('person-desk-phone'),
                  contentPadding: EdgeInsets.zero,
                  title: Text(l10n.peopleHasDeskPhone),
                  subtitle: Text(l10n.peopleHasDeskPhoneHelp),
                  value: _deskPhone,
                  onChanged: _busy
                      ? null
                      : (v) => setState(() => _deskPhone = v),
                ),
                if (_deskPhone) ...[
                  TextFormField(
                    key: const ValueKey('person-mac'),
                    controller: _mac,
                    decoration: InputDecoration(
                      labelText: '${l10n.peopleMac} *',
                      helperText: l10n.peopleMacHelp,
                      helperMaxLines: 2,
                    ),
                    validator: (v) => parseMac(v ?? '').error,
                  ),
                  TextFormField(
                    controller: _model,
                    decoration: InputDecoration(
                      labelText: l10n.peopleModel,
                      hintText: l10n.peopleModelHint,
                    ),
                  ),
                ],
              ],
              _partStatus(_Part.phone),
            ],
          ),
          if (canInvite)
            EditorSection(
              title: l10n.peopleSignInTitle,
              description: l10n.peopleSignInDescription,
              children: [
                if (hasSignIn)
                  ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: const Icon(Icons.verified_user_outlined),
                    title: Text('${person!.user!['email']}'),
                    subtitle: Text(l10n.peopleSignsInAs),
                  )
                else ...[
                  SwitchListTile(
                    key: const ValueKey('person-invite'),
                    contentPadding: EdgeInsets.zero,
                    title: Text(l10n.peopleInvite),
                    subtitle: Text(l10n.peopleInviteHelp),
                    value: _invite,
                    onChanged: _busy
                        ? null
                        : (v) => setState(() => _invite = v),
                  ),
                  if (_invite)
                    TextFormField(
                      key: const ValueKey('person-email'),
                      controller: _email,
                      keyboardType: TextInputType.emailAddress,
                      decoration: InputDecoration(
                        labelText: '${l10n.authEmail} *',
                      ),
                      validator: (v) => parseEmail(v ?? '').error,
                    ),
                ],
                _partStatus(_Part.invite),
              ],
            ),
          EditorSection(
            title: l10n.formAdvanced,
            description: l10n.formAdvancedHint,
            collapsible: true,
            initiallyExpanded: false,
            children: [
              DropdownButtonFormField<String>(
                initialValue: _locationId,
                isExpanded: true,
                decoration: InputDecoration(
                  labelText: '${l10n.peopleEmergencyLocation} *',
                  helperText: l10n.peopleEmergencyLocationHelp,
                  helperMaxLines: 2,
                ),
                items: [
                  for (final l in locations.requireValue)
                    DropdownMenuItem(
                      value: '${l['id']}',
                      child: Text('${l['label']}'),
                    ),
                ],
                onChanged: (v) => setState(() => _locationId = v),
                validator: (v) => v == null ? l10n.fieldRequired : null,
              ),
              TextFormField(
                controller: _callerIdNumber,
                keyboardType: TextInputType.phone,
                decoration: InputDecoration(
                  labelText: l10n.peopleCallerIdNumber,
                  helperText: l10n.peopleCallerIdNumberHelp,
                  helperMaxLines: 2,
                ),
                validator: (v) => (v ?? '').trim().isEmpty
                    ? null
                    : parsePhone(
                        v!,
                        country: ref.read(tenantCountryProvider),
                      ).error,
              ),
            ],
          ),
          if (_adding && _parts.isNotEmpty) _progress(),
        ],
      ),
    );
  }

  /// A step's outcome, under its section: what went wrong, when it did.
  Widget _partStatus(_Part part) {
    final problem = _partErrors[part];
    if (problem == null) return const SizedBox.shrink();
    return Text(
      problem,
      style: TextStyle(color: Theme.of(context).colorScheme.error),
    );
  }

  /// Where adding the person got to: what is done, and what isn't yet.
  Widget _progress() {
    final l10n = context.l10n;
    String label(_Part p) => switch (p) {
      _Part.extension => l10n.peoplePartExtension,
      _Part.voicemail => l10n.peoplePartVoicemail,
      _Part.phone => l10n.peoplePartPhone,
      _Part.invite => l10n.peoplePartInvite,
    };
    return Card(
      key: const ValueKey('person-progress'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final MapEntry(key: part, value: state) in _parts.entries)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                leading: switch (state) {
                  _PartState.done => const Icon(Icons.check_circle),
                  _PartState.failed => Icon(
                    Icons.error,
                    color: Theme.of(context).colorScheme.error,
                  ),
                  _PartState.working => const SizedBox.square(
                    dimension: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  ),
                  _PartState.waiting => const Icon(
                    Icons.radio_button_unchecked,
                  ),
                },
                title: Text(label(part)),
              ),
          ],
        ),
      ),
    );
  }

  Json _extensionBody() {
    final callerId = _callerIdNumber.text.trim();
    return {
      'number': _number.text.trim(),
      'displayName': _name.text.trim(),
      'emergencyLocationId': _locationId,
      'voicemailEnabled': _voicemail,
      if (callerId.isNotEmpty)
        'callerIdNumber': parsePhone(
          callerId,
          country: ref.read(tenantCountryProvider),
        ).value,
    };
  }

  Future<void> _save() async {
    if (!_form.currentState!.validate()) return;
    final api = ref.read(pbxApiProvider);
    if (api == null) return;
    final rows = ref.read(peopleRowsProvider).value;
    final existing = rows?.people
        .where((p) => p.id == _extensionId)
        .firstOrNull;
    final canVoicemail =
        ref.read(_privateAllowedProvider) && rows?.mailboxes != null;
    final canInvite = ref.read(_privateAllowedProvider) && rows?.users != null;
    final wanted = <_Part>[
      _Part.extension,
      if (canVoicemail && _voicemail && existing?.mailbox == null)
        _Part.voicemail,
      if (_deskPhone && (existing?.phones.isEmpty ?? true)) _Part.phone,
      if (canInvite && _invite && existing?.user == null) _Part.invite,
    ];
    setState(() {
      _busy = true;
      _error = null;
      _fieldErrors = const {};
      _partErrors.clear();
      for (final p in wanted) {
        if (_parts[p] != _PartState.done) _parts[p] = _PartState.waiting;
      }
      // Parts no longer wanted (a toggle turned off) are not done later.
      _parts.removeWhere((p, _) => !wanted.contains(p));
    });

    for (final part in wanted) {
      // A part done on an earlier try, except the extension's own details,
      // which a second Save sends again (they may have been corrected).
      if (_parts[part] == _PartState.done && part != _Part.extension) continue;
      setState(() => _parts[part] = _PartState.working);
      try {
        switch (part) {
          case _Part.extension:
            final saved = _extensionId == null
                ? await api.create('extensions', _extensionBody())
                : await api.update(
                    'extensions',
                    _extensionId!,
                    _extensionBody(),
                  );
            _extensionId = '${saved['id']}';
          case _Part.voicemail:
            await api.create('voicemail/mailboxes', {
              'extensionId': _extensionId,
              'pin': _pin.text.trim(),
            });
          case _Part.phone:
            await api.create('devices', {
              'mac': _mac.text.trim(),
              'extensionId': _extensionId,
              if (_model.text.trim().isNotEmpty) 'model': _model.text.trim(),
            });
          case _Part.invite:
            final target = ref.read(usersTargetProvider);
            final users = target == null
                ? null
                : ref.read(usersApiForProvider(target));
            await users!.invite({
              'email': _email.text.trim(),
              'displayName': _name.text.trim(),
              'extensionId': _extensionId,
            });
        }
        setState(() => _parts[part] = _PartState.done);
      } catch (e) {
        if (!mounted) return;
        setState(() {
          _parts[part] = _PartState.failed;
          _busy = false;
          if (part == _Part.extension) {
            _fieldErrors = problemFieldMessages(e);
            _error = problemMessage(e, shownFields: _fieldErrors.keys.toSet());
          } else {
            _partErrors[part] = problemMessage(e);
            _error = context.l10n.peoplePartlyDone;
          }
        });
        _refresh(ref);
        return;
      }
    }
    if (!mounted) return;
    _refresh(ref);
    showToastOnNextPage(
      _adding
          ? context.l10n.peopleAdded(_name.text.trim())
          : currentL10n.commonSaved,
    );
    context.go('/people');
  }

  Future<void> _removePhone(Json phone) async {
    final l10n = context.l10n;
    final messenger = ScaffoldMessenger.of(context);
    final api = ref.read(pbxApiProvider);
    final confirmed = await confirmAction(
      context,
      title: l10n.peopleRemovePhoneTitle,
      message: l10n.peopleRemovePhoneBody,
      confirmLabel: l10n.peopleRemovePhone,
    );
    if (!confirmed || api == null) return;
    try {
      await api.delete('devices', '${phone['id']}');
      _refresh(ref);
      setState(() => _deskPhone = false);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }
}
