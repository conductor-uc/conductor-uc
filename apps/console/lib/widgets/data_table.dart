import 'package:flutter/material.dart';

import '../l10n/l10n.dart';

/// One column of an [AppTable].
class AppColumn<T> {
  const AppColumn({
    required this.label,
    required this.cell,
    this.text,
    this.sortValue,
    this.numeric = false,
  });

  final String label;

  /// What the cell shows.
  final Widget Function(T row) cell;

  /// The cell as plain text, for searching; also the sort order unless
  /// [sortValue] is given. Null leaves the column out of search and sort.
  final String Function(T row)? text;

  /// A value to sort by other than [text] (a number, a date).
  final Comparable<Object?> Function(T row)? sortValue;

  final bool numeric;

  bool get sortable => text != null || sortValue != null;

  Comparable<Object?> _sortKey(T row) =>
      sortValue?.call(row) ?? text!.call(row).toLowerCase();
}

/// The console's table (S9-03): search, sort by any column, pages, and, when
/// [bulkActions] are given, selecting rows to act on together. Everything
/// happens on the rows it is given, which suits the lists a tenant has
/// (hundreds, not millions); a list the service pages itself keeps its own
/// paging.
class AppTable<T> extends StatefulWidget {
  const AppTable({
    super.key,
    required this.columns,
    required this.rows,
    required this.rowKey,
    this.actions,
    this.bulkActions,
    this.pageSize = 25,
    this.searchable = true,
    this.initialSort,
  });

  final List<AppColumn<T>> columns;
  final List<T> rows;

  /// A stable identity per row, for selection.
  final String Function(T row) rowKey;

  /// Buttons at the end of each row (edit, delete, ...).
  final List<Widget> Function(T row)? actions;

  /// Shown above the table while rows are selected, given the selected rows
  /// and a callback that clears the selection.
  final List<Widget> Function(List<T> selected, VoidCallback clear)?
  bulkActions;

  final int pageSize;
  final bool searchable;

  /// The column index to sort by at first, ascending.
  final int? initialSort;

  @override
  State<AppTable<T>> createState() => _AppTableState<T>();
}

class _AppTableState<T> extends State<AppTable<T>> {
  final _search = TextEditingController();
  late int? _sortColumn = widget.initialSort;
  bool _ascending = true;
  int _page = 0;
  final Set<String> _selected = {};

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(AppTable<T> old) {
    super.didUpdateWidget(old);
    // Rows that went away cannot stay selected.
    final keys = {for (final r in widget.rows) widget.rowKey(r)};
    _selected.retainAll(keys);
  }

