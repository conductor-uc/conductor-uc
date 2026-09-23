import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/brand.dart';
import '../../widgets/brand_header.dart';

/// The frame every signed-out page shares: the brand (or nothing, when
/// neutral), a heading, the page's content, and the brand's legal footer.
class AuthScaffold extends ConsumerWidget {
  const AuthScaffold({super.key, required this.title, required this.children});

  final String title;
  final List<Widget> children;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final brand = ref.watch(brandProvider);
    final theme = Theme.of(context);
    return Scaffold(
      body: Center(
        child: SingleChildScrollView(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 380),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: AutofillGroup(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    BrandHeader(brand: brand, large: true),
                    Text(title, style: theme.textTheme.headlineSmall),
                    const SizedBox(height: 16),
                    ...children,
                    if (brand.legalFooter != null) ...[
                      const SizedBox(height: 24),
                      Text(
                        brand.legalFooter!,
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The message under a form: an error in the theme's error color, or a plain
/// note.
class FormMessage extends StatelessWidget {
  const FormMessage(this.text, {super.key, this.isError = false});

  final String text;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 12),
      child: Text(
        text,
        style: isError
            ? TextStyle(color: Theme.of(context).colorScheme.error)
            : null,
      ),
    );
  }
}
