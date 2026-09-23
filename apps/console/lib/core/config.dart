/// Where api-gateway lives. Empty means same origin, which is how the console
/// is served in production (08 §1); a dev build points it at a gateway with
/// `--dart-define=API_BASE_URL=http://localhost:8080`.
const apiBaseUrl = String.fromEnvironment('API_BASE_URL');
