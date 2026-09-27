/**
 * A demo Backroom for the README's screenshots: the fake T3 with scripted replies, a crew with roles, shared browsers,
 * three rooms and a thread on its own, in a throwaway data folder. It touches neither your data nor T3, and never
 * starts a browser.
 *
 *   npm run build:web
 *   node --no-warnings=ExperimentalWarning scripts/readme-demo.ts      (serves http://127.0.0.1:4420; ROOMS_PORT to change)
 *
 * What it sets up, in the order the README shows it: "Checkout discounts", where one message chains three members
 * (build, then review, then the release note); "Release 2.4" and "Search latency", which finish while you look
 * elsewhere (one replies, one fails); a thread on its own that finishes too; and the crew, for the Add member dialog.
 */
import { serve } from "@hono/node-server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeT3Adapter, type FakeTurnCompletion } from "../src/adapter/fake.ts";
import type { StartTurnInput } from "../src/adapter/types.ts";
import { createStack } from "../src/app/bootstrap.ts";
import { RoomBrowsers } from "../src/browser/roomBrowsers.ts";
import { loadConfig } from "../src/config.ts";
import { parseCommand, type RoomCommandInput } from "../src/domain/commands.ts";
import { parseExplicit } from "../src/parser/explicit.ts";
import { createHttpApp } from "../src/server/http.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = mkdtempSync(join(tmpdir(), "backroom-readme-"));
const config = loadConfig({ ...process.env, ROOMS_ADAPTER: "fake", ROOMS_DATA_DIR: dataDir, ROOMS_PORT: process.env.ROOMS_PORT ?? "4420", ROOMS_BROWSER_MODE: "headless", ROOMS_SPEECH: "off" });

// ---- what the members answer: matched on their assignment ----

const REPLIES: Array<{ match: RegExp; reply: FakeTurnCompletion }> = [
  {
    match: /code field and validation/,
    reply: {
      progress: ["Reading the checkout form and the discounts API.", "The API already validates codes; the form never sends one. Adding the field and wiring it in."],
      text: [
        "Checkout now takes a discount code. The field sits under the order summary, applies on Enter or when it loses focus, and shows the saving, or why a code was refused: expired, unknown, or below its minimum order. Codes match whatever their capitals, as the room's note asks, and the public `POST /api/checkout` body is unchanged: the code travels in the existing optional `promo` field.",
        "",
        "**Handoff**",
        "- `src/checkout/DiscountField.tsx` (new): the field and its states.",
        "- `src/checkout/CheckoutForm.tsx`: renders it and sends `promo`.",
        "- `src/api/discounts.ts`: upper-cases the code before the lookup.",
        "- `tests/discounts.test.ts`: 6 cases, all passing (`npm test -- discounts`).",
        "- Uncommitted on `main`.",
      ].join("\n"),
      files: [
        { path: "src/checkout/DiscountField.tsx", kind: "added", additions: 84, deletions: 0 },
        { path: "src/checkout/CheckoutForm.tsx", kind: "modified", additions: 12, deletions: 3 },
        { path: "src/api/discounts.ts", kind: "modified", additions: 4, deletions: 1 },
        { path: "tests/discounts.test.ts", kind: "added", additions: 61, deletions: 0 },
      ],
    },
  },
  {
    match: /review Opus's branch/,
    reply: {
      progress: ["Reading Opus's diff on main.", "Running the discount tests and trying a few codes by hand."],
      text: [
        "Reviewed Opus's change. It does what the task asked and the tests pass. Two things to fix before it ships:",
        "",
        "1. `src/checkout/DiscountField.tsx:41` applies the code on every blur, so tabbing through the form sends a request each time. Apply it only when the value changed.",
        "2. `src/api/discounts.ts:18` upper-cases the code typed at checkout, but the admin import stores codes as typed, so a code created as `spring10` never matches. Normalise on import too.",
        "",
        "**Handoff**",
        "- No code changes from me: the two findings above, with file and line.",
        "- `npm test -- discounts` passes (6/6).",
      ].join("\n"),
    },
  },
  {
    match: /release note/,
    reply: {
      text: [
        "> **Discount codes at checkout.** Enter a discount code at checkout and see the saving before you pay. Capitals don't matter, and a code that can't be used says why: expired, unknown, or below its minimum order.",
        "",
        "**Handoff**",
        "- The note above, ready for the 2.4 changelog.",
        "- It leaves out Sol's two review points: they are fixes to this change, not features.",
      ].join("\n"),
    },
  },
  {
    match: /changelog/,
    reply: {
      progress: ["Listing the pull requests merged since v2.3."],
      text: [
        "Draft for 2.4, from the 14 pull requests merged since 2.3:",
        "",
        "- **Discount codes at checkout** (#431)",
        "- **Faster product pages**: images load at the size they are shown (#418, #422)",
        "- **Saved addresses** can be renamed and reordered (#409)",
        "- Fixes: cart badge after sign-out (#415), duplicate order emails (#427)",
        "",
        "**Handoff**",
        "- The draft above; nine pull requests were internal and are left out.",
        "- #412 has no description, so its entry is my reading of the diff.",
      ].join("\n"),
    },
  },
  { match: /search takes/, reply: { text: "", outcome: "error" } },
  {
    match: /date-fns/,
    reply: {
      progress: ["Upgrading date-fns and running the type check."],
      text: "date-fns is on 4.1. Three call sites used the removed `format` tokens; they now use the new ones, and the tests pass.\n\n**Handoff**\n- `package.json`, `src/lib/dates.ts` and two components.\n- Uncommitted on `main`.",
      files: [
        { path: "package.json", kind: "modified", additions: 1, deletions: 1 },
        { path: "src/lib/dates.ts", kind: "modified", additions: 9, deletions: 9 },
      ],
    },
  },
];

