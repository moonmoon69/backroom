# T3 no-fork adapter path for Rooms Phase 1

Inspected public `pingdotgg/t3code` `main` at commit `b954af60c402ff0698f9f2d9a214695e817f07fe` (2026-09-23T00:45:50Z). Live Nightly on this Mac is `0.0.43-nightly.20260922.2123` (bundle + well-known `serverVersion`), listening on `127.0.0.1:3773`. Community MCP inspected at commit `391b9a783c3e62dfa3ca948b4835efb3473d6ab4` (v0.3.0). Labels used below: **shipped source**, **shipped docs**, **closed PR**, **live observation**, **inference**, **gap**. Closed PRs `#12148`, `#12457`, `#9181` are not treated as shipped.

**Overall (inference from the sections below):** Phase 1 can be implemented without a T3 fork. The HTTP/RPC surface already covers create, attach-by-id, turn submit, interrupt, native Q&A, full message text, checkpoint/diff metadata, and command-id receipts. The missing piece on **this machine today** is not an API: it is pairing. The running Desktop server advertises `desktop-managed-local` with bootstrap `["desktop-bootstrap"]` only. A no-fork companion cannot obtain a session against that policy. Before an adapter spike the user must stand up a server that advertises `one-time-token` (service-managed `t3 serve` / `t3 service install`, or Desktop **Network access**), install the `t3` CLI (absent here), and pair once. Do not wait for closed PR `#12148`. Do not use the in-process `/mcp` provider toolkit as the companion control plane.

## What commands exist to create/attach a thread, submit a turn, interrupt, and answer pending questions/permissions?

### Takeaway

Shipped client commands cover create, turn start, interrupt, approval, and user-input. There is no `thread.attach`: an existing thread is addressed by `threadId` from the shell snapshot plus `orchestration.subscribeThread`. HTTP dispatch does not run WebSocket `bootstrap.createThread`; a companion using HTTP must `thread.create` then `thread.turn.start`.

### Cited Findings

- WebSocket methods include `orchestration.dispatchCommand`, `orchestration.subscribeThread`, `orchestration.subscribeShell`, `orchestration.getTurnDiff`, `orchestration.getFullThreadDiff`. — **shipped source** [orchestration.ts `ORCHESTRATION_WS_METHODS`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L35)
- HTTP, all behind `EnvironmentAuthenticatedAuth`: `GET /api/orchestration/snapshot`, `GET /api/orchestration/shell`, `GET /api/orchestration/threads/:threadId`, `POST /api/orchestration/dispatch`. Dispatch payload is `ClientOrchestrationCommand`; success is `DispatchResult` `{ sequence }`. Thread GET query comments: omitting `turnLimit`/`beforeCursor` keeps the full snapshot. — **shipped source** [environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/environmentHttp.ts)
- Dispatchable client commands include `thread.create`, `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`, `thread.user-input.respond`, `thread.user-input.dismiss`, `thread.runtime-mode.set`, `thread.interaction-mode.set`, `thread.session.stop`, `thread.settle`/`thread.unsettle`, `project.create`. `thread.auto-settle`, `thread.session.set`, assistant deltas, and `thread.turn.diff.complete` are internal. — **shipped source** [orchestration.ts `DispatchableClientOrchestrationCommand` / `ClientOrchestrationCommand`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1414)
- `thread.create` fields: client-supplied `threadId`, `projectId`, `title`, `modelSelection`, `runtimeMode`, `interactionMode`, `branch`, `worktreePath`, `createdAt`, optional `historyImport`. No persona/system-prompt field. — **shipped source** [orchestration.ts `ThreadCreateCommand`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1114)
- `thread.turn.start` carries `commandId`, `threadId`, user `message` (`messageId`, `role: "user"` only, `text`, `attachments`, optional `context`), optional `modelSelection`/`titleSeed`/`bootstrap`/`sourceProposedPlan`, required `runtimeMode`/`interactionMode` on the HTTP client schema, `createdAt`. — **shipped source** [orchestration.ts `ClientThreadTurnStartCommand`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1328)
- `thread.turn.interrupt` has optional `turnId`. The reactor still calls `providerService.interruptTurn({ threadId })` with the comment “Orchestration turn ids are not provider turn ids, so interrupt by session.” — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1348); [ProviderCommandReactor.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1611)
- `thread.approval.respond`: `requestId` + `decision` in `accept | acceptForSession | acceptAlways | decline | cancel`. `thread.user-input.respond`: `requestId` + `answers` (`Record<string, unknown>`) + optional per-question attachments. `thread.user-input.dismiss` closes an async question; schema comment: native callback questions cannot be dismissed because the provider is blocked. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L147)
- Decider `thread.turn.start` calls `requireThread` (thread must already exist), emits `thread.message-sent` (unless that user message was already appended) plus `thread.turn-start-requested`. The turn-start payload records `targetThread.runtimeMode` / `targetThread.interactionMode`, not the mode fields on the start command. It does not read `command.bootstrap`. — **shipped source** [decider.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/decider.ts#L1368)
- WebSocket dispatch, before the engine sees the turn, runs `bootstrap.createThread` as a separate `thread.create`, optional `prepareWorktree` + `thread.meta.update`, then the turn. HTTP `dispatch` only `normalizeDispatchCommand` then `orchestrationEngine.dispatch`. — **shipped source** [ws.ts `bootstrapProgram`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/ws.ts); [http.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/http.ts)
- `RuntimeMode` wire values: `approval-required`, `auto-accept-edits`, `auto`, `full-access` (schema default `full-access`). `ProviderInteractionMode`: `default | plan`. User docs name composer modes Supervised / Auto-accept edits / Auto / Full access and say providers enforce them differently. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L128); **shipped docs** [permission-modes.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/permission-modes.md)
- RPC scopes: `dispatchCommand` requires `orchestration:operate`; `subscribeThread`, `subscribeShell`, `getTurnDiff`, `getFullThreadDiff`, `server.getConfig` require `orchestration:read`; `server.refreshProviders` requires `orchestration:operate`. — **shipped source** [RpcAuthorization.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/auth/RpcAuthorization.ts)
- Provider catalog is `server.getConfig` / `subscribeServerConfig`, not a standalone `providers.list`. — **shipped source** [rpc.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/rpc.ts)
- Attach is subscribe/snapshot by id. Shell threads omit message bodies (`OrchestrationThreadShell`). — **shipped source** [orchestration.ts `OrchestrationThreadShell`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L880)
- Live well-known advertises `orchestrationProtocolVersion: 1`, `inlineMessageContext: true`, `requiredWorktreeBootstrap: true`, `threadSettlement: true`, `threadAutoSettlement: true`. — **live observation** `GET http://127.0.0.1:3773/.well-known/t3/environment` on 2026-09-23

