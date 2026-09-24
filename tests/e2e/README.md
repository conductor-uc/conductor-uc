# tests/e2e

The M2 pilot journey (plan S3-11) over HTTP, against real service processes
on real infrastructure. `src/stack.ts` starts identity, org, notification,
pbx-config, trunk, voicemail, cdr, callflow and the gateway on MariaDB, NATS,
MinIO, Redis and Mailpit (the same infrastructure the other integration tests
use), makes the master the way an operator does, and `test/m2-journey.test.ts`
walks the journey. Every call a browser would make goes through the gateway
with a real access token (G-60), so a route the gateway does not send to its
service fails here.

It runs with `pnpm test` here or in CI's test job. It needs the services built
(`pnpm exec turbo run build --filter=@cuc/tests-e2e...`, plus each service it
starts) and skips, like the other integration tests, when infrastructure is
missing unless the `REQUIRE_*` variables are set.

What it cannot walk here is listed as `todo` at the end of the test: the SIPp
carrier call through a published flow needs the FreeSWITCH and OpenSIPs stack
in `tests/sip`. The console's own walk through the same journey is
`apps/console/test/journey_test.dart`, against the demo backend.
