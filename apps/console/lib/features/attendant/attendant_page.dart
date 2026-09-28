import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/format.dart';
import '../../core/local_store.dart';
import '../../core/permissions.dart';
import '../../forms/validators.dart';
import '../../l10n/l10n.dart';
import '../../widgets/feedback.dart';
import '../../widgets/page.dart';
import '../monitoring/live_calls.dart';
import '../monitoring/presence.dart';
import '../monitoring/presence_board.dart' show presenceLook;
import '../myphone/my_phone_api.dart' show myExtensionProvider;
import '../pbx/pbx_api.dart';
import '../pbx/resource_form.dart' show tenantCountryProvider;
import '../monitoring/live_queues.dart';
import 'attendant_api.dart';

/// The attendant console (S9-14): the calls coming in, waiting, parked and in
/// progress; every extension and what it is doing; the parking lots and the
/// queues. A call is moved by dragging it onto an extension or a lot, by its
/// buttons, or from the keyboard. Every call the receptionist takes part in
/// rings their own phone (O-14).
class AttendantPage extends ConsumerStatefulWidget {
  const AttendantPage({super.key});

  @override
  ConsumerState<AttendantPage> createState() => _AttendantPageState();
}

const _dropKey = 'console.attendant.drop';

/// S9-21 (G-127): what dropping a call on someone does, as each receptionist
/// chooses and this browser remembers: send it at once (the default), or,
/// for a call on their own phone, talk to that person first while the caller
/// waits (an attended transfer). A call elsewhere is always sent at once:
/// only a call the receptionist is on can wait for them.
class AttendantTalkFirst extends Notifier<bool> {
  @override
  bool build() => readLocal(_dropKey) == 'talk';

  void choose(bool talkFirst) {
    state = talkFirst;
    writeLocal(_dropKey, talkFirst ? 'talk' : null);
  }
}

final attendantTalkFirstProvider = NotifierProvider<AttendantTalkFirst, bool>(
  AttendantTalkFirst.new,
);

/// An attended transfer under way from the receptionist's own phone.
typedef _Consult = ({String ownLeg, String caller, String to});

/// The calls, sorted into what the receptionist does with each.
class _Sorted {
  _Sorted(List<LiveCallRow> rows) {
    for (final row in rows) {
      if (row.parked != null) {
        parked.add(row);
      } else if (row.state == 'ringing') {
        ringing.add(row);
      } else if (row.queueId != null && row.legs.length == 1) {
        waiting.add(row);
      } else {
        active.add(row);
      }
    }
  }

  final ringing = <LiveCallRow>[];
  final waiting = <LiveCallRow>[];
  final parked = <LiveCallRow>[];
  final active = <LiveCallRow>[];

  /// In the order the column shows them, for moving the selection by keyboard.
  List<LiveCallRow> get all => [...ringing, ...waiting, ...parked, ...active];
}

