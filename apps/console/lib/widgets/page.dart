import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/problem.dart';

/// The padded page every screen sits in. Brand-agnostic: it reads only the
/// theme, so it looks right under any brand or the neutral palette (08 §2).
class PageFrame extends StatelessWidget {
  const PageFrame({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(24),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    ),
  );
}

/// A page title with an optional leading control, actions on the right, and a
/// line of explanation below.
class PageHeader extends StatelessWidget {
  const PageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.actions = const [],
  });

  final String title;
  final String? subtitle;
  final Widget? leading;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context).textTheme;
    // S9-17: on a narrow screen (a phone) the buttons go under the title and
    // wrap, instead of pushing past the edge.
    final narrow = MediaQuery.sizeOf(context).width < 600;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            ?leading,
            Expanded(child: Text(title, style: theme.headlineSmall)),
            if (!narrow)
              for (final (i, action) in actions.indexed) ...[
                if (i > 0) const SizedBox(width: 8),
                action,
              ],
          ],
        ),
        if (narrow && actions.isNotEmpty) ...[
          const SizedBox(height: 8),
          Wrap(spacing: 8, runSpacing: 8, children: actions),
        ],
        if (subtitle != null) ...[
          const SizedBox(height: 4),
          Text(subtitle!, style: theme.bodyMedium),
        ],
      ],
    );
  }
}

/// Text in the theme's error color.
class ErrorText extends StatelessWidget {
  const ErrorText(this.message, {super.key});

  final String message;

  @override
  Widget build(BuildContext context) => Text(
    message,
    style: TextStyle(color: Theme.of(context).colorScheme.error),
  );
}

/// A loading spinner, an error message, or an empty note, until there is
/// something to show; then [builder].
class AsyncBody<T> extends StatelessWidget {
  const AsyncBody({
    super.key,
    required this.value,
    required this.builder,
    this.emptyText = '',
    this.empty,
    this.isEmpty,
  });

  final AsyncValue<T> value;
  final Widget Function(T data) builder;
  final String emptyText;

  /// Shown instead of [emptyText] when there is nothing: an [EmptyState]
  /// that says what these are and how to add the first (S9-03).
  final Widget? empty;

  /// Whether [data] has nothing to list; defaults to an empty collection.
  final bool Function(T data)? isEmpty;

  @override
  Widget build(BuildContext context) => value.when(
    loading: () => const Center(child: CircularProgressIndicator()),
    error: (e, _) => Center(child: Text(problemMessage(e))),
    data: (data) {
      final empty = isEmpty?.call(data) ?? (data is Iterable && data.isEmpty);
      if (!empty) return builder(data);
      return this.empty ?? Center(child: Text(emptyText));
    },
  );
}
