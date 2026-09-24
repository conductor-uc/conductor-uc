import 'package:web/web.dart' as web;

void setDocumentTitle(String title) {
  web.document.title = title;
}

String? _neutralFavicon;

/// Points the tab icon at [url], or back at the neutral icon when null.
void setDocumentFavicon(String? url) {
  final link =
      web.document.querySelector('link[rel~="icon"]') as web.HTMLLinkElement?;
  if (link == null) return;
  _neutralFavicon ??= link.href;
  link.href = url ?? _neutralFavicon!;
}

String currentHost() => web.window.location.host;