class _AttendantPageState extends ConsumerState<AttendantPage> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  final _pageFocus = FocusNode();
  String? _selected;

  /// Calls with a request on its way, so their buttons wait.
  final _busy = <String>{};

  /// S9-21: the attended transfer under way, if any.
  _Consult? _consult;

  @override
  void dispose() {
    _search.dispose();
    _searchFocus.dispose();
    _pageFocus.dispose();
    super.dispose();
  }

  Map<String, String> get _names => {
    for (final e
        in ref.read(rowsProvider('extensions')).asData?.value ?? const <Json>[])
      '${e['number']}': '${e['displayName'] ?? ''}',
  };

  /// "101 · Alice Kim" for an extension, a formatted number otherwise.
  String _party(String number) {
    final name = _names[number];
    if (name != null && name.isNotEmpty) return '$number · $name';
    return number.startsWith('+')
        ? formatPhone(number, country: ref.read(tenantCountryProvider))
        : number;
  }

  LiveCallRow? _row(String? id, _Sorted sorted) =>
      sorted.all.where((r) => r.id == id).firstOrNull;

  Future<void> _run(
    LiveCallRow row,
    Future<Object?> Function(AttendantApi api) request,
    String done,
  ) async {
    final api = ref.read(attendantApiProvider);
    if (api == null || _busy.contains(row.id)) return;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy.add(row.id));
    try {
      await request(api);
      showToast(messenger, done);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    } finally {
      if (mounted) setState(() => _busy.remove(row.id));
    }
  }

  /// The receptionist's own leg of [row], when the call is on their phone.
  LiveCall? _ownLeg(LiveCallRow row) {
    final own = ref.read(myExtensionProvider).asData?.value?['number'];
    if (own == null) return null;
    return row.legs
        .where((l) => l.extension == '$own' && l.state == 'answered')
        .firstOrNull;
  }

  /// Sends the call to [to]: at once, or, when the receptionist chose to talk
  /// first and the call is on their own phone, after they have (S9-21).
  void _transfer(LiveCallRow row, String to) {
    final own = _ownLeg(row);
    if (own != null && ref.read(attendantTalkFirstProvider)) {
      _talkFirst(row, own, to);
      return;
    }
    // On their own phone, the other party is the one sent; the receptionist
    // is let go.
    final target = own == null
        ? row.first
        : row.legs.where((l) => l.callUuid != own.callUuid).firstOrNull ??
              row.first;
    _run(
      row,
      (api) => api.transfer(target.callUuid, to),
      currentL10n.attTransferred(_party(to)),
    );
  }

  /// S9-21: the other party waits (hold music) while the receptionist's phone
  /// calls [to]; then they put them through, or go back to the caller.
  void _talkFirst(LiveCallRow row, LiveCall own, String to) {
    // Who waits: the other party's extension, or their number.
    final other = row.legs.where((l) => l.callUuid != own.callUuid).firstOrNull;
    final caller = other == null
        ? row.from
        : other.extension ??
              (other.from != own.extension ? other.from : other.to);
    _run(row, (api) async {
      final answer = await api.consult(own.callUuid, to);
      if (mounted) {
        setState(
          () => _consult = (ownLeg: own.callUuid, caller: caller, to: to),
        );
      }
      return answer;
    }, currentL10n.attConsultCalling(_party(to)));
  }

  Future<void> _finishConsult({required bool complete}) async {
    final consult = _consult;
    final api = ref.read(attendantApiProvider);
    if (consult == null || api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (complete) {
        await api.completeTransfer(consult.ownLeg);
        showToast(messenger, currentL10n.attConsultDone(_party(consult.to)));
      } else {
        await api.cancelTransfer(consult.ownLeg);
        showToast(messenger, currentL10n.attConsultBack);
      }
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
    if (mounted) setState(() => _consult = null);
  }

  Future<String?> _askWhere({bool talkFirst = false}) => showDialog<String>(
    context: context,
    builder: (_) => _TransferDialog(
      names: _names,
      initial: _firstMatch(_search.text),
      talkFirst: talkFirst,
    ),
  );

  Future<void> _askTransfer(LiveCallRow row) async {
    final to = await _askWhere();
    if (to != null && mounted) _transfer(row, to);
  }

  Future<void> _askTalkFirst(LiveCallRow row) async {
    final own = _ownLeg(row);
    if (own == null) return;
    final to = await _askWhere(talkFirst: true);
    if (to != null && mounted) _talkFirst(row, own, to);
  }

  void _park(LiveCallRow row, Json lot) => _run(
    row,
    (api) => api.park(row.first.callUuid, '${lot['id']}'),
    currentL10n.attParked('${lot['label']}'),
  );

  void _pickUp(LiveCallRow row) {
    final ringing = row.ringingPhone;
    if (ringing == null) return;
    _run(row, (api) => api.pickup(ringing.callUuid), currentL10n.attPickedUp);
  }

  Future<void> _hangUp(LiveCallRow row) async {
    final l10n = context.l10n;
    final confirmed = await confirmAction(
      context,
      title: l10n.attHangUpTitle,
      message: _party(row.from),
      confirmLabel: l10n.attHangUp,
    );
    if (confirmed && mounted) {
      _run(row, (api) => api.hangup(row.first.callUuid), l10n.attHungUp);
    }
  }

  Future<void> _dial(String to) async {
    final api = ref.read(attendantApiProvider);
    if (api == null) return;
    final messenger = ScaffoldMessenger.of(context);
    showToast(messenger, currentL10n.attRingingYourPhone);
    try {
      await api.dial(to);
    } catch (e) {
      showToast(messenger, problemMessage(e));
    }
  }

  /// The first extension the search finds, by number or name.
  String? _firstMatch(String text) {
    final query = text.trim().toLowerCase();
    if (query.isEmpty) return null;
    final numbers = {
      ..._names.keys,
      for (final p
          in ref.read(presenceProvider).value?.extensions ?? const <Presence>[])
        p.extension,
    }.toList()..sort(compareExtensions);
    return numbers
        .where(
          (n) =>
              n.startsWith(query) ||
              (_names[n] ?? '').toLowerCase().contains(query),
        )
        .firstOrNull;
  }

  void _moveSelection(_Sorted sorted, int by) {
    final all = sorted.all;
    if (all.isEmpty) return;
    final at = all.indexWhere((r) => r.id == _selected);
    final next = at < 0 ? 0 : (at + by).clamp(0, all.length - 1);
    setState(() => _selected = all[next].id);
  }

  Future<void> _showShortcuts() => showDialog<void>(
    context: context,
    builder: (context) {
      final l10n = context.l10n;
      Widget line(String keys, String what) => ListTile(
        dense: true,
        leading: SizedBox(
          width: 72,
          child: Text(
            keys,
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
        ),
        title: Text(what),
      );
      return AlertDialog(
        title: Text(l10n.attShortcuts),
        content: SizedBox(
          width: 420,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              line('/', l10n.attKeySearch),
              line('↑ ↓', l10n.attKeySelect),
              line('T', l10n.attKeyTransfer),
              line(l10n.attKeyEnter, l10n.attKeyTransferFirst),
              line('P', l10n.attKeyPark),
              line('A', l10n.attKeyPickUp),
              line('H', l10n.attKeyHangUp),
              line(l10n.attKeyEsc, l10n.attKeyClear),
              line('?', l10n.attKeyHelp),
            ],
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: Text(l10n.commonClose),
          ),
        ],
      );
    },
  );

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (ref.watch(tenantIdProvider) == null) {
      return Center(child: Text(l10n.attChooseTenant));
    }
    if (!ref.watch(canProvider('call.control')) ||
        !ref.watch(canProvider('monitor.calls'))) {
      return Center(child: Text(l10n.attNotAllowed));
    }
    final view = ref.watch(liveCallsProvider).value;
    final sorted = _Sorted(view?.calls ?? const []);
    final selected = _row(_selected, sorted);
    final lots = ref.watch(rowsProvider('parking-lots')).asData?.value ?? [];
    final ownPhone = ref.watch(myExtensionProvider).asData?.value;
    ref.watch(rowsProvider('extensions'));

    void onSelected(void Function(LiveCallRow row) action) {
      if (selected != null) action(selected);
    }

    final bindings = <ShortcutActivator, VoidCallback>{
      const SingleActivator(LogicalKeyboardKey.slash): () =>
          _searchFocus.requestFocus(),
      const SingleActivator(LogicalKeyboardKey.slash, shift: true):
          _showShortcuts,
      const SingleActivator(LogicalKeyboardKey.escape): () =>
          setState(() => _selected = null),
      const SingleActivator(LogicalKeyboardKey.arrowDown): () =>
          _moveSelection(sorted, 1),
      const SingleActivator(LogicalKeyboardKey.arrowUp): () =>
          _moveSelection(sorted, -1),
      const SingleActivator(LogicalKeyboardKey.keyT): () =>
          onSelected(_askTransfer),
      const SingleActivator(LogicalKeyboardKey.keyP): () {
        if (lots.isNotEmpty) onSelected((row) => _park(row, lots.first));
      },
      const SingleActivator(LogicalKeyboardKey.keyA): () => onSelected(_pickUp),
      const SingleActivator(LogicalKeyboardKey.keyH): () => onSelected(_hangUp),
    };

    final calls = _CallsColumn(
      sorted: sorted,
      selected: _selected,
      busy: _busy,
      party: _party,
      lots: lots,
      canPickUp: ownPhone != null,
      stopped: view?.stopped,
      loaded: view?.loaded ?? false,
      onSelect: (row) =>
          setState(() => _selected = _selected == row.id ? null : row.id),
      onTransfer: _askTransfer,
      onTalkFirst: _consult == null ? _askTalkFirst : null,
      isMine: (row) => _ownLeg(row) != null,
      onPark: _park,
      onPickUp: _pickUp,
      onHangUp: _hangUp,
    );
    final grid = _ExtensionGrid(
      filter: _search.text,
      names: _names,
      selected: selected,
      canCall: ownPhone != null,
      onDrop: _transfer,
      onCall: _dial,
    );
    // On a wide screen the grid takes the height left; on a narrow one the
    // whole page scrolls, so the grid is as tall as it needs (S9-17).
    Widget directory({required bool fill}) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: fill ? MainAxisSize.max : MainAxisSize.min,
      children: [
        TextField(
          key: const ValueKey('attendant-search'),
          controller: _search,
          focusNode: _searchFocus,
          decoration: InputDecoration(
            prefixIcon: const Icon(Icons.search),
            labelText: l10n.attSearch,
            helperText: selected == null
                ? l10n.attSearchHelp
                : l10n.attSearchHelpSelected,
          ),
          onChanged: (_) => setState(() {}),
          onSubmitted: (text) {
            final match = _firstMatch(text);
            if (selected != null && match != null) {
              _transfer(selected, match);
              _search.clear();
              _pageFocus.requestFocus();
            }
          },
        ),
        const SizedBox(height: 12),
        if (fill) Expanded(child: grid) else grid,
        const SizedBox(height: 12),
        _ParkingStrip(
          lots: lots,
          parked: sorted.parked,
          party: _party,
          canTakeBack: ownPhone != null,
          onDrop: _park,
          onTakeBack: (slot) => _dial('$slot'),
        ),
        const SizedBox(height: 12),
        const QueuesPanel(),
      ],
    );

    return CallbackShortcuts(
      bindings: bindings,
      child: Focus(
        focusNode: _pageFocus,
        autofocus: true,
        child: PageFrame(
          children: [
            PageHeader(
              title: l10n.navAttendant,
              subtitle: l10n.attSubtitle,
              actions: [
                _DropSetting(),
                IconButton(
                  tooltip: l10n.attShortcuts,
                  icon: const Icon(Icons.keyboard_outlined),
                  onPressed: _showShortcuts,
                ),
              ],
            ),
            const SizedBox(height: 8),
            _OwnPhoneBanner(number: ownPhone?['number'] as String?),
            if (_consult case final consult?
                when (view?.calls ?? const []).any(
                  (row) => row.legs.any((l) => l.callUuid == consult.ownLeg),
                ))
              _ConsultBanner(
                caller: _party(consult.caller),
                to: _party(consult.to),
                onComplete: () => _finishConsult(complete: true),
                onCancel: () => _finishConsult(complete: false),
              ),
            const SizedBox(height: 12),
            Expanded(
              child: LayoutBuilder(
                builder: (context, constraints) => constraints.maxWidth < 900
                    ? SingleChildScrollView(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            SizedBox(height: 320, child: calls),
                            const SizedBox(height: 16),
                            directory(fill: false),
                          ],
                        ),
                      )
                    : Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          SizedBox(width: 380, child: calls),
                          const SizedBox(width: 24),
                          Expanded(child: directory(fill: true)),
                        ],
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// S9-21: the receptionist's choice of what a drop does.
class _DropSetting extends ConsumerWidget {
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final talkFirst = ref.watch(attendantTalkFirstProvider);
    return PopupMenuButton<bool>(
      key: const ValueKey('attendant-drop-menu'),
      tooltip: l10n.attDropSetting,
      icon: const Icon(Icons.call_split_outlined),
      onSelected: ref.read(attendantTalkFirstProvider.notifier).choose,
      itemBuilder: (_) => [
        CheckedPopupMenuItem(
          key: const ValueKey('attendant-drop-now'),
          value: false,
          checked: !talkFirst,
          child: Text(l10n.attDropNow),
        ),
        CheckedPopupMenuItem(
          key: const ValueKey('attendant-drop-talk'),
          value: true,
          checked: talkFirst,
          child: Text(l10n.attDropTalkFirst),
        ),
      ],
    );
  }
}

/// S9-21: an attended transfer under way: the caller waits while the
/// receptionist talks to the person they asked for.
class _ConsultBanner extends StatelessWidget {
  const _ConsultBanner({
    required this.caller,
    required this.to,
    required this.onComplete,
    required this.onCancel,
  });

  final String caller;
  final String to;
  final VoidCallback onComplete;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Card(
      key: const ValueKey('attendant-consult'),
      margin: const EdgeInsets.only(top: 8),
      color: Theme.of(context).colorScheme.tertiaryContainer,
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            const Icon(Icons.record_voice_over_outlined),
            Text(l10n.attConsulting(to, caller)),
            FilledButton(
              key: const ValueKey('attendant-consult-complete'),
              onPressed: onComplete,
              child: Text(l10n.attConsultComplete),
            ),
            OutlinedButton(
              key: const ValueKey('attendant-consult-cancel'),
              onPressed: onCancel,
              child: Text(l10n.attConsultCancel),
            ),
          ],
        ),
      ),
    );
  }
}

