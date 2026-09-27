# Architecture decision records

An ADR records one significant, hard-to-reverse architectural choice: the context, the decision, what was rejected and why, and what follows from it. [`decisions.md`](../../decisions.md) stays the register of every decision and open question. An ADR is the long form of one of its entries and links back to it.

- File name: `NNNN-short-title.md`, numbered in order and never reused.
- Status: **Proposed** (a recommendation awaiting the owner), **Accepted** (decided by the owner, with the date), or **Superseded by** another ADR. An accepted ADR is not rewritten; a change of mind is a new ADR that supersedes it.
- Sections: Status, Context, Decision, Alternatives considered, Consequences.

| ADR | Title | Status | Register |
|---|---|---|---|
| [0001](0001-orchestrator.md) | Container orchestration: Compose per server now, Kubernetes for the application tier later | Accepted (2026-09-25) | O-1 |
