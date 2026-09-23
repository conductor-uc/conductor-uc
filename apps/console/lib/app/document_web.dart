import 'package:web/web.dart' as web;

void setDocumentTitle(String title) {
  web.document.title = title;
}

void setDocumentFavicon(String url) {
  final link =
      web.document.querySelector('link[rel~="icon"]') as web.HTMLLinkElement?;
  if (link != null) {
    link.href = url;
  }
}

String currentHost() => web.window.location.host;