/// Which phone the receptionist's own calls ring, or that none will.
class _OwnPhoneBanner extends StatelessWidget {
  const _OwnPhoneBanner({required this.number});

  final String? number;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final number = this.number;
    return Row(
      children: [
        Icon(
          number == null ? Icons.phone_disabled_outlined : Icons.phone_outlined,
          size: 18,
          color: number == null ? theme.colorScheme.error : null,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            number == null ? l10n.attNoPhone : l10n.attYourPhone(number),
            style: theme.textTheme.bodySmall,
          ),
        ),
      ],
    );
  }
}

class _CallsColumn extends StatelessWidget {
  const _CallsColumn({
    required this.sorted,
    required this.selected,
    required this.busy,
    required this.party,
    required this.lots,
    required this.canPickUp,
    required this.stopped,
    required this.loaded,
    required this.onSelect,
    required this.onTransfer,
    required this.onTalkFirst,
    required this.isMine,
    required this.onPark,
    required this.onPickUp,
    required this.onHangUp,
  });

  final _Sorted sorted;
  final String? selected;
  final Set<String> busy;
  final String Function(String number) party;
  final List<Json> lots;
  final bool canPickUp;
  final String? stopped;
  final bool loaded;
  final void Function(LiveCallRow row) onSelect;
  final void Function(LiveCallRow row) onTransfer;

