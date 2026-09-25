# T3 no-fork companion connection path

Reviewed 2026-09-23. Scope is whether a local companion can drive an already-installed T3 Code server without forking T3, using official HTTP/RPC or [t3code-thread-mcp](https://github.com/samdickson22/t3code-thread-mcp). Herdr stays rejected as the execution backend. The only coexistence note used here is that both apps can be installed on one machine without sharing a live agent. [HERDR_ASSESSMENT.md](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md) lines 91–93.

Local evidence is read-only. No session was started, no prompt was sent, and no T3 config was written. Two GETs were issued against the already-listening server: `/.well-known/t3/environment` and `/api/auth/session`.

## What operations does t3code-thread-mcp expose, and is the 8,000-character cap still true?

### Takeaway
Package `t3code-thread-mcp` 0.3.0 (commit `391b9a783c3e62dfa3ca948b4835efb3473d6ab4`, committed 2026-09-16T22:11:31Z) still slices every returned message to 8,000 characters and sets `truncated: true` when the source is longer. It can create, read, send, wait, interrupt, and manage threads, and it always sends `worktreePath: null` on create.

### Cited Findings
- README line 7 states direct connections were tested with released T3 0.0.40 and 0.0.42. README line 104 states `read_thread` caps message text at 8,000 characters and indicates truncation. README line 140 states creating a thread does not create a worktree, and archived history is withheld until the thread is restored. [README.md at 391b9a78](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)
- `package.json` on that commit names the package `t3code-thread-mcp`, version `0.3.0`, description “MCP tools for persistent T3 Code threads over its existing HTTP API”. [package.json](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/package.json)
- Legacy `src/tools.json` exposes seven tools: `create_thread`, `list_threads`, `read_thread`, `send_message_to_thread`, `wait_threads`, `set_thread_settled`, `interrupt_thread`. Its `read_thread` description says tool output and attachments are omitted and message text is capped at 8000 characters. `turnLimit` is an integer from 1 to 100. `create_thread` says it does not create a worktree. [tools.json](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/tools.json)
- Global mode adds `list_environments`, `list_projects`, `list_providers`, `list_archived_threads`, `set_thread_title`, `set_thread_archived`, `set_thread_pinned`, `set_thread_snoozed`, `delete_thread`, `stop_thread_session`, `respond_to_approval`, `respond_to_user_input`, `dismiss_user_input`, and `create_project`. `create_thread` accepts `runtimeMode` of `approval-required`, `auto-accept-edits`, `auto`, or `full-access`, and `interactionMode` of `default` or `plan`. Its description says the default permission mode is approval-required. [global-tools.js lines 52–65 and 82–208](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-tools.js)
- Global `read_thread` maps messages with `text: m.text.slice(0, 8000)` and `truncated: m.text.length > 8000`. The same slice is in legacy `server.js` lines 200–205. [global-server.js lines 301–306](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-server.js)
- That read requests `turnLimit` defaulting to 10 (`global-server.js` lines 68–71). If the thread is archived it throws before the read: “T3 does not expose archived history…” (lines 264–267). Activities kept are the last 50, plus any `approval.requested` or `user-input.requested`; payloads are copied only for those two kinds (lines 308–322).
- `create_thread` dispatches `thread.create` with `branch: null` and `worktreePath: null`, and `runtimeMode: input.runtimeMode ?? "approval-required"` (lines 354–367). `send_message_to_thread` dispatches `thread.turn.start` with `role: "user"`, `attachments: []`, and `text` equal to an optional source prefix plus `input.message`, with no character slice on the outbound text (lines 372–393). Dispatch posts `{ ...command, commandId }` to `/api/orchestration/dispatch` (lines 458–461).
- Direct HTTP uses `authorization: Bearer ${env.token}` (`global-server.js` lines 40–47). Loopback HTTP is allowed only for `localhost`, `127.0.0.1`, and `[::1]` (lines 26–37).

### Inferences
- The PRD section 9 claims match this commit: create/read/send/wait exist, the 8,000-character read cap is still in source, worktrees are not created, and truncation is explicitly flagged. [PRD.md lines 360–366](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Paging with `beforeCursor` can retrieve older turns. It does not recover the characters removed by `slice(0, 8000)`.
- Outbound briefs are not truncated by the MCP. The loss is on the way back in.

### Gaps
- The README’s test claim was not re-run against a live T3. No prompt was sent.
- Server-side idempotency of a repeated `commandId` was not read in the decider. The HTTP success body defined by the contract is only `{ sequence }`. [orchestration.ts lines 2239–2241 at nightly tag](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/orchestration.ts)

## Does official T3 HTTP expose a full-text read that avoids that cap?

### Takeaway
Yes. On tag `v0.0.43-nightly.20260922.2123`, `GET /api/orchestration/threads/:threadId` with `turnLimit` omitted returns every stored message row for that thread, and the SQL selects the `text` column with no character limit. The 8,000-character cap is applied only inside the MCP after that response arrives.

### Cited Findings
- The contract comment says both `turnLimit` and `beforeCursor` are optional and “omitting them keeps the full-snapshot behavior, so pagination stays opt-in.” The route is `GET /api/orchestration/threads/:threadId`, success type `OrchestrationThreadDetailSnapshot`, behind `EnvironmentAuthenticatedAuth`. [environmentHttp.ts lines 497–530 on that tag](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/environmentHttp.ts). The same comment is on tag `v0.0.42` around line 498.
- The handler passes `undefined` as the window when `turnLimit` is omitted, then returns `projectThreadDetailSnapshot`. The environment-wide `GET /api/orchestration/snapshot` is different: its comment says it serves a lightweight read model with thread bodies empty because hydrating every message has OOM-killed servers. [http.ts lines 37–41 and 66–94](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/http.ts)
- `getThreadDetailSnapshot` documents that without a window the full thread is returned and pagination is opt-in. [ProjectionSnapshotQuery.ts lines 267–286](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts). The implementation takes that branch when `window?.turnLimit === undefined` and calls `getThreadDetailByIdBounded(threadId, undefined, …)`. [Layers/ProjectionSnapshotQuery.ts lines 3626–3647](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)
- When bounds are undefined, messages come from `listThreadMessageRowsByThread`, whose SQL is `SELECT … text … FROM projection_thread_messages WHERE thread_id = ${threadId} ORDER BY created_at ASC, message_id ASC` with no `LIMIT` and no substring. [same file lines 1354–1373 and 3477–3479](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)
- `OrchestrationMessage.text` is `Schema.String` with no max-length check. Roles include `user`, `assistant`, `system`, and `reasoning`. [orchestration.ts lines 566–584](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/orchestration.ts)
- A separate in-memory fold keeps only the last 2,000 messages (`MAX_THREAD_MESSAGES = 2_000`, then `messages.slice(-MAX_THREAD_MESSAGES)`). [projector.ts lines 59 and 801](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/projector.ts). A search of the official repo for `MAX_THREAD_MESSAGES` on grep.app hit `projector.ts` only, not the SQL snapshot query. [grep.app search](https://grep.app/search?q=MAX_THREAD_MESSAGES&filter[repo.repository][0]=pingdotgg/t3code)
- Activity reads are not full tool logs. Detail SQL keeps the latest 500 activities (`THREAD_DETAIL_ACTIVITY_LIMIT = 500`). [Layers/ProjectionSnapshotQuery.ts lines 94–97 and 1449](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts). `projectRawOutput` replaces tool `content`, `stdout`, and `stderr` with `summarizeToolTextOutput`, which returns one trimmed line of at most 84 characters, or a “N lines” count. [ActivityPayloadProjection.ts lines 164–178 and 362–397](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/ActivityPayloadProjection.ts)
- Active-thread lookup used by this detail read requires `archived_at IS NULL`. [Layers/ProjectionSnapshotQuery.ts lines 1306–1308](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts)

### Inferences
- A companion that calls the per-thread GET itself, omits `turnLimit`, and stores `message.text` avoids the MCP cap. Calling `GET /api/orchestration/snapshot` does not; that route is documented to omit thread bodies.
- Visible assistant and user text is the full-fidelity field. Tool stdout in activity payloads is summarized on the official path as well, so it is not a lossless artifact archive.
- The 2,000-message in-memory cap was not found on the HTTP detail SQL. Oldest messages can still be absent if some other writer deletes them; that writer was not found in the files read.

### Gaps
- No live thread was fetched, so full-text behavior is from source, not from a response body on this machine.
- Whether projection maintenance deletes `projection_thread_messages` rows older than 2,000 was not confirmed. The constant is not referenced in `Layers/ProjectionSnapshotQuery.ts` on this tag.
- Attachment bytes versus attachment metadata on `OrchestrationMessage.attachments` were not traced. The MCP drops attachments entirely.

## What auth does a direct connection need, and can a separate macOS process get it without a T3 fork?

### Takeaway
Direct calls need a bearer access token, a browser session cookie, or a DPoP token. The desktop server already running on this Mac advertises policy `desktop-managed-local` and accepts only `desktop-bootstrap` to establish that session. A separate process cannot complete the documented pairing exchange against that policy. Obtaining a token without forking T3 requires a user setting change that the docs say restarts the app, or a bridge that is not in this build.

### Cited Findings
- Session methods are `browser-session-cookie`, `bearer-access-token`, and `dpop-access-token`. Bootstrap methods are `desktop-bootstrap` (“a trusted local desktop handoff, used so the desktop shell can pair the renderer without a login screen”) and `one-time-token` (“a short-lived pairing token”). Token exchange is `POST /oauth/token` with grant type `urn:ietf:params:oauth:grant-type:token-exchange` and subject token type `urn:t3:params:oauth:token-type:environment-bootstrap`. [auth.ts lines 42–76 and 117–204](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/auth.ts); exchange route [environmentHttp.ts lines 432–438](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/environmentHttp.ts)
- `EnvironmentAuthPolicy` sets `desktop-managed-local` when `config.mode === "desktop"` and the host is not remote-reachable. That policy’s `bootstrapMethods` are only `["desktop-bootstrap"]`. Remote-reachable desktop mode is `["desktop-bootstrap", "one-time-token"]`. Non-desktop loopback is `loopback-browser` with `["one-time-token"]`. [EnvironmentAuthPolicy.ts lines 23–42](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/apps/server/src/auth/EnvironmentAuthPolicy.ts)
- The desktop bootstrap payload includes `desktopBootstrapToken` and is the handoff the desktop uses when it launches the backend. [desktopBootstrap.ts](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/desktopBootstrap.ts)
- User docs: on a desktop host, enable **Network access** under Settings → Connections, then create a pairing link. “Changing network access restarts the desktop app.” Command-line hosts use `t3 serve --host <private-ip>` and `t3 pair`. A loopback address reaches only the device opening the link. [remote-access.md lines 33–60](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/docs/user/remote-access.md)
- MCP README lines 31 and 43: desktop discovery is the default and requires [PR 12148](https://github.com/pingdotgg/t3code/pull/12148). Direct mode needs `T3_URL` plus `T3_ACCESS_TOKEN` from “T3’s normal pairing/token-exchange flow.” [README](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)
- PR 12148, “feat(desktop): let local tools reuse connected T3 environments,” is `state: closed`, `merged_at: null`, `closed_at: 2026-09-19T05:15:35Z`. [PR 12148](https://github.com/pingdotgg/t3code/pull/12148)
- The shipped local activation contract on current main is only `type: "open-workspace"`. It returns a `projectId` and `threadId`. It is not a general command bridge. [desktopAppActivation.ts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/desktopAppActivation.ts)
- MCP desktop mode connects to a Unix socket and sends `{ version: 1, type: "connection", operation }`. If the socket is missing it tells the caller to open a bridge-enabled app or use direct configuration. It states it never reads T3’s credential store. [desktop.js lines 9–14 and 42–80](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/desktop.js)
- This machine: `which t3` and `which t3code` found nothing. `/Applications/T3 Code (Nightly).app` `CFBundleShortVersionString` and `CFBundleVersion` are `0.0.43-nightly.20260922.2123`, bundle id `com.t3tools.t3code`. PID 55877 is that app executing `Contents/Resources/app.asar/apps/server/dist/bin.mjs --bootstrap-fd 3`, listening on `127.0.0.1:3773`. A string scan of `app.asar` found `open-workspace` (5) and `desktop-bootstrap` (14). `listEnvironments` hits were the managed-relay HTTP client (`/v1/environments`), not the MCP connection operation. The phrase “connection bridge” did not match.
- `GET http://127.0.0.1:3773/.well-known/t3/environment` on 2026-09-23 returned HTTP 200 with `serverVersion` `0.0.43-nightly.20260922.2123`, `orchestrationProtocolVersion` 1, and `inlineMessageContext: true`. `GET /api/auth/session` with no credential returned HTTP 200: `authenticated: false`, `policy: "desktop-managed-local"`, `bootstrapMethods: ["desktop-bootstrap"]`, `sessionMethods` the three methods above, `sessionCookieName: "t3_session_3773"`.

### Inferences
- The no-fork protocol path is direct HTTP with a bearer token, as the PRD says. Against this already-running desktop server, that token is not issued to a second process: the live bootstrap list does not include `one-time-token`.
- Enabling Network access is a settings change, not a source fork. The docs say it restarts the desktop app and then pairing links work. That path was not exercised, and this research was not allowed to change config.
- Desktop discovery cannot drive this install. PR 12148 is unmerged, and the installed app does not show the bridge the MCP calls.
- `t3 pair` is not available here because no `t3` binary is on `PATH`. The listening server is the Nightly app’s own backend.

### Gaps
- No pairing POST or cookie read was attempted. Whether the renderer’s `t3_session_3773` cookie is stored where another process could reuse it was not investigated; that would be outside the documented companion flow.
- Enforcement that `POST /oauth/token` rejects a one-time token while the policy omits that bootstrap method was inferred from the policy descriptor and the live session document, not from a rejected request.

## What T3 versions are current versus the versions the MCP README tested?

### Takeaway
GitHub’s latest non-prerelease release is `v0.0.42`, published 2026-09-16T04:59:02Z. The newest nightly seen in the releases API, and the app installed on this Mac, is `0.0.43-nightly.20260922.2123`, published 2026-09-22T21:59:17Z. The MCP README’s stated test versions are 0.0.40 (published 2026-09-08T00:02:00Z) and 0.0.42. It does not claim a test against 0.0.43 nightly.

### Cited Findings
- `GET /repos/pingdotgg/t3code/releases/latest` returned tag `v0.0.42`, `prerelease: false`, `published_at: 2026-09-16T04:59:02Z`. [v0.0.42](https://github.com/pingdotgg/t3code/releases/tag/v0.0.42)
- Tag `v0.0.40` exists, `prerelease: false`, `published_at: 2026-09-08T00:02:00Z`. [v0.0.40](https://github.com/pingdotgg/t3code/releases/tag/v0.0.40)
- The first page of `GET /repos/pingdotgg/t3code/releases?per_page=15` on 2026-09-23 starts with `v0.0.43-nightly.20260922.2123`, name “T3 Code Nightly 0.0.43-nightly.20260922.2123 (d7819c18813f)”, `prerelease: true`, `published_at: 2026-09-22T21:59:17Z`. [releases](https://github.com/pingdotgg/t3code/releases)
- README line 7 names only 0.0.40 and 0.0.42. [README](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/README.md)
- The installed bundle version and the live `serverVersion` are both `0.0.43-nightly.20260922.2123`, one nightly newer than the stable release the MCP says it tested, and newer than the MCP commit date 2026-09-16.
- The thread-snapshot “full snapshot when `turnLimit` is omitted” comment and the `RuntimeMode` literals are present on both `v0.0.42` and `v0.0.43-nightly.20260922.2123`. Nightly `ThreadCreateCommand` is lines 1114–1129, with required `runtimeMode` and nullable `worktreePath`, and no `systemPrompt` string anywhere in that file.

### Inferences
- Version skew is real for this machine: the running server is a 0.0.43 nightly from 2026-09-22; the MCP’s published test statement stops at 0.0.42. The HTTP routes the companion needs are still present on the nightly tag, which is necessary but not a substitute for the MCP’s own live test.
- Pin the companion to the connected `serverVersion`. The PRD already says these HTTP contracts are application interfaces, not a stable third-party protocol. [PRD.md lines 364–366](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

### Gaps
- The releases list was the first 15 entries plus `/releases/latest`. A stable release newer than 0.0.42 was not in that latest-release endpoint. A stable 0.0.43 was not found.
- Behavioral differences between 0.0.42 and this nightly, beyond the contracts cited above, were not diffed.

## Would Phase 1 context delivery fail if the companion can only see truncated messages?

### Takeaway
Yes, for any participant reply longer than 8,000 characters, if `read_thread` is the only history source. Phase 1 requires those originals to stay retrievable. The MCP flags truncation and does not return the rest. The companion can still meet that bar by storing its own outbound briefs and reading inbound `message.text` from the official per-thread snapshot.

### Cited Findings
- Phase 1 includes a shared timeline, named participants, preserved room notes, a persistent queue, and context delivery. Acceptance for context: “Earlier unseen decisions survive multiple sibling replies; long-message truncation is surfaced and originals remain retrievable.” Open question 2 is to verify full-text/history above the MCP’s 8,000-character cap before implementation is ready. [PRD.md lines 383–393, 419, and 441–444](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The shared-context contract says to preserve every unseen visible message while it fits the delivery budget. If history exceeds the budget, show that condensation occurred, retain source references, and provide access to originals. The exact briefing is saved before send. [PRD.md lines 337–346](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- MCP `read_thread` sets `truncated` and drops the tail (`global-server.js` lines 301–306). No other MCP tool takes a message id and returns the unsliced text. `tools.json` also omits tool output and attachments.
- Official per-thread GET selects full `text` when `turnLimit` is omitted, as cited in the HTTP section above.
- Default MCP reads also pass `turnLimit=10` (`global-server.js` lines 68–71). Turns outside that page are absent until the caller pages. That omission is separate from the character cap.

### Inferences
- Short replies can be delivered through the MCP. The acceptance line fails when a reply is longer than 8,000 characters and the room archive was filled only from `read_thread`, because the flag is not the original.
- Outbound room briefs are not lost if the companion saves them before `thread.turn.start`, which the PRD already requires. The hole is inbound native replies and any direct T3 activity the companion must observe.
- Treating the MCP transcript as the room archive would also drop attachment contents and tool results. Artifact paths that agents write only inside tool output are not recovered from either the MCP or the summarized activity payload.

### Gaps
- No message longer than 8,000 characters was read from the local server, so the failure mode is from the slice in source plus the PRD criterion, not from a captured truncated payload.
- How large a “delivery budget” Phase 1 will use is a product choice. The PRD allows condensation when that budget is exceeded, and still requires originals to remain retrievable.

## Are persona injection and permission-mode control available?

### Takeaway
Permission mode is a first-class field on both surfaces. A persona or system instruction is not a field on `thread.create` or `thread.turn.start`. The client turn command only accepts a user-role message. A persona brief can be sent as that user text, or as composer context, not as a harness system prompt through these commands.

### Cited Findings
- Nightly `RuntimeMode` is `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. The schema decoding default `DEFAULT_RUNTIME_MODE` is `full-access`. `ProviderInteractionMode` is `default` or `plan`. [orchestration.ts lines 128–138](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/orchestration.ts)
- `ThreadCreateCommand` requires `runtimeMode` and has no system-prompt field. `worktreePath` is nullable. [lines 1114–1129](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/orchestration.ts). `thread.runtime-mode.set` and `thread.interaction-mode.set` exist as later commands (lines 1263–1277).
- HTTP dispatch uses `ClientOrchestrationCommand`, whose turn command is `ClientThreadTurnStartCommand`: `message.role` is only `"user"`, `message.text` is `Schema.String`, and `runtimeMode` is required with no decoding default (lines 1328–1346). The internal `ThreadTurnStartCommand` does default `runtimeMode` to `full-access` (lines 1306–1326). A search of this file found no `systemPrompt` or `persona`.
- MCP `create_thread` sends `runtimeMode` defaulting to `approval-required`, not the contract’s `full-access` default (`global-server.js` lines 362–363). `send_message_to_thread` copies `t.runtimeMode` and `t.interactionMode` and does not take a new mode (lines 387–388). Global tools do not include `thread.runtime-mode.set`. There is no persona argument on `create_thread` or `send_message_to_thread`. [global-tools.js](https://github.com/samdickson22/t3code-thread-mcp/blob/391b9a783c3e62dfa3ca948b4835efb3473d6ab4/src/global-tools.js)
- Optional `context` on the user message is `OrchestrationMessageContext`: version 1 and at most 200 records, serialized to at most 16,000,000 characters. Record kinds include files, terminals, reviews, mentions, and `skill` (a name of at most 255 characters). The comment calls this “structured context riding on a user message,” not a system prompt. [composerContext.ts lines 211–216 and 257–281](https://github.com/pingdotgg/t3code/blob/v0.0.43-nightly.20260922.2123/packages/contracts/src/composerContext.ts). The live server reports `inlineMessageContext: true`.
- The installed `app.asar` contains `systemPrompt` strings next to provider `initConfig`. Those strings are not fields on the orchestration commands above.

### Inferences
- Phase 1 “optional persona briefs” can be the first user message the companion sends, which both the MCP and raw `thread.turn.start` will carry in full on the way out. That is user text inside the native transcript, not a hidden system role. [PRD.md lines 387 and 446](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Permission mode is available at create time on both surfaces. Changing it later is on the official command `thread.runtime-mode.set`, which the MCP does not wrap. A companion using HTTP directly can dispatch that command.
- If the companion omits `runtimeMode` on the client turn schema, dispatch validation should fail. The MCP avoids that by always sending the thread’s current mode. The contract default `full-access` applies to the internal command schema, not to the client command the HTTP route publishes.

### Gaps
- Provider-level custom instructions outside `ClientOrchestrationCommand` were not fully traced. The `systemPrompt` strings in the app bundle were not mapped to an HTTP route a companion can call.
- Whether a stored `role: "system"` message can be created by any command other than `thread.turn.start` was not confirmed. The turn command the companion would use cannot set that role.
- No live create or mode change was sent, so acceptance of these enums by the running 0.0.43 nightly is from the contract and the advertised `serverVersion`, not from a dispatch receipt.
