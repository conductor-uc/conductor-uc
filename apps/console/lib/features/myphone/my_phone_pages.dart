import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/permissions.dart';
import '../../l10n/l10n.dart';
import '../../widgets/page.dart';
import '../cdr/call_records_page.dart'
    show directionLabels, dispositionLabels, partyLabel;
import '../pbx/call_handling_dialog.dart';
import '../pbx/pbx_api.dart';
import '../shell/sections.dart' show myPhoneSections;
import '../voicemail/voicemail_page.dart' show MessagesView;
import 'my_live_calls.dart';
import 'my_phone_api.dart';
import '../../core/format.dart';

/// The three "My phone" screens (a person's own call handling, voicemail and
/// call history). A person who holds only self-service permissions gets them as
/// their whole console; an administrator linked to an extension gets them under
/// one entry, with the same three as tabs.
///
/// Every request here is to `/me/...`. Nothing on screen names an extension,
/// mailbox or user, and none of it can be pointed at anyone else's.
///
/// Above each screen, a card for each call the person is on now, with its
/// recording buttons ([MyLiveCalls], S5-15).
class _MyPhoneFrame extends ConsumerWidget {
  const _MyPhoneFrame({
    required this.current,
    required this.title,
    this.subtitle,
    this.actions = const [],
    required this.children,
  });

  final String current;
  final String title;
  final String? subtitle;
  final List<Widget> actions;
  final List<Widget> children;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return PageFrame(
      children: [
        PageHeader(title: title, subtitle: subtitle, actions: actions),
        MyPhoneTabs(current: current),
        const SizedBox(height: 16),
        const MyLiveCalls(),
        ...children,
      ],
    );
  }
}

/// The My phone screens as tabs, for an administrator who reaches them from
/// one navigation entry. A person with only a phone has them all in the
/// navigation already, so gets none.
class MyPhoneTabs extends ConsumerWidget {
  const MyPhoneTabs({super.key, required this.current});

  final String current;

  /// Shorter than the navigation's names: the tabs sit under "My phone".
  static String _label(AppLocalizations l10n, String path) => switch (path) {
    '/my-phone/home' => l10n.myTabHome,
    '/my-phone/call-handling' => l10n.myTabCallHandling,
    '/my-phone/voicemail' => l10n.myTabVoicemail,
    _ => l10n.myTabHistory,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (isSelfOnly(ref.watch(knownPermissionsProvider))) {
      return const SizedBox.shrink();
    }
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in myPhoneSections)
              ChoiceChip(
                label: Text(_label(context.l10n, s.path)),
                selected: s.path == current,
                onSelected: (_) => context.go(s.path),
              ),
          ],
        ),
      ),
    );
  }
}

/// Said instead of an error when nothing is linked to the person yet.
class _NothingLinked extends StatelessWidget {
  const _NothingLinked();

  @override
  Widget build(BuildContext context) =>
      Center(child: Text(context.l10n.myPhoneNothingLinked));
}

/// A page's body for one request, with the "no extension linked" case said in
/// plain words and any other problem shown as the service worded it.
Widget _bodyFor<T>(AsyncValue<T> value, Widget Function(T data) builder) =>
    value.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => isNoLinkedExtension(e)
          ? const _NothingLinked()
          : Center(child: Text(problemMessage(e))),
      data: builder,
    );