  /// Null while an attended transfer is already under way.
  final void Function(LiveCallRow row)? onTalkFirst;
  final bool Function(LiveCallRow row) isMine;
  final void Function(LiveCallRow row, Json lot) onPark;
  final void Function(LiveCallRow row) onPickUp;
  final void Function(LiveCallRow row) onHangUp;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (stopped != null) return Text(l10n.attUpdatesStopped);
    if (!loaded) return Text(l10n.shellLoading);
    final sections = [
      (l10n.attIncoming, sorted.ringing, Icons.ring_volume_outlined),
      (l10n.attWaiting, sorted.waiting, Icons.hourglass_top_outlined),
      (l10n.attOnHold, sorted.parked, Icons.local_parking_outlined),
      (l10n.attInProgress, sorted.active, Icons.call_outlined),
    ];
    if (sorted.all.isEmpty) {
      return EmptyState(
        icon: Icons.phone_in_talk_outlined,
        title: l10n.attNoCalls,
        message: l10n.attNoCallsHelp,
      );
    }
    return ListView(
      children: [
        for (final (title, rows, icon) in sections)
          if (rows.isNotEmpty) ...[
            Padding(
              padding: const EdgeInsets.only(top: 8, bottom: 4),
              child: Row(
                children: [
                  Icon(icon, size: 18),
                  const SizedBox(width: 6),
                  Text(
                    l10n.attSectionCount(title, rows.length),
                    style: Theme.of(context).textTheme.titleSmall,
                  ),
                ],
              ),
            ),
            for (final row in rows)
              _CallCard(
                key: ValueKey('attendant-call-${row.id}'),
                row: row,
                selected: row.id == selected,
                busy: busy.contains(row.id),
                party: party,
                lots: lots,
                canPickUp: canPickUp,
                onTap: () => onSelect(row),
                onTransfer: () => onTransfer(row),
                onTalkFirst: onTalkFirst != null && isMine(row)
                    ? () => onTalkFirst!(row)
                    : null,
                onPark: (lot) => onPark(row, lot),
                onPickUp: () => onPickUp(row),
                onHangUp: () => onHangUp(row),
              ),
          ],
      ],
    );
  }
}

