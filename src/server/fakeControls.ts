/**
 * Test controls for the fake T3 adapter (ROOMS_ADAPTER=fake only), so a script can play T3's side of a throwaway
 * service the way the tests play it in process: hold a member's run open, end it (completed or failed), start a turn
 * the room did not start (the agent continuing on its own, or someone typing in T3), and raise an approval or a
 * question. scripts/rehearse.ts drives the browser rehearsal (plan items L5 and Z2) with them. They exist only on a
 * fake adapter, which never talks to a real T3; with the real adapter nothing is mounted.
 *
 *   POST /api/fake/hold          { threadId, hold }            runs on the thread are not finished automatically
 *   POST /api/fake/complete      { threadId, text, outcome?, progress?, files? }   end the thread's running run
 *                                outcome "completed" | "error" | "interrupted"; progress: messages before the final one
 *   POST /api/fake/self-run      { threadId }                  a turn the agent starts itself -> { runId }
 *   POST /api/fake/external-run  { threadId, text }            a turn typed in T3 -> { runId }
 *   POST /api/fake/approval      { threadId }                  an approval on the running run -> { requestId }
 *   POST /api/fake/question      { threadId }                  a question on the running run -> { requestId }
 *   POST /api/fake/background    { threadId, taskIds }         what T3 lists in the thread's background (none: [])
 */
import { Hono, type Context } from "hono";
import type { FakeT3Adapter } from "../adapter/fake.ts";

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
    const outcome = input.outcome === "error" || input.outcome === "interrupted" ? input.outcome : "completed";
    const progress = Array.isArray(input.progress) ? input.progress.filter((p): p is string => typeof p === "string") : [];
    const files = Array.isArray(input.files) ? (input.files as Array<{ path: string; kind: string; additions: number; deletions: number }>) : [];
    fake.completeRun(thread(input), { text: typeof input.text === "string" ? input.text : "Done.", outcome, progress, files });
    return {};
  }));
  controls.post("/api/fake/self-run", run((input) => ({ runId: fake.startSelfRun(thread(input)) })));
  controls.post("/api/fake/external-run", run((input) => ({ runId: fake.startExternalRun(thread(input), typeof input.text === "string" ? input.text : "external prompt") })));
  controls.post("/api/fake/approval", run((input) => ({ requestId: fake.raiseApproval(thread(input)) })));
  controls.post("/api/fake/question", run((input) => ({ requestId: fake.raiseQuestion(thread(input)) })));
  controls.post("/api/fake/background", run((input) => {
    fake.setBackground(thread(input), Array.isArray(input.taskIds) ? input.taskIds.filter((id): id is string => typeof id === "string") : []);
    return {};
  }));
  return ((request: Request, ...rest: unknown[]) => (new URL(request.url).pathname.startsWith("/api/fake/") ? controls.fetch(request) : fetch(request, ...rest))) as F;
}
