# T3 Rooms product-shape feasibility

Documentary review of whether the written Phase 1 shape — a durable user-directed queue, shared context, and explicit actions — can be built as ordinary code. Sources are the local PRD (draft, updated 2026-09-22), the Herdr assessment (2026-09-22), and the Jev findings (tested 2026-09-21). No T3, Herdr, or Jev API was called. Claims those documents make about external systems are reported as their claims. Wire-level T3, MCP, and Jev/SemIf behavior is left to the other reviews.

The repo documents available here are `PRD.md`, `research/HERDR_ASSESSMENT.md`, `research/JEV_FINDINGS.md`, and the Jev fixture/result JSON files. There is no JSON Schema, SQL DDL, or transition appendix beside the PRD.

## Is Phase 1 fully specified enough to build the action catalog, command schema, state machine, dependency rules, delivery contract, and restart/outbox?

### Takeaway

The durable-queue shape is specified enough to implement and unit-test the happy path: explicit `task.create` / update / release / cancel, `after_all` on existing task revisions, a frozen briefing, and persist-before-send. It is not specified enough to implement Phase 1 as accepted in section 11 without inventing commands, recovery transitions, and retry identity. The PRD itself calls the text a draft and says Phase 0 did not build the room or run the scheduler.

### Cited Findings

**Action catalog**

- Section 4.4 tables nine operations: `task.create` with timing `now`, `after_all`, or `manual`; `room.note.create`; `task.update`; `task.release`; `task.cancel`; `task.interrupt`; `task.retry`. Each row lists required fields, a direct control, and a result sentence. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The same section says participant creation/attachment, renaming, binding changes, room creation, and answers to native harness questions are direct controls, do not depend on Jev, and sit outside the initial selectable action subset. It names no command types or fields for them. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- “Review” is an instruction, not a command. “Review now,” “review after task 41,” and “save a review for later” share `task.create` and differ only by timing. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 1 still requires those extra controls: create/attach participants, optional persona briefs, pending-input visibility, and error visibility. The acceptance bar is “every action in the catalog and all participant/native-request controls” with inference disabled. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 6.4 requires that the first release “let the user mark a task blocked.” No catalog row, command name, or state edge defines that operation. A later `report_task_outcome` facility is explicitly later work. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Command schema**