/// One call: who, to whom, how long, and what can be done with it. Drag it
/// onto an extension to send it there, or onto a parking lot to park it.
class _CallCard extends ConsumerWidget {
  const _CallCard({
    super.key,
    required this.row,
    required this.selected,
    required this.busy,
    required this.party,
    required this.lots,
    required this.canPickUp,
    required this.onTap,
    required this.onTransfer,
    required this.onTalkFirst,
    required this.onPark,
    required this.onPickUp,
    required this.onHangUp,
  });

  final LiveCallRow row;
  final bool selected;
  final bool busy;
  final String Function(String number) party;
  final List<Json> lots;
  final bool canPickUp;
  final VoidCallback onTap;
  final VoidCallback onTransfer;

  /// Only for a call on the receptionist's own phone (S9-21).
  final VoidCallback? onTalkFirst;
  final void Function(Json lot) onPark;
  final VoidCallback onPickUp;
  final VoidCallback onHangUp;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    final now = ref.watch(clockProvider).value ?? DateTime.now();
    final since = row.answeredAt ?? row.startedAt;
    final seconds = now.difference(since).inSeconds.clamp(0, 1 << 30);
    final parked = row.parked;
    final to = parked != null
        ? l10n.attParkedIn('${parked.slot}')
        : l10n.attTo(party(row.to));
    final card = Card(
      margin: const EdgeInsets.symmetric(vertical: 4),
      color: selected ? theme.colorScheme.primaryContainer : null,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsetsDirectional.fromSTEB(12, 8, 4, 4),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      party(row.from),
                      style: theme.textTheme.titleSmall,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Text(formatClock(seconds), style: theme.textTheme.bodySmall),
                  const SizedBox(width: 8),
                ],
              ),
              Text(to, style: theme.textTheme.bodySmall),
              if (busy)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: LinearProgressIndicator(),
                )
              else
                Wrap(
                  children: [
                    IconButton(
                      tooltip: l10n.attTransfer,
                      icon: const Icon(Icons.phone_forwarded_outlined),
                      onPressed: onTransfer,
                    ),
                    if (onTalkFirst != null)
                      IconButton(
                        key: ValueKey('attendant-talk-first-${row.id}'),
                        tooltip: l10n.attTalkFirst,
                        icon: const Icon(Icons.record_voice_over_outlined),
                        onPressed: onTalkFirst,
                      ),
                    if (lots.isNotEmpty && parked == null)
                      PopupMenuButton<Json>(
                        tooltip: l10n.attPark,
                        icon: const Icon(Icons.local_parking_outlined),
                        onSelected: onPark,
                        itemBuilder: (_) => [
                          for (final lot in lots)
                            PopupMenuItem(
                              value: lot,
                              child: Text('${lot['label']}'),
                            ),
                        ],
                      ),
                    if (canPickUp && row.ringingPhone != null)
                      IconButton(
                        tooltip: l10n.attPickUp,
                        icon: const Icon(Icons.call_received_outlined),
                        onPressed: onPickUp,
                      ),
                    IconButton(
                      tooltip: l10n.attHangUp,
                      icon: const Icon(Icons.call_end_outlined),
                      onPressed: onHangUp,
                    ),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
    return Draggable<LiveCallRow>(
      data: row,
      feedback: Material(
        elevation: 6,
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Text(party(row.from)),
        ),
      ),
      childWhenDragging: Opacity(opacity: 0.4, child: card),
      child: card,
    );
  }
}

