# The engine core (lean)

The board's journal and the rules over it. Each room has one append-only event log; requests, answers, runs, cursors,
background work and subscriptions are folds of that log, never stored work of their own. The host in `src/runtime`
drives T3 from it, the orchestrator posts on it through `rooms-board` (L3; members only read it and
answer in their final replies, H5) and the user through the message API (L4a); the read API (`src/server/engineView.ts`) reads it. This is the core as carved in L6 of the stage 4/5 plan
("Lean semantics"): 18 commands, 21 event kinds, nothing about provider evidence; H6 added `keep_alive`, a 19th command
that writes a `notice`. Approvals, questions and Stop are not
on the journal: they stay on the native-requests path (`native_requests`, the service's respond calls, `interruptRun`).

Files: `types.ts` (the contract), `transitions.ts` (`decide`), `fold.ts` (`fold`), `delivery.ts` (who reads what),
`incremental.ts` (the overlay the store decides on), `store.ts` (`EngineStore`, SQLite), `index.ts` (exports).

## decide and fold

`decide(log, command)` returns `{ expectedSeq, events, outcome }` for one room's contiguous committed log. It does no
I/O, reads no clock, makes no random IDs and never changes its inputs. The caller supplies every ID and authenticates
the actor. `outcome` is `appended`, `duplicate` (this actor already issued this command ID: nothing new), `idle`
(nothing to do) or `blocked`; a refusal throws with the reason. The whole batch is appended or none of it. The first
event takes the command's ID, the others `<command ID>/<n>`; a command ID may not collide with an event ID or its prefix.

`fold(log)` rebuilds the projection: `seats`, `requests`, `runs`, `activities`, `subscriptions`, `sourceKeys` (an
output's source key to its event), `commandKeys` (`[actor, command ID]`), `blocked` (seat to the input that does not
fit) and `orchestrator`. All of it can be thrown away and rebuilt from the log.

Principals are seat IDs, `$user` and `$system` (the host, Backroom: it also asks a seat for itself, its seat briefing or a reseat's checkpoint).

There is no backward compatibility: every engine journal written before L6 must be recreated. One that holds an event
kind the carve dropped (any control, provider or protocol event; a mid-turn cancel used to write a control) does not
fold, and in one that does, the runs T3 accepted carry no `providerRunId`, so the host finds no T3 run for them (no
import baseline, no answer carrier, no times in the read API). Such journals exist only in throwaway and rehearsal data
folders.

## Commands

| Command | Who | What it records |
|---|---|---|
| `seat` | user or orchestrator | `seat.created`: a fresh seat on a fresh T3 thread, optionally the orchestrator (when there is none) |
| `retire` | user or orchestrator | `seat.retired`; refused unless the seat is quiet (below) and owns no open request; clears the orchestrator if it was |
| `designate` | user | `orchestrator.set` to an active seat or null; naming the current one is idle |
| `transfer` | user or orchestrator | `transfer`: a quiet seat's open owned and awaited requests (named exactly) and its unread input move to a fresh seat |
| `request` | a seat, the user or `$system` | `request` to a seat (or the user), optionally under a parent the author may act on; `$system`'s (Backroom's own: a seat briefing, a reseat's checkpoint) is to a seat, under nothing |
| `correct` | the requester, orchestrator or user | `correction` of an open request; it becomes the request's version |
| `cancel` | the requester, orchestrator or user | `cancel`; applied only to an open request. A run T3 rejected for the owner ends with it. Stopping a live turn is the host's: it sends T3 the interrupt (§6) |
| `post` | a seat or the user | `note` (wakes nobody) or `progress` (wakes only followers of its milestone), under requests the author owns |
| `subscribe` | a seat | `subscription` to a request's milestones, or its removal (since H5 the host subscribes the orchestrator to a member's request, so the member's follow-ups wake it) |
| `reserve` | `$system` | `run.prepared`: an idle active seat's unread input up to `maxBytes` (or `delivery.blocked`, once per input) |
| `phase` | `$system` | `run.phase`: prepared → sending → accepted → running, with uncertain and rejected; `providerRunId` (the T3 run) once T3 has taken it, never changed, never shared by two runs |
| `sync` | `$system` or the run's seat | `sync.offered`: the input that arrived since, for a live run (a steer), with its digest |
| `confirm_sync` | `$system` | `sync.confirmed`: T3 showed the offer; the run's watermark moves to its end |
| `output` | `$system` or the author | `output` of a run or an activity, with its claims (below); `terminal` ends the run; `activityCompletion` resolves the activity |
| `observe_end` | `$system` | `run.ended` for a run whose output is already imported, with the failure's bounded notice if it failed |
| `activity_start` | `$system` or the run's seat | `activity.started`: background work of a live run under open requests it carries |
| `activity_status` | `$system` | `activity.status` of a pending or uncertain activity |
| `retry` | user or orchestrator (never the run's own seat) | `retry` of a failed or rejected run: its delivered input goes to the seat again |
| `keep_alive` | `$system` | `notice` with intent `keep-alive` to one idle active seat (H6): it wakes the seat to keep its thread's prompt cache warm, asks nothing and answers nothing, and an error notice never counts it as fresh work |

A seat is quiet when it has no unresolved run and no pending or uncertain activity, and the command carries an
evidence reference.

## What an answer does

An `output` with disposition `answer` names requests its run may name (open at its watermark or carried by its
input; an activity's output, the activity's). Each gets one outcome:

- `late`: cancelled, owned by another seat now, or the author has retired;
- `already_answered`;
- `superseded`: something the member has not seen bears on it: a correction after the watermark, or an unread result or
  correction addressed to the seat whose request walks up `parentId` to it (K1). It stays open; the next run delivers it;
- `pending_activity`: an open child request or a pending or uncertain activity remains under it (the only blocking
  rule, `pendingWork`). It stays open and nobody is woken;
- `answered`: closed, and its requester is woken once (`$system`, Backroom, is woken by nothing: it reads the journal).

`progress` wakes only followers of the milestone; `yield` and `silent` answer nothing. `error` records one bounded
error notice per run or activity to the requesters of the fresh work it affected and the orchestrator (a failed request
of `$system`'s, a seat briefing say, to the orchestrator alone). An output the host
cannot tie to a run is recorded as `orphan`, with an attention notice. Input addressed to a retired seat gets an
attention notice to the orchestrator.

## Delivery

`inputFor(event, seat)` says what an event is to a seat: a request, correction, applied cancel, result (an answer
claim returning to it), progress (subscribed milestones), notice, transfer or retry. Notes and own posts are never
input. `unread` lists what is past the seat's cursor and still deliverable (`deliveryDisposition`: a retired seat's
input is undeliverable; a transferred seat's went with the transfer). `selectPrefix` takes the oldest whole inputs
within the byte budget and never skips an oversized one: that is `delivery.blocked`, which the host's 4 MiB budget
against the board's 1 MiB post limit keeps out of reach. A run's end moves the cursor to its watermark, which a
confirmed sync extends; an ended run that never took input (rejected, then cancelled or retried) does not.

## Release closure

Every unresolved state a command creates is released by a command (checked by `tests/engine/release-closure.test.ts`):

| Unresolved state | Created by | Released by |
|---|---|---|
| open request | `request` | `output` answer; `cancel` |
| request blocked by an open child | child `request` | the child's answer or `cancel` |
| request blocked by an activity | `activity_start` | `activity_status`; `output` with `activityCompletion` |
| run prepared, sending, accepted, running or uncertain | `reserve`, `phase` | `output` terminal or `observe_end`; `phase` |
| run rejected | `phase rejected` | `retry`; `cancel` |
| `delivery.blocked` | `reserve` or `sync` with one input over the budget | not reachable through the host; a larger budget |
| retired seat | `transfer` or `retire` | terminal by design; later input becomes an undeliverable notice |
| unconfirmed `sync.offered` | `sync` | `confirm_sync`; unconfirmed, it has no effect |
| subscription | `subscribe` | `subscribe enabled:false` |

The orchestrator is changed by `designate`, cleared by `retire` of the orchestrator and moved by `transfer`; it is not
an unresolved state.

## The store

`EngineStore` keeps every room's log in one dedicated SQLite file (an existing database with other tables is refused),
in WAL mode with `synchronous=FULL`. `execute(room, command)` takes `BEGIN IMMEDIATE`, decides against the committed
head and appends the whole batch in that transaction. Only `engine_event` is authoritative (append-only, enforced by
triggers); `engine_head`, `engine_command`, `engine_projection` and `engine_key` are derived and are audited against a
replay on a cold start or after a write the connection cannot explain, and rebuilt when they differ (`audit`,
`rebuild`). The same command ID with the same content returns its original batch (`replayed`); with other content it
is refused, and so is an output source key reused with other content. `engine_key` keeps the identities unique within a
room: thread, T3 run, dispatch command and message, a seat's unresolved run, sync receipt, answer claim and source key.
Each room's projection is cached and changed in place by an overlay of the entries a command touched, published only
after the commit; a published entry or event is never changed again (a decision copies an entry before it edits it).
`snapshot` hands out the committed projection as one shared object, deeply frozen (every write to it throws, a nested
one too; its maps and sets are read-only views, not Maps or Sets, so `Map.prototype` and `Set.prototype` cannot write to
them either) and never changed: the same object until the room's journal grows, built again on the first read after that,
so a read copies nothing. It is read in a transaction, so a foreign suffix or an unexplained write is found before it
is handed out, and a write that fails drops the cache and its snapshot with it. The host reads it, and so does the read
API through `EngineHost.view`; `project` returns a detached copy of it the caller owns, and `load` the events. Optional
boundary hooks exist for fault tests.

## Tests

`tests/engine`: the domain, interleavings, incident and seat-lifecycle suites (decisions), the store, store-fault,
store-snapshot and incremental suites (transactions, real-SIGKILL crashes, cache and index parity, the two reads),
`golden.test.ts` (every history recorded from the core before the carve replays with equal decisions and maps) and
`release-closure.test.ts`. `scripts/long-room.ts` times 2,000-note rooms and a host tick; `scripts/projection-tick.ts`
times host ticks over a room of 4,000 events and 60 seats (`tests/runtime/projection-reads.test.ts` keeps a tick from
copying the projection).
