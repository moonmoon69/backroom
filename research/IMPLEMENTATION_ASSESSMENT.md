# T3 Rooms implementation assessment

Reviewed: 2026-09-23
Inputs: `PRD.md`, `research/JEV_FINDINGS.md`, `research/HERDR_ASSESSMENT.md`, `scripts/probe_jev.py`, the five Jev result JSON files, the public `pingdotgg/t3code` repository at `main`, TypeSafe documentation, the SemIf repository, and the T3 Code Nightly install on this machine (`0.0.43-nightly.20260922.2123`, server on `127.0.0.1:3773`, state in `~/.t3/userdata`).

## Implementation status (2026-09-23, later the same day)

The core described below has been built in this repository: command contract, SQLite queue, scheduler with turn correlation and identical-resend reconciliation, briefing assembly, explicit syntax parser with alias pools, HTTP T3 adapter with pairing exchange, HTTP API with Server-Sent Events, a React UI with live streaming and activity views, and 39 tests (acceptance flows through the fake adapter plus HTTP adapter contract tests with a mocked transport) (`npm test`). Gate 1 passed on 2026-09-23 after Network access was enabled in T3 Code: pairing, authenticated reads, thread creation, turn start with identical resend, turn correlation and completion, checkpoint read, and interrupt all passed against the live Desktop server with Claude Sonnet 5. One correction came out of it: T3 never stamps the user message with a turn id, so correlation is by adjacency to the following provider messages or the session's active turn (see `src/adapter/correlate.ts`). See `README.md`.

## Verdict

The plan is implementable as specified. Phase 1 needs no T3 fork and no model. Every T3 capability the PRD depends on exists in the public contracts and in the locally installed build. One precondition is not met on this machine today: the Desktop app's embedded server does not allow a third-party process to obtain credentials. That must be resolved before the adapter spike, and the PRD should record it. Three statements in the PRD are inaccurate and should be corrected before implementation starts. None of them change the product shape.

## Internal consistency of the docs

- The numbers in `JEV_FINDINGS.md` match the stored JSON summaries exactly: 0/3, 2/3, 13/16, 14/16, 7/12; all runs on `jev-1.13.0`; no transport errors.
- `PRD.md`, `JEV_FINDINGS.md`, and `HERDR_ASSESSMENT.md` agree on scope: T3 is the backend, Herdr is rejected, Jev/SemIf are optional Phase 2 adapters.
- The PRD header says the working directory is `t3code-threads`. The actual directory is `t3code-rooms`. The T3 project `t3code-threads` exists in the local T3 database but is soft-deleted; `t3code-rooms` is registered and live.
- The directory is not a git repository. `.gitignore` already excludes `.env`, which holds `JEV_API_KEY`.
- The Herdr assessment was not re-verified; it is not on the implementation path.

## T3 Code integration: what was verified

Source: `packages/contracts/src/orchestration.ts`, `environmentHttp.ts`, `rpc.ts`, and string extraction from the installed app bundle. Both agree.

| PRD need | T3 surface | Status |
| --- | --- | --- |
| Project discovery | `projects.list`, `projects.add` RPC | Verified |
| Provider/model catalog | `server.getConfig` (no standalone `providers.list`); `~/.t3/userdata/model-manifest.json` locally | Verified |
| Create thread | `thread.create` command; client supplies `threadId` and `commandId` | Verified |
| Attach to existing thread | `orchestration.subscribeThread` with `threadId`, `afterSequence` resumption | Verified |
| Submit a turn | `thread.turn.start` via `orchestration.dispatchCommand` (WebSocket) or `POST /api/orchestration/dispatch` (HTTP); client-supplied `commandId`; receipts table `orchestration_command_receipts` keyed by `command_id` | Verified; idempotent retry is supported as the PRD requires |
| Observe execution | `orchestration.subscribeThread` / `subscribeShell`; HTTP `GET /api/orchestration/threads/:threadId`, `/snapshot` | Verified |
| Read full history | Thread detail; `turnLimit` pagination is optional, not forced | Verified; the 8,000-character cap belongs to the community MCP bridge, not T3 |
| Answer permissions/questions | `thread.approval.respond` (accept, acceptForSession, acceptAlways, decline, cancel), `thread.user-input.respond`, `thread.user-input.dismiss` | Verified |
| Interrupt | `thread.turn.interrupt` | Verified |
| Permission mode | `thread.runtime-mode.set`: approval-required, auto-accept-edits, auto, full-access; `thread.interaction-mode.set`: default, plan | Verified |
| Persona / system instruction | No per-thread field on any command. Only `message.context` and turn `bootstrap` exist. T3 reads repository `AGENTS.md` itself. | Not natively supported; use an initial brief or repo instruction files |

### Completion contract is achievable, but not through named lifecycle events

T3 emits no `turn.completed`, `turn.failed`, or `turn.interrupted` event. Observed locally across 726 completed, 24 errored, and 14 interrupted turns, the terminal sequence is:

1. Provider `thread.session-set` with `status: running` and `activeTurnId` set.
2. Provider `thread.message-sent` for the assistant message with `streaming: false` and the `turnId`.
3. Provider `thread.session-set` with `status: ready` (or `error`) and `activeTurnId: null`.
4. Server `thread.turn-diff-completed` carrying `turnId`, `status: ready|error`, `assistantMessageId`, and changed files.