### Inferences

- Phase 1 “attach” is `GET /api/orchestration/shell` (or `subscribeShell`) then bind the chosen `threadId`. No extra attach RPC is required and none exists.
- Permission/plan mode for an existing thread must be `thread.runtime-mode.set` / `thread.interaction-mode.set`. Putting those fields only on `thread.turn.start` does not change what `thread.turn-start-requested` persists.
- Interrupt is session-wide even if the client sends a `turnId`.
- Native `/mcp` on the same port is a **provider-scoped in-session toolkit** (capability `"preview"`), authenticated by a hashed per-thread MCP bearer, not the orchestration pairing session. Unauthenticated `GET /mcp` returned `401` `{ error: "invalid_mcp_credential", message: "A valid provider-scoped MCP bearer credential is required." }`. That is not a companion create/turn API. — **live observation** plus **shipped source** [McpHttpServer.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/mcp/McpHttpServer.ts); [McpSessionRegistry.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/mcp/McpSessionRegistry.ts)

### Gaps

- Per-provider mapping of user-visible “stop” vs `turn.aborted` vs `turn.completed(interrupted|cancelled)` was not traced through each adapter.
- Whether this Nightly’s compiled dispatch schema matches `main` `b954af60` was not proven by a live dispatch (disallowed).

## What persisted events or subscription payloads identify a specific turn’s successful terminal state, failure, interruption, and needs-input, as distinct from thread.settled / auto-settle?

### Takeaway

There is no `turn.completed` orchestration event. Provider completion is session status leaving `running`, projected onto `latestTurn.state`. `thread.settled` is a separate inbox lifecycle event for both manual settle and auto-settle and does not name a turn. Needs-input is pending approval/user-input activity, including while the session is still `running`. Production runtime receipts are a no-op.

### Cited Findings