  List<T> get _visible {
    final query = _search.text.trim().toLowerCase();
    var rows = widget.rows;
    if (query.isNotEmpty) {
      rows = [
        for (final r in rows)
          if (widget.columns.any(
            (c) => c.text?.call(r).toLowerCase().contains(query) ?? false,
          ))
            r,
      ];
    }
    final sort = _sortColumn;
    if (sort != null && widget.columns[sort].sortable) {
      final column = widget.columns[sort];
      rows = [...rows]
        ..sort((a, b) {
          final order = column._sortKey(a).compareTo(column._sortKey(b));
          return _ascending ? order : -order;
        });
    }
    return rows;
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    final visible = _visible;
    final pages = (visible.length / widget.pageSize).ceil().clamp(1, 1 << 30);
    final page = _page.clamp(0, pages - 1);
    final start = page * widget.pageSize;
    final shown = visible.skip(start).take(widget.pageSize).toList();
    final selectable = widget.bulkActions != null;
    final selectedRows = [
      for (final r in widget.rows)
        if (_selected.contains(widget.rowKey(r))) r,
    ];
    final searching = _search.text.trim().isNotEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (widget.searchable &&
            widget.columns.any((c) => c.text != null) &&
            (widget.rows.length > 5 || searching))
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 360),
                child: TextField(
                  key: const ValueKey('table-search'),
                  controller: _search,
                  decoration: InputDecoration(
                    isDense: true,
                    prefixIcon: const Icon(Icons.search),
                    hintText: l10n.tableSearch,
                    suffixIcon: searching
                        ? IconButton(
                            tooltip: l10n.tableClearSearch,
                            icon: const Icon(Icons.close),
                            onPressed: () => setState(() {
                              _search.clear();
                              _page = 0;
                            }),
                          )
                        : null,
                  ),
                  onChanged: (_) => setState(() => _page = 0),
                ),
              ),
            ),
          ),
        if (selectable && selectedRows.isNotEmpty)
          Material(
            color: Theme.of(context).colorScheme.secondaryContainer,
            borderRadius: BorderRadius.circular(8),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
              child: Row(
                children: [
                  Expanded(
                    child: Text(l10n.tableSelected(selectedRows.length)),
                  ),
                  ...widget.bulkActions!(
                    selectedRows,
                    () => setState(_selected.clear),
                  ),
                  TextButton(
                    onPressed: () => setState(_selected.clear),
                    child: Text(l10n.tableClearSelection),
                  ),
                ],
              ),
            ),
          ),
        if (visible.isEmpty && searching)
          Padding(
            padding: const EdgeInsets.all(24),
            child: Text(
              l10n.tableNoMatches(_search.text.trim()),
              textAlign: TextAlign.center,
            ),
          )
        else
          LayoutBuilder(
            builder: (context, constraints) => SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: ConstrainedBox(
                constraints: BoxConstraints(minWidth: constraints.maxWidth),
                child: DataTable(
                  // S9-17: the selection checkboxes are drawn here, so each
                  // can be named for screen readers ("Select 101 Alice");
                  // the table's own are unlabeled and make every cell a
                  // tap target.
                  showCheckboxColumn: false,
                  sortColumnIndex: _sortColumn == null
                      ? null
                      : _sortColumn! + (selectable ? 1 : 0),
                  sortAscending: _ascending,
                  columns: [
                    if (selectable)
                      DataColumn(
                        label: Checkbox(
                          value:
                              shown.isNotEmpty &&
                                  shown.every(
                                    (r) => _selected.contains(widget.rowKey(r)),
                                  )
                              ? true
                              : shown.any(
                                  (r) => _selected.contains(widget.rowKey(r)),
                                )
                              ? null
                              : false,
                          tristate: true,
                          semanticLabel: l10n.tableSelectAll,
                          onChanged: (_) => setState(() {
                            final all = shown.every(
                              (r) => _selected.contains(widget.rowKey(r)),
                            );
                            for (final r in shown) {
                              all
                                  ? _selected.remove(widget.rowKey(r))
                                  : _selected.add(widget.rowKey(r));
                            }
                          }),
                        ),
                      ),
                    for (final (i, c) in widget.columns.indexed)
                      DataColumn(
                        label: Text(c.label),
                        numeric: c.numeric,
                        onSort: c.sortable
                            ? (_, _) => setState(() {
                                _ascending = _sortColumn == i
                                    ? !_ascending
                                    : true;
                                _sortColumn = i;
                                _page = 0;
                              })
                            : null,
                      ),
                    if (widget.actions != null)
                      DataColumn(
                        // Named for screen readers; the buttons explain
                        // themselves to everyone else.
                        label: Semantics(
                          label: l10n.tableActions,
                          child: const SizedBox.shrink(),
                        ),
                      ),
                  ],
                  rows: [
                    for (final r in shown)
                      DataRow(
                        key: ValueKey(widget.rowKey(r)),
                        selected: _selected.contains(widget.rowKey(r)),
                        cells: [
                          if (selectable)
                            DataCell(
                              Checkbox(
                                value: _selected.contains(widget.rowKey(r)),
                                semanticLabel: l10n.tableSelectRow(
                                  widget.columns.first.text?.call(r) ??
                                      widget.rowKey(r),
                                ),
                                onChanged: (on) => setState(
                                  () => on == true
                                      ? _selected.add(widget.rowKey(r))
                                      : _selected.remove(widget.rowKey(r)),
                                ),
                              ),
                            ),
                          for (final c in widget.columns) DataCell(c.cell(r)),
                          if (widget.actions != null)
                            DataCell(
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: widget.actions!(r),
                              ),
                            ),
                        ],
                      ),
                  ],
                ),
              ),
            ),
          ),
        if (pages > 1)
          Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              Text(
                MaterialLocalizations.of(context).pageRowsInfoTitle(
                  start + 1,
                  start + shown.length,
                  visible.length,
                  false,
                ),
              ),
              IconButton(
                tooltip: MaterialLocalizations.of(context).previousPageTooltip,
                icon: const Icon(Icons.chevron_left),
                onPressed: page == 0
                    ? null
                    : () => setState(() => _page = page - 1),
              ),
              IconButton(
                tooltip: MaterialLocalizations.of(context).nextPageTooltip,
                icon: const Icon(Icons.chevron_right),
                onPressed: page >= pages - 1
                    ? null
                    : () => setState(() => _page = page + 1),
              ),
            ],
          ),
      ],
    );
  }
}
