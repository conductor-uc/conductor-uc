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

Sign in as a tenant user (any email that is not `master@` or `reseller@`) to
reach the PBX screens: extensions, phone numbers, ring groups, queues and agents,
conference rooms, parking lots, media, call flows, and emergency locations (under
Settings). They read and write an in-memory tenant seeded in `lib/dev/demo_pbx.dart`.

Sign in as `master@` to create, edit, and suspend resellers and browse their tenants, or `reseller@` to manage
tenants and edit the brand (colors, name, hostnames, with a live preview), then use **Act as** on a tenant to open its PBX screens. A banner shows
while acting, and a reseller does not see the private-data sections (voicemail,
recordings).

Sign-in details for the demo: `master@` is asked for a code, `reseller@` first sets up
an authenticator (both accept `123456`), any other email signs in directly. Resetting
someone's two-step verification under **Users** asks for your own code too (`123456`;
anything else shows the wrong-code message). Open
`/reset` for password reset (a token of `expired` is rejected on the confirm page) and
`/invite?token=x` for an invitation (`expired` is invalid, `taken` conflicts).

## Adding or changing a PBX screen

The screens are driven by `lib/features/pbx/resource.dart`: one `ResourceDef` per
service resource, listing its fields. `test/contract_test.dart` compares those
definitions with `api/openapi.json`, which `tool/dump-openapi.mjs` builds from the
services' own route schemas (run `pnpm build` first). When a service's schema changes,
re-run the dump and the contract test says which screen to update.

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

## Canvas benchmark

`lib/dev/canvas_bench.dart` pans and zooms 150 connected nodes for six seconds
and prints one `BENCH {...}` line of frame timings to the browser console.
Run it in Chrome, ideally on a real GPU:

    flutter run -d chrome --profile -t lib/dev/canvas_bench.dart

Record a performance trace from DevTools alongside it if the numbers need a
closer look. The target (08 §4.1) is 60 fps, meaning few frames over 16.7 ms.

## Call-flow builder

`lib/canvas/` is the generic canvas engine (no telephony). The builder on top
of it is `lib/features/callflow/builder/`. Its node types and local validator
are checked against `@cuc/callflow-ir` through `api/callflow-ir.json`; after
changing the IR, re-run `node tool/dump-callflow-ir.mjs` (build `@cuc/callflow-ir`
first) and the console tests say what to update.
