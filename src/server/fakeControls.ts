/**
 * Test controls for the fake T3 adapter (ROOMS_ADAPTER=fake only), so a script can play T3's side of a throwaway
 * service the way the tests play it in process: hold a member's run open, end it (completed or failed), start a turn
 * the room did not start (the agent continuing on its own, or someone typing in T3), and raise an approval, a
 * question or a secret. scripts/rehearse.ts drives the browser rehearsal (plan items L5 and Z2) with them. They exist only on a
 * fake adapter, which never talks to a real T3; with the real adapter nothing is mounted.
 *
 *   POST /api/fake/hold          { threadId, hold }            runs on the thread are not finished automatically
 *   POST /api/fake/complete      { threadId, text, outcome?, progress?, files?, resetAt? }   end the thread's running run
 *                                outcome "completed" | "error" | "interrupted" | "limit"; progress: messages before the
 *                                final one; "limit": the provider's usage limit stopped it, `text` its sentence, resetting
 *                                at `resetAt` (ISO), or in `resetInMs` from now
 *   POST /api/fake/say           { threadId, text }            the agent says something in its running turn -> { messageId }
 *   POST /api/fake/self-run      { threadId }                  a turn the agent starts itself -> { runId }
 *   POST /api/fake/external-run  { threadId, text }            a turn typed in T3 -> { runId }
 *   POST /api/fake/approval      { threadId, kind?, prompt?, options?, appName? }   an approval on the running run ->
 *                                { requestId }; a command's by default, or e.g. an MCP server's form request
 *                                (kind "mcp-elicitation") with the choices T3 offers ([{ decision, label, warning? }])
 *   POST /api/fake/question      { threadId, questions? }      a question on the running run -> { requestId }
 *                                questions: T3's own shape (options, allowCustomAnswer); T3's "Proceed?" yes/no by default
 *   POST /api/fake/secret        { threadId, label, reason, placeholder?, delivery? }   the agent asks for a secret in its
 *                                running turn (T3's request_secret) -> { requestId }; delivery "file" or none
 *   GET  /api/fake/secret?threadId=…&requestId=…               where a secret request stands, as T3 keeps it -> { secretStatus }
 *                                ("pending", "saved", "declined" or "cancelled"); the fake never keeps the secret itself
 *   POST /api/fake/background    { threadId, taskIds }         what T3 lists in the thread's background (none: [])
 *   POST /api/fake/subagent      { threadId, subagentId, status, title?, origin?, driver? }   a subagent of the running
 *                                (else latest) run, made or moved to `status`
 *   GET  /api/fake/subagent?threadId=…&subagentId=…            its status as T3 keeps it -> { status }
 *   POST /api/fake/outage        { down, message?, shellOnly? } T3 stops answering (every call fails) or answers again;
 *                                shellOnly: only its projects and threads fail, its descriptor still answers (#8)
 *   GET  /api/fake/request?threadId=…&requestId=…              an approval's or question's record, as T3 keeps it -> { status,
 *                                decision, answers }: what the page answered reached T3 ("resolved" with the decision or
 *                                the answers; a dismissed question "cancelled")
 */
import { Hono, type Context } from "hono";
import type { FakeT3Adapter } from "../adapter/fake.ts";
import { T3Unavailable } from "../adapter/types.ts";

