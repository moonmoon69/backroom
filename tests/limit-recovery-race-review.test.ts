import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeT3Adapter } from "../src/adapter/fake.ts";
import { T3Unavailable, type T3Adapter } from "../src/adapter/types.ts";
import { LimitRecovery } from "../src/app/limitRecovery.ts";

async function limited(fake: FakeT3Adapter): Promise<string> {
  await fake.launchThread({ commandId: "launch", threadId: "t", projectId: "project_demo", title: "limited", modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default", workspace: { type: "root" }, initialMessage: { messageId: "m", text: "Work" } });
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
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

test("review round 2: Stop everything survives T3's due recovery between arming and the repair read", async () => {
  class RecoverBeforeRepair extends FakeT3Adapter {
    override async controlThread(input: Parameters<T3Adapter["controlThread"]>[0]) {
      if (input.control.type !== "limit.arm") return super.controlThread(input);
      await super.controlThread({ commandId: "user-stop", threadId: input.threadId, control: { type: "thread.stop" } });
      await super.controlThread(input);
      this.sweepLimits(Date.parse(input.control.resetAt) + 1);
    }
  }
  const fake = new RecoverBeforeRepair({ autoCompleteMs: null });
  await limited(fake);
  await new LimitRecovery(fake).sweep();
  assert.equal(fake.threads.get("t")!.runs.length, 1, "T3 must not continue the stopped turn before Backroom's repair read");
});

test("review round 2: an in-flight arming preserves Don't resume", async () => {
  class DisarmBeforeArm extends FakeT3Adapter {
    override async controlThread(input: Parameters<T3Adapter["controlThread"]>[0]) {
      if (input.control.type !== "limit.arm") return super.controlThread(input);
      await super.controlThread({ commandId: "user-dont-resume", threadId: input.threadId, control: { ...input.control, type: "limit.disarm" } });
      return super.controlThread(input);
    }
  }
  const fake = new DisarmBeforeArm({ autoCompleteMs: null });
  const resetAt = await limited(fake);
  await new LimitRecovery(fake).sweep();
  fake.sweepLimits(Date.parse(resetAt) + 1);
  assert.equal(fake.threads.get("t")!.runs.length, 1, "Don't resume must remain off when a previously decided arming arrives");
});