- Architecture: command acknowledgement means intent committed, not that provider/checkpoint/follow-up finished. The projector settles the turn from session status. A late checkpoint must not extend recorded turn duration. Production runtime receipts are a no-op; tests must use persisted state and events. Durable command receipts are a different mechanism. — **shipped docs** [overview.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/overview.md)
- `OrchestrationSessionStatus`: `idle | starting | running | ready | interrupted | stopped | error`. `OrchestrationLatestTurn.state`: `running | interrupted | completed | error`. `latestTurn` holds `turnId`, timestamps, `assistantMessageId`. It does not hold the user `messageId` or client `commandId`. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L608)
- Leaving session `running` settles a still-running `latestTurn`: `idle`/`ready` → `completed`; `error` → `error`; `interrupted`/`stopped` → `interrupted`; `starting`/`running` stay unsettled. `completedAt` is `session.updatedAt`. Comment: “Leaving the `running` session status is the turn-end signal.” — **shipped source** [projector.ts `settledTurnStateForSessionStatus`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/projector.ts)
- Provider runtime `waiting` maps to orchestration session `running`. `turn.aborted` → session `interrupted`. `session.exited` → `stopped`. `turn.completed` → session `error` only when normalized state is `failed`; every other completed state, including literals `interrupted` and `cancelled`, becomes session `ready`. Unknown states default to `completed`. — **shipped source** [ProviderRuntimeIngestion.ts `normalizeRuntimeTurnState` / terminal switch](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)
- `thread.turn-diff-completed` updates checkpoints. If the session is still `running` on that `turnId`, `latestTurn` is left unchanged. Otherwise checkpoint `error` → turn `error`; `missing`/`ready` → `completed`, unless that `latestTurn` is already `interrupted`. Comment: a missing git ref is not an interruption. — **shipped source** [projector.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/projector.ts)
- `thread.settled` payload is `threadId`, `settledAt`, `updatedAt`. No reason, no turn id. Both `thread.settle` (client) and `thread.auto-settle` (internal) emit that same event type. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1779); [decider.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/decider.ts#L480)
- Auto-settle is blocked while session is `starting`/`running`, while queued-turn-start grace applies (2 minutes), while `hasPendingApprovals`/`hasPendingUserInput`, while `backgroundLiveness` is set, or while archived/`settledOverride` is set. It can still settle on age or a closed/merged PR. Manual settle still blocks on approvals and on user-input whose `responseMode` is not `"message"`; it dismisses async `responseMode: "message"` questions. — **shipped source** [ThreadSettlementPolicy.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/ThreadSettlementPolicy.ts); [decider.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/decider.ts#L495)
- Shell fields `hasPendingApprovals` and `hasPendingUserInput` are booleans. `backgroundLiveness` is `working | monitoring | null` for native background work **after** the turn settles. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L914)
- `subscribeThread` yields `synchronized`, `snapshot` (`OrchestrationThreadDetailSnapshot`), or `event` (`OrchestrationEvent`). Events carry `commandId`, `correlationId` (aliased to `CommandId`; comment: “Correlation id is command id by design”), and `metadata`. Input supports `afterSequence` (HTTP snapshot then resume), optional `turnLimit`, `reasoningMessages`, `requestCompletionMarker`. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L186)
- `thread.turn-start-requested` payload has `messageId` and **no** `turnId`. Its event `commandId` is the client command id. Later `thread.session-set` is an internal command, so that event’s `commandId` is server-generated. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1903)
- One pending turn start is stored per thread, keyed by `messageId`. When a session becomes `running` with an `activeTurnId`, that pending `messageId` is copied onto the SQL turn as `pendingMessageId`, then the pending row is deleted. `pendingMessageId` is **not** on `packages/contracts` public snapshots. — **shipped source** [ProjectionPipeline.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
- A new running turn marks other still-running turns on that thread `completed`. Comment: “steering can open a new turn without the provider ever completing the previous one.” — **shipped source** [ProjectionPipeline.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
- Turn-start failure activity is `provider.turn.start.failed` whose `requestId` is the user `messageId`. — **shipped source** [ProviderCommandReactor.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1231)
- Live well-known advertises `threadSettlement` and `threadAutoSettlement` both true. — **live observation** `GET /.well-known/t3/environment`

### Inferences

- Correlate a Rooms run as: our `thread.turn-start-requested` (`commandId` + `messageId`) is still the pending start when the next `thread.session-set` enters `running` with `activeTurnId`; then **that same `turnId`** leaves `running`. Success: `latestTurn.state === "completed"` for that `turnId`, session `ready` or `idle`, and shell `hasPendingApprovals` / `hasPendingUserInput` false. Failure: `latestTurn.state === "error"` or activity `provider.turn.start.failed` for our `messageId`. Interruption: session `interrupted`/`stopped` settling that `turnId` to `interrupted` (`turn.aborted`).
- Do **not** use `thread.settled` as the assignment-complete signal. Auto-settle can fire later for age/PR merge with the same event type as a user settle.
- Do **not** treat “session left `running`” without checking `turnId`. Steering marks the previous running turn `completed` when a new turn starts — a false success if keyed only on idle.
- A provider `turn.completed` with state `interrupted` or `cancelled` is stored as successful `ready`/`completed`. Phase 1 should not assume those provider states survive as `latestTurn.state === "interrupted"`.
- `thread.turn-diff-completed` is the checkpoint milestone, not provider completion. `backgroundLiveness` can remain after the turn has settled.
- Needs-input can be true while `latestTurn.state` is still `running` because provider `waiting` stays `running`.
- Historical turn state for any turn that is no longer `latestTurn` is not on `OrchestrationThread`. A client that connects after the fact sees the latest turn, messages, and checkpoints, not a public turn-state log. The companion must keep `commandId` → `messageId` → `turnId` from the event stream (or its own store).

### Gaps

- Whether each shipped provider actually emits `turn.completed` vs `turn.aborted` vs `session.state.changed: waiting` for the same user-visible outcome remains empirical (PRD spike 3).
- No public event field joins client `commandId` to provider `turnId`. The join exists only in the internal turn row (`pendingMessageId`).
- Local historical event counts from earlier notes (completed/errored/interrupted/`thread.settled`) were **not** re-queried this pass; SQLite was not opened.

## Is there a stable client command ID for idempotent retry, and does receipt replay ignore a changed body?

### Takeaway

Yes. The client supplies `commandId`. The engine persists one receipt per id and, on a matching aggregate, replays an accepted receipt as `{ sequence }` without running the command again. The receipt lookup does **not** compare the new body to the original body.

### Cited Findings

- `CommandId` is a branded non-empty trimmed string. No UUID pattern is required. Every client command includes `commandId`. — **shipped source** [baseSchemas.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/baseSchemas.ts)
- If a receipt exists for that id and the same aggregate, status `accepted` returns the stored `{ sequence }`. Status `rejected` fails with the stored error. The same id aimed at a different aggregate fails as a command-id conflict. Comment: “A receipt only proves this exact command was handled. Replaying it for a command aimed at another aggregate would report success for work that never happened.” There is **no payload-equality check** in that branch. — **shipped source** [OrchestrationEngine.ts `processEnvelope`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/OrchestrationEngine.ts)
- Events, projections, and the accepted command receipt commit in one transaction. Retries are idempotent because of that receipt. Acknowledgement is not provider completion. — **shipped docs** [overview.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/overview.md)
- Receipts are not a client-facing read API in `OrchestrationRpcSchemas`. The client sees `DispatchResult.sequence` or an error. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L2239)
- `normalizeDispatchCommand` overwrites client `createdAt` with server receipt time, including `bootstrap.createThread.createdAt`. It does not hash or store the body for later comparison. — **shipped source** [Normalizer.ts `canonicalizeClientCommandTimestamps`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Normalizer.ts)
- Community MCP documents: persist `commandId` before dispatch and reuse it only for the identical operation and arguments; T3 stores receipts including rejected commands; a receipt means accepted, not completed. Global mode **re-hashes** a caller `commandId` into `mcp-global:<sha256([env, name, project, thread, source, commandId])>`. — **shipped source** (third-party) [README](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md); [global-server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js)

### Inferences

- Retry of an uncertain dispatch must resend the **same** `commandId` and the **same** aggregate (`threadId` / `projectId`). A changed briefing under the same id is **not** applied; the old acceptance is returned. A rejected id cannot be reused; a revised instruction needs a new id. That matches PRD section 6.5.
- After reconnect, there is no `GET receipt by commandId`. Reconciliation is: look for `thread.message-sent` / `thread.turn-start-requested` with that `commandId` on the thread subscription, or treat a replayed `sequence` as acceptance.
- If the companion goes through t3code-thread-mcp, it does **not** control the T3 command id directly (the MCP wraps/hashes it). Direct HTTP/WS is required for PRD-stable ids.

### Gaps

- Receipt retention lifetime (forever versus compaction of `orchestration_command_receipts`) was not read.
- No live retry was sent (disallowed). Body-ignore behavior is from the engine source, not a captured HTTP replay.

## Can a third party read full message text and artifact/diff metadata, or is truncation only in t3code-thread-mcp?

### Takeaway

Conversation `message.text` is returned in full from the per-thread snapshot and from `thread.message-sent` events. There is no 8,000-character cap in T3. The community MCP slices every returned message to 8,000 characters. Official client activity payloads **are** summarized (tool stdout to ~84 characters); checkpoint file metadata is on the snapshot; patch text is a separate `orchestration:read` RPC.

### Cited Findings

- `OrchestrationMessage.text` is `Schema.String` with no max length. `thread.message-sent` payload `text` is the same. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L574)
- HTTP thread GET: omitting `turnLimit` keeps full-snapshot behavior; pagination is opt-in. Environment-wide `GET /api/orchestration/snapshot` is a lightweight read model with thread bodies empty because hydrating every message has OOM-killed servers. — **shipped source** [environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/environmentHttp.ts); [http.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/http.ts)
- In-memory decider fold caps messages at the last 2,000 (`MAX_THREAD_MESSAGES`). That constant is in `projector.ts`, not the SQL snapshot query. — **shipped source** [projector.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/projector.ts)
- Client activity reads project payloads: MCP `result` text is summarized; command output is reduced to one line of at most 84 characters or a line count. Comment: full payloads remain in persistence and the event store. Client activity window is the latest 500 ids plus pinned unresolved approvals/user-input. — **shipped source** [ActivityPayloadProjection.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/ActivityPayloadProjection.ts)
- Checkpoint summary per turn: `checkpointRef`, `status` `ready | missing | error`, `files[]` of `{ path, kind, additions, deletions }`. Patch text is `getTurnDiff` / `getFullThreadDiff`, both `Schema.String` named `diff`, scoped `orchestration:read`. Search snippets are max 240 characters (not the conversation read). — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L631)
- Outbound user turns are limited to `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` = 120,000. That limit is on provider send input, not stored assistant text. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L165)
- `orchestration:read` permits reading files the server account can read, including absolute paths outside a project. — **shipped docs** [environment-auth.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/environment-auth.md)
- t3code-thread-mcp `read_thread` maps `text: m.text.slice(0, 8000)` and `truncated: m.text.length > 8000`. Default `turnLimit` is 10. Archived threads throw before read. Last 50 activities plus pending request kinds; payloads copied only for those two kinds. README line 104 states the 8,000-character cap. — **shipped source** (third-party) [global-server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js); [README.md](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)