/// Every extension with what it is doing; a call dropped on one is sent there,
/// and a tap sends the selected call.
class _ExtensionGrid extends ConsumerWidget {
  const _ExtensionGrid({
    required this.filter,
    required this.names,
    required this.selected,
    required this.canCall,
    required this.onDrop,
    required this.onCall,
  });

  final String filter;
  final Map<String, String> names;
  final LiveCallRow? selected;
  final bool canCall;
  final void Function(LiveCallRow row, String to) onDrop;
  final void Function(String to) onCall;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = context.l10n;
    final presence = ref.watch(presenceProvider).value;
    final states = {
      for (final p in presence?.extensions ?? const <Presence>[])
        p.extension: p.state,
    };
    final numbers = {...names.keys, ...states.keys}.toList()
      ..sort(compareExtensions);
    final query = filter.trim().toLowerCase();
    final shown = [
      for (final n in numbers)
        if (query.isEmpty ||
            n.startsWith(query) ||
            (names[n] ?? '').toLowerCase().contains(query))
          n,
    ];
    if (shown.isEmpty) return Text(l10n.attNoExtensions);
    return SingleChildScrollView(
      // Inside the narrow page's own scroll view, the page scrolls instead.
      primary: false,
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final number in shown)
            DragTarget<LiveCallRow>(
              key: ValueKey('attendant-ext-$number'),
              onAcceptWithDetails: (details) => onDrop(details.data, number),
              builder: (context, candidates, _) => _ExtensionTile(
                number: number,
                name: names[number],
                state: states[number],
                highlighted: candidates.isNotEmpty,
                onTap: selected == null
                    ? null
                    : () => onDrop(selected!, number),
                onCall: canCall ? () => onCall(number) : null,
              ),
            ),
        ],
      ),
    );
  }
}