The projected `latestTurn.state` is `running`, `completed`, `error`, or `interrupted`. Interrupts add a client `thread.turn-interrupt-requested` event before step 4. The adapter should key completion on the `turnId` it obtained from its own `thread.turn.start` (via the pending message ID) and treat `turn-diff-completed` plus `latestTurn.state == completed` as the success signal. The PRD's warning about `thread.settled` is correct: the decider emits it for both `thread.settle` and `thread.auto-settle`, and 86 such events exist locally.

### Blocker on this machine: no credential path to the Desktop server

`EnvironmentAuthPolicy.ts` selects `desktop-managed-local` when the Desktop app runs on loopback. That policy advertises only the `desktop-bootstrap` method; `one-time-token` pairing is not offered. The local database confirms it: all 13 bearer sessions belong to "T3 Code Desktop", the single pairing link was consumed on 2026-08-26, and `server-runtime.json` is a discovery file with no token. The upstream change that would have let local tools reuse the Desktop connection, PR #12148, was closed unmerged on 2026-09-19.

Supported alternatives:

- Run the server as a background service (`t3 service install`, documented in `docs/user/background-service.md`). Under that mode the policy is `loopback-browser`, which offers `one-time-token`; the companion pairs once with `t3 pair` and exchanges the link at `POST /oauth/token` for a scoped bearer token. Whether the Desktop app then attaches to the service-managed server is documented but must be confirmed in the spike. The `t3` CLI is not currently installed here.
- Enable remote access on the Desktop app (`remote-reachable`), which adds `one-time-token`. This exposes the server beyond loopback and should be paired with Tailscale or equivalent.
- Read-only observation by opening `~/.t3/userdata/state.sqlite` in WAL read-only mode. This works for observing but cannot dispatch and depends on an undocumented schema. Not recommended beyond prototyping.

The PRD's spike item 1 should be rewritten to state the precondition rather than treating it as unknown.

### PR citations are wrong

PRs #12457 (per-instance Cursor config directories) and #9181 (mid-thread account switching) are closed unmerged, but neither concerns third-party API access. The relevant rejected PR is #12148. Section 9 should cite that one.

### Versioning

Latest stable release is 0.0.42 (2026-09-16); this machine runs a 2026-09-22 nightly. The overview states contracts are independently versioned with no stability promise. Pin the adapter to a stable release and add a contract check at startup, as the PRD already proposes.

## Jev and SemIf: what was verified

All TypeSafe claims in PRD section 5 and `JEV_FINDINGS.md` are accurate: endpoint, bearer auth, `state`/`model`/`questions` shape, independent question evaluation, keys not used in inference, Choice `confidence` derived from the distribution, Noul with no confidence field, `jev-1.13.0` as the current version behind `jev-latest`, $0.042 per million input tokens with free output, and the jaggedness page. TypeSafe's own examples use `TYPESAFE_API_KEY`; the PRD's decision to keep `JEV_API_KEY` is fine because only the header matters. A third primitive, Score, exists and is not needed.

SemIf is real, MIT-licensed, formerly OpenJev, and independent of TypeSafe. Its default branch is `master`, so the PRD's links are correct. It is Python-only with pinned heavy dependencies (torch 2.10, transformers 5.17), has no HTTP server, no Noul or Score primitive, and its own README labels its probabilities uncalibrated as decision confidence. A TypeScript service would need a Python sidecar. The video exists (Sam Witteveen, 2026-09-21); its chapter timestamps could not be confirmed, which the PRD already hedges.

None of this blocks Phase 1 because the PRD makes interpretation optional and the held-out result (7/12) already fails the proposed gate.

## Gaps to close before coding

1. **Choose the stack.** Not stated anywhere. T3's contracts are Effect/TypeScript schemas; a TypeScript service can vendor them and get validation for free. Recommended: TypeScript service with better-sqlite3 for the queue and outbox, a small web UI, and an optional Python sidecar only if SemIf is ever enabled.
2. **Rewrite section 6.4 completion detection** to the observed event sequence above instead of implying discrete lifecycle events.
3. **Record the auth precondition** (service-managed or remote-reachable server) in sections 9 and 12, and note that Desktop-only setups are not supported until upstream changes.
4. **Persona delivery.** State that T3 has no per-thread instruction field; persona goes in the first turn's text or repository instruction files, and permission mode is set with `thread.runtime-mode.set`.
5. **Correct the PR references** in section 9.
6. **Fix the working directory** in the PRD header and initialize git so `.gitignore` takes effect.
7. **Direct-activity detection** is straightforward: turn-start events carry `command_id` and `actor_kind`; any turn whose command ID the room did not issue is external and must not satisfy a prerequisite. Add this to the adapter spec.

## Recommended order

1. Adapter spike (1 to 2 days): stand up a service-managed T3 server, pair, create a thread, send one turn, observe the terminal sequence, interrupt a turn, answer one approval, read a message longer than 8,000 characters. This answers spike items 1 through 3 and 5.
2. Queue and scheduler with SQLite persistence, state machine from section 6.2, and restart reconciliation tests, driven by a fake adapter.
3. Room UI with direct controls and the explicit `@alias` / `/after` syntax.
4. Acceptance run against two real harnesses per section 11.
5. Only then revisit Jev or SemIf with the action-first question layout.