/** The fetch handler to serve: `/api/fake/*` answered here, everything else by the app's own handler, as it was called. */
export function withFakeControls<F extends (request: Request, ...rest: any[]) => Response | Promise<Response>>(fetch: F, fake: FakeT3Adapter): F {
  const controls = new Hono();
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const thread = (input: Record<string, unknown>): string => {
    if (typeof input.threadId !== "string" || !fake.threads.has(input.threadId)) throw new Error("threadId must name a thread of the fake T3");
    return input.threadId;
  };
  const run = (handler: (input: Record<string, unknown>) => Record<string, unknown>) => async (c: Context) => {
    try {
      return c.json({ ok: true, ...handler(await body(c)) });
    } catch (error) {
      return c.json({ error: "fake_control", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
  controls.post("/api/fake/hold", run((input) => {
    const id = thread(input);
    fake.setHeld(id, input.hold !== false);
    return { held: fake.held.has(id) };
  }));
  controls.post("/api/fake/complete", run((input) => {
    const outcome = input.outcome === "error" || input.outcome === "interrupted" || input.outcome === "limit" ? input.outcome : "completed";
    const progress = Array.isArray(input.progress) ? input.progress.filter((p): p is string => typeof p === "string") : [];
    const files = Array.isArray(input.files) ? (input.files as Array<{ path: string; kind: string; additions: number; deletions: number }>) : [];
    const resetAt = typeof input.resetAt === "string" ? input.resetAt : typeof input.resetInMs === "number" ? new Date(Date.now() + input.resetInMs).toISOString() : null;
    fake.completeRun(thread(input), { text: typeof input.text === "string" ? input.text : "Done.", outcome, progress, files, resetAt });
    return {};
  }));
  controls.post("/api/fake/say", run((input) => ({ messageId: fake.say(thread(input), typeof input.text === "string" ? input.text : "working on it") })));
  controls.post("/api/fake/self-run", run((input) => ({ runId: fake.startSelfRun(thread(input)) })));
  controls.post("/api/fake/external-run", run((input) => ({ runId: fake.startExternalRun(thread(input), typeof input.text === "string" ? input.text : "external prompt") })));
  controls.post("/api/fake/approval", run((input) => ({
    requestId: fake.raiseApproval(thread(input), undefined, {
      ...(typeof input.kind === "string" ? { kind: input.kind as never } : {}),
      ...(typeof input.prompt === "string" ? { prompt: input.prompt } : {}),
      ...(Array.isArray(input.options) ? { options: input.options as never } : {}),
      ...(typeof input.appName === "string" ? { appName: input.appName } : {}),
    }),
  })));
  controls.post("/api/fake/question", run((input) => ({ requestId: fake.raiseQuestion(thread(input), Array.isArray(input.questions) ? { questions: input.questions as never } : {}) })));
  controls.post("/api/fake/secret", run((input) => {
    const text = (key: string): string | null => (typeof input[key] === "string" && (input[key] as string).length > 0 ? (input[key] as string) : null);
    const label = text("label");
    if (!label) throw new Error("label must name the secret");
    return { requestId: fake.raiseSecret(thread(input), { label, reason: text("reason") ?? "", placeholder: text("placeholder"), delivery: input.delivery === "file" ? "file" : null }) };
  }));
  controls.get("/api/fake/secret", async (c) => {
    try {
      const input = { threadId: c.req.query("threadId"), requestId: c.req.query("requestId") };
      const item = fake.threads.get(thread(input))!.turnItems.find((x) => x.id === input.requestId);
      if (item?.type !== "secret_request") throw new Error("requestId must name a secret request of the thread");
      return c.json({ ok: true, secretStatus: item.secretStatus });
    } catch (error) {
      return c.json({ error: "fake_control", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  controls.get("/api/fake/request", async (c) => {
    try {
      const input = { threadId: c.req.query("threadId"), requestId: c.req.query("requestId") };
      const request = fake.threads.get(thread(input))!.runtimeRequests.find((r) => r.id === input.requestId);
      if (!request) throw new Error("requestId must name a request of the thread");
      return c.json({ ok: true, status: request.status, decision: request.decision, answers: request.answers });
    } catch (error) {
      return c.json({ error: "fake_control", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  controls.post("/api/fake/background", run((input) => {
    fake.setBackground(thread(input), Array.isArray(input.taskIds) ? input.taskIds.filter((id): id is string => typeof id === "string") : []);
    return {};
  }));
  controls.post("/api/fake/subagent", run((input) => {
    if (typeof input.subagentId !== "string" || typeof input.status !== "string") throw new Error("subagentId and status must be given");
    fake.setSubagent(thread(input), {
      id: input.subagentId,
      status: input.status as never,
      ...(typeof input.title === "string" ? { title: input.title } : {}),
      ...(input.origin === "app_owned" ? { origin: "app_owned" as const } : {}),
      ...(typeof input.driver === "string" ? { driver: input.driver } : {}),
    });
    return {};
  }));
  controls.get("/api/fake/subagent", async (c) => {
    try {
      const input = { threadId: c.req.query("threadId"), subagentId: c.req.query("subagentId") };
      const subagent = fake.threads.get(thread(input))!.subagents.find((s) => s.id === input.subagentId);
      if (!subagent) throw new Error("subagentId must name a subagent of the thread");
      return c.json({ ok: true, status: subagent.status });
    } catch (error) {
      return c.json({ error: "fake_control", message: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  controls.post("/api/fake/outage", run((input) => {
    const shellOnly = input.shellOnly === true;
    const failure = input.down === true ? new T3Unavailable(typeof input.message === "string" && input.message ? input.message : shellOnly ? "T3 did not answer within 30s (orchestration shell)" : "fetch failed: connect ECONNREFUSED (the fake T3 is down)") : null;
    // Answering again clears both.
    fake.outage = shellOnly ? null : failure;
    fake.shellOutage = shellOnly ? failure : null;
    return { down: failure !== null, shellOnly: failure !== null && shellOnly };
  }));
  return ((request: Request, ...rest: unknown[]) => (new URL(request.url).pathname.startsWith("/api/fake/") ? controls.fetch(request) : fetch(request, ...rest))) as F;
}
