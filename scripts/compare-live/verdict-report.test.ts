/**
 * Z1's verdict.md sections beyond the gate (verdict-report.ts): the rules diff, the briefing bytes, the behaviour checks
 * on the new side and the embedded report, on constructed records.
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, test } from "node:test";
import type { EnginePost } from "../../src/domain/engineView.ts";
import type { JobRecord, Snapshot } from "./campaign.ts";
import type { JobMeasure } from "./measure.ts";
import type { TaskId } from "./tasks.ts";
import { backgroundWorkOf, behaviourChecks, campaignLimitsSection, embeddedReport, lineDiff, normalizeRules, rulesOf, standingPart, verdictSections, type RoomRecord, type VerdictJob } from "./verdict-report.ts";

const SEATS = { C: "seat-c", W1: "seat-w1", V: "seat-v" } as const;

function jobRecord(task: TaskId, side: "old" | "new", extra: Partial<JobRecord> = {}): JobRecord {
  return {
    campaign: "t",
    side,
    task,
    run: 1,
    jobId: "abc123",
    status: "closed",
    close: "quiet",
    dry: false,
    seats: [
      { role: "C", alias: "Fable", participantId: "p-c", threadId: "t-c" },
      { role: "W1", alias: "W1", participantId: "p-w1", threadId: "t-w1" },
      { role: "V", alias: "V", participantId: "p-v", threadId: "t-v" },
    ],
    message: { clientMessageId: "m", requestIds: ["prompt"] },
    snapshots: [],
    childThreads: [],
    ...extra,
  } as unknown as JobRecord;
}

function measureOf(task: TaskId, side: "old" | "new", extra: Partial<JobMeasure> = {}): JobMeasure {
  return {
    task,
    side,
    run: 1,
    jobId: "abc123",
    dry: false,
    earlyAnswers: [],
    subagentRan: false,
    engineAtClose: side === "new" ? { head: 30, unread: 0, unresolvedRuns: 0, openRequests: [], pendingActivities: [] } : null,
    briefing: { turns: 2, bytes: 300, crossCheck: null },
    seats: [
      { role: "C", briefingBytes: [200] },
      { role: "W1", briefingBytes: [100] },
    ],
    ...extra,
  } as unknown as JobMeasure;
}

const request = (seq: number, id: string, owner: string, parentId: string | null, answerSeq: number | null): EnginePost =>
  ({
    seq,
    number: seq,
    id,
    kind: "request",
    author: "$user",
    to: [owner],
    body: "",
    about: [],
    turn: false,
    at: null,
    after: null,
    request: { id, parentId, rootId: "prompt", owner, returnTo: "$user", state: answerSeq === null ? "open" : "answered", answer: answerSeq === null ? null : { seq: answerSeq, number: answerSeq }, corrections: 0, message: null },
  }) as EnginePost;

const output = (seq: number, author: string, claims: Array<[string, string]>, source = "final", runId: string | null = null, activityId: string | null = null): EnginePost =>
  ({
    seq,
    number: seq,
    id: `out-${seq}`,
    kind: "output",
    author,
    to: [],
    body: "",
    about: [],
    turn: true,
    at: null,
    after: null,
    output: { disposition: "answer", claims: claims.map(([requestId, outcome]) => ({ requestId, number: null, outcome, returnTo: "$user" })), source, runId, activityId, t3: null, afterAnswer: false },
  }) as unknown as EnginePost;

const engineRoom = (posts: EnginePost[], runs: NonNullable<RoomRecord["runs"]>): RoomRecord => ({
  engine: true,
  seats: [
    { seatId: SEATS.C, participantId: "p-c", alias: "Fable" },
    { seatId: SEATS.W1, participantId: "p-w1", alias: "W1" },
    { seatId: SEATS.V, participantId: "p-v", alias: "V" },
  ],
  posts,
  runs,
});

const outcome = (checks: ReturnType<typeof behaviourChecks>, id: string) => checks.find((c) => c.id === id)?.outcome;

describe("the rules each side delivered", () => {
  test("the standing part keeps 'Where everyone works' and stops at room content", () => {
    const briefing = ["[Backroom briefing]", "Rules for the Consigliere:", "- one", "== Where everyone works ==", "You: here", "== Shared room messages you have not seen (#1–#2) ==", "[#1]", "== Your assignment (task3) ==", "do it"].join("\n");
    assert.equal(standingPart(briefing), ["[Backroom briefing]", "Rules for the Consigliere:", "- one", "== Where everyone works ==", "You: here"].join("\n"));
  });

  test("job-specific text is normalised: the job id, the board key's room suffix, lists of the job's aliases", () => {
    const text = 'room "tally abc123" with @W1, @V. Run `x --as Fable.9b1bc9a0`; post "@name the job" (@Opus, @Opus2); @Fable is the Consigliere; @Vx stays';
    assert.equal(normalizeRules(text, jobRecord("T1", "old")), 'room "tally <job>" with @<crew>. Run `x --as Fable.<room>`; post "@name the job" (@Opus, @Opus2); @<crew> is the Consigliere; @Vx stays');
  });

  test("the Consigliere's first rules briefing and W1's seat briefing, on both sides' records", () => {
    const old: RoomRecord = {
      bindings: [
        { id: "b-c", participantId: "p-c" },
        { id: "b-w1", participantId: "p-w1" },
      ],
      runs: [
        { id: "2", bindingId: "b-c", createdAt: "2026-01-01T00:00:02Z", briefing: "Rules for the Consigliere:\n- old\n== Your assignment (task3) ==\nx" },
        { id: "1", bindingId: "b-w1", createdAt: "2026-01-01T00:00:01Z", briefing: "seat briefing old" },
        { id: "3", bindingId: "b-w1", createdAt: "2026-01-01T00:00:03Z", briefing: "later work" },
      ],
    };
    assert.deepEqual(rulesOf(jobRecord("T1", "old"), old), { consigliere: "Rules for the Consigliere:\n- old", member: "seat briefing old" });
    const fresh = engineRoom([], [
      { id: "r2", seatId: SEATS.W1, reservedSeq: 9, briefing: "later work" },
      { id: "r1", seatId: SEATS.W1, reservedSeq: 5, briefing: "seat briefing new" },
      { id: "r3", seatId: SEATS.C, reservedSeq: 12, briefing: "Rules for the Consigliere:\n- new\nHow the board works:\n- x\n== Your assignment ==\ny" },
    ]);
    assert.deepEqual(rulesOf(jobRecord("T1", "new"), fresh), { consigliere: "Rules for the Consigliere:\n- new\nHow the board works:\n- x", member: "seat briefing new" });
  });

  test("the line diff: nothing for identical texts; changes with context, the rest elided", () => {
    assert.equal(lineDiff("a\nb", "a\nb", ["old", "new"]), "");
    const diff = lineDiff(["1", "2", "3", "4", "5", "6", "7"].join("\n"), ["1", "2", "3", "4", "5", "six", "7", "8"].join("\n"), ["old", "new"], 1);
    assert.equal(diff, ["--- old", "+++ new", "@@ 4 unchanged lines @@", " 5", "-6", "+six", " 7", "+8"].join("\n"));
  });
});

describe("behaviour checks on the new side", () => {
  // The prompt #10 to C; C asks W1 (#12); W1 asks V for a review under it (#14); V answers (#16); W1 answers (#18); C reports (#20).
  const t2Posts = (w1Run: string) => [
    request(10, "prompt", SEATS.C, null, 20),
    request(12, "a", SEATS.W1, "prompt", 18),
    request(14, "r", SEATS.V, "a", 16),
    output(16, SEATS.V, [["r", "answered"]]),
    output(18, SEATS.W1, [["a", "answered"]], "final", w1Run),
    output(20, SEATS.C, [["prompt", "answered"]]),
  ];

  test("T2: a review under the worker's request; the worker answers after V and the Consigliere sleeps through it", () => {
    const room = engineRoom(t2Posts("w1-late"), [
      { id: "c1", seatId: SEATS.C, reservedSeq: 11, inputs: [10] },
      { id: "w1-late", seatId: SEATS.W1, reservedSeq: 17, through: 16, inputs: [16] },
      { id: "c2", seatId: SEATS.C, reservedSeq: 19, inputs: [18] },
    ]);
    const checks = behaviourChecks({ job: jobRecord("T2", "new"), measure: measureOf("T2", "new"), room });
    assert.equal(outcome(checks, "plainFinal"), "pass");
    assert.equal(outcome(checks, "earlyReview"), "pass");
    assert.equal(outcome(checks, "consigliereHeld"), "pass");
    assert.equal(outcome(checks, "backgroundHeld"), "n/a");
    assert.equal(outcome(checks, "subagentClean"), "n/a");
    assert.equal(outcome(checks, "quiet"), "pass");
    assert.equal(outcome(checks, "noEarlyAnswer"), "pass");
    assert.equal(outcome(checks, "noUnresolved"), "pass");
  });

  test("T2: the worker's request closed by a run that never had V's answer, and the Consigliere woken mid-exchange, both fail", () => {
    const room = engineRoom(t2Posts("w1-early"), [
      { id: "c1", seatId: SEATS.C, reservedSeq: 11, inputs: [10] },
      { id: "w1-early", seatId: SEATS.W1, reservedSeq: 13, through: 12, inputs: [12] },
      { id: "c-mid", seatId: SEATS.C, reservedSeq: 15, inputs: [14] },
      { id: "c2", seatId: SEATS.C, reservedSeq: 19, inputs: [18] },
    ]);
    const checks = behaviourChecks({ job: jobRecord("T2", "new"), measure: measureOf("T2", "new"), room });
    assert.equal(outcome(checks, "earlyReview"), "FAIL");
    assert.equal(outcome(checks, "consigliereHeld"), "FAIL");
    assert.match(checks.find((c) => c.id === "consigliereHeld")?.evidence ?? "", /inputs #14/);
  });

  test("T2: a review the Consigliere asked himself exercises neither hold: both checks are n/a, with the review named", () => {
    const posts = [request(10, "prompt", SEATS.C, null, 20), request(12, "a", SEATS.W1, "prompt", 13), output(13, SEATS.W1, [["a", "answered"]]), request(15, "r", SEATS.V, "prompt", 16), output(16, SEATS.V, [["r", "answered"]]), output(20, SEATS.C, [["prompt", "answered"]])];
    const room = engineRoom(posts, [
      { id: "c1", seatId: SEATS.C, reservedSeq: 11, inputs: [10] },
      { id: "c2", seatId: SEATS.C, reservedSeq: 14, inputs: [13] },
      { id: "c3", seatId: SEATS.C, reservedSeq: 17, inputs: [16] },
    ]);
    const checks = behaviourChecks({ job: jobRecord("T2", "new"), measure: measureOf("T2", "new"), room });
    assert.equal(outcome(checks, "earlyReview"), "n/a");
    assert.equal(outcome(checks, "consigliereHeld"), "n/a");
    assert.match(checks.find((c) => c.id === "consigliereHeld")?.evidence ?? "", /asked by the Consigliere himself \(#15\)/);
  });

  test("T2: the Consigliere asks W1 and V together; W1's answer wakes him while V's review is open: n/a, not a false FAIL", () => {
    const posts = [request(10, "prompt", SEATS.C, null, 20), request(12, "a", SEATS.W1, "prompt", 14), request(13, "r", SEATS.V, "prompt", 17), output(14, SEATS.W1, [["a", "answered"]]), output(17, SEATS.V, [["r", "answered"]]), output(20, SEATS.C, [["prompt", "answered"]])];
    const room = engineRoom(posts, [
      { id: "c1", seatId: SEATS.C, reservedSeq: 11, inputs: [10] },
      { id: "c2", seatId: SEATS.C, reservedSeq: 15, inputs: [14] },
      { id: "c3", seatId: SEATS.C, reservedSeq: 18, inputs: [17] },
    ]);
    assert.equal(outcome(behaviourChecks({ job: jobRecord("T2", "new"), measure: measureOf("T2", "new"), room }), "consigliereHeld"), "n/a");
  });

  // W1's request #12, carried by run w1-1 (00:01–00:02), where W1 starts the slow-check in the background at 00:01:30.
  // Held: #18 is pending_activity and a later post (#22 at 00:06) closes it, settling a bg: (runtime) or work: (member) activity.
  const at = (post: EnginePost, time: string) => ({ ...post, at: `2026-01-01T${time}Z` }) as EnginePost;
  const task = (startedAt: string, endedAt: string | null, id = "bg1") => ({ id, what: 'background Bash "npm run slow-check"', startedAt: Date.parse(`2026-01-01T${startedAt}Z`), endedAt: endedAt ? Date.parse(`2026-01-01T${endedAt}Z`) : null, status: endedAt ? "completed" : null });
  const t3 = (logDetail: string, hold: "bg" | "work" | null, background: Record<string, ReturnType<typeof task>[]> = { W1: [task("00:01:30", "00:05:00")] }) => {
    const posts = [
      request(10, "prompt", SEATS.C, null, 24),
      request(12, "a", SEATS.W1, "prompt", hold ? 22 : 18),
      at(output(18, SEATS.W1, [["a", hold ? "pending_activity" : "answered"]], "final", "w1-1"), "00:02:00"),
      ...(hold ? [at(output(22, SEATS.W1, [["a", "answered"]], hold === "bg" ? "continuation" : "answer", null, `${hold}:w1-1`), "00:06:00")] : []),
      output(24, SEATS.C, [["prompt", "answered"]]),
    ];
    const runs = [{ id: "w1-1", seatId: SEATS.W1, reservedSeq: 13, inputs: [12], requestIds: ["a"], startedAt: "2026-01-01T00:01:00Z", endedAt: "2026-01-01T00:02:00Z" }];
    const snapshots = [{ kind: "answer", alias: "W1", postId: hold ? "out-22" : "out-18", at: "2026-01-01T00:10:00Z", dir: "", check: { pass: false, parts: { catalog: { pass: true }, slowCheckLog: { pass: logDetail.includes("passed"), detail: logDetail } } } }] as unknown as Snapshot[];
    return { job: jobRecord("T3", "new", { snapshots }), measure: measureOf("T3", "new"), room: engineRoom(posts, runs), background } satisfies VerdictJob;
  };
  const RUNNING = "a run (pid 7) had not finished up to 2026-01-01T00:10:00Z";
  const PASSED = "the last run (pid 7) passed";
  const check = (job: VerdictJob) => behaviourChecks(job).find((c) => c.id === "backgroundHeld");

  test("background work: n/a only when no member's transcripts show any; a runtime hold that closed after the end passes", () => {
    const held = check(t3(PASSED, "bg"));
    assert.equal(held?.outcome, "pass");
    assert.equal(held?.note, "runtime hold");
    assert.match(held?.evidence ?? "", /runtime hold bg:w1-1 settled by #22 \(continuation\)/);
    assert.match(held?.evidence ?? "", /1 of 1 background task started in its runs had ended/);
    // Ended with a failing last run: the hold did its part (the early-answer check judges the result).
    assert.equal(check(t3("the last run (pid 7) failed", "bg"))?.outcome, "pass");
    assert.equal(check(t3(PASSED, null, {}))?.outcome, "n/a");
    assert.equal(check(t3(PASSED, null, { W1: [] }))?.outcome, "n/a");
  });

  test("background work: fails closed: a run still going, no log at all, no end recorded, or a final that closed the request mid-run", () => {
    assert.equal(check(t3(RUNNING, "bg"))?.outcome, "FAIL");
    assert.equal(check(t3("no .slow-check.log in the folder", "bg"))?.outcome, "FAIL");
    assert.equal(check(t3(PASSED, "bg", { W1: [task("00:01:30", null)] }))?.outcome, "FAIL");
    // The defect the check exists for: background work ran, the runtime held nothing, the final closed the request at 00:02.
    const unheld = check(t3(PASSED, null));
    assert.equal(unheld?.outcome, "FAIL");
    assert.equal(unheld?.note, "no hold");
    assert.match(unheld?.evidence ?? "", /holds: none/);
    assert.match(unheld?.evidence ?? "", /0 of 1 background task started in its runs had ended/);
  });

  test("background work: a request held only by the member's own working mark is reported as that", () => {
    const marked = check(t3(PASSED, "work"));
    assert.equal(marked?.outcome, "pass");
    assert.equal(marked?.note, "member's mark only");
    assert.match(marked?.evidence ?? "", /member's working mark work:w1-1 via #22 \(answer\)/);
  });

  test("background work: every member is judged (V's review closed while its own slow-check ran fails); work outside a carrying run is not", () => {
    const job = t3(PASSED, "bg", { W1: [task("00:01:30", "00:05:00")], V: [task("00:03:10", "00:07:00", "bgv")] });
    const room = job.room as RoomRecord;
    room.posts = [...(room.posts ?? []), request(14, "r", SEATS.V, "a", 16), at(output(16, SEATS.V, [["r", "answered"]], "final", "v-1"), "00:04:00")];
    room.runs = [...(room.runs ?? []), { id: "v-1", seatId: SEATS.V, reservedSeq: 15, inputs: [14], requestIds: ["r"], startedAt: "2026-01-01T00:03:00Z", endedAt: "2026-01-01T00:04:00Z" }];
    const v = check(job);
    assert.equal(v?.outcome, "FAIL");
    assert.match(v?.evidence ?? "", /@V's #14 answered by #16 \(final\) at 00:04:00: 0 of 1 background task/);
    // T4 (no slow-check rule): W2's background work in a run that carried its request, answered after it ended, passes.
    const t4 = { ...job, job: jobRecord("T4", "new", { snapshots: [] }), background: { V: [task("00:03:10", "00:03:50", "bgv")] } };
    assert.equal(check(t4)?.outcome, "pass");
    // Background work started after the request's answer: n/a, listed.
    const outside = { ...t4, background: { V: [task("00:08:00", "00:09:00", "late")] } };
    assert.equal(check(outside)?.outcome, "n/a");
  });

  test("background work started in a continuation, after the first carrying run and before the answer, is judged too", () => {
    // V's run v-1 (00:03–00:04) carries #14; a continuation starts a second background run at 00:04:30 that ends at
    // 00:08; the runtime settles V's request at 00:05 (an idle or continuation output): FAIL.
    const job = t3(PASSED, "bg", { W1: [task("00:01:30", "00:05:00")], V: [task("00:04:30", "00:08:00", "bgv2")] });
    const room = job.room as RoomRecord;
    room.posts = [...(room.posts ?? []), request(14, "r", SEATS.V, "a", 17), at(output(16, SEATS.V, [["r", "pending_activity"]], "final", "v-1"), "00:04:00"), at(output(17, SEATS.V, [["r", "answered"]], "continuation", null, "bg:v-1"), "00:05:00")];
    room.runs = [...(room.runs ?? []), { id: "v-1", seatId: SEATS.V, reservedSeq: 15, inputs: [14], requestIds: ["r"], startedAt: "2026-01-01T00:03:00Z", endedAt: "2026-01-01T00:04:00Z" }];
    const v = check(job);
    assert.equal(v?.outcome, "FAIL");
    assert.equal(v?.note, "runtime hold");
    assert.match(v?.evidence ?? "", /@V's #14 answered by #17 \(continuation\) at 00:05:00: 0 of 1 background task/);
    // With another request of V's open meanwhile, the failure is marked for the hand classification.
    room.posts = [...room.posts, request(15, "r2", SEATS.V, "a", null)];
    const unsure = check(job);
    assert.equal(unsure?.outcome, "FAIL");
    assert.equal(unsure?.note, "runtime hold; to classify by hand");
    assert.match(unsure?.evidence ?? "", /another request of @V open meanwhile: #15; to classify by hand/);
  });

  test("an early member post fails only when it closed a request; an open request or a pending activity at the close fails", () => {
    const posts = [request(10, "prompt", SEATS.C, null, 20), request(12, "a", SEATS.W1, "prompt", null), output(20, SEATS.C, [["prompt", "answered"]])];
    const early = (claims: string[]) => {
      const snapshots = [{ kind: "answer", alias: "W1", postId: "x", at: "2026-01-01T00:05:00Z", via: "final", claims, dir: "", check: { pass: false, parts: {} } }] as unknown as Snapshot[];
      return { job: jobRecord("T4", "new", { snapshots }), measure: measureOf("T4", "new", { earlyAnswers: [{ alias: "W1", at: "2026-01-01T00:05:00Z", failing: ["slugify"] }], engineAtClose: { head: 20, unread: 0, unresolvedRuns: 0, openRequests: [12], pendingActivities: ["work:r@W1:held"] } }), room: engineRoom(posts, []) };
    };
    const closing = behaviourChecks(early(["answered"]));
    assert.equal(outcome(closing, "noEarlyAnswer"), "FAIL");
    assert.equal(outcome(behaviourChecks(early(["pending_activity"])), "noEarlyAnswer"), "pass");
    assert.equal(outcome(closing, "plainFinal"), "FAIL");
    assert.equal(outcome(closing, "noUnresolved"), "FAIL");
  });

  test("T1: a subagent that ran with nothing left pending passes; no subagent is n/a; a job that did not quiesce fails", () => {
    const posts = [request(10, "prompt", SEATS.C, null, 20), output(20, SEATS.C, [["prompt", "answered"]])];
    const t1 = (subagentRan: boolean, close: JobRecord["close"]) => behaviourChecks({ job: jobRecord("T1", "new", { close }), measure: measureOf("T1", "new", { subagentRan }), room: engineRoom(posts, []) });
    assert.equal(outcome(t1(true, "quiet"), "subagentClean"), "pass");
    assert.equal(outcome(t1(false, "quiet"), "subagentClean"), "n/a");
    assert.equal(outcome(t1(true, "did not quiesce"), "subagentClean"), "FAIL");
    assert.equal(outcome(t1(true, "did not quiesce"), "quiet"), "FAIL");
  });

  test("a job whose journal was not recorded fails every check", () => {
    const checks = behaviourChecks({ job: jobRecord("T1", "new"), measure: measureOf("T1", "new"), room: null });
    assert.ok(checks.length === 8 && checks.every((c) => c.outcome === "FAIL"));
  });
});

describe("W1's background work, from T3's side of the evidence", () => {
  const scratch = join(import.meta.dirname, `.scratch-verdict-${process.pid}`);
  after(() => rmSync(scratch, { recursive: true, force: true }));

  test("background Bash, Monitor and background subagents in the window, with the end T3's harness recorded for each (first final status)", () => {
    mkdirSync(join(scratch, "t3"), { recursive: true });
    const db = new DatabaseSync(join(scratch, "t3", "state-subset.sqlite"));
    db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (thread_id TEXT, driver TEXT, payload_json TEXT)");
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run("t-w1", "claudeAgent", JSON.stringify({ nativeThreadRef: { nativeId: "sess-w1" } }));
    db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)").run("t-v", "claudeAgent", JSON.stringify({ nativeThreadRef: { nativeId: "sess-v" } }));
    db.close();
    const project = join(scratch, "transcripts", "-home-x-tally");
    mkdirSync(join(project, "sess-w1", "subagents"), { recursive: true });
    const use = (at: string, id: string, name: string, input: Record<string, unknown>) => JSON.stringify({ timestamp: at, message: { content: [{ type: "tool_use", id, name, input }] } });
    writeFileSync(
      join(project, "sess-w1.jsonl"),
      [
        use("2026-01-01T00:00:30Z", "early", "Bash", { command: "npm run slow-check", run_in_background: true }),
        use("2026-01-01T00:01:00Z", "fg", "Bash", { command: "npm test" }),
        use("2026-01-01T00:02:00Z", "bg", "Bash", { command: "npm run slow-check", run_in_background: true }),
        use("2026-01-01T00:02:00Z", "bg", "Bash", { command: "npm run slow-check", run_in_background: true }),
        use("2026-01-01T00:03:00Z", "mon", "Monitor", { command: "tail -f .slow-check.log" }),
        "not json",
        JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-01-01T00:05:00Z", content: "<task-notification>\n<task-id>x</task-id>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n</task-notification>" }),
        JSON.stringify({ type: "user", timestamp: "2026-01-01T00:05:01Z", message: { role: "user", content: "<task-notification>\n<tool-use-id>bg</tool-use-id>\n<status>completed</status>\n</task-notification>" } }),
        JSON.stringify({ type: "user", timestamp: "2026-01-01T00:04:00Z", message: { role: "user", content: "<task-notification>\n<tool-use-id>mon</tool-use-id>\n<status>running</status>\n</task-notification>" } }),
      ].join("\n"),
    );
    writeFileSync(
      join(project, "sess-w1", "subagents", "agent-1.jsonl"),
      [use("2026-01-01T00:04:00Z", "sub", "Agent", { description: "watch the check", run_in_background: true }), JSON.stringify({ timestamp: "2026-01-01T00:06:00Z", message: { content: "<task-notification><tool-use-id>sub</tool-use-id><status>killed</status></task-notification>" } })].join("\n"),
    );
    writeFileSync(join(project, "sess-v.jsonl"), use("2026-01-01T00:02:30Z", "other", "Bash", { command: "sleep 1", run_in_background: true }));
    const t = (time: string) => Date.parse(`2026-01-01T${time}Z`);
    assert.deepEqual(backgroundWorkOf(scratch, "t-w1", t("00:01:00"), t("00:10:00")), [
      { id: "bg", what: 'background Bash "npm run slow-check"', startedAt: t("00:02:00"), endedAt: t("00:05:00"), status: "completed" },
      { id: "mon", what: "Monitor", startedAt: t("00:03:00"), endedAt: null, status: null },
      { id: "sub", what: 'background subagent "watch the check"', startedAt: t("00:04:00"), endedAt: t("00:06:00"), status: "killed" },
    ]);
  });
});

describe("verdict.md's sections", () => {
  test("behaviour checks (new side only), rules, briefing bytes; then the report with its headings one level down", () => {
    const oldRoom: RoomRecord = { bindings: [{ id: "b-c", participantId: "p-c" }], runs: [{ id: "1", bindingId: "b-c", createdAt: "2026-01-01T00:00:00Z", briefing: "Rules for the Consigliere:\n- old" }] };
    const newRoom = engineRoom([request(10, "prompt", SEATS.C, null, 20), output(20, SEATS.C, [["prompt", "answered"]])], [{ id: "r", seatId: SEATS.C, reservedSeq: 11, briefing: "Rules for the Consigliere:\n- new" }]);
    const jobs: VerdictJob[] = [
      { job: jobRecord("T1", "old"), measure: measureOf("T1", "old"), room: oldRoom },
      { job: jobRecord("T1", "new"), measure: measureOf("T1", "new"), room: newRoom },
    ];
    const { beforeLimits, afterLimits } = verdictSections(jobs, "# Comparison campaign t\n\n## Every run\n\n| a |", "W1's early answer: an agent cause.");
    const text = beforeLimits.join("\n");
    assert.match(text, /## Behaviour checks on the new side\n/);
    assert.match(text, /\| check \| T1#1 abc123 \|/);
    assert.match(text, /### Classification of the failures[^\n]*\n\nW1's early answer: an agent cause\./);
    assert.match(text, /-- old\n\+- new/);
    assert.match(text, /\| T1 \| old \| 1 \| 2 \(2–2\) \| 300 \(300–300\) \| 150 \(150–150\) \| 200 \(200–200\) \| 100 \(100–100\) \|/);
    assert.deepEqual(afterLimits, embeddedReport("# Comparison campaign t\n\n## Every run\n\n| a |"));
    assert.deepEqual(afterLimits.slice(2), ["", "### Every run", "", "| a |"]);
  });
});

describe("the limits of this campaign", () => {
  test("the hand-written notes, then T3's load in each job's window, in the order the jobs ran", () => {
    const job = (jobId: string, postedAt: string, closeAt: string) =>
      ({ job: { ...jobRecord("T3", "new"), jobId, times: { postedAt, closeAt } }, measure: { ...measureOf("T3", "new"), overlap: { sampled: ["x"], stateDb: ["x", "y"] } }, room: null }) as unknown as VerdictJob;
    const sample = (at: string, cpuPct: number | null, providerProcs: number) => ({ at: `2026-01-01T${at}Z`, cpuPct, providerProcs, stateDbBytes: 3.8e9 });
    const samples = [sample("00:00:30", 70, 8), sample("00:01:00", 80, 9), sample("00:01:30", null, 9), sample("00:05:00", 120, 4), sample("00:05:30", 110, 3)];
    const text = campaignLimitsSection([job("bbb", "2026-01-01T00:04:00Z", "2026-01-01T00:06:00Z"), job("aaa", "2026-01-01T00:00:00Z", "2026-01-01T00:02:00Z")], "- Jobs 1-14 ran under T3's overload.", samples).join("\n");
    assert.match(text, /## Limits of this campaign\n\n- Jobs 1-14 ran under T3's overload\.\n/);
    assert.match(text, /\| 1 \| aaa \| new \| T3#1 \| 00:00:00–00:02:00 \| 75 \(80\) \| 9 \| 3\.80 GB \| 1 \/ 2 \| quiet \|/);
    assert.match(text, /\| 2 \| bbb \| new \| T3#1 \| 00:04:00–00:06:00 \| 115 \(120\) \| 4 \| 3\.80 GB \| 1 \/ 2 \| quiet \|/);
    assert.match(campaignLimitsSection([], null, []).join("\n"), /No load samples recorded\./);
  });
});
