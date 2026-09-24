# tests/e2e

The M2 pilot journey (plan S3-11) over HTTP, against real service processes
on real infrastructure. `src/stack.ts` starts identity, org, notification,
callflow and the gateway on MariaDB, NATS, MinIO, Redis and Mailpit (the same
infrastructure the other integration tests use), makes the master the way an
operator does, and `test/m2-journey.test.ts` walks the journey.

It runs with `pnpm test` here or in CI's test job. It needs the services built
(`pnpm exec turbo run build --filter=@cuc/tests-e2e...`) and skips, like the
other integration tests, when infrastructure is missing unless the `REQUIRE_*`
variables are set.

What it cannot walk yet is listed as `todo` at the end of the test, with the
reason (gateway routing, decision G-60; the SIPp call needs the FreeSWITCH
stack in `tests/sip`). The console's own walk through the same journey is
`apps/console/test/journey_test.dart`, against the demo backend.