### Inferences

- A companion that calls `GET /api/orchestration/threads/:threadId` without `turnLimit`, plus `reasoningMessages=true`, and pages with `beforeCursor` only when advertised, can archive full `message.text`. That path is **not** the MCP cap.
- Lossless tool stdout is not on the client thread API. Artifact handoff that is actually on the wire is: assistant/user message text, checkpoint file paths and add/delete counts, `getTurnDiff` patch text, plus thread `branch` / `worktreePath`.
- Phase 1 acceptance “originals remain retrievable” fails if the room archive is filled only from MCP `read_thread`.

### Gaps

- No live thread was fetched (auth required; pairing disallowed). Full-text behavior is from source, not a response body on this machine.
- Whether projection maintenance deletes `projection_thread_messages` rows older than 2,000 was not confirmed.
- Undocumented diff-size cutoffs outside `apps/server/src/orchestration` remain possible.

## How does direct activity in the T3 UI interact with an external client on the same thread (steering, false completion if keyed only on session leaving running)?

### Takeaway

The UI and a companion are two clients of one serialized event log. There is no lock that reserves a thread. A second `thread.turn.start` while a provider turn is running is sent immediately, except during compaction (queued; cancelled if compaction fails). Steering can mark the previous turn `completed` without the provider finishing it. Keying Rooms success only on “session left `running`” will false-complete.

### Cited Findings

