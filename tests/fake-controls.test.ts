import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { withFakeControls } from "../src/server/fakeControls.ts";

const launch = (fake: FakeT3Adapter, threadId: string) =>
  fake.launchThread({ commandId: `launch:${threadId}`, threadId, projectId: "project_demo", title: "Room · worker", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" } });

test("GET /api/fake/request shows what an approval and a question were answered with, as the fake T3 keeps it", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  await launch(fake, "thread-a");
  fake.setHeld("thread-a", true);
  await fake.sendMessage({ commandId: "cmd:1", threadId: "thread-a", messageId: "msg:1", text: "run the tests", mode: { type: "start" } });
  const serve = withFakeControls((_request: Request) => new Response("the app"), fake);
  const call = async (path: string, body: unknown) => (await serve(new Request(`http://fake${path}`, { method: "POST", body: JSON.stringify(body) }))).json();
  const record = async (requestId: string) => (await serve(new Request(`http://fake/api/fake/request?threadId=thread-a&requestId=${encodeURIComponent(requestId)}`))).json();

  const approval = ((await call("/api/fake/approval", { threadId: "thread-a" })) as { requestId: string }).requestId;
  const question = ((await call("/api/fake/question", { threadId: "thread-a" })) as { requestId: string }).requestId;
  const dropped = ((await call("/api/fake/question", { threadId: "thread-a" })) as { requestId: string }).requestId;
  assert.deepEqual(await record(approval), { ok: true, status: "pending", decision: null, answers: null });

  await fake.respondApproval({ commandId: "cmd:2", threadId: "thread-a", requestId: approval, decision: "acceptForSession" });
  await fake.respondUserInput({ commandId: "cmd:3", threadId: "thread-a", requestId: question, answers: { "Proceed?": "no" } });
  await fake.dismissUserInput({ commandId: "cmd:4", threadId: "thread-a", requestId: dropped });
  assert.deepEqual(await record(approval), { ok: true, status: "resolved", decision: "acceptForSession", answers: null });
  assert.deepEqual(await record(question), { ok: true, status: "resolved", decision: null, answers: { "Proceed?": "no" } });
  assert.equal(((await record(dropped)) as { status: string }).status, "cancelled");

  // Each of T3's five decisions is told apart.
  for (const decision of ["accept", "acceptForSession", "acceptAlways", "decline", "cancel"] as const) {
    const id = ((await call("/api/fake/approval", { threadId: "thread-a" })) as { requestId: string }).requestId;
    await fake.respondApproval({ commandId: `cmd:${decision}`, threadId: "thread-a", requestId: id, decision });
    assert.equal(((await record(id)) as { decision: string }).decision, decision);
  }

  // An unknown request is refused, and the rest of the app is the app's.
  assert.equal(((await record("nope")) as { error?: string }).error, "fake_control");
  assert.equal(await (await serve(new Request("http://fake/api/rooms"))).text(), "the app");
});

test("POST /api/fake/outage: T3 down altogether, or only its projects and threads with its descriptor answering (#8); answering again clears either", async () => {
  const fake = new FakeT3Adapter({ autoCompleteMs: null });
  const serve = withFakeControls((_request: Request) => new Response("the app"), fake);
  const outage = async (body: unknown) => (await serve(new Request("http://fake/api/fake/outage", { method: "POST", body: JSON.stringify(body) }))).json();
  const reads = async () => Promise.all([fake.describe(), fake.listProjects(), fake.listThreads()].map((p) => p.then(() => "ok", (error: Error) => error.name)));

  assert.deepEqual(await outage({ down: true }), { ok: true, down: true, shellOnly: false });
  assert.deepEqual(await reads(), ["T3Unavailable", "T3Unavailable", "T3Unavailable"]);
  assert.deepEqual(await outage({ down: false }), { ok: true, down: false, shellOnly: false });
  assert.deepEqual(await reads(), ["ok", "ok", "ok"]);

  assert.deepEqual(await outage({ down: true, shellOnly: true }), { ok: true, down: true, shellOnly: true });
  assert.deepEqual(await reads(), ["ok", "T3Unavailable", "T3Unavailable"], "the descriptor answers, the shell does not");
  assert.deepEqual(await outage({ down: false }), { ok: true, down: false, shellOnly: false });
  assert.deepEqual(await reads(), ["ok", "ok", "ok"]);
});
