import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../widgets/page.dart';

/// Shown when a signed-in person types the address of a page their role does
/// not have. The services refuse the same request with 403 (rule H1).
class ForbiddenPage extends StatelessWidget {
  const ForbiddenPage({super.key});

  @override
  Widget build(BuildContext context) => PageFrame(
    children: [
      const PageHeader(
        title: 'Not available to you',
        subtitle: "Your role doesn't include this page.",
      ),
      TextButton(
        onPressed: () => context.go('/'),
        child: const Text('Go back'),
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
      const PageHeader(
        title: 'Page not found',
        subtitle: 'There is nothing at this address.',
      ),
      TextButton(
        onPressed: () => context.go('/'),
        child: const Text('Go back'),
      ),
    ],
  );
}
