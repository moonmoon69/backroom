import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { T3Unavailable, type T3Adapter } from "../src/adapter/types.ts";
import { LimitRecovery } from "../src/app/limitRecovery.ts";
import { createTestStack } from "./helpers.ts";

async function limited(fake: FakeT3Adapter, resetAt = new Date(Date.now() + 3_600_000).toISOString()): Promise<string> {
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "limited", modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Work" } });
  fake.completeRun("t", { text: "limit", outcome: "limit", resetAt });
  return resetAt;
}

test("review round 2: Stop everything survives a lost arming response and recovery restart", async () => {
  class LostArmResponse extends FakeT3Adapter {
    override async controlThread(input: Parameters<T3Adapter["controlThread"]>[0]) {
      if (input.control.type !== "limit.arm") return super.controlThread(input);
      await super.controlThread({ commandId: "user-stop", threadId: input.threadId, control: { type: "thread.stop" } });
      await super.controlThread(input);
      throw new T3Unavailable("The arming response was lost after T3 committed it.");
    }
  }
  const fake = new LostArmResponse({ autoCompleteMs: null });
  const resetAt = await limited(fake);
  await new LimitRecovery(fake).sweep();
  await new LimitRecovery(fake).sweep();
  fake.sweepLimits(Date.parse(resetAt) + 1);
  assert.equal(fake.threads.get("t")!.runs.length, 1, "Stop everything must survive the arming response being lost and Backroom restarting");
});

test("review round 3: a promptly landed arming is repaired before T3 is due on the same clock", async () => {
  let now = Date.now();
  const resetAt = new Date(now + 3_600_000).toISOString();
  class RecoverBeforeRepair extends FakeT3Adapter {
    override async controlThread(input: Parameters<T3Adapter["controlThread"]>[0]) {
      if (input.control.type !== "limit.arm") return super.controlThread(input);
      await super.controlThread({ commandId: "user-stop", threadId: input.threadId, control: { type: "thread.stop" } });
      now += 1_000;
      await super.controlThread(input);
      this.sweepLimits();
    }
  }
  const fake = new RecoverBeforeRepair({ autoCompleteMs: null });
  const control = new FakeT3Adapter({ autoCompleteMs: null });
  fake.clock = control.clock = () => now;
  await limited(fake, resetAt);
  await limited(control, resetAt);
  await new LimitRecovery(fake, { now: () => now }).sweep();
  await new LimitRecovery(control, { now: () => now }).sweep();
  assert.equal(fake.threads.get("t")!.recovery?.autoResume, false, "the prompt arming is repaired before the reset's two-minute margin");
  now = Date.parse(resetAt) - 1;
  fake.sweepLimits();
  control.sweepLimits();
  assert.equal(control.threads.get("t")!.runs.length, 1, "T3's worker is not due before the shared clock reaches reset");
  now += 2;
  fake.sweepLimits();
  control.sweepLimits();
  assert.equal(fake.threads.get("t")!.runs.length, 1, "the stopped turn stays stopped when T3 is due");
  assert.equal(control.threads.get("t")!.runs.length, 2, "the armed control continues when the same clock reaches reset");
});

test("review round 3: an in-flight arming preserves Don't resume pressed through Backroom for members and loose threads", async () => {
  for (const path of ["member", "loose"] as const) {
    const stack = await createTestStack();
    try {
      const threadId = path === "member" ? stack.threadOf("sol1") : (await stack.run({ type: "thread.start", projectId: "project_demo", text: "Work" }) as { threadId: string }).threadId;
      if (path === "member") await stack.fake.startExternalRun(threadId, "Work");
      const resetAt = new Date(Date.now() + 3_600_000).toISOString();
      stack.fake.completeRun(threadId, { text: "limit", outcome: "limit", resetAt });
      const original = stack.fake.controlThread.bind(stack.fake);
      stack.fake.controlThread = async (input) => {
        if (input.control.type === "limit.arm") {
          await stack.run(path === "member"
            ? { type: "member.control", roomId: stack.roomId, participantId: stack.participants.sol1!, control: { type: "resume.cancel" } }
            : { type: "thread.control", threadId, control: { type: "resume.cancel" } });
        }
        return original(input);
      };
      await stack.limitRecovery.sweep();
      assert.equal(stack.fake.threads.get(threadId)!.recovery?.autoResume, false, `${path}: Backroom repairs the arming in the same pass`);
      stack.fake.sweepLimits(Date.parse(resetAt) + 1);
      assert.equal(stack.fake.threads.get(threadId)!.runs.length, 1, `${path}: Don't resume stays off at the reset`);
    } finally {
      stack.close();
    }
  }
});
