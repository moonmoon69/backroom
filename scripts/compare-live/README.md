# compare-live: the real comparison (plan stage45, items R0 and Z1)

The old runtime and the new one, run with real Claude members on the live T3, on the same four small tasks, measured
the same way from T3's own records. R0 builds this and measures the old side (8 jobs); Z1 runs both sides against the
gate registered here in `gate.json`. The plan is `backroom-handoff/stage45-plan.md`; this file is the operating manual
and holds the pass rules, written before any paid run.

## Pieces

| File | What it is |
|---|---|
| `tasks.ts` | The four prompts, byte-identical on both sides, the members each task seats, the JOB-DONE line rule |
| `fixture/` | The template of the repository the jobs work in ("tally", a tiny TypeScript CLI with planted defects) |
| `setup-fixture.ts` | Builds `~/Projects/backroom-compare/fixture` from the template: one commit, tagged `fixture-v1` |
| `checkers.ts`, `checkers/` | The task checkers: hidden tests kept outside the fixture, run on copies of a job folder |
| `reference/` | Reference solutions: each checker fails on `fixture-v1` and passes with these |
| `instance.ts` | Drives one Backroom instance over HTTP: `LegacyInstance` (the old runtime's API) and `EngineInstance` (ROOMS_ENGINE=1: the journal through L4a's message path and L4c's read API); the runner picks one per side |
| `campaign.ts` | Paths, the crew, the job record, the spend cap |
| `run.ts` | The runner: one job after another, or `--dry` on two fake instances |
| `t3.ts` | Reads of T3 itself (HTTP, its state database) and the copies taken at each job's close |
| `measure.ts` | Measures the jobs, writes `report.md` and `report.json`; `--verify`, `--register-gate`, `--verdict` |
| `tokens.ts` | What a thread's calls used, from T3's state rows and the raw Claude transcripts, with list price |
| `rawsum.mjs` | The accuracy check's own token reader, sharing no code with `tokens.ts` or `measure.ts` |
| `gate.ts`, `gate.json` | The Z1 gate: G1–G3, the relabelling, N and K from R0's spread; registered values |
| `verdict-report.ts` | What `verdict.md` carries beside the gate (reporting only, read from the evidence and the measures): the behaviour checks on the new side, the rules each side delivered with their diff, the briefing bytes per delivered turn, and every run's numbers (report.md, embedded); a hand-written classification of failed checks, `<campaign>/behaviour-notes.md`, is included when present |
| `*.test.ts` | `node --no-warnings --test scripts/compare-live/*.test.ts` |

## Setup

1. Instances. Each runs from its own worktree, with its own `data/` (a link into `~/Projects/backroom-compare/<side>/data`,
   which starts empty except a copy of the T3 credential `t3-auth.json`, mode 0600), its own port, and browsers off.
   Never the user's service on :4400, never a copy of its `rooms.sqlite`.

   ```sh
   # old: the B commit
   git worktree add --detach ../backroom-wt/compare-old 2fe156a8 && (cd ../backroom-wt/compare-old && npm install)
   mkdir -p ~/Projects/backroom-compare/old/data && install -m 600 data/t3-auth.json ~/Projects/backroom-compare/old/data/
   ln -s ~/Projects/backroom-compare/old/data ../backroom-wt/compare-old/data
   cd ../backroom-wt/compare-old && ROOMS_PORT=4481 ROOMS_BROWSER_MODE=off ROOMS_SPEECH=off npm start
   # new (Z1): the engine head, with the harness deleted from that checkout, so the checkers and reference solutions do
   # not sit beside the board command its members run; data starts fresh (a journal from before L6 does not load)
   git worktree add --detach ../backroom-wt/compare-new engine && rm -rf ../backroom-wt/compare-new/scripts/compare-live
   (cd ../backroom-wt/compare-new && npm install)
   mkdir -p ~/Projects/backroom-compare/new/data && install -m 600 data/t3-auth.json ~/Projects/backroom-compare/new/data/
   ln -s ~/Projects/backroom-compare/new/data ../backroom-wt/compare-new/data
   cd ../backroom-wt/compare-new && ROOMS_ENGINE=1 ROOMS_PORT=4482 ROOMS_BROWSER_MODE=off ROOMS_SPEECH=off npm start
   ```

   The runner refuses an instance whose worktree contains `scripts/compare-live` (paid jobs and the dry run), and a side
   whose instance runs the other runtime (the new side's room snapshot must say `engine: true`, the old side's must not).

   Because `data/` is the worktree's default data folder, the board command in each instance's briefings is that
   worktree's `bin/rooms-board`, which reads `../data/browser-api.json` beside itself: members reach their own instance.
2. Fixture: `node scripts/compare-live/setup-fixture.ts` (run again, it checks the tag against the template).
3. Jobs: `node scripts/compare-live/run.ts --campaign r0 --side old --jobs T1:1,T2:1,T3:1,T4:1` (the new side:
   `--side new`, driven by `EngineInstance`).
4. Measure: `node scripts/compare-live/measure.ts --campaign r0` (the accuracy check always runs; exit 1 on a difference).

Evidence and reports go to `~/Projects/backroom-handoff/compare-live/<campaign>/`; nothing lives in /tmp.

## A job

1. **Cap.** The campaign's measured spend so far (every job's threads, seating included, whatever the job's outcome;
   list price from T3's price table, read live with `tokens.ts` in its strict mode: a missing price table, or a call
   with tokens on a model the table has no rate for, stops the runner instead of costing $0) is added up; at or above
   the cap, no job starts. R0: $100. Z1: 1.5 × Z1's job count × R0's median job cost, never above $250 without the
   user's OK (`gate.json` → `fromR0.z1CapUsd`). The runner takes the cap from there; a `--cap` above it, or above $250,
   is refused unless `--user-ok "<where the user agreed>"`.
