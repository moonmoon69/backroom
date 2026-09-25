import { FakeT3Adapter, type FakeAdapterOptions } from "../src/adapter/fake.ts";
import { createStack, type AppStack } from "../src/app/bootstrap.ts";
import type { RoomCommandInput } from "../src/domain/commands.ts";
import { parseCommand } from "../src/domain/commands.ts";
import type { Task } from "../src/domain/types.ts";

export interface TestStack extends AppStack {
  fake: FakeT3Adapter;
  roomId: string;
  participants: Record<string, string>;
  threadOf(alias: string): string;
  run(command: RoomCommandInput): Promise<unknown>;
  tick(times?: number): Promise<void>;
  task(number: number): Task;
  taskByAlias(alias: string): Task[];
}

export async function createTestStack(
  options: FakeAdapterOptions = { autoCompleteMs: null },
  aliases = ["sol1", "sol2", "claude"],
  extra: { browsers?: Parameters<typeof createStack>[0]["browsers"] } = {},
): Promise<TestStack> {
  const fake = new FakeT3Adapter(options);
  const stack = createStack({ dbPath: ":memory:", adapter: fake, briefingBudgetChars: 60000, ...(extra.browsers ? { browsers: extra.browsers } : {}) });
  const run = async (command: RoomCommandInput) => stack.service.execute(parseCommand(command));
  const created = (await run({ type: "room.create", projectId: "project_demo", title: "payments" })) as { roomId: string };
  const roomId = created.roomId;
  const participants: Record<string, string> = {};
  for (const alias of aliases) {
    const result = (await run({
      type: "participant.create",
      roomId,
      alias,
      modelSelection: { instanceId: "codex", model: "gpt-6-sol" },
      thread: { mode: "create" },
    })) as { participantId: string };
    participants[alias] = result.participantId;
  }
  const test: TestStack = {
    ...stack,
    fake,
    roomId,
    participants,
    threadOf(alias) {
      const binding = stack.repos.currentBinding(participants[alias] as string);
      if (!binding) throw new Error(`no binding for ${alias}`);
      return binding.threadId;
    },
    run,
    async tick(times = 1) {
      for (let index = 0; index < times; index += 1) await stack.scheduler.tick();
    },
    task(number) {
      const task = stack.repos.listTasks(roomId).find((t) => t.number === number);
      if (!task) throw new Error(`task${number} not found`);
      return task;
    },
    taskByAlias(alias) {
      return stack.repos.listTasks(roomId).filter((t) => t.participantId === participants[alias]);
    },
  };
  return test;
}
