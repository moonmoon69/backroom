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
| `instance.ts` | Drives one Backroom instance over HTTP (the old runtime's API; the new side's driver arrives with L4) |
| `campaign.ts` | Paths, the crew, the job record, the spend cap |
| `run.ts` | The runner: one job after another, or `--dry` on two fake instances |
| `t3.ts` | Reads of T3 itself (HTTP, its state database) and the copies taken at each job's close |
| `measure.ts` | Measures the jobs, writes `report.md` and `report.json`; `--verify`, `--register-gate`, `--verdict` |
| `tokens.ts` | What a thread's calls used, from T3's state rows and the raw Claude transcripts, with list price |
| `rawsum.mjs` | The accuracy check's own token reader, sharing no code with `tokens.ts` or `measure.ts` |
| `gate.ts`, `gate.json` | The Z1 gate: G1–G3, the relabelling, N and K from R0's spread; registered values |
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
   # new (Z1): the engine head, ROOMS_ENGINE=1 ROOMS_PORT=4482, the same way with new/data
   ```

   Because `data/` is the worktree's default data folder, the board command in each instance's briefings is that
   worktree's `bin/rooms-board`, which reads `../data/browser-api.json` beside itself: members reach their own instance.
2. Fixture: `node scripts/compare-live/setup-fixture.ts` (run again, it checks the tag against the template).
3. Jobs: `node scripts/compare-live/run.ts --campaign r0 --side old --jobs T1:1,T2:1,T3:1,T4:1 --cap 100`.
4. Measure: `node scripts/compare-live/measure.ts --campaign r0 --verify`.

Evidence and reports go to `~/Projects/backroom-handoff/compare-live/<campaign>/`; nothing lives in /tmp.

## A job

1. **Cap.** The campaign's measured spend so far (every job's threads, seating included, whatever the job's outcome;
   list price from T3's price table, read live with `tokens.ts`) is added up; at or above the cap, no job starts. R0: $100. Z1: 1.5 × Z1's job count
   × R0's median job cost, never above $250 without the user's OK (`gate.json` → `fromR0.z1CapUsd`).
2. **Folder.** A fresh clone of the fixture at `fixture-v1` in `~/Projects/backroom-compare/jobs/<random id>/tally`, on a
   branch `main`, with no remote, registered as its own throwaway T3 project `tally-<id>`. The path does not say which
   side the job is on.
3. **Seating** (measured apart from the job). Saved crew on the instance: `Fable` (claude-fable-5-1, effort high, 1m
   context) as the Consigliere, `Opus` (claude-opus-5-5, effort xhigh, fast mode off, 1m context) for the members; full
   access; the project folder. The room is created with the Consigliere; W1 and V are seated (W2 too in T4). The runner
   waits until the seat briefings are answered, every seat is idle in T3 and nothing is pending.
4. **Prompt.** The task's prompt is posted once, as the user, the way the page's composer posts it. The time just before
   the post is `postedAt`, the start of the job window.
5. **Watching.** Every 2 s the runner reads the board. At each member answer and at the Consigliere's report it copies
   the job folder (without `node_modules` and `.git`) and runs the task's checker on the copy. Every 10 s it samples T3's
   thread list for other threads with an active run (the overlap).
6. **The report** is the first message from the Consigliere to the user with a line that says `JOB-DONE`: the line, with
   list, quote or heading marks, emphasis and closing punctuation taken off, is exactly `JOB-DONE`. On the old side that
   is a Consigliere reply (`assistant.reply`) on the board; measure.ts finds the same message in T3 as the final message of
   a Consigliere run. His earlier replies ("work handed out") are not reports.
7. **Close.** After the report, the room is quiet when, at the same moment: no job thread has an active run in T3, no job
   thread has a pending approval or question in T3, no job thread has background work in T3 (its pending background tasks:
   subagents, commands, monitors), and the instance has no pending work (old side: no task queued, dispatching, running
   or waiting on input). The window closes after 3 minutes of continuous quiet; every sample is in `quiet.jsonl`. It
   closes as "did not quiesce" 30 minutes after the report, and as "no report" 60 minutes after the post without one.
   (The background-work condition and the 60-minute cap are additions to the plan's wording; both apply to both sides.)
8. **Evidence**, copied at the close: a final copy of the folder (with `.git`) and its check; `final.diff` against the
   tag; T3's detail of every job thread (`t3/<thread>.json`, `t3/threads.json`); T3's state-database rows for them
   (`t3/state-subset.sqlite`: threads, runs, provider threads, messages, subagents, requests); the raw Claude transcripts
   of every session started in the job folder, subagents included (`transcripts/`, Claude Code prunes the originals);
   the room snapshot with the instance's runs and the briefings it sent (`instance-room.json`); T3's version at start and
   end; then `measure.json`. Job threads are the seats' threads plus any T3 thread they started (same project or lineage).

## Pass rules (fixed before any paid run)

Each checker is a set of parts; a part passes when its hidden test file exits 0 on the copy (or its text rule holds).

| Task | Prompt | Checker parts | Correct (the job) | Member's own parts (early answers) |
|---|---|---|---|---|
| T1 | one member finds `src/cli.ts`'s imports and the unused one with a subagent | `facts`: the report names node:fs, args, text, format, dates, legacy and types; contains `cli.ts:6`; has a line naming legacy as unused | the JOB-DONE report passes `facts` | W1 or W2 (whichever answers): `facts` on its answer |
| T2 | W1 fixes the failing test in `src/dates.ts`, V reviews | `monthEnd` (the visible defect), `leapYear` (the second defect in the same function, covered by no visible test) | the final tree passes both, and V answered (a final message on V's thread in T3) before the report | W1: `monthEnd`, `leapYear` |
| T3 | W1 runs `npm run slow-check` (~3 min) in the background, fixes it, reports when it passes | `catalog`: the catalog rules hold on the tree, no entry deleted; `slowCheckLog`: in `.slow-check.log` up to the cutoff, the last run finished and passed, none in progress | the final tree passes `catalog`, and `slowCheckLog` passes with the report's time as cutoff (the report came after the last slow-check finished) | W1: `catalog`, `slowCheckLog` (cutoff: the answer's time) |
| T4 | W1 adds `slugify`, W2 adds `--json`, in parallel; V reviews both | `slugify`, `json`, and on the report `reportCoversBoth` | the final tree passes `slugify` and `json`, and the report covers both | W1: `slugify`; W2: `json` |

- **Premature report** (gated by G1): the checker failed on the copy taken at the JOB-DONE report (T1: the report text;
  T3: including the log with the report's time as cutoff, so a report before the last slow-check finished is premature).
- **Early member answers** (reported, not gated): a member's answer while its own parts failed on the copy taken then.
  Reviewers' answers are not checked. On the old side every member turn end is an answer. T1's part is judged on the
  answer's text, so once a member has given the facts its later answers are not early (added after the first R0 job,
  where W1's after-report "nothing left to do" was flagged; information only).
- T2 also reports, for information, whether W1 made a correction after V's first review and before the report. The plan
  read "V's review, then W1's correction"; a W1 who fixes both defects at once leaves V nothing to correct, so the gate
  needs only V's review before the report and the tree right.
- **Wall-clock to the first pass**: from the post to the first copy (answers and report) that passed the checker.

## What is measured (measure.ts, from T3's records only)

Window: `postedAt` to the close. Seating: everything before `postedAt`, reported apart. Per seat and per job:

- **turns**: T3 runs requested in the window on the seats' threads, until and after the report;
- **wakes**: the Consigliere's runs in the window minus the one the post started; after-report wakes listed apart;
- **tokens**: fresh input, cache read, cache write, output, calls and list-price cost (T3's price table), by `tokens.ts`
  over the copied transcripts and state rows, each message counted once with its final usage (see "Recomputing one
  job"); `tokens` in the gate is all four kinds summed over every job thread;
- **peak context**: the thread's largest single call of its own in the window;
- **briefing bytes per delivered turn**: the user messages T3 recorded for each run in the window, cross-checked against
  the instance's own record of what it sent (old side: `runs.briefing`);
- **wall-clock** to the report and to the checker's first pass; **correct**, **premature**, **early member answers**;
- **other activity**: threads outside the job running at any point in the window, sampled live and recounted from T3's
  state database; a job with any is marked in the report.

**Accuracy check** (`--verify`, non-zero exit on any difference): for every job thread, `rawsum.mjs` sums the same
transcripts by message id (sessions found with the `sqlite3` CLI) for the job window and for seating, and must equal
`measure.ts`'s four totals; the `sqlite3` CLI counts the runs in the window from the state rows and must equal the turns
read from T3's thread detail; a message id whose copies differ in input or cache figures is reported.

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
undercounts subagents' output; the comparison reads tokens with `tokens.ts` instead. checks. Compare with `measure.json` → `seats[]` (`turns`, `tokens`).

## The dry run

`node scripts/compare-live/run.ts --dry` starts two `ROOMS_ADAPTER=fake` instances from `compare-old` and `compare-new`
(ports 4491 and 4492, data under `~/Projects/backroom-compare/dry/`), runs the four tasks on each (seat, post, watch,
snapshot and check, quiet, evidence, measure), then stops them; `measure.ts --campaign dry --verify` measures them. A fake
agent cannot write JOB-DONE or use the board, so the dry run plays the Consigliere's part: after his first reply it posts
one piece of work to each member with his board key, and his first reply after all of them have answered is the report.
Fake threads have no transcripts or state rows: the token check is real only from the first paid job on, and the turn
check compares T3's runs (the fake's) with the instance's own run records. The quiet period is 20 s (`--quiet-ms`).

## Limits

- The hidden tests and reference solutions live in this repository, which the members do not work in; a member that
  went looking through other folders on the machine could find them. The job folder's path and the T3 project's name do
  not say which side a job is on; the board command in the briefings does (`compare-old`/`compare-new`).
- The crew is Claude only (Codex is out of quota until 2026-10-14; Cursor is not signed in).
- Other rooms share the account's rate limits; overlap is recorded per job.
