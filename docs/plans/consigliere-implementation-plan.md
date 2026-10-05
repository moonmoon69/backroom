# Backroom Consigliere Implementation Plan

Status on 3 October 2026: stages 1 to 4 are built and in use on this machine; nothing is committed. One small real trial has run (see [Known limits](#known-limits)); the trial of stage 0, a real discussion with a wait over ten minutes, has not. Backroom runs on T3's Orchestrator V2.

Where the build differs from the text below:

- A room with a Consigliere has one composer, under the chat. Every message goes to him, also one that names members with `@name` or `@all`: he reads the names as who the user wants on it and sends the work himself. Only a T3 slash command (`@bob /compact`) goes to the member it names. This replaces the plan's “mentions keep their meaning” and “`@all` excludes him”.
- He may edit and run things like any member. His rules say to do the small things himself and hand out real work, replacing the plan's “Do not edit files”; forbidding it made him hand out every small fix, which was slow.
- His rules tell him to point at posts by number and not to quote the user's instruction in each assignment (the trial showed him quoting it four times).
- “Talk to the Consigliere” takes text only for the first message; images can be sent once the room is open.
- `rooms-board index` lists what was said. Task status lines and system notes are listed with `--all`.
- The seat briefing is a task Backroom writes (kind `seat`), so it is retried, shown and acknowledged like any assignment. It carries no room messages.
- Members' messages are recorded from the first start of this build onward. Older ones stay in T3 only.
- An unaddressed message to the Consigliere is always sent as a steer. T3 puts it into his turn when he is working and starts a turn when he is idle.

The user talks to one person. “Alice, research this with Bob and Charlie, discuss your differences, and bring me the result.” Alice brings Bob and Charlie in, gives them work, reads their answers, runs the discussion, and reports back. The user does not create a room, seat people, or pass answers around. Everything Alice and the others say to each other is on a board the user can read.

Alice is the Consigliere. Any crew member the user chooses can be one.

## How it works

**T3 acts. Backroom records and shows.**

T3 already gives every member the tools to work with other members' threads. Backroom does not rebuild them. It watches the threads, keeps the record, and displays it.

| Part | What it is | What it owns |
| --- | --- | --- |
| **T3's tools** | The tools T3 gives every member's session | Sending work to a member, steering, queueing, interrupting, waiting, reading a member's thread |
| **The board** | The room's saved record, kept by Backroom | Every message and answer in the room: who sent it, to whom, in answer to what, and how the turn ended |
| **The Consigliere** | A seated member the user designated | Every judgement: who works on what, what they need to read, whether another round is needed, whether the members agree, when to stop |
| **Workers** | The other seated members | Their own task and its answer |
| **The page** | Backroom's web UI | A chat with the Consigliere, and the board |

Three rules:

1. **The board holds no conclusions.** It is a database of inputs and outputs. It never records that members agree, that an answer is right, or that work succeeded in any sense beyond “the turn completed”. The Consigliere says those things in his own words, citing board posts, and anyone can open them and check him.
2. **Backroom makes no judgements and sets no limits.** It never reads the meaning of a message. The Consigliere decides how many rounds a discussion needs and when to stop. The user sees spend as it grows and can stop anything.
3. **The board is shared.** The user reads it on the page; members read it with one command. The `#51` the user sees is the `#51` a member is told to read.

### What was tried

On 3 October 2026 one room member (Claude) drove a second (Codex) using only T3's tools. An Antigravity agent confirmed it has the same tools. Cursor was not signed in and is untested.

| Need | T3 tool | Result |
| --- | --- | --- |
| Find the room's threads | `t3_thread_list` | Works |
| Give a member work | `t3_thread_send` | Works; the member starts at once |
| Wait for it | `t3_thread_wait` | Works; returns completed, interrupted or failed. One tool call, no polling |
| Read the answer | `t3_thread_read` | Works; can read only what is new |
| Steer running work | `t3_thread_send`, mode `steer` | Works |
| Queue a follow-up | `t3_thread_send`, mode `queue` | Works |
| Interrupt | `t3_thread_interrupt` | Works |
| A worker asks the sender something | The worker's own `t3_thread_send` | Works; it arrives mid-wait, and the answer reaches the worker as a steer |

What the same trial showed is missing, all on Backroom's side:

- The room recorded each answer but not the message that asked for it. Backroom drops the prompt of a turn an agent started.
- Steers, a worker's question and its answer were not recorded at all.
- An interrupted turn was recorded like any other, with no mark.
- A message sent this way arrives bare: no role, folder or room rules.
- A message from a member looks, to the receiver, exactly like a message from the user. T3 does record who sent it: its API gives each such message `createdBy: "agent"` and a `senderThreadId`.
- T3's tools read one thread at a time. They cannot read the user's own messages by room number, and they do not know the user's saved crew.

The stages below close those gaps and nothing else.

### Terms

- **Post:** one saved room event, with a permanent id and a room number such as `#51`.
- **Member:** someone seated in a room. Each member is one ordinary T3 thread of its own, which keeps its whole conversation from one message to the next.
- **Subagent:** a helper a member creates for part of its own task, with its harness's own subagent tool or T3's `delegate_task`. It gets only that job's prompt, belongs to its parent, and is not on the board. Any member may use subagents inside its own task, as today.
- **Saved crew:** the presets the user has built (model, options, permission mode, role, workspace).
- **Designation:** the mark on one member of a room that makes him its Consigliere.

## Intended experience

1. The user picks, in settings, which of their saved crew is the Consigliere for new conversations. Backroom names no model.
2. The user starts a conversation with him in a project. Backroom creates the room with him seated. The user never has to seat anyone.
3. He seats the saved crew he needs as members, sends each one work that points at board posts by number, and waits. They are members and not subagents, so each keeps what it has read and said through every round.
4. Each message he sends, and each answer, appears on the board as it happens.
5. A worker reads the posts it was pointed at, and can ask him a question. He answers while he waits.
6. He decides when the discussion is finished. His report cites the post where each member stated its position. If they will not converge, he stops and says who disagrees, citing it.
7. When the user changes direction, the message reaches him mid-wait. He interrupts what is running and sends the replacement.

The user can still do everything by hand as today: create a room, seat members, address them with `@`.

## Delivery order

### 0. One trial before building

No code. It tests the one thing the plan depends on: that a model can mediate from pointers without losing objections or declaring agreement early.

Give the stage 3 rules to one member by hand, seat two more, and give him one real request that needs research and a discussion. Then read the members' threads and the cost.

Watch two more things during it, and write what happened into [Known limits](#known-limits):

- A wait longer than ten minutes. The longest tried so far is one minute.
- A message from the user to the Consigliere while he waits. A member's message arrived mid-wait; the user's should too.

Done when the trial has run and its result is written here. Stages 1 and 2 do not depend on it and can start at once.

### 1. Record what members send each other

*Part: the board.*

Today a turn Backroom did not start is imported after it finishes, as one `t3.turn` event holding the answer. Its prompt is left out when an agent sent it, and nothing marks how it ended ([`importDirectRuns`](../../src/scheduler/scheduler.ts)).

**Read the sender.** Add `senderThreadId` to `T3Message` in the [adapter](../../src/adapter/http.ts) (`toMessage`) and its [types](../../src/adapter/types.ts).

**Record each message a member sent.** On every scheduler tick, for every member thread in a room, each T3 message with `createdBy: "agent"` and a `senderThreadId` becomes a room event of a new kind, `member.message`, as soon as it is seen:

| Field | Value |
| --- | --- |
| `speaker` | The room member whose thread is `senderThreadId`. If that thread is not a member of this room, the sender is recorded as outside the room, with the thread's title |
| `to` | The member whose thread the message arrived in |
| `text` | The message, unchanged |
| `sourceRef` | The thread id, the T3 message id and the T3 run id |

This covers a message that starts a turn, a steer, a queued message, a question and an answer; they are all the same kind of T3 message. It applies to turns Backroom started too, so a steer into one is recorded. Use the T3 message id to record each once (`findEventIdForSource` already does this for `t3.message`).

**Record how each turn ended.** Add `outcome` to the `t3.turn` event: completed, interrupted or failed, from the T3 run's status. An interrupted or failed turn with no reply is still recorded, with empty text.

**Link the answer.** A `t3.turn` and the `member.message` posts of the same run share the T3 run id in `sourceRef`. The page groups them by it.

**While it runs.** No change is needed: a member working on a turn Backroom did not start already shows as working (`externalActivity`).

**Hide subagent threads in the sidebar.** A thread a member created with `delegate_task` is listed in Backroom's [sidebar](../../web/src/components/Sidebar.tsx) as a loose thread of the project (seen on 3 October: “Tool check · Antigravity” under the backroom project). T3's own list leaves these out. Leave out of the sidebar's thread list, and its settled list, every thread whose `lineage.relationshipToParent` is `subagent`. The parent member already shows it as “subagents running”. This fix does not depend on the rest of the stage and can ship first.

Unchanged: turns Backroom starts, turns the user types in T3, and briefings. `member.message` posts, like `t3.turn` today, are not delivered in briefings and do not satisfy prerequisites. Members read them with the stage 2 command.

Files: [scheduler](../../src/scheduler/scheduler.ts), [adapter](../../src/adapter/http.ts), [adapter types](../../src/adapter/types.ts), [domain types](../../src/domain/types.ts), [database](../../src/db/database.ts), [repositories](../../src/db/repos.ts), [page types](../../web/src/types.ts), [Timeline](../../web/src/components/Timeline.tsx) (show the new kind as a plain row until stage 4), [Sidebar](../../web/src/components/Sidebar.tsx).

Done when the trial in “What was tried” is repeated and the room's timeline shows every message of it, in order, each with sender and receiver, and the interrupted turn marked interrupted.

### 2. One command for what T3's tools cannot reach

*Part: the board.* Needs: stage 1.

A `bin/rooms-board` command, built like [`bin/rooms-browser`](../../bin/rooms-browser.mjs): a thin client that calls Backroom's server. The caller identifies itself with the same `--as` key `rooms-browser` uses, which names the member and the room. Every command works within that room only.

| Command | Does |
| --- | --- |
| `index` | Lists the room's posts, newest last: number, kind, sender, receiver, outcome, size in characters. No bodies. `--after <number>` lists only later posts |
| `read <number>…` | Prints the exact saved text of those posts. A post longer than 20,000 characters is printed in pages; the output says how many pages there are, and `--page <n>` prints another |
| `members` | Lists the room's seated members with alias, model and thread id, and which one is the Consigliere |
| `crew` | Lists the user's saved crew by name, with model and role |
| `seat <saved crew name>` | Seats that saved crew member in the room and prints the new member's alias and thread id |
| `help` | Prints this list |

`seat` uses the existing `participant.fromPreset` command. Sending, waiting, steering and interrupting are not here; they are T3's.

Add one line to today's briefing, under the browser section, saying how to call `rooms-board`. That also fixes an existing gap: a briefing over its budget (`ROOMS_BRIEFING_BUDGET`, 60,000 characters) shortens old messages with “full text available in the room”, and no member can read the room.

Files: `bin/rooms-board` and `bin/rooms-board.mjs` (new), a new `src/app/board.ts`, [server routes](../../src/server/http.ts), [briefing assembler](../../src/briefing/assemble.ts).

Done when a member can list and read the posts of its own room by number, cannot name a post of another room, and can seat a saved crew member who then appears in `members`.

### 3. The Consigliere

*Part: the Consigliere.* Needs: stage 2.

**Designation.** A room records at most one member as its Consigliere. A new command sets, moves or clears it; the user can designate any seated member. Retiring the designated member clears it. The designation carries no model or preset of its own.

**For new conversations.** One new app-wide setting holds the id of one of the user's saved crew, or nothing. A new command starts a conversation: it creates a room in the given project, titled with the first 40 characters of the user's first message, seats that saved crew member through `participant.fromPreset`, designates him, and delivers the message to him. Record the intended room, member and command ids before calling T3, so a retry recovers the same attempt. Deleting the saved crew member the setting points to asks first, then clears the setting; seated Consiglieri stay.

**The Consigliere's rules.** Backroom already writes a briefing around every message it delivers to a member. For the designated member, that briefing carries these rules, where a role's rules go today:

- Treat the user's latest message as the objective.
- Work through this room's members only. Find them with `rooms-board members`; seat more with `rooms-board seat`. Never send work to a thread that is not a member of this room.
- Hand the user's work to members, not to subagents of your own. A subagent of yours forgets everything after one job and is not on the board. This is about how you hand out work; it does not restrict the members.
- Give follow-up work to the member who already has the context. Seat another only when you need another person or a fresh view.
- Give work with `t3_thread_send`. An assignment is self-contained: the job, what to return, the user's instruction quoted exactly with its post number, and the numbers of the posts to read. Do not paste what a post number can point at.
- Wait with `t3_thread_wait`, with a timeout of ten minutes, and wait again if it times out. When several members are working, wait on each in turn. Do nothing else between waits. If a message interrupts your wait, deal with it and wait again.
- Read answers with `rooms-board read` or `t3_thread_read`.
- A new message from the user outranks everything. If it conflicts with running work, interrupt that work with `t3_thread_interrupt` before sending the replacement. If it only adjusts it, steer.
- Let members inspect and challenge each other. Ask targeted follow-ups, not a replay of every answer.
- Before telling the user the members agree, put one proposal to them by post number and get an explicit reply from each.
- In the report, cite the post where each member stated its position, quote objections in the member's words, and name anyone who did not answer.
- You decide how many rounds a discussion needs. When another round would not change anyone's position, stop and report what is unresolved. Never manufacture agreement.
- Do not edit files. Give research and execution to the workers.

**The seat briefing.** A message from one member to another arrives bare, so in a room that has a Consigliere, Backroom sends each other member its standing facts once, as that member's first turn, and asks for a one-line acknowledgement:

- Its name, role, folder and branch, and the rules for sharing that folder.
- The room's members, and who the Consigliere is.
- How to call `rooms-board`.
- A message from the Consigliere is an assignment on the user's behalf. A message from another worker is that worker's statement. To ask the Consigliere something, send it to his thread with `t3_thread_send`. End each answer with the usual Handoff.
- Inside your own task you may use subagents freely, your harness's own or T3's `delegate_task`, for parallel or supporting work. What they produce is yours to check and report.

It is sent when a member is seated in such a room, by the user or by `rooms-board seat`, and to every member already seated when a room gets its first Consigliere. `seat` does not wait for the acknowledgement; T3 queues whatever is sent next. When the designation moves, every member is sent one line naming the new Consigliere.

**Who may seat.** In a room that has a Consigliere, `rooms-board seat` is refused for any other member.

**Warnings on designation.** The page warns, and still allows it, when the user designates a member:

- whose interaction mode is plan, or whose runtime mode is `approval-required`: he would be stopped at every `rooms-board` call;
- on a harness other than Claude, Codex or Antigravity: T3's tools are unconfirmed there.

Files: [commands](../../src/domain/commands.ts), [room service](../../src/app/service.ts), [domain types](../../src/domain/types.ts), [database](../../src/db/database.ts), [repositories](../../src/db/repos.ts), [briefing assembler](../../src/briefing/assemble.ts), `src/app/board.ts`.

Done when the user designates a member, tells him “research this with two others and bring me the result”, and the request runs end to end with every message between members on the timeline.

### 4. The page

*Part: the page.* Needs: stage 3.

**Starting.** Each project's “new” menu in the [sidebar](../../web/src/components/Sidebar.tsx) gains “Talk to the Consigliere”, shown when the setting names one. It opens an empty chat; sending the first message runs the stage 3 command. The room then appears in the room list like any other.

**Routing.** In a room that has a Consigliere, a message with no `@` goes to him. Today the [parser](../../src/parser/explicit.ts) treats such a message as incomplete; with a Consigliere it becomes an assignment to him. If he is working, it is delivered as a steer, the same as `/steer` today, so it reaches him while he waits. Mentions, notes and scheduling syntax keep their meaning. `@all` excludes him.

**Two panels,** in a room that has a Consigliere:

- **The Consigliere chat.** The user's messages to him and his replies to them, oldest first, with the composer under it. It is a view of the board: every message in it is a room event, and nothing is stored for the chat alone.
- **The board.** Every post in the room, oldest first. Each turn is one row: sender, receiver, the first line of what was sent, the state (working, completed, interrupted, failed), and the answer underneath when it arrives. `member.message` posts that share the turn's T3 run id (steers, questions, answers) show inside the row. The user can post here to any member with `@`.

On a wide screen the chat is on the left and the board on the right. On a narrow screen the chat shows first, with a button to switch to the board. A room without a Consigliere shows the board alone, with the composer, and works as today.

**The Tasks tab** in the [side panel](../../web/src/components/Inspector.tsx) is removed in rooms that have a Consigliere; the board covers it.

**Controls.** In Settings, the Consigliere setting: a picker over the user's saved crew, with “none”. In a room's member list ([Crew](../../web/src/components/Crew.tsx)), on each member: “Make Consigliere”, and on the designated one a marker and “Remove as Consigliere”, with the stage 3 warnings. Stop on any working member, as today.

**Notifications.** The user is notified when the Consigliere replies to them. Other activity follows their existing notification settings.

Files: [App](../../web/src/App.tsx), [Sidebar](../../web/src/components/Sidebar.tsx), [Composer](../../web/src/components/Composer.tsx), [Timeline](../../web/src/components/Timeline.tsx), [Inspector](../../web/src/components/Inspector.tsx), [Crew](../../web/src/components/Crew.tsx), [AppControls](../../web/src/components/AppControls.tsx), [page types](../../web/src/types.ts), [notifications](../../web/src/news.ts), [parser](../../src/parser/explicit.ts).

Done when a conversation started from the sidebar shows the chat and the board, an unaddressed message reaches the Consigliere while he waits, and a room without one looks and works as today.

## Verification

**App tests,** with the fake adapter and the existing room, scheduler, briefing and parser tests:

| Stage | Scenario | Required result |
| --- | --- | --- |
| 1 | An agent-sent message appears in a member's thread | One `member.message` event with speaker, `to` and text; seeing it again adds nothing |
| 1 | Its sender's thread is not a member of the room | Recorded as from outside the room, with the thread's title |
| 1 | That turn completes; another is interrupted | `t3.turn` with outcome completed; `t3.turn` with outcome interrupted |
| 1 | A steer into a turn Backroom started | Recorded as a `member.message` |
| 1 | A turn the user typed in T3 | Recorded as today |
| 1 | A thread whose lineage says subagent | Not listed in the sidebar, active or settled |
| 2 | `index`, then `read` a post by number | The list; the exact text |
| 2 | `read` a post longer than a page | The first page and the page count; `--page 2` prints the next |
| 2 | An `--as` key of another room | Only that other room's posts; never this room's |
| 2 | `seat` a saved crew member | One new member, listed by `members` |
| 3 | Start a conversation; retry; restart | One room, one Consigliere, one recovered attempt |
| 3 | A message Backroom delivers to the Consigliere | Its briefing carries his rules |
| 3 | Seat a member in a room with a Consigliere | Its first turn is the seat briefing |
| 3 | Designate a Consigliere in a room with two members | Both others get the seat briefing |
| 3 | A worker calls `seat` in a room with a Consigliere | Refused |
| 3 | Retire the designated member | The room has no Consigliere |
| 3 | Delete the saved crew member the setting points to | Asked first; the setting is cleared; seated Consiglieri stay |
| 4 | Plain text in a room with a Consigliere, idle and working | An assignment to him; a steer to him |
| 4 | Plain text in a room without one | Incomplete, as today |
| 4 | `@all` in a room with a Consigliere | The workers only |

**The Consigliere's judgement** is measured, not tested. Give the same real request, one with research, cross-review and disagreement, to each saved crew member the user wants to compare, and score:

- Does the report keep every material objection, with its author?
- Does every agreement it reports hold up against the posts it cites?
- Did he send the right members the right posts?
- Did he stop when the discussion stopped moving?
- What did it cost?

**After each stage:** run `npm run check` and `npm run build:web`, then try it in one room with real members and read the board.

## Known limits

- **Tried once, small.** On 3 October 2026 a Codex Consigliere (Sol) seated two saved crew (Gemini on Antigravity, Astra on Codex), asked each a question, showed each the other's answer by post number, and reported with post numbers. Every message and answer was on the board. A message from the user while he waited reached him inside his turn, and his report covered it. Cost: $0.34. The longest wait was under a minute, so a wait over ten minutes is still untried, and so is a discussion where members disagree.
- **A restart ends a wait.** If T3 or the Consigliere's session restarts while he waits, nothing wakes him. The work the members were doing is still on the board; the user tells him to carry on.
- **Anyone can send.** T3 gives every member the same tools, so a worker can send work to another member. The board shows it, with its sender. Backroom does not prevent it.
- **Cursor is untested.** It was not signed in when the tools were tried.
- **Bare messages rely on memory.** A member's standing rules are in its seat briefing, not repeated with each assignment.
- **Members' threads grow.** Keeping context means each member's thread gets longer and each turn costs more, until its harness compacts it. Spend per member is shown, as today.

## Out of scope

Coordination across rooms, search by meaning over all history, limits on rounds or spend, Backroom's own assign, wait, steer and interrupt tools, and moving the scheduler from polling to V2 subscriptions.

## Settled

1. T3's tools do the acting. Backroom records and shows.
2. The board is a record. Backroom records no votes, computes no agreement and sets no limits. The Consigliere reports, citing posts.
3. The user chooses the Consigliere from their own saved crew, or designates any seated member. Backroom ships no preset and names no model.
4. The user starts by talking to the Consigliere. He seats the others as members, never as his own subagents, so they keep their context. Any member may still use subagents inside its own task.
5. He assigns at once, with no confirmation step. The board shows it, and the user can stop it.
6. `@all` means the workers, never the Consigliere.
7. The room has two panels: the Consigliere chat, and the board it is a view of.
