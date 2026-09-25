# Herdr fit for the shared-room product

Reviewed: 2026-09-22. The agent's research was a documentation/source review. The user subsequently tried Herdr and reported the outcome below; the agent did not reproduce or diagnose that installation.

## Assessment

The user tried Herdr, disliked the experience, and reported that it could not find the agent harnesses. **Keep T3 as the execution backend for this project.** A terminal interface itself remains acceptable to the user; this is feedback on Herdr's practical fit. No version, logs, or root cause were established, and the trial does not establish whether Synapse works in that environment.

The source review below remains useful reference material. Herdr plus Synapse has relevant collaboration features, but it is not part of the selected implementation path and no further Herdr trial is required before proceeding with T3 Rooms.

## What “agent cockpit” means here

Herdr groups real terminal panes into tabs and project workspaces and tracks the agents running in those panes. A background server retains the processes when a client detaches. Machine/server restart is a different case: it restores saved layout and can resume supported native sessions, rather than keeping dead processes alive. The current stable release inspected was **v0.9.1**, published September 16, 2026. [Herdr](https://herdr.dev/), [release](https://github.com/herdrdev/herdr/releases/tag/v0.9.1), [README](https://github.com/herdrdev/herdr/blob/master/README.md).

Herdr's CLI can name, start, prompt, read, and wait for agents. Names identify live agent processes and can disappear when those processes exit; a durable participant identity needs another layer. Crucially, its documented prompt/wait behavior does not track individual turns. Prompting an already-working agent and waiting can finish on the old active turn. A status change therefore cannot by itself prove completion of a particular queued assignment. [Agent automation](https://herdr.dev/docs/agent-automation/).

For Claude Code, Codex, and Cursor, Herdr's documented lifecycle authority is screen detection; other integrations can provide lifecycle hooks. Native session-identity integration is distinct from reliable task-success reporting. [Agent detection](https://herdr.dev/docs/agents/).

## The relevant plugin: Herdr Synapse

The inspected Synapse source is version **0.18.0**, commit `8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f` from September 19. Its manifest targets macOS/Linux and requires Herdr 0.8.2 or later. It provides a team console, compose popup, roster management, and a background notifier through Herdr's plugin system. [Manifest](https://github.com/vitalysim/herdr-synapse/blob/8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f/herdr-plugin.toml).

The console accepts `@name`, role addressing, team broadcasts, replies, and file references. It has completion menus and direct controls for teams and delivery. This is a genuine shared board, not merely a pane layout. Separate members can use the same harness; their conversation identities are tracked independently. A manager agent is optional. The author reports live core-workflow validation with Claude Code, Codex, OpenCode, and Pi; other harnesses have conditional/unverified support. [README and compatibility matrix](https://github.com/vitalysim/herdr-synapse), [command reference](https://github.com/vitalysim/herdr-synapse/blob/main/docs/reference.md).

## Requirement comparison

| Our requirement | Herdr alone | Herdr + Synapse |
| --- | --- | --- |
| Multiple harnesses and same-model sessions | Agent panes | Named team members over those panes |
| Project-level organization | Workspaces/tabs | Team board associated with a space/project |
| Shared composer and attributed messages | No room composer identified | Team console with mentions, roles, broadcasts, and replies |
| Persistent participant identity | Live aliases are limited | Roster associates members with native conversations |
| Parallel work | Independent panes | Directed posts and broadcasts to independent members |
| Hold messages while recipient works | Scriptable agent-state observation | Notifier holds delivery until recipient eligibility checks pass |
| Release a review after a specific other task | No task-turn guarantee | No prerequisite-task graph found in inspected source |
| Full native outputs shared automatically | Terminal reads, not a merged transcript | Board posts and harness-specific catch-up; not full transcript mirroring |
| Manual operations without Jev | CLI and terminal UI | Console, menus, shortcuts, and CLI; no Jev requirement |
| Agent-owned worktree decisions | Terminal processes can manage their work | No requirement to allocate one worktree per member identified |
| Existing T3 desktop/web room experience | Different terminal-based interface | Still a terminal-based plugin interface |

The comparison is a synthesis of the cited docs and inspected implementation, not a live interoperability test.

## Two consequential gaps

### Delivery eligibility is not a prerequisite graph

Synapse pending records identify a recipient and unread board sequences. Delivery gates inspect that recipient's identity, idle/stable state, dialogs, draft input, focus, and throttling. They do not represent edges such as “release task B after task A succeeds.” Source searches for prerequisite/dependency-task fields found no such implementation in the examined command, daemon, and gate code. [Pending records](https://github.com/vitalysim/herdr-synapse/blob/8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f/herdr_team/daemon.py), [delivery gates](https://github.com/vitalysim/herdr-synapse/blob/8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f/herdr_team/gate.py).

If sol1 is busy and sol2 is idle, a post addressed to sol2 can be delivered before sol1 finishes. Natural-language “wait for sol1” inside that post leaves the waiting logic with the agent. A direct handoff from sol1 to sol2 after finishing is another practical workflow, but it is not the deterministic room-owned queue specified in our PRD.

### Board context is not every native reply

For most harnesses, the notifier sends a short instruction to read new board posts. The agent reads the board, acts, and is expected to post back. `board --new` defaults to unread posts addressed to the member or everyone. Broader reads are possible, but complete shared knowledge is not automatic. [Nudge implementation](https://github.com/vitalysim/herdr-synapse/blob/8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f/herdr_team/nudge.py), [board selection](https://github.com/vitalysim/herdr-synapse/blob/8bf13ee5339e6ba44dfa4176842dd6a6b5c5949f/herdr_team/cmd_board.py).

Claude has additional prompt/stop hooks; Codex and other supported paths use notifier delivery and agent-side board reads. This is useful context sharing, but does not establish that every final answer shown in a native pane is copied into the common room. Our “all unseen visible replies” requirement would need adaptation or additional capture.

## Extension and operational implications

Herdr has an actual plugin API with actions, event hooks, and terminal panes. A scheduler or room extension can be packaged without forking Herdr. Plugin UI is terminal-based, and plugins own their durable files/database; a T3-like web interface remains separate work. [Plugin documentation](https://herdr.dev/docs/plugins/).

One concrete default matters before a trial: Synapse launches supported agents with unrestricted flags by default. Its `native` permission policy preserves the harness's own configuration instead. This is a documented behavior, not a hypothetical concern or a claim that `native` guarantees a sandbox. [Permissions documentation](https://github.com/vitalysim/herdr-synapse#launch-permissions-yolo-by-default).

Other plugins exist. Cadence uses a conversational Lead and fleet, while ORC uses a dedicated coordinator and structured worker outcomes. These are different from the requested user-directed room. Dagr visualizes task graphs but explicitly does not schedule them. None was validated as a combined replacement for Synapse plus our queue. [Cadence](https://github.com/zhenyufu/herdr-cadence), [ORC](https://github.com/tamdogood/herdr-orc), [Dagr contract](https://github.com/aemrebarut/herdr-dagr/blob/main/CONTRACT.md).

## Earlier evaluation proposal

The research originally proposed a small Herdr + Synapse workflow: two same-model members, one independent reviewer, attributed board replies, and an implementation-to-review handoff. The user's trial outcome supersedes that recommendation for this project.

Continue with the T3 companion direction and retain Synapse as reference material for named members, board delivery, and read cursors. The room still owns its own shared-context contract and deterministic task dependencies.

Neither option requires Jev for explicit addressing, board delivery, or programmed task dependencies. A model is needed only if we choose to infer unspecified actions or prerequisites from unrestricted language.

## Review of the second assessment

The supplied assessment correctly identifies T3's advantage in normalized messages and the weaknesses of inferring agent status from terminal output. Its conclusion nevertheless relies on several overstatements.

### A wait primitive does not replace the scheduler

Herdr's `agent.wait` is useful for observing lifecycle state. It does not supply our persistent task graph, dependency validation, per-attempt correlation, edited/cancelled tasks, or restart-safe dispatch outbox. Its own documentation says it does not track individual turns, and a wait on an already working agent can be satisfied by that pre-existing turn. It is an observation primitive the scheduler can use, not section 6 of the PRD implemented as one call. [Official wait semantics](https://herdr.dev/docs/agent-automation/#choose-the-control-surface).

### T3's `thread.settled` is not a task-success receipt either

The inspected T3 decider emits `thread.settled` for both `thread.settle` and `thread.auto-settle`. Its policy permits automatic settlement based on inactivity or pull-request state; the event is not synonymous with successful completion of the turn we submitted. Our adapter needs the actual correlated turn lifecycle and outcome. The relevant client subscription names in the inspected contract are `orchestration.subscribeThread` and `orchestration.subscribeShell`, not a generic public `event.subscribe`. [Decider](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/decider.ts), [settlement policy](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/orchestration/ThreadSettlementPolicy.ts), [contracts](https://github.com/pingdotgg/t3code/blob/main/packages/contracts/src/orchestration.ts).

### Structured context is possible above a terminal runtime

Herdr's generic `agent read` returns terminal text. That is a limitation of that read surface, not a proof that every layer above Herdr must scrape its conversation data. Synapse already persists structured board records, attribution, replies, and read cursors; its context features also consult native session data for supported harnesses. An adapter could read native transcripts or receive explicit agent-posted outcomes. Doing so adds integration work and does not automatically recreate T3's normalized transcript coverage. [Synapse board storage](https://github.com/vitalysim/herdr-synapse/blob/main/herdr_team/store.py), [board commands](https://github.com/vitalysim/herdr-synapse/blob/main/herdr_team/cmd_board.py).

Similarly, saying that Herdr has no project/session/model organization is too broad. It has workspaces and persistent native agent sessions; Synapse adds durable members and supported model settings. These objects are different from T3's thread model, not absent altogether.

### The products can coexist; ownership of a particular live agent is separate

T3-managed provider processes do not automatically become interactive Herdr agent panes. Running a T3 server command inside a pane would not accomplish that. However, both applications can exist on the same machine, and a future room can have separate execution adapters for them. A pilot does not require migrating or deleting the existing T3 setup. This is an architecture inference from their process-ownership boundaries, not a claim of shared live-session control or seamless migration.

### Headless Linux and SSH are supported by T3

T3 documents `t3 serve`, user services on Linux/macOS, command-line T3 Connect, direct network pairing, and desktop-managed SSH environments. The `desktop-managed-local` authentication policy applies to a local desktop-managed server; it is not the only server policy. A companion accessing that particular mode still needs to follow its authentication boundary, but a headless deployment is not architecturally blocked. [Background service](https://github.com/pingdotgg/t3code/blob/main/docs/user/background-service.md), [remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md), [auth-policy selection](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/auth/EnvironmentAuthPolicy.ts).

### Current license

The canonical Herdr `LICENSE` at both current master and release tag `v0.9.1` contains Apache License 2.0. Older forks/third-party descriptions are not authoritative for those versions. This records the observed license; it is not an analysis of redistribution obligations. [Versioned license](https://github.com/herdrdev/herdr/blob/v0.9.1/LICENSE).

## Previously proposed trial criteria

These questions were proposed before the user's trial. They are retained as reference, not as completed tests or pending requirements:

1. Can two same-model participants keep their identity, native conversation, and board read positions across detach/resume?
2. Do multiline pasted/dictated instructions land intact, including while another agent is busy? Are focused panes, existing drafts, and approval dialogs handled understandably?
3. When an agent only replies in its native pane, does the intended collaborator receive enough context? Compare that with an explicitly posted board handoff and record the difference.
4. With sol1 busy and sol2 idle, does a natural-language delayed review reach sol2 early? Treat that as testing the delivery-versus-dependency distinction, not as proof of a task scheduler.
5. After a known completion, failure, interruption, or daemon restart, do delivery receipts and visible state match what actually happened?

The user-reported experience was enough to reject Herdr as the chosen foundation without completing this controlled comparison. The PRD's own T3 integration, context-delivery, and scheduler acceptance tests remain necessary.