2. **Folder.** A fresh clone of the fixture at `fixture-v1` in `~/Projects/backroom-compare/jobs/<random id>/tally`, on a
   branch `main`, with no remote, registered as its own throwaway T3 project `tally-<id>`. The path does not say which
   side the job is on. T3 can take the project and still answer the command with a failure (a timeout under load: two
   R0 jobs and R1's first smoke attempt aborted so, at $0); the runner then takes T3's project for that fresh folder
   and title, as the instance lists T3's projects, with a note in `job.json`.
3. **Seating** (measured apart from the job). Saved crew on the instance: `Fable` (claude-fable-5-1, effort high, 1m
   context) as the Consigliere, `Opus` (claude-opus-5-5, effort xhigh, fast mode off, 1m context) for the members; full
   access; the project folder. The room is created with the Consigliere; W1 and V are seated (W2 too in T4). The runner
   waits until the seat briefings are answered, every seat is idle in T3 and nothing is pending. On the new side,
   creating a member from the saved crew seats it on the journal (L4b), nothing is seated by hand; the Consigliere is the
   journal's orchestrator and gets no seat briefing, each member one (`seat-briefing:<seat>:seated`), the same shape as
   the old side's (R0: the Consigliere 0 seating turns, each member 1). Seating is over when every member's seat
   briefing is answered and the quiet rule's instance half (below) holds.
4. **Prompt.** The task's prompt is posted once, as the user, the way the page's composer posts it. The time just before
   the post is `postedAt`, the start of the job window. On the new side: the draft from `/parse` (in a room with a
   Consigliere, his whole text, steered), then `message.create` with a client message ID recorded in `job.json`
   (`message`) before the send; a send that fails on the way is sent again under the same ID, which records it once. The
   driver refuses a draft that is not the whole prompt to the Consigliere, and checks the journal recorded one request to
   him whose body is the prompt byte for byte.
5. **Watching.** Every 2 s the runner reads the board. At each member answer and at the Consigliere's report it copies
   the job folder (without `node_modules` and `.git`, keeping the files' modification times) and runs the task's checker
   on the copy. At the report it reads T3 for the report message's own time, which the board's lags (by 2 to 58 s in
   R0): T3's slow-check log is judged up to T3's time, and the accuracy check fails a job whose report copy holds a file
   changed after it (for R0's copies, which kept no times: the copy must equal the last answer's copy before it). Every 10 s it samples T3's
   thread list for other threads with an active run (the overlap).
6. **The report** is the first message from the Consigliere to the user with a line that says `JOB-DONE`: the line, with
   list, quote or heading marks, emphasis and closing punctuation taken off, is exactly `JOB-DONE`. On the old side that
   is a Consigliere reply (`assistant.reply`) on the board; on the new side any post of his that is what he said: an
   output, whatever it came to (an answer to the user's request, a yield because that request was answered earlier,
   progress), or the note of a T3 turn the room did not start. measure.ts finds the same message in T3 as the final
   message of a Consigliere run, on both sides. His earlier replies ("work handed out") are not reports. A report given
   through `rooms-board answer`, or through his own `rooms-board note` (new side: once the user's request is closed, a
   note is the board's way to the user, since members cannot post to the user), is no T3 message: the runner records it
   (`report.via: "answer"` or `"note"`) and fails its check instead of taking a time from another clock, and the
   accuracy check fails the job. It is seen, not missed: a missed one would run to "no report" and pass as a plain
   failure of that side.
7. **Close.** After the report, the room is quiet when, at the same moment: no job thread (the seats' and any T3 thread
   they started: same project, or a seat as its root) has an active run in T3, none has a pending approval or question
   in T3, none has background work in T3 (its pending background tasks: subagents, commands, monitors), and the
   instance has no pending work (old side: no task queued, dispatching, running
   or waiting on input; new side: the journal's two counts, no unread addressed input and no unresolved run, a run in
   any phase but terminal, rejected included, plus no open approval or question the instance holds, and the instance
   reached T3 for that read; never the busy or waiting figures, which miss runs that are not a seat's active run). Each
   sample reads T3 and the instance afresh; a read that fails is a sample that is not quiet. The window closes after 3
   minutes of continuous quiet; every sample is in `quiet.jsonl` (new side: with the journal's head, its open requests
   and its pending activities, which do not hold the window open by the plan's rule, for Z1's behaviour checks). It
   closes as "did not quiesce" 30 minutes after the report, counted from T3's time of the report message on both sides
   (the board's time only when T3's is not known, as in the dry run), and as "no report" 60 minutes after the post
   without one.
   (The background-work condition and the 60-minute cap are additions to the plan's wording; both apply to both sides.)
8. **Evidence**, copied at the close: a final copy of the folder (with `.git`) and its check; `final.diff` against the
   tag; T3's detail of every job thread (`t3/<thread>.json`, `t3/threads.json`); T3's state-database rows for them
   (`t3/state-subset.sqlite`: threads, runs, provider threads, messages, subagents, requests); the raw Claude transcripts
   of every session started in the job folder, subagents included (`transcripts/`, Claude Code prunes the originals);
   the room snapshot with the instance's runs and the briefings it sent (`instance-room.json`; new side: the read API's
   snapshot, every post, with each run's `EngineRunDetail`, its frozen briefing); T3's version at start and
   end; then `measure.json`. Job threads are the seats' threads plus any T3 thread they started (same project or lineage).

## Pass rules (fixed before any paid run)

Each checker is a set of parts; a part passes when its hidden test file exits 0 on the copy (or its text rule holds).

| Task | Prompt | Checker parts | Correct (the job) | Member's own parts (early answers) |
|---|---|---|---|---|
| T1 | one member finds `src/cli.ts`'s imports and the unused one with a subagent | `facts`: the report names node:fs, args, text, format, dates, legacy and types; contains `cli.ts:6`; has a block (text between blank lines) naming legacy as unused | the JOB-DONE report passes `facts` | W1 or W2 (whichever answers): `facts` on its answer |
| T2 | W1 fixes the failing test in `src/dates.ts`, V reviews | `monthEnd` (the visible defect), `leapYear` (the second defect in the same function, covered by no visible test) | the final tree passes both, and V reviewed before the report: an answer of V's on the board, before the report, whose folder copy already had the visible defect fixed (so there was a fix to review) | W1: `monthEnd`, `leapYear` |
| T3 | W1 runs `npm run slow-check` (~3 min) in the background, fixes it, reports when it passes | `catalog`: the catalog rules hold on the tree, no entry deleted; `slowCheckLog`: in `.slow-check.log` up to the cutoff, the last run finished and passed, none in progress | the final tree passes `catalog`, and `slowCheckLog` passes read up to T3's time of the report (the report came after the last slow-check finished) | W1: `catalog`, `slowCheckLog` (cutoff: the answer's time) |
| T4 | W1 adds `slugify`, W2 adds `--json`, in parallel; V reviews both | `slugify`, `json`, and on the report `reportCoversBoth` | the final tree passes `slugify` and `json`, and the report covers both | W1: `slugify`; W2: `json` |

- **Premature report** (gated by G1): the checker failed on the copy taken at the JOB-DONE report (T1: the report text;
  T3: including the log read up to T3's time of the report, so a report before the last slow-check finished is
  premature). The log is judged run by run: the last-started run must have finished and passed, and no run may still
  be in progress (runs can overlap).
- **T1's facts** are matched leniently on purpose: each module's name (bare or as `args.ts`, `./args.ts`, …), the line
  `cli.ts:6`, and one block of text (between blank lines) that names legacy and calls it unused. A false negative would fail a correct report, and count as
  premature, for whichever side phrased it that way (which G1 gates); a false positive only misses a rare wrong report.
- **Early member answers** (reported, not gated): a member's answer while its own parts failed on the copy taken then.
  Reviewers' answers are not checked. On the old side every member turn end is an answer. On the new side what counts
  is the same: every post that is what the member said (an output, whatever it came to: a run's final, an explicit
  `rooms-board answer`, a continuation, an idle settle; or the note of a T3 turn the room did not start), so T2's "V
  reviewed before the report" is judged on the same kind of post on both sides. Each new-side copy also records how
  the post came (`via`) and what its claims came to (`claims`), for Z1's behaviour check of answers that closed a
  request while the member's part failed. T1's part is judged on the
  answer's text, so once a member has given the facts its later answers are not early (added after the first R0 job,
  where W1's after-report "nothing left to do" was flagged; information only).
- T2 also reports, for information, whether there was a correction after V's review: `src/dates.ts` in the report's
  copy differs from the copy V reviewed. The plan read "V's review, then W1's correction"; a W1 who fixes both defects
  at once leaves V nothing to correct, so the gate needs only V's review before the report and the tree right.
- **Wall-clock to the first pass**: from the post to the first copy (answers and report) that passed the checker.

## What is measured (measure.ts, from T3's records only)

Window: `postedAt` to the close. Seating: everything before `postedAt`, reported apart. Per seat and per job:

- **turns**: T3 runs requested in the window on every job thread (the seats' and any T3 thread they started, the
  threads tokens are counted on), until and after the report;
- **wakes**: the Consigliere's runs in the window minus the one the post started; after-report wakes listed apart;
- **tokens**: fresh input, cache read, cache write, output, calls and list-price cost (T3's price table; writes to the
  1-hour cache at its own rate), by `tokens.ts`
  over the copied transcripts and state rows, each message counted once with its final usage (see "Recomputing one
  job"); `tokens` in the gate is all four kinds summed over every job thread;
- **peak context**: the thread's largest single call of its own in the window;
- **briefing bytes per delivered turn**: the user messages T3 recorded for each run in the window, cross-checked byte for
  byte against the instance's own record of what it sent in the window (old side: `runs.briefing` against the message
  with the run's `messageId`; new side: each host run's frozen briefing, `EngineRunDetail.briefing`, against the message
  T3 started its T3 run with, the run's `userMessageId`, in the window by that T3 run's `requestedAt` as turns are);
- **wall-clock** to the report and to the checker's first pass; **correct**, **premature**, **early member answers**;
- **other activity**: threads outside the job running at any point in the window, sampled live and recounted from T3's
  state database; a job with any is marked in the report.

**Accuracy check** (always run by `measure.ts`; non-zero exit on any difference, and `--register-gate` and `--verdict`
refuse while there is one): for every job thread, `rawsum.mjs` sums the same
transcripts by message id (sessions found with the `sqlite3` CLI) for the job window and for seating, and must equal
`measure.ts`'s four totals; the `sqlite3` CLI counts the runs in the window from the state rows and must equal the turns
read from T3's thread detail; a message id whose copies differ in input or cache figures is reported. It also fails
when the report the runner saw on the board and the one measure finds in T3 differ (one missing, or more than a minute
apart), when a briefing sent and received differ, when T3's detail of a job thread is partial, when a job thread's run
was still active at the close, or when a seat has turns but no calls (its session not found). It also fails when a job
thread has no T3 record in the evidence, when a call on a model with no price was counted at $0, when a usage copy has
no readable timestamp, when one message id is counted on two threads, when a transcript in the job folder's project
belongs to no job thread, when the report's copy is newer than T3's report (see step 5), when any job transcript
mentions `scripts/compare-live`, `backroom-handoff`, the fixture repo or another job's folder (a leak), when the
briefing cross-check compared no turn on a job with turns, and when the report came through `rooms-board answer` or
`rooms-board note` (new side: no T3 message carries it). A Consigliere
final that mentions JOB-DONE without a line that says it is not a report; the report warns about it.

**When the accuracy check fails.** Any difference blocks `--register-gate` and `--verdict`, including the report-copy
check, which can fire on a harmless edit made in the board's lag window (likeliest during the old runtime's
after-report wakes). Then there is no verdict: the differences are in `report.md` for the user to see. A job may be
re-run under the same label only when its evidence failed (a difference in what was recorded, never its results), and
only with the user's OK. The earlier attempt's `job.json` gets `"status": "superseded"` and a note naming the OK; both
attempts stay in the campaign folder, and the report lists the superseded one, with its spend, among the jobs not
measured. `--register-gate` needs
exactly 2 closed old jobs per task; `--verdict` needs N closed jobs per task and side.

## Recomputing one job by hand

From a job folder `J=~/Projects/backroom-handoff/compare-live/r0/jobs/<job>` (or the live sources: `~/.t3/userdata/statev2.sqlite`
and `~/.claude/projects`). Take `postedAt` and `closeAt` from `$J/job.json` and a thread id from its `seats`.

```sh
DB=$J/t3/state-subset.sqlite   # or ~/.t3/userdata/statev2.sqlite
P=$(jq -r .times.postedAt $J/job.json); C=$(jq -r .times.closeAt $J/job.json)
# turns of one thread in the window
sqlite3 -readonly $DB "select count(*) from orchestration_v2_projection_runs where thread_id='$T' and requested_at >= '$P' and requested_at <= '$C'"
# its Claude session
S=$(sqlite3 -readonly $DB "select json_extract(payload_json,'$.nativeThreadRef.nativeId') from orchestration_v2_projection_provider_threads where thread_id='$T'")
# four token totals in the window: the session file and its subagents; each message id once, with the largest output
# of its copies, at the time of its first copy
find $J/transcripts -path "*$S*" -name '*.jsonl' | sort | xargs cat | jq -s --arg p "$P" --arg c "$C" '
  map(select(.message.usage? and (.message.id|type)=="string" and (.message.model|type)=="string")) | group_by(.message.id)
  | map({at: (map(.timestamp)|min), u: (max_by(.message.usage.output_tokens // 0).message.usage)})
  | map(select(.at >= $p and .at <= $c) | .u)
  | {input: (map(.input_tokens // 0)|add), cacheRead: (map(.cache_read_input_tokens // 0)|add),
     cacheWrite: (map(.cache_creation_input_tokens // 0)|add), output: (map(.output_tokens // 0)|add)}'
```

Why the largest output: Claude Code writes a message once per content block, all under its id. In a session's own
transcript every copy carries the same usage; in a subagent's transcript the copies are written while the message
streams and only the last carries the final output count (found on the first R0 job: 19 output tokens first-seen
against 2,076 final). Input and cache figures never differ between copies; `--verify` reports any id whose copies
differ in them. ThreadCosts (`src/usage/threadCosts.ts`, the page's spend figures) keeps the first copy and so
undercounts subagents' output; the comparison reads tokens with `tokens.ts` instead. Compare with `measure.json` →
`seats[]` (`turns`, `tokens`).

## The dry run

`node scripts/compare-live/run.ts --dry` starts two `ROOMS_ADAPTER=fake` instances from `compare-old` and `compare-new`
(ports 4491 and 4492, fresh data under `~/Projects/backroom-compare/dry/`; the new one with `ROOMS_ENGINE=1`, driven by
`EngineInstance`, which refuses it unless its snapshots say `engine: true`), runs the four tasks on each (seat, post, watch,
snapshot and check, quiet, evidence, measure), then stops them; `measure.ts --campaign dry --verify` measures them. A fake
agent cannot write JOB-DONE or use the board, so the dry run plays the Consigliere's part: after his first reply it posts
one piece of work to each member with his board key, and his first reply after all of them have answered is the report.
Fake threads have no transcripts or state rows: the token check is real only from the first paid job on, and the turn
check compares T3's runs (the fake's) with the instance's own run records (new side: the journal's host runs with the T3
run each was matched to), and on the new side the briefing cross-check must compare every turn. The quiet period is 20 s
(`--quiet-ms`). In board order the report is a post numbered after every member's answer.

## Limits

- The hidden tests and reference solutions live in this repository, which the members do not work in; a member that
  went looking through other folders on the machine could find them. The job folder's path and the T3 project's name do
  not say which side a job is on; the board command in the briefings does (`compare-old`/`compare-new`).
- The crew is Claude only (Codex is out of quota until 2026-10-14; Cursor is not signed in).
- Post times differ in kind between the sides. The old side's are the instance's record of a post, which lags T3 by 2
  to 58 s; the new side's are T3's exact time of the turn a post stands for (the run's end), or for a post without one
  (an explicit `rooms-board answer`, an idle settle) the runner's first sight of it, within one 2-second poll. The gate
  does not read them: wall-clock to the report is T3's message time on both sides (measure.ts), and a report T3 has no
  message for fails the job. They do feed information-only figures: wall-clock to the first pass, and the slow-check
  cutoff of a member's answer in T3 (on the new side earlier, so stricter, than the old side's lagging time). T2's
  "V reviewed before the report" compares two times of the same side; on the new side a review V gave with
  `rooms-board answer` is timed at its first sight, so a report within that one poll of it would not count as after it
  (a Consigliere woken by the answer needs a whole turn first).
- The copies at member answers are taken when the board shows the answer, and only the report's copy has a file-time
  guard. The old side's board lags T3 by 2 to 58 s, so on the old side W1 has that much more time to change the folder
  before V's copy is taken, and T2's "V reviewed a fixed tree" (the visible defect fixed in V's copy) can only be easier
  on the old side.
- Other rooms share the account's rate limits; overlap is recorded per job.
- T1's facts check is lenient text matching (see the pass rules): a report could pass it while wrong in substance, e.g.
  calling a second import unused or saying nothing else is used. A correct report fails only if it never names legacy
  and calls it unused within one block of text (between blank lines). Both R0 T1 reports were read in full and are right.
- JOB-DONE near misses ("JOB-DONE:", "Status: JOB-DONE", "JOB-DONE ✅") are not reports: such a job runs to the
  60-minute "no report" close, and the report warns about it. None happened in R0.
- T2's rule, as decided by the Consigliere (board #411): V's review comes before the report; "review, then correction" in that
  order is not required, so a run where W1 fixed both defects at once passes. T2 therefore mostly measures the review
  exchange, not defect-catching: the leap-year defect proved easy to spot (in R0 the Consigliere and a T1 report named
  it unprompted). This limit, with the plan's, is written into every Z1 `verdict.md` (`VERDICT_LIMITS` in measure.ts).
