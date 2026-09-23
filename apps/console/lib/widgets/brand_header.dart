import 'package:flutter/material.dart';

import '../app/brand.dart';

/// The brand's logo and display name. Neutral renders nothing at all: no
/// mark and no product label (02 §5.3). Colors come from the theme and no
/// asset is embedded (08 §2).
class BrandHeader extends StatelessWidget {
  const BrandHeader({super.key, required this.brand, this.large = false});

  final Brand brand;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final name = brand.displayName;
    final logo = brand.logoLightUrl;
    if (name == null && logo == null) return const SizedBox.shrink();
    final style = large
        ? Theme.of(context).textTheme.headlineMedium
        : Theme.of(context).textTheme.titleLarge;
    return Padding(
      padding: EdgeInsets.only(bottom: large ? 24 : 0),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          if (logo != null)
            Image.network(
              logo,
              height: large ? 40 : 28,
              errorBuilder: (_, _, _) => const SizedBox.shrink(),
            ),
          if (logo != null && name != null) const SizedBox(width: 12),
          if (name != null)
            Flexible(
              child: Text(name, style: style, overflow: TextOverflow.ellipsis),
            ),
        ],
      ),
    );
  }
}
