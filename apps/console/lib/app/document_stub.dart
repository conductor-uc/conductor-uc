/// Non-web stand-in so the app's sources can be analyzed and unit-tested on
/// the Dart VM. The console itself only ever runs on the web.
void setDocumentTitle(String title) {}

void setDocumentFavicon(String url) {}

String currentHost() => 'localhost';