- The event log is the source of truth. The engine serializes commands. Subscribers receive events after commit. Web, desktop, and mobile use the same authenticated RPC boundary. — **shipped docs** [overview.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/overview.md)
- `thread.turn.start` from any client emits `thread.turn-start-requested` and, if the thread was settled or snoozed, `thread.unsettled` / `thread.unsnoozed` with `reason: "activity"`. — **shipped source** [decider.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/decider.ts#L1459)
- The provider reactor calls `sendTurn` for a normal turn start even when a session is already running. The only queue is `turnsAfterCompaction`. Compact is refused while status is `starting` or `running`. Compaction failure cancels queued turns. — **shipped source** [ProviderCommandReactor.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1416)
- Projection: a new active turn supersedes any still-running turn on the same thread — “steering can open a new turn without the provider ever completing the previous one,” and those other turns are upserted `state: "completed"`. — **shipped source** [ProjectionPipeline.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProjectionPipeline.ts)
- Ingestion accepts a conflicting `turn.started` when the server has a pending turn start and the provider’s active turn id matches (steering / OpenCode-style new turn). — **shipped source** [ProviderRuntimeIngestion.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts)
- Client-dispatched events can carry `metadata.origin` `{ surface?, appVersion? }`. `surface` is `web | desktop | mobile | cli`. HTTP dispatch was not shown stamping origin; WS takes `clientSurface` from the `/ws` query. Comment: origin must not become a server-global current client. — **shipped source** [orchestration.ts `OrchestrationClientOrigin`](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1980)
- Community MCP `ready()` returns true if `hasPendingApprovals` **or** `hasPendingUserInput` **or** session error after the latest user message **or** (latest turn exists, not `running`, session not `starting`/`running`, `backgroundLiveness !== "working"`). Cursor includes `latestTurn.turnId/state`, `session.status`, pending flags, `settledAt`, `backgroundLiveness`. `wait_threads` fires when `ready(value) && value.cursor !== t.cursor`. It does **not** match a Rooms `commandId`. — **shipped source** (third-party) [server.js `ready` / `summary`](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/server.js)

### Inferences

- Direct UI activity is visible as ordinary events whose `commandId` is not the companion’s. It can unsettle, start another turn, answer a pending request, or interrupt. It does not complete the companion’s command id.
- A UI send during a companion turn is a steer. The previous running turn can be marked `completed` when the new turn starts. If the adapter treats “our previous `latestTurn` left `running`” as success without checking that the terminal state belongs to **our** `turnId` **and** was not superseded, dependents will release incorrectly.
- `metadata.origin.surface` can distinguish desktop/web from a companion that connects with `clientSurface=cli`, but only for WebSocket-dispatched commands. It is not an authorization boundary. HTTP-only companions are harder to tell apart by surface.
- MCP `wait_threads` is unsafe for Phase 1 correlation: it treats needs-input as ready, treats any later idle/completed latest turn as ready, and includes `settledAt` in the cursor so auto-settle can wake it.

### Gaps

- Exact Desktop composer behavior when the user types during an in-flight turn (whether the app always sends `thread.turn.start` immediately) was not read in the client package. The server will accept that command if the client sends it.
- Live UI-versus-companion collision was not exercised (disallowed).

## What authentication modes exist, and which can a no-fork companion use today on this Mac?

### Takeaway

Shipped policies are `desktop-managed-local`, `loopback-browser`, `remote-reachable`, and schema-only `unsafe-no-auth`. Session methods after pairing are cookie, bearer, and DPoP. **This Mac’s running Nightly advertises `desktop-managed-local` with bootstrap `["desktop-bootstrap"]` only.** A separate process cannot complete that bootstrap. A no-fork companion can pair today only after the user switches the server to a policy that offers `one-time-token` (service-managed / `t3 serve`, or Desktop **Network access**). The `t3` CLI is not installed. Closed PR `#12148` (desktop connection bridge for local tools) is unmerged.

### Cited Findings

- `EnvironmentAuthPolicy`: desktop + loopback → `desktop-managed-local` / `["desktop-bootstrap"]`; desktop + remote host → `remote-reachable` / `["desktop-bootstrap", "one-time-token"]`; non-desktop + remote → `remote-reachable` / `["one-time-token"]`; non-desktop + loopback or empty host → `loopback-browser` / `["one-time-token"]`. Session methods are always `browser-session-cookie`, `bearer-access-token`, `dpop-access-token`. — **shipped source** [EnvironmentAuthPolicy.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/auth/EnvironmentAuthPolicy.ts)
- Policy meanings and bootstrap vs session methods are documented on the schema. `desktop-bootstrap` is “trusted local desktop handoff” so the shell can pair the renderer without a login screen. `one-time-token` is the short-lived pairing token (`/pair?token=...`). `unsafe-no-auth` is an explicit unsafe escape hatch; `EnvironmentAuthPolicy.make` never assigns it. — **shipped source** [auth.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/auth.ts)
- Token exchange: `POST /oauth/token`, grant `urn:ietf:params:oauth:grant-type:token-exchange`, subject type `urn:t3:params:oauth:token-type:environment-bootstrap`. Bearer/DPoP clients get short-lived WebSocket tickets via `POST /api/auth/websocket-ticket`. Pairing credential mint is `POST /api/auth/pairing-token` (authenticated; ordinary pairing does not grant `access:write`). — **shipped source** [auth.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/auth.ts); [environmentHttp.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/environmentHttp.ts); **shipped docs** [environment-auth.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/environment-auth.md)
- User docs: Desktop host enables **Network access** under Settings → Connections, then creates a pairing link. “Changing network access restarts the desktop app.” CLI: `t3 serve --host <private-ip>` or `t3 pair` against an already running server. Loopback pairing reaches only the device opening the link. Standard pairing scopes include `orchestration:read` and `orchestration:operate`. `T3CODE_DEV_AUTH_TOKEN` is ignored by desktop and non-development servers. — **shipped docs** [remote-access.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/remote-access.md); [environment-auth.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/environment-auth.md)
- Background service: `t3 service install` after installing the CLI (`curl -fsSL https://t3.codes/install.sh | sh`, binary in `~/.local/bin`). macOS starts at login and **stops at logout**. Windows services are not supported. `t3 serve` is the fallback. — **shipped docs** [install.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/install.md); [background-service.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/background-service.md)
- PR `#12148` “feat(desktop): let local tools reuse connected T3 environments”: `state: closed`, `merged_at: null`, `closed_at: 2026-09-19T05:15:35Z`. Close comment (juliusmarminge): not taking orchestration/provider-layer changes now because that part of the server is being rewritten for V2. — **closed PR** [PR 12148](https://github.com/pingdotgg/t3code/pull/12148); [GitHub API](https://api.github.com/repos/pingdotgg/t3code/pulls/12148)
- MCP desktop discovery requires that unmerged PR. Direct MCP mode needs `T3_URL` plus `T3_ACCESS_TOKEN` from “T3’s normal pairing/token-exchange flow.” — **shipped source** (third-party) [README](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)
- **This machine, 2026-09-23:** `which t3` / `which t3code` / `which t3code-thread-mcp` all not found. `~/.local/bin/t3` absent. No `~/Library/LaunchAgents/*t3*` login item. `/Applications/T3 Code (Nightly).app` version `0.0.43-nightly.20260922.2123`, bundle id `com.t3tools.t3code`. PID 55877 runs `.../app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3` and listens `127.0.0.1:3773`. `~/.t3/userdata/server-runtime.json` is discovery only: `{ version: 1, pid: 55877, host: "127.0.0.1", port: 3773, origin: "http://127.0.0.1:3773", startedAt: "2026-09-22T22:17:41.005Z" }` — no token keys. Well-known `serverSelfUpdate: "desktop-managed"`. — **live observation**
- `GET /api/auth/session` with no credential: HTTP 200 `{ authenticated: false, auth: { policy: "desktop-managed-local", bootstrapMethods: ["desktop-bootstrap"], sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"], sessionCookieName: "t3_session_3773" } }`. — **live observation**
- `GET /api/orchestration/shell` and `GET /api/auth/pairing-links` with no credential: HTTP 401 `EnvironmentAuthInvalidError` `reason: "missing_credential"`. `GET /mcp` unauthenticated: HTTP 401 `invalid_mcp_credential`. — **live observation**
- `desktop-settings.json` has window bounds and update-channel flag only; it does not record Network access. `settings.json` lists provider instances (cursor, antigravity enabled) with empty `apiKey` fields in the file as read. Credential stores (`clerk-tokens.json`, `secrets/`) were not read. SQLite was not opened. — **live observation**

### Inferences

- Without a fork, the companion’s path is: pair to a server that advertises `one-time-token`, exchange at `POST /oauth/token`, call HTTP with the bearer, open `/ws` with a websocket ticket. Standard scopes include operate, so “read-only companion” is a client choice, not a pairing profile.
- Against the already-running Desktop server, that token is **not** issuable to a second process: live `bootstrapMethods` omit `one-time-token`. Completing `desktop-bootstrap` requires the IPC secret on fd 3; that is not a companion API.
- Enabling Network access is a settings change, not a source fork. Docs say it restarts the app and then pairing links work. That path was not exercised (config write disallowed).
- `t3 service install` / `t3 serve` should yield `loopback-browser` + `one-time-token`. Whether the Nightly Desktop UI then attaches to that service-managed server is documented as a separate `t3 app` / Local environment concern and remains empirical.
- Native `/mcp` credentials are per-thread provider toolkit tokens. They must not be reused as environment pairing (and were not). T3 Connect is an extra hop still ending in an environment session; a same-machine companion does not need it.
- Julius’s V2-rewrite close on `#12148` is a versioning risk, not a current missing API. Pin the adapter to the connected `serverVersion` and fail closed on protocol mismatch.

### Gaps

- Enforcement that `POST /oauth/token` rejects a one-time token while the policy omits that bootstrap method was inferred from the descriptor, not from a rejected POST (pairing disallowed).
- Whether Desktop-with-Network-access and service-managed `t3 serve` can coexist on the same `~/.t3/userdata` without surprising the user was not tested.
- Cookie name `t3_session_3773` is advertised; whether another process could steal the renderer cookie was not investigated (out of documented companion flow; credential reuse disallowed).

## Which of PRD section 12’s five spike questions are already answered by source, and which remain empirical?

### Takeaway

Source plus this machine’s unauthenticated GETs answer connection **procedure**, full-text **shape**, command ids, settle-versus-completion, persona-field absence, and the current **blocked** desktop-managed-local posture. They do not answer two-harness live sequences, persona enforcement, or reconnect/rebinding against room bookkeeping. Spike 1 is no longer “unknown how to connect”; it is “user must change server mode before the spike can run.”

### Cited Findings

- PRD section 12 lists five spike questions: (1) direct authenticated connection without unexpected mutation; (2) full text/artifacts beyond the MCP 8,000-character cap; (3) provider-specific successful completion, attention states, and native turn identity on two harnesses; (4) persona instructions and enforced permission modes; (5) direct T3 activity, native compaction, server restart, and thread rebinding vs room delivery records. — [PRD.md](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Question 1, source: policies, pairing, bearer, DPoP, websocket tickets, `server.getConfig.auth`. Live: this server is `desktop-managed-local` / `desktop-bootstrap` only; shell is 401 without credentials; `t3` CLI absent. — citations in the auth section above.
- Question 2, source: message `text` has no 8k schema cap; MCP applies the slice; activity payloads and search snippets are capped; checkpoint metadata + `getTurnDiff` are the diff reads. — citations in the reads section above.
- Question 3, source: normalized state machine and `messageId` → internal `pendingMessageId` → `activeTurnId` path are shipped. Provider permission differences are user-doc level only. — [permission-modes.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/permission-modes.md)
- Question 4, source: no persona/system-prompt field on `thread.create`, `thread.meta.update`, or `thread.turn.start`. `ProviderInteractionMode` is only `default | plan`. `RuntimeMode` is the permission enum. Docs: Antigravity can still send approval requests in Full access; providers without Auto ask instead. Optional `message.context` is structured composer context (files, terminals, reviews, mentions, skill **name**), not a system prompt. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1114)
- Question 5, source: concurrent clients share the log; compaction queues later turn starts and cancels them if compaction fails; command receipts and the event log are the restart record; `thread.meta.update` can change `branch` and `worktreePath`. `ORCHESTRATION_PROTOCOL_VERSION` / live well-known `orchestrationProtocolVersion` is `1`. Overview: RPC is independently versioned with no third-party stability promise. — [overview.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/internals/overview.md)

### Inferences

- **Spike 1 — answered as procedure + blocked on this Mac.** Pair to `one-time-token`, then read `server.getConfig` and the shell. Do not dispatch until the spike is explicitly authorized. Desktop-only as currently running cannot complete pairing. User actions before the spike: install `t3` CLI; choose service-managed server **or** enable Network access; pair; do not rely on `#12148`.
- **Spike 2 — answered for message text and checkpoint metadata on this commit; empirical for a >8k live body and for real workspace diffs.** Tool-output losslessness is answered negatively on the official client path (summarized).
- **Spike 3 — remains empirical.** Source says how a normalized terminal state is recorded. It does not show two harnesses producing that state for a known prompt.
- **Spike 4 — answered negatively for a native persona field; permission mode is first-class; enforcement remains empirical.** Deliver persona as the first user-message brief (and/or repo `AGENTS.md`, which T3 reads itself). Set `thread.runtime-mode.set` separately. UI must not imply a persona string is an enforced permission mode (PRD already says this).
- **Spike 5 — partly answered.** The server will accept a UI turn on a companion thread, will queue turns across compaction, and will keep command receipts across process restart. What that does to **room** delivery cursors is a Rooms concern. Whether changing `worktreePath` via `thread.meta.update` rebases the live provider cwd was not traced.

### Gaps

- No live spike was run. Installed Nightly vs `main` `b954af60` behavioral delta beyond advertised `serverVersion` was not diffed.
- Julius’s V2 rewrite comment on `#12148` is a roadmap risk, not a current missing command.

## Is the community MCP (t3code-thread-mcp) an acceptable Phase 1 adapter, or must the companion speak HTTP/WS directly?

### Takeaway

It is **not** an acceptable Phase 1 adapter. Keep it as a reference client that already speaks HTTP dispatch. The companion must speak authenticated HTTP (and WebSocket subscriptions) itself.

### Cited Findings

- Package `t3code-thread-mcp` 0.3.0. README: direct connections tested with T3 **0.0.40 and 0.0.42**; desktop discovery requires PR `#12148`. — [README.md](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)
- Create/read/send/wait/interrupt/approval/user-input exist in global mode. `create_thread` always sends `branch: null`, `worktreePath: null`, default `runtimeMode: "approval-required"`. `send_message_to_thread` POSTs `thread.turn.start` to `/api/orchestration/dispatch`. Global tools do **not** wrap `thread.runtime-mode.set`. — [global-server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js); [global-tools.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-tools.js)
- `read_thread` 8,000-character slice; default `turnLimit` 10; paging cannot recover sliced characters. `wait_threads` uses uncorrelated `ready()` (see UI-interaction section). Caller `commandId` is hashed. — [global-server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js); [server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/server.js)
- This machine does not have `t3code-thread-mcp` on `PATH`. Direct MCP mode still needs a pairing token this Desktop server will not issue. Desktop discovery cannot work: `#12148` unmerged. — **live observation** plus **closed PR**
- Native T3 `/mcp` is a different product (in-session preview toolkit). Unauthenticated GET is 401 `invalid_mcp_credential`. — **live observation**; [McpHttpServer.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/mcp/McpHttpServer.ts)
- PRD already says: use direct authenticated connections for the no-fork path; do not treat truncated MCP reads as a complete room archive. — [PRD.md](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md) section 9

### Inferences

- Failures versus Phase 1: truncated inbound archive; wait not correlated to a Rooms run; needs-input treated as ready; settle/auto-settle in the wait cursor; hashed command ids; no later permission-mode command; default create permission `approval-required` vs T3 schema default `full-access`; version skew vs this Nightly; desktop discovery blocked.
- Speaking HTTP/WS directly is implementable without a T3 fork **once paired**. The MCP is useful as a worked example of `thread.create` then `thread.turn.start` over HTTP, not as the adapter.

### Gaps

- The README’s 0.0.40/0.0.42 test claim was not re-run. No prompt was sent.

## Does HTTP dispatch apply bootstrap.createThread, or must the companion create then start as two commands?

### Takeaway

HTTP dispatch does **not** apply `bootstrap.createThread`. Only the WebSocket dispatch path runs that pre-step. A companion using `POST /api/orchestration/dispatch` must send `thread.create` then `thread.turn.start`. Putting bootstrap only on an HTTP turn start will not create the thread; the decider `requireThread`s.

### Cited Findings

- `ClientThreadTurnStartCommand` accepts optional `bootstrap.createThread` / `prepareWorktree` / `runSetupScript`. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1279)
- `normalizeDispatchCommand` keeps bootstrap and only rewrites its `createdAt`. — **shipped source** [Normalizer.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/Normalizer.ts)
- HTTP handler: `normalizeDispatchCommand` then `orchestrationEngine.dispatch(normalizedCommand)` — no bootstrap branch. — **shipped source** [http.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/http.ts)
- WebSocket: `normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap` → `dispatchBootstrapTurnStart`, which dispatches `thread.create`, optional worktree `thread.meta.update`, then the turn; failures clean up the created thread. — **shipped source** [ws.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/ws.ts)
- Decider `thread.turn.start` `requireThread`s and does not read `command.bootstrap`. — **shipped source** [decider.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/apps/server/src/orchestration/decider.ts#L1368)
- Community MCP already uses two HTTP commands: `thread.create` then `thread.turn.start`, never bootstrap. — [global-server.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js)
- Live well-known `requiredWorktreeBootstrap: true` means **T3’s own composer** may require worktree bootstrap on this server. Rooms PRD does not create worktrees. — **live observation**; [PRD.md](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md) section 8

### Inferences

- HTTP companion: two commands, two `commandId`s (create vs start). Do not send `bootstrap.createThread` on HTTP and expect the WS pre-step.
- A companion that **does** use WebSocket may use bootstrap as the UI does, including `prepareWorktree`. Phase 1 product choice is still “agents own worktrees”; passing `worktreePath: null` on `thread.create` matches the MCP and the PRD.
- `requiredWorktreeBootstrap: true` on this Nightly is a capability flag for T3 clients, not a missing companion API. If T3 itself refuses a create with null worktree on some projects, that is empirical (spike).

### Gaps

- No live create was sent, so acceptance of two-step HTTP on this Nightly is from contracts + advertised protocol version, not a dispatch receipt.
- Whether some other layer still applies bootstrap on HTTP was not found; the HTTP handler shown calls the engine directly.

## Is the t3 CLI installed? Is T3 Code Nightly running? What does GET /.well-known/t3/environment and GET /api/auth/session return without credentials?

### Takeaway

The `t3` / `t3code` CLIs are **not** installed. T3 Code Nightly **is** running (embedded server on loopback 3773, desktop-managed). Unauthenticated well-known returns the environment descriptor including `serverVersion` `0.0.43-nightly.20260922.2123`. Unauthenticated session returns `authenticated: false` and policy `desktop-managed-local` with only `desktop-bootstrap`.

### Cited Findings

- `which t3` → not found; `which t3code` → not found; `~/.local/bin/t3` absent. Install docs put `t3` in `~/.local/bin` via `curl -fsSL https://t3.codes/install.sh | sh`. `PATH` includes `~/.local/bin` but no binary is there. No LaunchAgent `*t3*`. — **live observation**; **shipped docs** [install.md](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/docs/user/install.md)
- App: `/Applications/T3 Code (Nightly).app`, `CFBundleShortVersionString` / `CFBundleVersion` `0.0.43-nightly.20260922.2123`, `CFBundleIdentifier` `com.t3tools.t3code`. Process: PID 55877 `.../T3 Code (Nightly) .../apps/server/dist/bin.mjs --bootstrap-fd 3`. `lsof`: `127.0.0.1:3773` LISTEN by that PID. Renderer/GPU/helpers also running since 6:17 AM. — **live observation**
- `GET http://127.0.0.1:3773/.well-known/t3/environment` HTTP 200 JSON (2026-09-23): `environmentId` `76de14c2-5db7-405a-b0a6-d87964041ed6`, `label` “the owner’s MacBook Pro”, `platform` darwin/arm64/laptop, `serverVersion` `0.0.43-nightly.20260922.2123`, `orchestrationProtocolVersion` 1. Capabilities include `inlineMessageContext`, `requiredWorktreeBootstrap`, `threadSettlement`, `threadAutoSettlement`, `threadRestartContinuation`, `serverSelfUpdate: "desktop-managed"`, `agentActivityPublishing: false`. CORS `access-control-allow-origin: *`. — **live observation**
- `GET http://127.0.0.1:3773/api/auth/session` HTTP 200 JSON: `authenticated: false`; `auth.policy` `desktop-managed-local`; `bootstrapMethods` `["desktop-bootstrap"]`; `sessionMethods` `["browser-session-cookie","bearer-access-token","dpop-access-token"]`; `sessionCookieName` `t3_session_3773`. — **live observation**
- `GET /api/orchestration/shell` HTTP 401 `missing_credential`. `GET /api/auth/pairing-links` HTTP 401 `missing_credential`. `GET /mcp` HTTP 401 `invalid_mcp_credential`. `GET /api/orchestration/dispatch` (GET, not POST) returned the SPA HTML shell (unrelated catch-all). — **live observation**
- `~/.t3/userdata/server-runtime.json` matches the listener (`pid` 55877, `127.0.0.1:3773`) and contains no token fields. — **live observation**

### Inferences

- The adapter spike cannot authenticate against the currently running server without a user-visible policy change. Read-only discovery (well-known + session) already works and is enough to detect the blocker at startup: if `bootstrapMethods` lacks `one-time-token`, refuse to proceed.
- Installing the CLI is a prerequisite for the documented service-managed path (`t3 service install`, `t3 pair`, `t3 serve`). Nightly Desktop does not put `t3` on `PATH`.
- Pin the companion to live `serverVersion` and `orchestrationProtocolVersion`. Latest GitHub non-prerelease was previously reported as `v0.0.42` (2026-09-16); this machine runs a 2026-09-22 nightly. `main` HEAD at research time was `b954af60` (web usage test, 2026-09-23), newer than the installed nightly.

### Gaps

- GitHub `/releases/latest` was not re-fetched this pass; the 0.0.42 latest-stable claim is from earlier same-day notes, not this live check.
- Whether `npx t3@latest` would start a **second** server against the same userdata (conflict with Nightly) was not tried.

## Adapter implementability without modifying T3 (folded conclusion)

### Takeaway

No missing command forces a T3 fork. The fork-shaped hole is **auth policy on the running Desktop server**, which the user can change with documented settings/CLI rather than a patch. Do not treat closed PRs as the path.

### Cited Findings

- All Phase 1 control operations exist on `ClientOrchestrationCommand` and HTTP/WS as cited above. Full-text reads exist on the official per-thread GET. Command-id receipts exist. Completion is reconstructable from session/`latestTurn`/activities, not from `thread.settled`. — **shipped source** (sections above)
- Missing native persona field is a product mapping (first-turn brief), not a fork requirement. — **shipped source** [orchestration.ts](https://github.com/pingdotgg/t3code/blob/b954af60c402ff0698f9f2d9a214695e817f07fe/packages/contracts/src/orchestration.ts#L1114)
- `#12148` (local tools reuse desktop connections), `#12457`, `#9181`: closed, `merged_at` null for `#12148`. Julius: V2 rewrite of orchestration/provider layers. — **closed PR** [PR 12148](https://github.com/pingdotgg/t3code/pull/12148)
- Live policy blocks pairing. — **live observation** `GET /api/auth/session`

### Inferences

**User must do before an adapter spike (ordered):**

1. Install the `t3` CLI (`curl -fsSL https://t3.codes/install.sh | sh`, ensure `~/.local/bin` on `PATH`). Optionally `T3CODE_CHANNEL=nightly` to match this app train.
2. Choose one pairing-capable mode (do not do both blindly on first try):
   - **Preferred for a same-machine companion:** `t3 serve` or `t3 service install` so policy becomes `loopback-browser` with `one-time-token`. Confirm Desktop “Local environment” coexistence empirically in the spike. macOS service **stops at logout**.
   - **Keep using the Desktop app as the server:** Settings → Connections → enable **Network access** (docs: restarts the app; exposes beyond loopback — pair with Tailscale if needed). Then create a pairing link. Policy should become `remote-reachable` with `one-time-token` plus `desktop-bootstrap`.
3. Pair once (`t3 pair` or the pairing URL). Exchange at `POST /oauth/token`. Store the bearer **in the companion service**, never in the browser bundle.
4. Confirm `GET /api/auth/session` with the bearer shows `authenticated: true` and `GET /api/orchestration/shell` returns projects/threads. Then — and only then — run the isolated spike: create thread, start one turn, observe terminal sequence, interrupt, answer one approval, read a message longer than 8,000 characters. Do not key completion on `thread.settled` or on session leaving `running` without `turnId` correlation.
5. Do **not**: fork T3; wait for `#12148`; use native `/mcp` provider credentials; treat t3code-thread-mcp as the adapter; dispatch against the current `desktop-managed-local` server hoping bootstrap will work.

### Gaps

- Which of (service-managed vs Network access) is least surprising for this user’s Desktop workflow remains a user choice plus a short coexistence check in the spike.
- Two-harness completion/attention sequences remain empirical after pairing.