class _ExtensionTile extends StatelessWidget {
  const _ExtensionTile({
    required this.number,
    required this.name,
    required this.state,
    required this.highlighted,
    required this.onTap,
    required this.onCall,
  });

  final String number;
  final String? name;
  final String? state;
  final bool highlighted;
  final VoidCallback? onTap;
  final VoidCallback? onCall;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final theme = Theme.of(context);
    // The same look as the presence board (S9-15), in the theme's shade.
    final look = presenceLook(l10n, state ?? '', brightness: theme.brightness);
    final label = state == null ? l10n.presenceUnknown : look.label;
    final icon = look.icon;
    final color = look.color ?? theme.colorScheme.outline;
    return Tooltip(
      message: onTap == null ? '' : l10n.attSendHere,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          width: 196,
          padding: const EdgeInsetsDirectional.fromSTEB(10, 6, 2, 6),
          decoration: BoxDecoration(
            color: highlighted
                ? theme.colorScheme.primaryContainer
                : color.withValues(alpha: 0.08),
            border: Border.all(
              color: highlighted ? theme.colorScheme.primary : color,
              width: highlighted ? 2 : 1,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(icon, color: color, size: 20),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(number, style: theme.textTheme.titleSmall),
                    if (name != null && name!.isNotEmpty)
                      Text(
                        name!,
                        style: theme.textTheme.bodySmall,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    Text(label, style: theme.textTheme.bodySmall),
                  ],
                ),
              ),
              if (onCall != null)
                IconButton(
                  tooltip: l10n.attCall(number),
                  icon: const Icon(Icons.call_outlined, size: 18),
                  onPressed: onCall,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The parking lots: drop a call on one to park it; the calls parked in each,
/// with a way to take one back on the receptionist's phone.
class _ParkingStrip extends StatelessWidget {
  const _ParkingStrip({
    required this.lots,
    required this.parked,
    required this.party,
    required this.canTakeBack,
    required this.onDrop,
    required this.onTakeBack,
  });

  final List<Json> lots;
  final List<LiveCallRow> parked;
  final String Function(String number) party;
  final bool canTakeBack;
  final void Function(LiveCallRow row, Json lot) onDrop;
  final void Function(int slot) onTakeBack;

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    if (lots.isEmpty) return const SizedBox.shrink();
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final lot in lots)
          DragTarget<LiveCallRow>(
            key: ValueKey('attendant-lot-${lot['id']}'),
            onAcceptWithDetails: (details) => onDrop(details.data, lot),
            builder: (context, candidates, _) {
              final here = [
                for (final row in parked)
                  if (row.parked?.parkingLotId == lot['id']) row,
              ];
              return Card(
                margin: EdgeInsets.zero,
                color: candidates.isNotEmpty
                    ? Theme.of(context).colorScheme.primaryContainer
                    : null,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        l10n.attLot('${lot['label']}', here.length),
                        style: Theme.of(context).textTheme.titleSmall,
                      ),
                      for (final row in here)
                        Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text('${row.parked!.slot} · ${party(row.from)}'),
                            if (canTakeBack)
                              TextButton(
                                onPressed: () => onTakeBack(row.parked!.slot),
                                child: Text(l10n.attTakeBack),
                              ),
                          ],
                        ),
                      if (here.isEmpty) Text(l10n.attDropToPark),
                    ],
                  ),
                ),
              );
            },
          ),
      ],
    );
  }
}

