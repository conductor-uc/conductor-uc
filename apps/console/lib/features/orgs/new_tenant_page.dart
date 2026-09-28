import 'dart:math';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/acting.dart';
import '../../core/problem.dart';
import '../../core/session.dart';
import '../../core/time_zone.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../pbx/pbx_api.dart';
import '../pbx/resource.dart' show commonTimezones;
import 'orgs_api.dart';

/// The countries offered for a new customer, by the code the service keeps.
const newTenantCountries = [
  'US',
  'CA',
  'GB',
  'IE',
  'AU',
  'NZ',
  'DE',
  'FR',
  'ES',
  'MX',
];

String countryName(AppLocalizations l, String code) => switch (code) {
  'US' => l.countryUS,
  'CA' => l.countryCA,
  'GB' => l.countryGB,
  'IE' => l.countryIE,
  'AU' => l.countryAU,
  'NZ' => l.countryNZ,
  'DE' => l.countryDE,
  'FR' => l.countryFR,
  'ES' => l.countryES,
  'MX' => l.countryMX,
  _ => code,
};

/// A short name from a name: lowercase letters, digits and single hyphens.
String slugFrom(String name) => name
    .toLowerCase()
    .replaceAll(RegExp(r'[^a-z0-9]+'), '-')
    .replaceAll(RegExp(r'^-+|-+$'), '');

final _slugPattern = RegExp(r'^[a-z0-9][a-z0-9-]*[a-z0-9]$');

/// A password nobody has to invent: 16 letters and digits, without the ones
/// that are easy to misread.
String generatePassword([Random? random]) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  final r = random ?? Random.secure();
  return List.generate(16, (_) => alphabet[r.nextInt(alphabet.length)]).join();
}

/// Setting up a new customer (S9-16), in three steps: who they are, who looks
/// after their phones, and a last look. It ends on what to do next: set up
/// their phone system now (acting as them, from their home's checklist), or
/// later.
class NewTenantPage extends ConsumerStatefulWidget {
  const NewTenantPage({super.key, required this.resellerId});

  /// The reseller the customer is under.
  final String resellerId;

  @override
  ConsumerState<NewTenantPage> createState() => _NewTenantPageState();
}

class _NewTenantPageState extends ConsumerState<NewTenantPage> {
  final _name = TextEditingController();
  final _slug = TextEditingController();
  final _adminName = TextEditingController();
  final _adminEmail = TextEditingController();
  final _password = TextEditingController(text: generatePassword());
  bool _slugEdited = false;
  String _country = 'US';
  String _timeZone = browserTimeZone() ?? 'America/New_York';
  int _step = 0;
  bool _saving = false;
  final _errors = <String, String>{};
  String? _problem;
  Json? _created;

  /// Where the customers are listed: the reseller's page for the master.
  String get _back => ref.read(sessionProvider)?.orgType == OrgType.master
      ? '/resellers/${widget.resellerId}'
      : '/tenants';

  @override
  void dispose() {
    for (final c in [_name, _slug, _adminName, _adminEmail, _password]) {
      c.dispose();
    }
    super.dispose();
  }

  /// Checks the fields of [step]; true when they are all right.
  bool _check(int step) {
    final l10n = context.l10n;
    final errors = <String, String>{};
    if (step == 0) {
      if (_name.text.trim().isEmpty) errors['name'] = l10n.ntNameRequired;
      if (!_slugPattern.hasMatch(_slug.text)) {
        errors['slug'] = l10n.ntSlugInvalid;
      }
    } else if (step == 1) {
      if (_adminName.text.trim().isEmpty) {
        errors['adminDisplayName'] = l10n.ntAdminNameRequired;
      }
      if (!parseEmail(_adminEmail.text).ok) {
        errors['adminEmail'] = l10n.ntEmailInvalid;
      }
      if (_password.text.length < 12) {
        errors['adminPassword'] = l10n.ntPasswordShort;
      }
    }
    setState(() {
      _errors
        ..removeWhere(
          (key, _) =>
              (step == 0
                      ? const ['name', 'slug']
                      : const [
                          'adminDisplayName',
                          'adminEmail',
                          'adminPassword',
                        ])
                  .contains(key),
        )
        ..addAll(errors);
    });
    return errors.isEmpty;
  }

  void _next() {
    if (!_check(_step)) return;
    setState(() => _step += 1);
  }