/// "Do not disturb: off", "Forward all calls to 102 · Bob Osei"...
List<(String, String)> describeCallHandling(
  Json handling,
  List<Json> people, [
  AppLocalizations? l10n,
]) {
  final l = l10n ?? currentL10n;
  String where(Object? d) {
    if (d is! Map) return l.myNotSet;
    switch (d['type']) {
      case 'extension':
        final match = people.where((p) => p['id'] == d['extensionId']);
        return match.isEmpty
            ? l.myAnExtension
            : '${match.first['number']} · ${match.first['displayName']}';
      case 'voicemail':
        final own = d['extensionId'];
        if (own == null) return l.myYourVoicemail;
        final match = people.where((p) => p['id'] == own);
        return match.isEmpty
            ? l.myAVoicemail
            : l.myVoicemailOf(
                '${match.first['number']}',
                '${match.first['displayName']}',
              );
      case 'external':
        return '${d['e164']}';
    }
    return l.myNotSet;
  }

  final ring = [...?(handling['simultaneousRing'] as List?)];
  final dnd = handling['dnd'] == true;
  return [
    (
      l.myDoNotDisturb,
      dnd
          ? l.myDndOn(handling['dndAction'] == 'busy' ? 'busy' : 'voicemail')
          : l.myOff,
    ),
    (l.myForwardAll, where(handling['forwardAlways'])),
    (l.myForwardBusy, where(handling['forwardBusy'])),
    (
      l.myForwardNoAnswer,
      handling['forwardNoAnswer'] == null
          ? l.myNotSet
          : l.myForwardAfter(
              where(handling['forwardNoAnswer']),
              '${handling['noAnswerSeconds']}',
            ),
    ),
    (l.myForwardUnreachable, where(handling['forwardUnreachable'])),
    (l.myAlsoRing, ring.isEmpty ? l.myNobody : ring.map(where).join(', ')),
  ];
}