/// Where to send a call: a number, with the directory's matches to pick from.
class _TransferDialog extends StatefulWidget {
  const _TransferDialog({
    required this.names,
    this.initial,
    this.talkFirst = false,
  });

  final Map<String, String> names;
  final String? initial;

  /// S9-21: asking whom to talk to first, rather than where to send the call.
  final bool talkFirst;

  @override
  State<_TransferDialog> createState() => _TransferDialogState();
}

class _TransferDialogState extends State<_TransferDialog> {
  late final _to = TextEditingController(text: widget.initial ?? '');
  String? _error;

  @override
  void dispose() {
    _to.dispose();
    super.dispose();
  }

  void _submit([String? value]) {
    final text = (value ?? _to.text).replaceAll(RegExp(r'[\s().-]'), '');
    if (!RegExp(r'^\+?[0-9*#]{1,32}$').hasMatch(text)) {
      setState(() => _error = context.l10n.attNotANumber);
      return;
    }
    Navigator.of(context).pop(text);
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final query = _to.text.trim().toLowerCase();
    final matches = [
      for (final e in widget.names.entries)
        if (query.isNotEmpty &&
            (e.key.startsWith(query) || e.value.toLowerCase().contains(query)))
          e,
    ]..sort((a, b) => compareExtensions(a.key, b.key));
    return AlertDialog(
      title: Text(
        widget.talkFirst ? l10n.attTalkFirstTitle : l10n.attTransferTitle,
      ),
      content: SizedBox(
        width: 400,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              key: const ValueKey('attendant-transfer-to'),
              controller: _to,
              autofocus: true,
              decoration: InputDecoration(
                labelText: l10n.attTransferTo,
                helperText: l10n.attTransferHelp,
                errorText: _error,
              ),
              onChanged: (_) => setState(() => _error = null),
              onSubmitted: _submit,
            ),
            for (final e in matches.take(5))
              ListTile(
                dense: true,
                title: Text('${e.key} · ${e.value}'),
                onTap: () => _submit(e.key),
              ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.commonCancel),
        ),
        FilledButton(
          onPressed: _submit,
          child: Text(
            widget.talkFirst ? l10n.attTalkFirstCall : l10n.attTransfer,
          ),
        ),
      ],
    );
  }
}
