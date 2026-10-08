/**
 * H6 review probes (Opus4), run from tests/runtime/ of a checkout. Each states what the design requires; a failing
 * probe is a finding. Hunts: a keep-alive with nothing in flight, one into a running turn, a keep-alive reply treated
 * as an answer, drift, an interval outside the cache's hour.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { KEEP_ALIVE_LINE } from "../../src/briefing/envelope.ts";
import { loadConfig } from "../../src/config.ts";
import { KEEP_ALIVE_MS, KEEP_ALIVE_REPLY, type KeepAliveSetting } from "../../src/runtime/index.ts";
import type { T3ThreadShell } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

const say = (line: string) => process.stdout.write(`# ${line}\n`);

function endedAt(r: Room, seat: string): number {
  return Date.parse(r.fake.thread(r.threadOf(seat)).shell.latestRunCompletedAt!);
}
function after(r: Room, seat: string, ms: number): void {
  r.clock = endedAt(r, seat) + ms;
}
function keepAlives(r: Room) {
  return r.p.events.filter((e) => e.data.kind === "notice" && e.data.intent === "keep-alive");
}

/** listThreads answers from a snapshot for these threads (T3's shell cache, H5's reuse window: up to 2 x a slow read). */
function staleList(r: Room, threads: string[]): void {
  const frozen = new Map<string, T3ThreadShell>(threads.map((t) => [t, structuredClone(r.fake.thread(t).shell)]));
  const list = r.fake.listThreads.bind(r.fake);
  r.fake.listThreads = async (projectId?: string) => (await list(projectId)).map((s) => frozen.get(s.id) ?? s);
}

async function handOff(r: Room): Promise<string> {
  r.user("C", "Have W build the release.");
  await r.tick();
  const w = r.post("C", "W", "Build the release; it takes a while.");
  r.complete("C", "Handed off to W.");
  await r.tick(2);
  assert.ok(r.running("W") && !r.running("C"));
  return w;
}

test("K1 never into a running turn: T3's listed shell still says C is idle, but a turn has started on C's thread", async () => {
  room = await Room.create();
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  staleList(room, [room.threadOf("C")]);
  room.fake.startExternalRun(room.threadOf("C"), "typed in T3 just now");
  const sendsBefore = room.fake.sent.filter((s) => s.threadId === room.threadOf("C")).length;
  await room.tick(2);
  const sent = room.fake.sent.filter((s) => s.threadId === room.threadOf("C")).length - sendsBefore;
  say(`K1 keep-alives posted ${keepAlives(room).length}; messages sent to C while its turn runs: ${sent}; C's runs: ${room.fake.runsOf(room.threadOf("C")).map((r) => r.status).join(",")}`);
  assert.equal(sent, 0, "no message goes to C while a turn runs on its thread");
});

test("K2 never with nothing in flight: W's listed shell still shows its background task, which T3's thread already says ended", async () => {
  room = await Room.create();
  const w = room.post("C", "W", "Build it.");
  await room.tick();
  room.fake.background(room.threadOf("W"), ["build"]);
  room.complete("W", "The build runs in the background.");
  await room.tick(2);
  assert.equal(room.state(w), "answered");
  room.complete("C", "Noted.");
  await room.tick(2);
  after(room, "C", KEEP_ALIVE_MS);
  // The listed shell is the snapshot before the task ended; the thread itself lists nothing now.
  staleList(room, [room.threadOf("W")]);
  room.fake.background(room.threadOf("W"), []);
  // The detail's shell is T3's thread record: patch the fake's detail to read the live shell, not the listed one.
  await room.tick();
  const posted = keepAlives(room).map((e) => (e.data.kind === "notice" ? e.data.body : ""));
  say(`K2 keep-alives: ${JSON.stringify(posted)}`);
  assert.ok(posted.every((b) => !/: idle\]/.test(b)), "a keep-alive never says work is in flight with an idle status line");
});

test("K3 a stale keep-alive beside real work does not put an out-of-date status in the briefing", async () => {
  room = await Room.create();
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  room.crashOnce("keep-alive", "C");
  await room.tick();
  room.fake.startSelfRun(room.threadOf("C"));
  room.complete("C", "My own check passed.");
  await room.tick(3);
  room.complete("W", "Built.");
  await room.tick(2);
  const prompt = room.prompt("C");
  say(`K3 C's briefing:\n${prompt.replace(/^/gm, "#   ")}`);
  const lines = prompt.split("\n").filter((l) => l.startsWith("[T3 status of @W"));
  assert.ok(lines.length <= 1, `one status for W, not two that disagree: ${JSON.stringify(lines)}`);
});

test("K4 ROOMS_KEEPALIVE_MS under a minute is refused, as the board refuses it (a unit slip, 55 for 55 minutes, is a storm)", () => {
  const base = { ROOMS_DATA_DIR: "data-test" };
  for (const bad of ["55", "1000", "59999"]) assert.throws(() => loadConfig({ ...base, ROOMS_KEEPALIVE_MS: bad }), /ROOMS_KEEPALIVE_MS/, bad);
});

test("K5 what a 55 ms interval does while W works (the storm K4 guards against)", async () => {
  room = await Room.create({ host: { keepAlive: (): KeepAliveSetting => ({ intervalMs: 55, on: null }) } });
  await handOff(room);
  const before = room.wakes("C");
  for (let i = 0; i < 5; i += 1) {
    room.clock = Date.now() + 1000;
    await room.tick();
    if (room.running("C")) room.complete("C", "Nothing to do.");
    await room.tick();
  }
  say(`K5 C woken ${room.wakes("C") - before} times in 10 ticks with W still working`);
});