/// My call handling: what happens to calls to my extension, and a way to
/// change it (the same dialog the administrator's Extensions screen uses).
class MyCallHandlingPage extends ConsumerWidget {
  const MyCallHandlingPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final extension = ref.watch(myExtensionProvider);
    final handling = ref.watch(myCallHandlingProvider);
    final people = ref.watch(myDirectoryProvider).asData?.value ?? const [];
    final ext = extension.asData?.value;
    final l = context.l10n;
    return _MyPhoneFrame(
      current: '/my-phone/call-handling',
      title: l.navMyCallHandling,
      subtitle: ext == null
          ? l.myCallHandlingSubtitle
          : l.myCallHandlingSubtitleExt(
              '${ext['number']}',
              '${ext['displayName']}',
            ),
      actions: [
        if (ext != null)
          FilledButton.icon(
            onPressed: () async {
              final saved = await showDialog<bool>(
                context: context,
                builder: (_) => CallHandlingDialog(extension: ext, mine: true),
              );
              if (saved == true) ref.invalidate(myCallHandlingProvider);
            },
            icon: const Icon(Icons.edit_outlined),
            label: Text(l.myChange),
          ),
      ],
      children: [
        Expanded(
          child: extension.isLoading
              ? const Center(child: CircularProgressIndicator())
              : ext == null
              ? const _NothingLinked()
              : _bodyFor<Json>(
                  handling,
                  (h) => SingleChildScrollView(
                    child: Column(
                      children: [
                        for (final (label, value) in describeCallHandling(
                          h,
                          people,
                          l,
                        ))
                          ListTile(
                            dense: true,
                            title: Text(label),
                            trailing: Text(value),
                          ),
                      ],
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}

/// My voicemail: my messages (listen, delete), my PIN, and where new messages
/// are emailed. The same messages table the administrator's Voicemail screen
/// uses, on my own routes.
class MyVoicemailPage extends ConsumerWidget {
  const MyVoicemailPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mailbox = ref.watch(myMailboxProvider);
    return mailbox.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (e, _) => _MyPhoneFrame(
        current: '/my-phone/voicemail',
        title: context.l10n.navMyVoicemail,
        children: [
          Expanded(
            child: isNoLinkedExtension(e)
                ? const _NothingLinked()
                : Center(child: Text(problemMessage(e))),
          ),
        ],
      ),
      data: (box) => Column(
        children: [
          // The messages view supplies its own frame, so the tabs go here.
          const Padding(
            padding: EdgeInsets.fromLTRB(24, 12, 24, 0),
            child: MyPhoneTabs(current: '/my-phone/voicemail'),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(24, 12, 24, 0),
            child: MyLiveCalls(),
          ),
          Expanded(child: MessagesView(mailbox: box, mine: true)),
        ],
      ),
    );
  }
}

/// My call history: calls to, from and dialed as my extension, newest first.
class MyCallHistoryPage extends ConsumerStatefulWidget {
  const MyCallHistoryPage({super.key});

  @override
  ConsumerState<MyCallHistoryPage> createState() => _MyCallHistoryPageState();
}

class _MyCallHistoryPageState extends ConsumerState<MyCallHistoryPage> {
  String? _direction;
  final _search = TextEditingController();
  Timer? _typing;
  final _rows = <Json>[];
  String? _next;
  Object? _error;
  var _loading = true;

  /// Which load is the latest: an answer to an earlier search that arrives
  /// late is dropped.
  var _generation = 0;

  @override
  void initState() {
    super.initState();
    _load(reset: true);
  }

  @override
  void dispose() {
    _typing?.cancel();
    _search.dispose();
    super.dispose();
  }

  Future<void> _load({bool reset = false}) async {
    final api = ref.read(myPhoneApiProvider);
    if (api == null) return;
    final generation = ++_generation;
    setState(() {
      _loading = true;
      if (reset) {
        _rows.clear();
        _next = null;
        _error = null;
      }
    });
    try {
      final page = await api.calls(
        direction: _direction,
        search: _search.text,
        cursor: _next,
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _rows.addAll(page.rows);
        _next = page.nextCursor;
        _loading = false;
      });
    } catch (e) {
      if (mounted && generation == _generation) {
        setState(() {
          _error = e;
          _loading = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final error = _error;
    final l = context.l10n;
    return _MyPhoneFrame(
      current: '/my-phone/history',
      title: l.navMyCallHistory,
      subtitle: l.myHistorySubtitle,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            SizedBox(
              width: 280,
              child: TextField(
                key: const ValueKey('my-calls-search'),
                controller: _search,
                decoration: InputDecoration(
                  labelText: context.l10n.myHistorySearch,
                  prefixIcon: const Icon(Icons.search),
                ),
                onChanged: (_) {
                  _typing?.cancel();
                  _typing = Timer(
                    const Duration(milliseconds: 300),
                    () => _load(reset: true),
                  );
                },
              ),
            ),
            SizedBox(
              width: 220,
              child: DropdownButtonFormField<String?>(
                key: const ValueKey('my-calls-direction'),
                initialValue: _direction,
                isExpanded: true,
                decoration: InputDecoration(labelText: l.myHistoryDirection),
                items: [
                  DropdownMenuItem(value: null, child: Text(l.myHistoryAll)),
                  for (final e in directionLabels.entries)
                    DropdownMenuItem(value: e.key, child: Text(e.value)),
                ],
                onChanged: (v) {
                  _direction = v;
                  _load(reset: true);
                },
              ),
            ),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: error != null
              ? (isNoLinkedExtension(error)
                    ? const _NothingLinked()
                    : Center(child: Text(problemMessage(error))))
              : _rows.isEmpty
              ? Center(
                  child: _loading
                      ? const CircularProgressIndicator()
                      : Text(
                          _search.text.trim().isEmpty
                              ? context.l10n.homeRecentCallsNone
                              : context.l10n.myHistoryNoMatch,
                        ),
                )
              : SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: DataTable(
                          columns: [
                            DataColumn(label: Text(l.myHistoryWhen)),
                            DataColumn(label: Text(l.myHistoryDirection)),
                            DataColumn(label: Text(l.monFrom)),
                            DataColumn(label: Text(l.monTo)),
                            DataColumn(label: Text(l.myHistoryLength)),
                            DataColumn(label: Text(l.myHistoryResult)),
                          ],
                          rows: [
                            for (final r in _rows)
                              DataRow(
                                key: ValueKey('my-call-${r['id']}'),
                                cells: [
                                  DataCell(Text(formatDateTime(r['startAt']))),
                                  DataCell(
                                    Text(
                                      directionLabels['${r['direction']}'] ??
                                          '${r['direction']}',
                                    ),
                                  ),
                                  DataCell(
                                    Text(
                                      partyLabel(
                                        r['fromNumber'],
                                        r['fromName'],
                                      ),
                                    ),
                                  ),
                                  DataCell(Text('${r['toNumber']}')),
                                  DataCell(Text(formatClock(r['durationSec']))),
                                  DataCell(
                                    Text(
                                      dispositionLabels['${r['disposition']}'] ??
                                          '${r['disposition']}',
                                    ),
                                  ),
                                ],
                              ),
                          ],
                        ),
                      ),
                      if (_next != null)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: OutlinedButton(
                            onPressed: _loading ? null : () => _load(),
                            child: Text(l.myHistoryLoadMore),
                          ),
                        ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}