  Future<void> _create() async {
    if (!_check(0)) {
      setState(() => _step = 0);
      return;
    }
    if (!_check(1)) {
      setState(() => _step = 1);
      return;
    }
    final api = ref.read(orgsApiProvider);
    if (api == null) return;
    setState(() {
      _saving = true;
      _problem = null;
    });
    try {
      final created = await api.create(
        resellerId: widget.resellerId,
        body: {
          'slug': _slug.text,
          'name': _name.text.trim(),
          'adminEmail': _adminEmail.text.trim(),
          'adminDisplayName': _adminName.text.trim(),
          'adminPassword': _password.text,
          'timezone': _timeZone,
          'country': _country,
        },
      );
      ref.invalidate(tenantsProvider(widget.resellerId));
      if (mounted) setState(() => _created = created);
    } catch (e) {
      final fields = problemFieldMessages(e);
      final problem = problemOf(e);
      if (!mounted) return;
      setState(() {
        _errors.addAll(fields);
        if (problem?.code == 'slug_taken') {
          _errors['slug'] = context.l10n.ntSlugTaken;
        }
        final back = _errors.keys.any(
          (k) =>
              k == 'name' || k == 'slug' || k == 'timezone' || k == 'country',
        );
        if (_errors.isNotEmpty) {
          _step = back ? 0 : 1;
        } else {
          _problem = problemMessage(e);
        }
      });
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final created = _created;
    return PageFrame(
      children: [
        PageHeader(
          title: created == null ? l10n.ntTitle : l10n.ntDoneTitle,
          subtitle: created == null ? l10n.ntSubtitle : null,
          leading: IconButton(
            tooltip: l10n.ntBack,
            icon: const Icon(Icons.arrow_back),
            onPressed: () => context.go(_back),
          ),
        ),
        const SizedBox(height: 16),
        Expanded(
          child: created == null
              ? _stepper(l10n)
              : SingleChildScrollView(child: _done(l10n, created)),
        ),
      ],
    );
  }

  Widget _stepper(AppLocalizations l10n) {
    InputDecoration field(String key, String label, {String? help}) =>
        InputDecoration(
          labelText: label,
          helperText: help,
          helperMaxLines: 2,
          errorText: _errors[key],
        );
    Widget controls(ControlsDetails details) => Padding(
      padding: const EdgeInsets.only(top: 16),
      child: Row(
        children: [
          if (_step < 2)
            FilledButton(
              key: const ValueKey('nt-next'),
              onPressed: _next,
              child: Text(l10n.ntNext),
            )
          else
            FilledButton(
              key: const ValueKey('nt-create'),
              onPressed: _saving ? null : _create,
              child: Text(_saving ? l10n.ntCreating : l10n.ntCreate),
            ),
          const SizedBox(width: 8),
          if (_step > 0)
            TextButton(
              onPressed: () => setState(() => _step -= 1),
              child: Text(l10n.ntPrevious),
            ),
        ],
      ),
    );
    return Stepper(
      currentStep: _step,
      onStepTapped: (i) {
        // Forward only past checked steps.
        if (i < _step || (i == _step + 1 && _check(_step))) {
          setState(() => _step = i);
        }
      },
      // The stepper builds every step's controls; only the current one's show.
      controlsBuilder: (context, details) => details.stepIndex == _step
          ? controls(details)
          : const SizedBox.shrink(),
      steps: [
        Step(
          title: Text(l10n.ntStepCustomer),
          subtitle: _step > 0 ? Text(_name.text) : null,
          isActive: _step >= 0,
          state: _step > 0 ? StepState.complete : StepState.indexed,
          content: SizedBox(
            width: 480,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(
                  key: const ValueKey('nt-name'),
                  controller: _name,
                  autofocus: true,
                  decoration: field('name', l10n.ntName, help: l10n.ntNameHelp),
                  onChanged: (v) {
                    if (!_slugEdited) _slug.text = slugFrom(v);
                    setState(() {});
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('nt-slug'),
                  controller: _slug,
                  inputFormatters: [
                    FilteringTextInputFormatter.allow(RegExp('[a-z0-9-]')),
                  ],
                  decoration: field('slug', l10n.ntSlug, help: l10n.ntSlugHelp),
                  onChanged: (_) => _slugEdited = true,
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  key: const ValueKey('nt-country'),
                  initialValue: _country,
                  decoration: field(
                    'country',
                    l10n.ntCountry,
                    help: l10n.ntCountryHelp,
                  ),
                  items: [
                    for (final c in newTenantCountries)
                      DropdownMenuItem(
                        value: c,
                        child: Text(countryName(l10n, c)),
                      ),
                  ],
                  onChanged: (v) => setState(() => _country = v ?? _country),
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<String>(
                  key: const ValueKey('nt-timezone'),
                  initialValue: _timeZone,
                  isExpanded: true,
                  decoration: field(
                    'timezone',
                    l10n.ntTimeZone,
                    help: l10n.ntTimeZoneHelp,
                  ),
                  items: [
                    for (final z in {_timeZone, ...commonTimezones})
                      DropdownMenuItem(value: z, child: Text(z)),
                  ],
                  onChanged: (v) => setState(() => _timeZone = v ?? _timeZone),
                ),
              ],
            ),
          ),
        ),
        Step(
          title: Text(l10n.ntStepAdmin),
          subtitle: _step > 1 ? Text(_adminEmail.text) : null,
          isActive: _step >= 1,
          state: _step > 1 ? StepState.complete : StepState.indexed,
          content: SizedBox(
            width: 480,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(l10n.ntAdminHelp),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('nt-admin-name'),
                  controller: _adminName,
                  decoration: field('adminDisplayName', l10n.ntAdminName),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('nt-admin-email'),
                  controller: _adminEmail,
                  keyboardType: TextInputType.emailAddress,
                  decoration: field('adminEmail', l10n.ntAdminEmail),
                ),
                const SizedBox(height: 12),
                TextField(
                  key: const ValueKey('nt-password'),
                  controller: _password,
                  decoration:
                      field(
                        'adminPassword',
                        l10n.ntPassword,
                        help: l10n.ntPasswordHelp,
                      ).copyWith(
                        suffixIcon: IconButton(
                          tooltip: l10n.ntNewPassword,
                          icon: const Icon(Icons.refresh),
                          onPressed: () => setState(
                            () => _password.text = generatePassword(),
                          ),
                        ),
                      ),
                ),
              ],
            ),
          ),
        ),
        Step(
          title: Text(l10n.ntStepReview),
          isActive: _step >= 2,
          content: SizedBox(
            width: 480,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _line(l10n.ntName, _name.text),
                _line(l10n.ntSlug, _slug.text),
                _line(l10n.ntCountry, countryName(l10n, _country)),
                _line(l10n.ntTimeZone, _timeZone),
                _line(l10n.ntAdminName, _adminName.text),
                _line(l10n.ntAdminEmail, _adminEmail.text),
                if (_problem != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _problem!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _line(String label, String value) => ListTile(
    dense: true,
    contentPadding: EdgeInsets.zero,
    title: Text(label),
    subtitle: Text(value),
  );

  Widget _done(AppLocalizations l10n, Json created) {
    final id = '${created['id']}';
    final name = '${created['name']}';
    final domain = ref.watch(tenantDomainProvider(id)).value?['fqdn'];
    final details = [
      l10n.ntDetailsEmail(_adminEmail.text.trim()),
      l10n.ntDetailsPassword(_password.text),
      if (domain != null) l10n.ntDetailsAddress('$domain'),
    ].join('\n');
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              l10n.ntDoneHeading(name),
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 8),
            Text(l10n.ntDoneHelp),
            const SizedBox(height: 12),
            SelectableText(details, key: const ValueKey('nt-details')),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  key: const ValueKey('nt-set-up'),
                  icon: const Icon(Icons.play_arrow),
                  label: Text(l10n.ntSetUpNow),
                  onPressed: () {
                    ref
                        .read(actingProvider.notifier)
                        .enter(
                          ActingTenant(
                            id: id,
                            name: name,
                            resellerId: widget.resellerId,
                          ),
                        );
                    context.go('/dashboard');
                  },
                ),
                OutlinedButton.icon(
                  icon: const Icon(Icons.copy),
                  label: Text(l10n.ntCopyDetails),
                  onPressed: () async {
                    await Clipboard.setData(ClipboardData(text: details));
                    if (mounted) {
                      ScaffoldMessenger.of(context)
                          .showSnackBar(SnackBar(content: Text(l10n.ntCopied)));
                    }
                  },
                ),
                TextButton(
                  onPressed: () => context.go(_back),
                  child: Text(l10n.ntLater),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
