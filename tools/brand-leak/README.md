# @cuc/brand-leak

Scans user-facing and network-visible surfaces for forbidden strings, and fails the build when it
finds one. This is what makes CLAUDE.md rule 1 and D-002 enforceable rather than a convention.

```sh
pnpm brand-leak              # from the repository root
pnpm exec brand-leak --root /path/to/repo
```

Exit codes: `0` clean, `1` something was found, `2` the configuration is broken.

## What it looks for

| Rule | Catches |
|---|---|
| `codebase-name` | `ConductorUC`, `conductoruc`, `conductor-uc`, `conductor_uc`, `Conductor UC`, any case |
| `flutter-template` | `A new Flutter project` |
| `flutter-default-title` | Flutter's default metadata in the console shell |

`operator-name` is deliberately **not** a built-in: there is no operator name in this repository,
and a deployment that has one adds it through its own config rather than by editing the default.

The pattern is word-shaped, not a bare substring — "Conduct a survey", "Much success", and "Reduce"
do not trip it.

## Where it looks

An **include-list**, not "everything minus exceptions". The codebase name is explicitly allowed in
source, package names, image names, internal logs, and developer docs (02 §5.2), so a
scan-everything default would be almost entirely false positives and would be silenced within a
week. What is scanned is the checklist in 02 §5.5:

- `apps/console/web/**` and `apps/console/lib/**` — the shell carries Flutter's own defaults, the
  Dart sources carry every user-visible string
- `apps/console/build/web/**` — built output, when a build has run
- email templates (`services/*/templates/**`, `.mjml`, `.hbs`)
- telephony config templates (`.xml`, `.cfg`, `.conf`, `.lua`, `.tpl`) — SIP `User-Agent`/`Server`
  headers and SDP identity
- `**/openapi.json` and `**/openapi.yaml`

Binary assets are skipped by extension, and files over 2 MB are skipped with a warning rather than
read into memory.

## Surfaces that match nothing

Most of those directories do not exist until the stage that creates them, so the report **lists
every include glob that matched no files**. A surface that is renamed or moved otherwise stops being
scanned in silence, and the run stays green while covering nothing — which is worse than a failure,
because it looks like proof.

Set `failOnEmptyInclude: true` once a surface exists, to keep it from disappearing again.

## Configuring it

`brand-leak.config.json` at the repository root:

```json
{
  "deny": [
    { "id": "operator-name", "pattern": "Acme Telecom", "hint": "The operator's name is not a brand here." }
  ],
  "allow": ["**/node_modules/**", "**/*.g.dart"],
  "failOnEmptyInclude": false
}
```

**`deny` is added to, never replaced.** A deployment can add its operator name; it cannot quietly
drop the codebase-name rule. `include` and `allow` are replaced, because those are genuinely
deployment-shaped.
