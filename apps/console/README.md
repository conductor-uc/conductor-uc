# Console (Flutter web)

Design: `docs/architecture/08-console.md`.

## Run it without a backend (demo mode)

```sh
cd apps/console
flutter run -d chrome --dart-define=DEMO=true
```

Demo mode serves canned responses for the two routes the console calls today
(`lib/dev/demo_backend.dart`):

- **Brand:** a hostname containing `reseller` (for example
  `reseller.localhost:PORT`) shows a sample reseller brand; anything else is neutral.
- **Sign in:** the email picks the role. `master@x`, `reseller@x`, or anything else
  (a tenant user). Any password works except `wrong`, which shows the error state.
  The organization ID can be anything.

## Run it against a gateway

```sh
flutter run -d chrome --dart-define=API_BASE_URL=http://localhost:8080
```

The gateway allows the console's origin only if its hostname is in the gateway's
console hostnames. Master and reseller users must complete MFA (07 §1), which the
console cannot do until S3-04, so only tenant users can sign in for now.

## Checks

```sh
dart format lib test
flutter analyze
flutter test                      # add --update-goldens after an intended visual change
flutter build web --release
```

`tool/generate-api.sh` regenerates `packages/console_api` from `api/openapi.yaml`.