test("K6 a keep-alive T3 runs after Backroom recorded its run as failed: the reply still wakes nobody", async () => {
  room = await Room.create({ host: { unrecordedMs: 60_000 } });
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  // T3 takes the message but does not record it yet.
  const held: Parameters<typeof room.fake.sendMessage>[0][] = [];
  const send = room.fake.sendMessage.bind(room.fake);
  room.fake.sendMessage = async (input) => {
    if (input.threadId === room.threadOf("C") && held.length === 0) {
      held.push(structuredClone(input));
      return;
    }
    return send(input);
  };
  await room.tick();
  assert.equal(held.length, 1, "the keep-alive went out");
  room.clock += 2 * 60_000;
  await room.tick(2);
  const failed = [...room.p.runs.values()].filter((r) => r.seatId === "C").at(-1)!;
  say(`K6 C's keep-alive run phase ${failed.phase}, failure ${failed.failure}`);
  // T3 records and runs it late.
  room.fake.sendMessage = send;
  const outputsBefore = room.outputs().length;
  const eventsBefore = room.p.events.length;
  await send({ ...held[0]!, commandId: `${held[0]!.commandId}:late` });
  room.complete("C", "Nothing to do; W is still building.");
  room.clock = Date.now();
  await room.tick(2);
  const added = room.p.events.slice(eventsBefore).map((e) => ({ id: e.id, kind: e.data.kind, recipients: "recipients" in e.data ? e.data.recipients : null, requestIds: "requestIds" in e.data ? e.data.requestIds : null, body: "body" in e.data ? e.data.body : null }));
  say(`K6 recorded after the late run: ${JSON.stringify(added)}`);
  void outputsBefore;
  assert.ok(added.every((e) => !e.recipients || e.recipients.length === 0), "nobody is woken, the user included");
  assert.ok(added.every((e) => e.kind !== "progress"), "the reply to a keep-alive is not a follow-up on the user's request");
});

test("K7 a subagent W left running after its answer is work in flight, as H5's status line says", async () => {
  room = await Room.create();
  const w = room.post("C", "W", "Survey the imports with a subagent.");
  await room.tick();
  room.fake.subagent(room.threadOf("W"), "sub-imports", "running");
  room.complete("W", "A subagent is reading the files.");
  await room.tick(2);
  assert.equal(room.state(w), "answered");
  room.complete("C", "Ok.");
  await room.tick(2);
  const last = room.outputs().filter((o) => o.author === "W").at(-1)!;
  say(`K7 W's answer as C got it: ${last.body.split("\n")[0]}`);
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick(2);
  say(`K7 keep-alives: ${JSON.stringify(keepAlives(room).map((e) => (e.data.kind === "notice" ? e.data.body : "")))}`);
  assert.equal(keepAlives(room).length, 1, "C is kept warm while W's subagent runs");
});

test("K8 C's own subagent running after its turn is work in flight", async () => {
  room = await Room.create();
  room.user("C", "Survey the imports.");
  await room.tick();
  room.fake.subagent(room.threadOf("C"), "sub-c", "running");
  room.complete("C", "A subagent of mine is reading the files.");
  await room.tick(2);
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick(2);
  say(`K8 keep-alives: ${JSON.stringify(keepAlives(room).map((e) => (e.data.kind === "notice" ? e.data.body : "")))}`);
  assert.equal(keepAlives(room).length, 1);
});

test("K9 drift: with W working for three intervals, C gets exactly one keep-alive per interval after each keep-alive turn", async () => {
  room = await Room.create();
  await handOff(room);
  const before = room.wakes("C");
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    // Tick every 30 s of host time from the turn's end up to just past the interval.
    const end = endedAt(room, "C");
    for (let t = 0; t <= KEEP_ALIVE_MS + 30_000; t += 30_000) {
      room.clock = end + t;
      await room.tick();
      if (room.running("C")) {
        times.push(t);
        room.complete("C", "Nothing to do.");
        await room.tick();
        break;
      }
    }
  }
  say(`K9 keep-alives at ${times.map((t) => `${t / 60_000} min`).join(", ")} after each turn's end`);
  assert.equal(room.wakes("C") - before, 3);
  assert.ok(times.every((t) => t >= KEEP_ALIVE_MS && t < KEEP_ALIVE_MS + 30_000));
  // Each reply is a note; nobody else woke.
  assert.equal(room.p.events.filter((e) => e.data.kind === "note" && e.id.startsWith(KEEP_ALIVE_REPLY)).length, 3);
  assert.equal(room.wakes("W"), 1);
});

test("K10 a keep-alive run that also carries the user's message ends as an answer to the user, not as a note", async () => {
  room = await Room.create();
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  // The user's message lands while the host reads W's thread for the keep-alive's status lines.
  room.fake.onDetail = { threadId: room.threadOf("W"), run: () => { room.user("C", "How is it going?"); } };
  await room.tick();
  const prompt = room.prompt("C");
  say(`K10 C's briefing starts: ${prompt.slice(0, 160).replace(/\n/g, " | ")}`);
  room.complete("C", "W is still building; about ten minutes left.");
  await room.tick(2);
  const userAnswers = room.outputs().filter((o) => o.author === "C" && o.recipients.includes("$user"));
  say(`K10 C's outputs to the user: ${userAnswers.length}`);
  assert.ok(prompt.includes("How is it going?"), "the user's message is in the run");
  assert.ok(userAnswers.some((o) => o.body.includes("ten minutes")), "and C's reply answers it");
});

test("K11 the keep-alive text: one line, then status lines, and the rules line", async () => {
  room = await Room.create();
  await handOff(room);
  after(room, "C", KEEP_ALIVE_MS);
  await room.tick();
  say(`K11 sent to C:\n${room.prompt("C").replace(/^/gm, "#   ")}`);
  assert.ok(room.prompt("C").startsWith(KEEP_ALIVE_LINE));
});
