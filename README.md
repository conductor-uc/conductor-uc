# conductor-uc (monorepo)

Multi-tenant unified communications platform. "ConductorUC" is the codebase name only; deployments are unbranded, and resellers apply their own brand.

- [Documentation index](docs/README.md)
- [Architecture baseline (SAD)](docs/sad.md)
- [Staged implementation plan](docs/plan/implementation-plan.md)
- [Decisions & open questions](docs/decisions.md)

## Getting started

Requires Node 22 (`.nvmrc`). pnpm is pinned by the `packageManager` field and provided by Corepack:

```sh
corepack enable
pnpm install
pnpm lint typecheck test build
```

| Command | What it does |
|---|---|
| `pnpm lint` | ESLint (flat config, type-aware) over every workspace package |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm test` | Vitest per package |
| `pnpm build` | `tsc --build` per package, into `dist/` |
| `pnpm check` | All four, through one Turborepo run |
| `pnpm format` | Prettier over code (Markdown is excluded; see `.prettierignore`) |
| `pnpm vitest` | Runs every package's suite at once from the root |

Turborepo caches task output in `.turbo/`; `pnpm clean` removes build output and caches.

## Layout

The directory structure follows [01 §5](docs/architecture/01-system-overview.md#5-monorepo-layout). `packages/*`,
`services/*`, `tools/*`, and `tests/*` are pnpm workspace members. `apps/console` (Flutter) is built by its
own toolchain from CI and is not a workspace member.

`packages/example` is a scaffold placeholder with no product code — delete it once the real shared packages land.