- Section 4.5 shows one JSON object: `type: task.create`, `roomId`, `recipients`, `instruction`, and `schedule.mode: after_all` with `prerequisites: [{taskId, revision}]`. It says the service adds trusted command identity, current room revision, binding generations, and submission provenance. — [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The schema rule is a discriminated union: `now` and `manual` do not accept prerequisite fields; `after_all` requires a nonempty list. Unknown names, invalid enums, nonexistent references, unsupported fields, and stale revisions fail before execution. — [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The prose calls this a “versioned command.” The only example has no version field. Section 6.1’s Room record has “next event sequence,” not a room revision. Participant records have a binding generation. Task, draft, and interpretation each have their own revision. The text never equates these tokens. — [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `instruction` must stay user-authored text or a selected verbatim span. Aliases resolve to participant ids. There is no schema for the other command types, for dependent-task handling on `task.retry`, or for a native-permission response. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Explicit syntax is “example proposed syntax”: `@sol2 review the diff` for Now, and `/after task41 @sol2 review the implementation` for After. The parser uses exact id/alias matching, keeps incomplete commands as drafts, and “is not expected to understand arbitrary paraphrases of ‘after.’” — [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**State machine**

- Section 6.2 draws composer states `action_draft`, `needs_interpretation`, and `needs_clarification`, and says a task exists only after a valid submit. Direct UI reaches the queue without a Jev state. An unresolved draft authorizes no partial dispatch. — [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Task edges that are drawn: `held → queued` on release; `queued → dispatching` when prerequisites are satisfied and the assignee is available; `queued → blocked` when a prerequisite fails or the binding is unavailable; `dispatching → running` when T3 accepts and starts a correlated turn; `running → needs_input → running`; `running → succeeded | failed | interrupted`; `queued → cancelled`; `held → cancelled`; `blocked → queued` when the user resolves the blocker. — [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `queued` has a visible reason: waiting for named tasks, waiting for the assignee, or ready. Manual hold is a different state from dependency waiting. — [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The diagram has no edge out of `dispatching` except `running`, no edge out of `failed` or `interrupted`, and no user “mark blocked” edge. `task.retry` and the section 6.5 restart rule are not drawn. — [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Dependency rules**

- Edges bind to a task revision, not to “alias becomes idle.” The only initial semantics are wait-for-all. “After either” is out of scope. Already-successful prerequisites add no wait. Failure, interruption, or unresolved native input does not release dependents. A new attempt is an explicit user operation, and the system records whether dependents reattach. — [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- One room-dispatched turn at a time per participant. Different participants may run concurrently, within provider capacity. The service owns the wait and must not send the review early for the agent to poll. — [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Submit-time checks: references belong to this room; UI selections beat inferred ones; a prerequisite mention does not make that participant a recipient; every dependency needs an explicit task/author/topic reference or an unambiguous selection; `send_after` maps to nonempty `after_all`; “now” plus prerequisite edges is invalid; no self-edge or cycle; fan-in keeps every requested predecessor; unresolved candidates are not dropped; the roster/task snapshot is re-checked at save. — [PRD §5.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Cancel of work T3 has not accepted “expose[s] the resulting block on dependent tasks.” The state diagram’s blocked trigger is “prerequisite fails or binding unavailable,” not cancellation. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Delivery contract**

- At dispatch the service freezes a room sequence cutoff, gathers shared messages this binding has not received and does not already own, includes prerequisite results and reported file/branch/commit/artifact references, appends the current assignment separately, and saves the exact briefing and source event ids before sending. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Parallel tasks released together share one initial cutoff. A review assembles its briefing only when released. In-progress streaming text is shown in the UI and is not injected into another running session. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Unseen visible messages are kept while they fit “the delivery budget.” Over budget, condensation is shown, source references are kept, and originals stay accessible. A generative summarizer is optional. The budget size, the condensation algorithm, and a “user-pinned decisions” action are not defined. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 6.1’s Delivery record is task/run id, exact briefing, included event ids/sequence range, command id, and acceptance state. The room keeps original history; native session history is not rewritten. Agent replies do not create work. — [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Restart and outbox**

- SQLite is required for transactional tasks and an outbox. A JSON log is “sufficient for a disposable conversation demo” and insufficient for restart-safe dispatch. — [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Persist the task and dispatch intent before external submission. Use a stable T3 command id for an identical retry, and store the exact briefing so a retry does not rebuild it with newer context while reusing that id. After reconnect, reconcile accepted commands and correlated turns before another dispatch. Bookkeeping advances on confirmed acceptance, not on prepare, and not on an HTTP acknowledgement. Editing a pending instruction creates a new revision and command identity. Closing the UI does not stop the service. Offline time does not run jobs. — [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- No outbox columns, lease, or `dispatching` recovery transition are specified. Section 6.5 does not say whether one `task.create` with several recipients is one command id or one id per created task. — [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 0 “does not start T3 sessions, test the scheduler against real harnesses, or build the room interface.” The Jev study did not test queue persistence, retries, restart recovery, or completion correlation. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Jev findings, Not tested](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)

### Inferences

- An engineer can build the deterministic core from sections 4.4, 4.5, 6.1, 6.3, and the five dispatch steps in section 7, then test it against a fake adapter. The catalog table plus the three schedule modes is a real command surface.
- Phase 1 as a completion claim needs more than that core. Participant/native commands, mark-blocked, `dispatching` recovery, cancel-to-dependent transitions, and the meaning of “identical retry” versus `task.retry` are product rules the prose requires and does not define. Those are internal gaps. They remain even if an adapter can create threads, submit turns, and report correlated completion.
- “Versioned command” and “room revision” are words without a wire or storage definition. Implementers will pick an optimistic-concurrency token. Section 11’s “stale revisions” test cannot be written unambiguously until task revision, room/event revision, binding generation, and draft revision are distinguished in the schema.

### Gaps

- No field-level schema for `task.update`, `task.release`, `task.cancel`, `task.interrupt`, `task.retry`, `room.note.create`, participant/binding commands, or permission responses.
- No enumerated values for `task.retry`’s “explicit dependent-task handling.”
- No definition of assignee-available beyond “one room-dispatched turn” plus section 9’s warning about direct T3 activity.
- No delivery-budget number, pin action, or condensation procedure.
- No SQL for the outbox and no crash matrix (before send, after send before ack, after ack before `running`, process duplicated).
- This review did not look at T3’s actual command-id or turn-id types. Whether the PRD’s “stable T3 command ID” matches a real idempotency key is outside this note.

## Where is the spec contradictory, underspecified, or dependent on untested adapter behavior?

### Takeaway

The contradictions that can ship the wrong Phase 1 are the natural-language examples in section 4.3 against the Phase 1 parser limit, the state diagram against retry/cancel/restart, and “mark blocked” / “dependents blocked” against a diagram that never defines those transitions. Section 12’s five spikes are still open, and the PRD forbids the fallbacks it already knows are inadequate (`thread.settled` alone, an uncorrelated wait, the test-only receipt bus, 8,000-character reads as an archive).

### Cited Findings

**Section 12, quoted as open spikes**

- The PRD lists five items to resolve “before implementation is considered ready,” in an isolated adapter spike: (1) a direct authenticated connection to the installed T3 version without unexpected live-state changes; (2) full-text/history and artifact access, including outputs larger than the MCP bridge’s 8,000-character cap; (3) provider-specific successful completion, attention states, and native turn-identity correlation for two actual harnesses; (4) how persona instructions and enforced permission modes are expressed; (5) how direct T3 activity, native compaction, server restart, and thread rebinding interact with room delivery records. — [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- It then says these “affect adapter behavior” and “do not change the agreed product shape.” — [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 0 and the Jev note both say no T3 session, scheduler, queue, retry, restart, or correlation test was run. All 50 probe requests were synthetic routing calls. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Jev findings, Not tested](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)

**Known-bad signals the product forbids**

- Completion is the correlated turn’s successful terminal state, with no outstanding blocking request, after the final response/artifact metadata is ingested. Dispatch acknowledgement, a commentary message, or an idle thread “observed without run correlation” is not completion. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- “Do not depend on T3’s test-only receipt bus in production.” “Do not use `thread.settled` alone.” The PRD says T3 emits that event for manual settlement and automatic lifecycle policies, and that it does not identify a successful run of the room’s assignment. An uncorrelated Herdr `agent.wait` is likewise not success. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The Herdr assessment, from its own source inspection, says the T3 decider emits `thread.settled` for both `thread.settle` and `thread.auto-settle`, including inactivity or pull-request policies. It names `orchestration.subscribeThread` and `orchestration.subscribeShell` as the inspected subscription surfaces. This note does not re-check those files. — [Herdr assessment, second-assessment review](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- The MCP candidate “caps returned message text at 8,000 characters,” does not create worktrees, and “desktop discovery requires a companion T3 change.” The no-fork path is direct authenticated connections. Truncated reads must not be treated as a complete archive. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Cited T3 pull requests #12457 and #9181 “were closed unmerged” and “are not evidence of shipped capabilities.” The PRD does not rely on them. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Internal contradictions and holes**

- Section 4.3’s table lists natural-language results, including “Sol two, review once sol one finishes the parser” and “@claude compare their changes after both finish,” under the primary workflow. The next paragraphs say the initial release fills fields directly or through explicit syntax, and that an interpreter comes later. Section 5.0 says the parser will not understand arbitrary “after” paraphrases. Section 5.5 and the Phase 2 list defer dependencies on tasks created in the same message. — [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 4.3 and the `now` row say a busy participant waits in “their ordinary queue.” Section 6.3 says the service keeps one room-dispatched turn per participant and does not send early. “Ordinary queue” is never defined. — [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 11’s Failures row: failed, interrupted, and input-blocked predecessors “keep dependents blocked.” Section 6.2 sends a task to `blocked` only when a prerequisite fails or the binding is unavailable. Unresolved input is a `needs_input` state on the predecessor. Section 6.3 says that state does not release dependents; it does not say it moves them to `blocked`. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `task.cancel` applies to work T3 has not accepted, and dependents show a block. The diagram allows cancel only from `queued` and `held`, not from `blocked` or `dispatching`. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `task.interrupt` is keyed by “Task/run ID” and must observe the real outcome, including “do not pretend a completed run was interrupted.” Other mutations are keyed by task id and revision. No interrupt-pending state is drawn. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 6.5’s “identical retry” reuses the command id and the frozen briefing. Section 4.4’s `task.retry` “record[s] a new attempt” and takes an explicit dependent-handling choice. Section 6.3 forbids treating unrelated later work as the prerequisite’s completion. The word “retry” covers both cases. — [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `task.update` creates a new revision before dispatch. Dependencies point at a specific revision. The PRD never says whether dependents of revision 1 follow revision 2, stay on the superseded revision, or become blocked. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- A normal final response may contain a prose blocker with no native blocked state. The release rule is still “successful terminal state.” Accepted work cannot be retracted by editing the local card. The user-facing correction (“mark a task blocked”) has no command. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 5.1 says a multi-person message is briefed whole, with a line to perform only the recipient’s part, and that the room must not invent rewritten requirements. Section 7’s assembly steps do not repeat that line. Section 4.3’s multi-recipient example stores one shared source request. — [PRD §5.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- “Parallel tasks released together use a common initial room cutoff.” The text does not say what cutoff a later sibling gets if it is released after the first because that participant was busy. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Rebinding “must account for outstanding tasks” and “cannot silently send a pending task to a different session.” The blocked reason “binding unavailable” exists. The account-for algorithm does not. — [PRD §4.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- A delivered-event cursor “means ‘delivered,’ not ‘the model still remembers every token.’” Important context “can be reattached after compaction” without replaying the room. The trigger, the payload, and the acceptance test for that reattachment are not given. Spike 5 leaves compaction interaction unresolved. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 8 tells the session brief to ask agents for path, branch, commit/diff, and unfinished integration, and says those reports are shared automatically. It does not define a parser from prose into fields. The room must not assume `main` holds the work, and must not treat a shell-created worktree as a rebound session. — [PRD §8](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Jev’s selectable names (`send_now`, `send_after`, `save_for_later`, `post_note`, `cancel_pending`, `release_held`, `clarify`, `unsupported`) are a different vocabulary from section 4.4, with a stated mapping for `send_after`. Interrupt, retry, arbitrary text edit, and adding a participant “can initially remain direct-UI operations.” The findings say the measured 14/16 and 7/12 results are the old question layout, not this mapping. — [PRD §5.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Jev findings, Design update](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)

### Inferences

- Section 12’s closing sentence is true about the decisions in section 3 (companion owns coordination, T3 owns execution, actions are explicit, Jev is optional). It is not true of the section 11 completion bar. Run correlation, lossless-enough history, persona/permission controls, and restart all sit on spikes 1–5. A client that can only create a thread and send text is not the adapter section 9 describes, and it cannot pass Phase 1.
- The dangerous internal misread is “ordinary queue” as the harness input queue. That implementation would submit early, which section 6.3 forbids, and a correct adapter would faithfully deliver the early prompt. The sequential-review acceptance test would fail with no adapter bug.
- Prose-blocker release is a product-shape failure mode that a perfect correlation adapter still implements: the turn is terminally successful, dependents dispatch once, and section 4.3 says the local card cannot retract an accepted prompt. Without a specified mark-blocked command and a rule about dependents already in `dispatching`, the user cannot stop that handoff.
- Superseded revisions plus `task.retry` reattachment are where two careful implementers will persist different graphs. Section 11 does not list an acceptance row for “edit prerequisite revision” or “cancel versus fail.”

### Gaps

- Whether T3’s supported events can satisfy spike 3 without `thread.settled` or the test-only bus is not decided in these documents. Other reviews own that contract.
- Whether a full-message or artifact read exists above the 8,000-character cap is not decided here.
- No author mapping from each section 4.3 table row to “direct UI,” “explicit grammar,” or “later interpreter.”
- No rule for staggered fan-out cutoffs, for dependents of a cancelled or edited revision, or for mark-blocked after a dependent has already been accepted.

## Can the stated user story be implemented with the Phase 1 rules, including the section 5.5 compound-sentence limit?

### Takeaway

The story can be implemented as three explicit Phase 1 actions once sol1 and sol2’s tasks already exist: two `now` assignments with separate instructions, then an `after_all` for claude on those two revisions, using the two-card “After both” control. It cannot be implemented as the single spoken utterance in section 1. That utterance creates the predecessor tasks and the fan-in in one message, which section 5.5 and Phase 2 defer. Executing it as parallel work is the failure mode the PRD tells the builder not to ship.

### Cited Findings

- Section 1’s user-visible example is: “Sol one, investigate the parser. Sol two, independently inspect the fixtures.” Then: “Claude, compare their findings when both finish.” The user should not copy outputs or watch a session only to send the next instruction. — [PRD §1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The success list is narrower than that quotation. It asks for two same-model sessions, one timeline, a participant acting on another’s results without pasting, and a review queued while implementation runs, with the wait visible. — [PRD §2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Section 5.5: the first release supports one request to one or more participants, with optional dependencies on “already identified tasks.” The flow it “must correctly record” is: while sol1 is working, queue sol2’s review of that task. A message such as “@sol1 implement X, then @sol2 review it” needs prospective nodes for assignments created in that same message. “The live probe does not test this prospective-task construction.” Until it is supported, “expose two linked assignment cards for the user to complete rather than silently executing the sentence as parallel work.” — [PRD §5.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 1 includes “dependencies on existing room tasks, including waiting for both tasks.” Phase 2 includes “multiple prospective assignments and dependencies from one compound sentence.” — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Direct substitutes that need no classifier: recipient chips, timing, a prerequisite picker, **Add follow-up** on one card (preselects that task revision), and selecting two task cards to prefill **After both**. — [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- “@sol1 @sol2 independently investigate the timeout” creates two independent assignments with the same source request. “@claude compare their changes after both finish” binds “to both identified tasks, if the room context resolves ‘both.’” Multiple possible antecedents open a picker; the room does not guess from confidence alone. — [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- A pronoun plus several plausible tasks is not a grounded dependency. Fan-in must include every requested predecessor. — [PRD §5.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The documented grammar examples are a single recipient and a single `/after task41`. They do not show two different instruction strings, spoken “sol one,” or a list of prerequisites. — [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Voice in the first release is OS or third-party dictation into text. The user dictates task content while choosing recipients and timing directly. Free-form action interpretation is optional. — [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The Jev fixture `parallel` expects one message, “@sol1 @sol2 independently investigate the timeout bug now,” to become two `now` plans with empty dependencies. The fixture `fan_in` expects “@claude compare their changes after both sol1 and sol2 finish” to depend on `task41` and `task43`, and those two tasks are already in the fixture state, both `running`, before the call. — [Jev routing cases](file:///Users/moonmoon/Projects/t3code-rooms/research/jev-routing-cases.json)
- The findings list “compare after both tasks” as recognized under that pre-existing-task setup, and list “creation of prospective task nodes from a compound multi-step sentence” as not tested. — [Jev findings, Result](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md), [Jev findings, Not tested](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)
- Different work for different people, in the Jev section, is handled by briefing the original message and telling the recipient to do only their part. The room does not invent rewritten requirements. Jev does not generate instruction strings or these ids. — [PRD §5.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

### Inferences

- Phase 1 path that matches the written rules: (1) Send now to sol1, instruction “investigate the parser”; (2) Send now to sol2, instruction “independently inspect the fixtures,” with no edge between them, so section 6.3 allows them to run at the same time; (3) after both revisions exist, select those two cards, Queue claude’s “compare their findings” as `after_all`. The review briefing is built only at release, so it can include both results (section 7). Ambiguous “both” stays in the picker (section 4.3).
- The section 1 quotation is a different feature. The first sentence creates two tasks with different instructions. The second sentence’s predecessors are those not-yet-created tasks. That is the prospective graph section 5.5 postpones. The closest specified behavior for an unsupported compound sentence is two linked cards the user finishes, not silent fan-out. Silent fan-out would start claude immediately, which fails “when both finish.”
- The Jev `fan_in` pass does not license the quotation. The tasks already existed, the message named sol1 and sol2, and the probe never built nodes. The shared-instruction `parallel` fixture also does not cover “investigate the parser” versus “inspect the fixtures.”
- Clause-splitting the quotation into three verbatim instructions would be the room inventing requirements, which section 5.1 forbids. Putting the whole quotation in each briefing and adding “only your part” leaves sequencing to the agents, which section 6.3 forbids for the review.
- Section 2’s success line (“queue a review while implementation is running”) is the section 5.5 central flow and is in Phase 1. The section 1 speech is the Phase 2 compound sentence. Treating the speech as the Phase 1 demo would make Phase 1 look failed, or would force the untested prospective-node path into the first release.

### Gaps

- The `/after` example has one task id. Multi-prerequisite syntax is unspecified; the two-card control is the specified fan-in input.
- No rule for how many existing tasks make “both” unambiguous versus a picker. Section 5.4’s “unambiguous room selection” is not an algorithm.
- No test fixture in this repo for the three-step direct path. The routing JSON covers the old interpreter questions with tasks pre-seeded.

## What must be built in ordinary code, and what is optional?

### Takeaway

Phase 1 is ordinary application code: catalog handlers, exact syntax, SQLite, revisioned tasks, cycle checks, `after_all`, a frozen briefing, and restart reconciliation, all with Jev off. Jev, SemIf, a generative summarizer, same-message prospective graphs, alias pools, and semantic completion are optional and explicitly later. The T3 adapter is required code, but its protocol is someone else’s review; the room still owns the queue if that adapter is only a port.

### Cited Findings

**Required for the Phase 1 promise**

- “Ordinary code validates, persists, queues, dispatches, and observes work.” “No supervising generative model is required.” “Perform every room action directly, with Jev disabled or unavailable.” — [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Build order: action catalog and handlers, then complete direct controls, then deterministic validation and scheduling, then optional interpretation. “The durable queue must continue without either model or an open browser.” — [PRD §5.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 1 list: versioned catalog and direct controls; one local T3 environment; create/attach participants; shared timeline and room notes; exact alias and explicit-command parsing with no model call; dependencies on existing tasks, including waiting for both; held tasks; edit/cancel/release; pending-input and errors; SQLite queue/outbox; reconnect reconciliation; context delivery; agent-managed workspaces; links back to T3. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Records required by section 6.1 for that promise: room, participant, session binding, room event, task (id and revision), run, delivery. Action drafts are required for incomplete explicit commands, which stay in the composer. — [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Cycle rejection is a submit-time code check, and section 11 requires cycles to be rejected before execution. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Briefing freeze, saved source event ids, and “do not keep only the latest reply per sibling” are required context behavior. Originals remain retrievable when condensation happens. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The adapter boundary is required as a port: project/provider discovery, thread create/attach, turn submission, observation, conversation reads, pending-request responses, interruption. T3 ids are opaque. One service holds control-plane access. The room does not install cross-thread tools into every participant, and does not create worktrees. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §8](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Direct activity in T3 may occupy a session and “must not accidentally satisfy an unrelated room prerequisite.” — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Optional, and not evidence for Phase 1**

- Hosted Jev and local SemIf are “optional later” adapters. Sections 5.1–5.5 “do not make hosted Jev a prerequisite for Phase 1.” No SemIf install, local benchmark, or automatic parser was done for this PRD. — [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Phase 2 is where those adapters, compound prospective assignments, `@sol` alias pools, explicit outcome reporting, broader condensation, extra T3 environments, in-app transcription, and richer tool views go. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- “A generative summarizer is an optional later component, not a required orchestrator.” “Jev cannot write these summaries.” Initial text may use user-pinned decisions and a handoff summary from a coding session. — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The Jev quality gate (at least 100 instructions, at least 95% exact suggestions on clear in-scope commands, no observed confidently wrong recipient or prerequisite in that run) applies “for each enabled Jev mapping.” Mappings that miss it stay disabled while direct actions remain. The current holdout “does not meet the PRD’s proposed release gate.” — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Jev findings, Held-out outcomes](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)
- v3 development cases: 14/16 exact. Holdout: 7/12 exact. Thirteen automatically actionable plans all matched fixtures; other runs asked for clarification. An earlier version accepted an ambiguous prerequisite; a code guard stopped it. Thresholds are “exploratory policy settings, not calibrated production guarantees.” — [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Jev findings, Runs and cost](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md), [PRD §5.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Out of scope: a T3 fork, automatic worktree administration, autonomous debates, recursive mention-triggered delegation, replacing harness loops, automatic account provisioning, calendar scheduling, and a general workflow language. — [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The Interpretation record (model, template version, typed answers) is the optional adapter’s audit row. Queue execution “runs without further Jev calls or continued Jev availability” once a task is accepted. — [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

### Inferences

- Required ordinary code, named the way the question asks: a SQLite store of the section 6.1 records; tasks addressed by id plus revision; a directed acyclic check on dependency edges at create and update; a briefing frozen at a sequence cutoff and stored on the delivery row before send; an outbox that reconciles by command id on restart. Plus the `after_all` waiter, per-participant single flight, and the direct composer.
- Optional: Jev HTTP, SemIf scoring, any summarizer model, prospective same-message graphs, alias pools, “after either,” calendar, and a semantic done-classifier. Shipping Phase 1 does not require a Jev key, a local model, or a browser demo.
- The adapter is not optional. What is optional is the third-party MCP package as the implementation of that port. Section 9 treats it as a candidate and rejects its truncation and its desktop-discovery patch as the no-fork path.
- “User-pinned decisions” are mentioned as an initial condensation tactic and are not in the catalog. They are not a second required subsystem until someone specifies them. The required fallback in the acceptance text is: keep originals, and show it when the delivered set was reduced.

### Gaps

- Persona briefs are in Phase 1, while spike 4 (how a harness actually accepts them) is open. The product allows an “initial session brief” when no instruction mechanism exists, so the local record can be built before that spike. Enforced permission modes cannot. — [PRD §4.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- No decision on whether the Interpretation table is created empty in Phase 1 or omitted until Phase 2.

## Which acceptance tests run without a live model, and which need two real harnesses?

### Takeaway

Most of the section 11 table is a deterministic test against a fake adapter: schema rejection, explicit parsing, fan-in, non-release on failure, one-shot briefing, and restart reconciliation. The plan itself says two real harnesses are required before implementation is ready, for provider-specific completion, attention, and turn identity. Jev is not part of that Phase 1 bar. Nothing in the local documents records that either kind of scheduler test has been run.

### Cited Findings

- “Validate deterministic actions first with meaningful state-transition and integration tests, including queue recovery.” Release the deterministic interface only after catalog actions work without Jev and their required acceptance tests pass. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Rows that the PRD already marks as code or no-model behavior: contract validation (unknown actions, bad enums, missing references, cycles, stale revisions, illegal transitions) rejects before execution; input parsing of exact aliases, explicit commands, incomplete syntax, and missing task references produces drafts or errors “without a model”; command validity never depends on intent accuracy. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Further rows whose written oracle is local state, not a model answer: action parity between direct controls and explicit syntax; draft fields surviving a later inference response; fan-in waiting for both identified prerequisites; failed/interrupted/input-blocked predecessors not releasing dependents; pending edit/cancel versus an already accepted task; secrets kept out of browser payloads, room events, logs, and version control; restart after submission and before acknowledgement reconciles instead of duplicating or dropping context. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Context row: earlier unseen decisions survive multiple sibling replies; truncation is visible; originals stay retrievable. That oracle can be a fixture transcript plus the delivery record. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Run-correlation row: an old completion event or an unrelated direct T3 turn does not release a dependency. The guard is local. The events it must ignore are adapter-shaped. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Named sessions: two aliases on the same provider and model keep separate native histories across multiple turns. Parallel work: one user message starts two eligible participants without waiting for the first result. Sequential review: a review queued during implementation stays queued, then receives the completed output exactly once. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Spike 3 is the only place that says “two actual harnesses,” and it pairs them with successful completion, attention states, and native turn identity. Spike 5 adds direct T3 activity, compaction, server restart, and rebinding, without repeating “two harnesses.” — [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Workspace row: agents can choose worktree strategy; the room forwards artifact locations and does not create worktrees. The negative (no worktree API) is a property of the companion. The positive (an agent actually chooses) is a live session. — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §8](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The Jev gate is separate and later: per mapping, on an independently reviewed set of at least 100 instructions. Direct controls must not wait for Jev. The probe’s 50 calls are “not a production reliability benchmark.” — [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Jev findings “Not tested”: a real T3 adapter, queue persistence, retries, restart, completion correlation, prospective compound sentences, cancellation target resolution, and a real permission-response workflow. — [Jev findings, Not tested](file:///Users/moonmoon/Projects/t3code-rooms/research/JEV_FINDINGS.md)

### Inferences

- Without a live coding model and without Jev, using a fake port that records submits and emits scripted terminal events: contract validation, explicit-syntax parsing, action parity, draft staleness, hold/release, edit/cancel, cycle rejection, fan-in, non-release on scripted failure/interrupt/`needs_input`, exactly-once briefing from fixture predecessor output, restart-before-ack, local context truncation, secret scanning, and the “unrelated event does not release” guard.
- Same-model dual session (the Named sessions row) needs one live provider with two threads. It does not, by its own wording, need two harness products. Spike 3 does: completion and attention are “provider-specific,” and the plan asks for two harnesses before calling implementation ready.
- Two real harnesses are required to evidence spike 3 and, transitively, to claim the live forms of Run correlation, Sequential review (“exactly once” from a real terminal state), Failures (real native questions), and Parallel work (two sessions actually running). A fake adapter can pass the queue-shaped versions of those rows and still leave spike 3 empty.
- Spike 2 (full text over 8,000 characters) and spike 5 (compaction, server restart, rebinding, direct activity) need a live T3. The text does not require two harness products for those two spikes. Persona/permission (spike 4) is live and may differ by harness; the PRD does not say “two” there.
- No Phase 1 acceptance row requires a Jev call. The 95% / 100-instruction gate is a Phase 2 enablement gate. The existing 7/12 holdout is evidence that gate is unmet, not that the SQLite queue fails.

### Gaps

- The acceptance table does not label rows as fake-adapter versus live-harness. The split above is an inference from section 11’s oracles plus section 12’s spike wording.
- No recorded local test run of the deterministic suite. “Testable” here means the oracle is defined, not that a harness exists in the repo.
- “Two actual harnesses” does not name which two. The section 1 story’s claude-versus-sol pair is not the same requirement as the Named sessions row (two aliases, one model).

## Is rejecting Herdr consistent with the written gaps?

### Takeaway

Yes. The assessment’s two structural gaps — no prerequisite graph, and no per-turn completion — are exactly the section 6 behaviors Phase 1 has to own, and Herdr’s documented wait/idle gates do not supply them. The rejection does not show that T3 already has turn correlation. The same assessment says `thread.settled` is the analogous hole, and the PRD leaves that as spike 3.

### Cited Findings

- The user tried Herdr, disliked it, and reported that it could not find the agent harnesses. No version, logs, or root cause were established. The trial did not establish whether Synapse works there. The decision recorded in both documents: keep T3, and do not require another Herdr pilot. — [Herdr assessment, Assessment](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Herdr names identify live processes and can disappear when processes exit. Documented prompt/wait “does not track individual turns.” Prompting an already-working agent and waiting “can finish on the old active turn.” A status change does not prove a particular assignment completed. The stable release inspected in that review was v0.9.1. — [Herdr assessment, What “agent cockpit” means](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- Synapse pending records and delivery gates, in the inspected 0.18.0 source, key off recipient identity, idle/stable state, dialogs, draft input, focus, and throttling. The assessment says source searches found no prerequisite or dependency-task fields. If sol1 is busy and sol2 is idle, a post to sol2 can be delivered before sol1 finishes. Natural-language “wait for sol1” inside the post leaves the wait with the agent. — [Herdr assessment, Delivery eligibility](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- That early delivery “is not the deterministic room-owned queue specified in our PRD.” The PRD’s rule is the complement: the service owns dependency waiting and does not send the review early. — [Herdr assessment, Delivery eligibility](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- For most harnesses, Synapse’s notifier tells the agent to read new board posts. Complete shared knowledge is not automatic. The assessment says the PRD’s “all unseen visible replies” requirement would need extra capture. — [Herdr assessment, Board context](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `agent.wait` “does not supply our persistent task graph, dependency validation, per-attempt correlation, edited/cancelled tasks, or restart-safe dispatch outbox.” It “is an observation primitive the scheduler can use, not section 6 of the PRD implemented as one call.” — [Herdr assessment, A wait primitive does not replace the scheduler](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- The same review says T3 `thread.settled` is not a task-success receipt either, for the policy reasons summarized in section 6.4 of the PRD. — [Herdr assessment, T3’s thread.settled](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The assessment also says a Herdr plugin could package a scheduler without forking Herdr; plugin UI is terminal-based; plugins own their own database; a T3-like web UI would still be separate work. It tells the project to continue with the T3 companion and to keep Synapse as reference material. “The room still owns its own shared-context contract and deterministic task dependencies.” The PRD’s T3 integration, context, and scheduler tests “remain necessary.” — [Herdr assessment, Extension and operational implications](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [Herdr assessment, Earlier evaluation proposal](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- Neither Herdr path requires Jev for explicit addressing. A model is needed only to infer unspecified actions. That matches the PRD’s split between direct actions and optional interpretation. — [Herdr assessment, Earlier evaluation proposal](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md), [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The proposed Herdr trial questions, including “with sol1 busy and sol2 idle, does a delayed review arrive early?” and restart/receipt checks, are “retained as reference, not as completed tests.” The user report replaced that pilot. — [Herdr assessment, Previously proposed trial criteria](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)

### Inferences

- Rejecting Herdr as the execution backend is consistent with the written gaps. A Synapse delivery gate would fail Sequential review and Fan-in in section 11 whenever the reviewer is idle, because eligibility is not a revisioned `after_all` edge. An `agent.wait` return would fail Run correlation, because the assessment says it can complete on the previous turn. Building Phase 1 on Herdr would still mean writing the SQLite graph, cycle checks, revision rules, and outbox. Herdr does not shrink that scope.
- The user’s trial and the source gaps are different reasons that the documents stack, not a single measured demonstration. The trial is undiagnosed discovery and dislike. The graph and turn gaps are from a documentation and source reading that this note did not repeat. Both are internally consistent with “do not block T3 Rooms on another Herdr pilot.”
- It is not consistent to treat “Herdr has no turn correlation” as proof that the T3 path is safe. The assessment and section 6.4 say T3’s settled event has the same class of bug, and section 12.3 still asks for a two-harness correlation spike. The consistent reading is that idle, settled, and uncorrelated wait are inadequate on both backends, so the companion must correlate the turn it submitted.
- It is also not consistent to claim Herdr could not host a queue. The assessment says the plugin API could. The PRD’s packaging decision is a separate local web companion over T3, not a terminal plugin. The gaps explain why Herdr is not a shortcut; the packaging section explains why it is not the chosen shell.

### Gaps

- This review did not re-read Herdr or Synapse source. The “no prerequisite fields” and “wait finishes on the old turn” claims are only as strong as the 2026-09-22 assessment.
- The detection failure’s cause is explicitly unknown, so it is not evidence for or against Synapse’s gate code.
- No side-by-side run shows T3 correlating turns better than Herdr. The PRD does not claim one.

## What is straightforward, what is hard, and what could force a T3 fork?

### Takeaway

Straightforward: the explicit queue, revisioned `after_all`, cycle rejection, and fixture-level briefing/restart tests. Hard, and able to fail Phase 1 with a working send/observe adapter: dispatch identity, revision and cancel propagation, prose-success release, and context after the happy path. A fork is not required by any demonstrated missing API in this review. The written plan creates a fork-or-fail corner if spikes 2 or 3 come back negative, because it forbids both a T3 fork and the fallbacks it already calls inadequate.

### Cited Findings

**Straightforward relative to the written rules**

- Three timings, one create handler, direct controls equivalent to explicit syntax, and reject-before-execute for unknown actions, bad enums, missing refs, cycles, and stale revisions. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- `after_all` on known revisions, including “already successful prerequisites do not introduce a new wait,” fan-in of two tasks, and no release on failure, interruption, or unresolved input. — [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Hold is not a dependency. `manual` cannot carry prerequisites. Release moves a held task to the ready queue. Cancel and edit apply before T3 acceptance; edit writes a new revision. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- SQLite plus the section 6.1 records, a monotonic room event sequence, and a delivery row that stores the exact briefing and event ids before send. — [PRD §6.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- The two-card After both path and Add follow-up implement the central “queue a review of an existing task” flow without a model. — [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §5.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Worktree policy is a non-feature: the room does not create, merge, or clean them, and a missing worktree API on the MCP bridge is acknowledged and accepted. — [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Jev, SemIf, and the summarizer can stay unwired. The queue is required to run with them absent. — [PRD §5.0](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Hard parts of this plan, not of T3’s wire protocol**

- `dispatching` has one success edge. Restart, rejection, and “reconcile before another dispatch” are prose in section 6.5 with no transition. The acceptance test is specifically “after submission but before acknowledgement.” — [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Command-id scope is unspecified for one create that fans out to two participants, and “retry” means both idempotent resend and a new user attempt with a dependent-handling choice. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.5](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Cancel, superseded revisions, and retry reattachment change the graph, and the diagram does not say how. Section 6.3 says dependents must not follow the wrong attempt. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Terminal harness success releases dependents even when the prose says the worker is blocked, and there is no specified undo. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §4.3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Long-context behavior: an undefined budget, unspecifed pins, compaction reattach in one sentence, and a shared cutoff only when parallel tasks are “released together.” — [PRD §7](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Rebind versus outstanding tasks, and “assignee available” while the user is also typing in T3. — [PRD §4.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Native permission round-trip is an acceptance item and a `needs_input` state, without a command in the catalog. — [PRD §4.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §6.2](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

**Fork pressure as written, not as measured**

- “Initial delivery does not modify T3.” “Out of scope: a T3 fork.” — [PRD §3](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- If the only history read is the 8,000-character cap, the PRD says not to claim a lossless archive, and spike 2 requires a full-text or artifact path first. The context acceptance row requires originals retrievable. The room’s own event log can retain what it has already stored; it cannot invent text the adapter never returned. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §11](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- If the only completion signal is `thread.settled` or the test-only receipt bus, section 6.4 forbids using those as the dependency trigger. Spike 3 is then unsatisfied. Patching T3 to expose a correlated terminal state would be a fork, which section 10 forbids. — [PRD §6.4](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §10](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- MCP desktop discovery “requires a companion T3 change.” The PRD’s alternative is a direct authenticated connection, which is spike 1 and is not yet done. The Herdr assessment says T3 documents more than one auth policy, including `t3 serve` and network pairing, and that headless use is not architecturally blocked. This note does not verify that against the user’s install. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §12](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [Herdr assessment, Headless Linux and SSH](file:///Users/moonmoon/Projects/t3code-rooms/research/HERDR_ASSESSMENT.md)
- Closed PRs #12457 and #9181 are called out so the plan does not depend on unmerged work. They are not a reason to fork. — [PRD §9](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)
- Abbreviated tool views are allowed to be incomplete because full inspection stays in T3. That gap does not push a fork. Worktrees are agent-owned for the same reason. — [PRD §4.1](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md), [PRD §8](file:///Users/moonmoon/Projects/t3code-rooms/PRD.md)

### Inferences

- The part that will not sink Phase 1 is the queue math: modes, revisions, cycle detection, hold versus `after_all`, and a frozen briefing tested with fixtures. That is small, local, and independent of whether T3’s socket exists. A fake port is enough to prove it.
- The part that can sink Phase 1 after a basic adapter works is the identity of a run. The product has to decide, in code the PRD does not fully specify, when a command id is reused, which revision a dependent waits on, when `dispatching` is retried, and what happens when the model’s successful message is actually a blocker. Those bugs duplicate work, drop a review, or release a review of the wrong output. They show up in section 11’s Restart, Editing, Sequential review, and Failures rows.
- The part that can force a fork despite the prohibition is narrower than “T3 is hard.” It is the pair of constraints “do not fork” and “do not use the signals we already know are wrong.” That corner is conditional on spikes 2 and 3. If a supported read returns full text and a supported subscription correlates the submitted turn, the no-fork path in section 9 holds. If not, Phase 1’s correlation and context bars cannot be met inside the written constraints. This review does not know which side those spikes land on.
- Spike 1 forces a fork only in a further conditional: direct auth cannot be established, and the only remaining discovery path is the MCP desktop change that section 9 says modifies T3. The documents do not establish that the user’s server is in that position.
- Persona text does not force a fork. Section 4.2 already allows a first-message brief. Enforced permission modes could, if the adapter cannot report real options and the only way to pass “native-request controls” is a T3 change. That is spike 4, still open.
- Building the section 1 sentence as one parser in Phase 1 would expand scope into Phase 2. It would not by itself require a T3 fork. The specified escape is linked cards and After both.

### Gaps

- No evidence in these files that full-text reads or turn ids are absent from T3. Fork pressure is a constraint conflict, not a measured missing API.
- No spike log for the user’s installed version, so “working adapter” is still undefined.
- No estimate of person-weeks is justified by the documents. The risk split above is scope and failure mode, not a schedule.
