import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../l10n/l10n.dart';
import '../../widgets/page.dart';

/// Shown when a signed-in person types the address of a page their role does
/// not have. The services refuse the same request with 403 (rule H1).
class ForbiddenPage extends StatelessWidget {
  const ForbiddenPage({super.key});

  @override
  Widget build(BuildContext context) => PageFrame(
    children: [
      PageHeader(
        title: context.l10n.shellForbiddenTitle,
        subtitle: context.l10n.shellForbiddenBody,
      ),
      TextButton(
        onPressed: () => context.go('/'),
        child: Text(context.l10n.commonGoBack),
      ),
    ],
  );
}

/// Shown for an address that is not a page at all.
class NotFoundPage extends StatelessWidget {
  const NotFoundPage({super.key});

  @override
  Widget build(BuildContext context) => PageFrame(
    children: [
      PageHeader(
        title: context.l10n.shellNotFoundTitle,
        subtitle: context.l10n.shellNotFoundBody,
      ),
      TextButton(
        onPressed: () => context.go('/'),
        child: Text(context.l10n.commonGoBack),
      ),
    ],
  );
}