function reply(input: StartTurnInput): FakeTurnCompletion {
  const assignment = /== Your assignment \([^)]+\) ==\n([^\n]+)/.exec(input.text)?.[1] ?? input.text;
  return REPLIES.find((r) => r.match.test(assignment))?.reply ?? { text: "Done." };
}

// ---- the service ----

const adapter = new FakeT3Adapter({ autoCompleteMs: 2500, autoReply: reply });
// One project, named like a real one, in place of the fake's "demo".
adapter.projects.splice(0, adapter.projects.length, { id: "project_shop", title: "acme-shop", workspaceRoot: "/srv/acme-shop", defaultModelSelection: null });

const stack = createStack({
  dbPath: join(dataDir, "rooms.sqlite"),
  adapter,
  briefingBudgetChars: config.briefingBudgetChars,
  browsers: () => new RoomBrowsers({ dataDir, ...config.browser, isBusy: () => false, onChange: () => undefined, log: () => undefined }),
});
const run = async (command: RoomCommandInput) => (await stack.service.execute(parseCommand(command))) as Record<string, string>;
const app = createHttpApp(stack, config, join(repoRoot, "web", "dist"));
stack.scheduler.start(500);

/** Send text as the composer does: Backroom's own rules turn it into tasks. */
async function say(roomId: string, text: string): Promise<void> {
  const participants = stack.repos.listActiveParticipants(roomId).map((p) => ({ id: p.id, alias: p.alias }));
  const draft = parseExplicit(text, participants, stack.repos.listTasks(roomId));
  await run({
    type: "message.create",
    roomId,
    sourceText: text,
    assignments: draft.assignments.map((a) => ({ recipients: a.recipients, instruction: a.instruction, schedule: a.schedule ?? { mode: "now" }, after: a.after.map((ref) => ref.index) })),
  });
}

const settled = async (roomId: string) => {
  for (let i = 0; i < 120; i += 1) {
    if (stack.repos.listTasks(roomId).every((t) => ["succeeded", "failed", "cancelled", "interrupted"].includes(t.state))) return;
    await new Promise((r) => setTimeout(r, 250));
  }
};

// ---- the scenario ----

const builder = await run({ type: "role.create", name: "builder", rules: "Build what is asked, with tests. Keep public APIs as they are unless told otherwise." });
const reviewer = await run({ type: "role.create", name: "reviewer", rules: "Review for correctness first, then clarity. Name file and line for every finding; don't change code yourself." });
const writer = await run({ type: "role.create", name: "writer", rules: "Write for customers: short, concrete, no internal names." });
const opus = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
const fable = { instanceId: "claudeAgent", model: "claude-fable-5-1", options: [{ id: "effort", value: "high" }] };
const sol = { instanceId: "codex", model: "gpt-6-sol" };
const presets: Record<string, string> = {};
for (const [name, modelSelection, roleId] of [["Opus", opus, builder.roleId], ["Sol", sol, reviewer.roleId], ["Fable", fable, writer.roleId]] as const) {
  presets[name] = (await run({ type: "preset.create", name, modelSelection, runtimeMode: "full-access", roleId, workspaceMode: "local" })).presetId!;
}
const staging = await run({ type: "browser.create", name: "staging", description: "The staging shop, signed in as the QA customer." });
await run({ type: "browser.create", name: "payments-sandbox", description: "The payment provider's test dashboard, signed in." });

const room = async (title: string, crew: string[]) => {
  const { roomId } = await run({ type: "room.create", projectId: "project_shop", title });
  for (const name of crew) await run({ type: "participant.fromPreset", roomId: roomId!, presetId: presets[name]! });
  return roomId!;
};

const checkout = await room("Checkout discounts", ["Opus", "Sol", "Fable"]);
await run({ type: "room.note.create", roomId: checkout, text: "Discount codes match whatever their capitals. Keep the public checkout API as it is." });
await say(checkout, "Customers can't apply discount codes at checkout. @Opus add the code field and validation, then @Sol review Opus's branch. @Fable write the release note when Sol finishes");
await settled(checkout);

const release = await room("Release 2.4", ["Fable"]);
const latency = await room("Search latency", ["Sol"]);
await say(release, "draft the 2.4 changelog from the pull requests merged since 2.3");
await say(latency, "find out why search takes 3 seconds on the staging catalogue");
await run({ type: "thread.start", projectId: "project_shop", text: "Upgrade date-fns to v4 and fix whatever breaks", modelSelection: opus });
await settled(release);
await settled(latency);
// Browsers on once the chain is done, so no task starts one.
await run({ type: "room.browser", roomId: checkout, enabled: true, browserId: staging.browserId!, allowed: [staging.browserId!, "general"] });

serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Backroom README demo on http://127.0.0.1:${info.port} (data in ${dataDir})`);
});
