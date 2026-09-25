/**
 * Repair stored replies from T3's record (turns still within the recent window are checked):
 *  - final answer: the room used to take checkpoint.assistantMessageId, which can be an earlier progress note; the
 *    final answer is the turn's last message.
 *  - prompt of "in T3" turns: the room used to take the last user message before the turn, even for turns the agent
 *    started itself (a background task finishing); those have no prompt.
 * Usage: node scripts/repair-replies.ts [--dry-run]
 */
import { readStoredAuth } from "../src/adapter/auth.ts";
import { promptForTurn } from "../src/adapter/correlate.ts";
import { HttpT3Adapter } from "../src/adapter/http.ts";
import { loadConfig } from "../src/config.ts";
import { Database } from "../src/db/database.ts";
import { Repos } from "../src/db/repos.ts";

const dryRun = process.argv.includes("--dry-run");
const config = loadConfig();
const stored = readStoredAuth(config.dataDir);
const adapter = new HttpT3Adapter({
  baseUrl: config.t3BaseUrl ?? stored?.baseUrl ?? "http://127.0.0.1:3773",
  accessToken: config.t3AccessToken ?? stored?.accessToken ?? null,
  userDataDir: config.t3UserDataDir,
});
const db = new Database(config.dbPath);
const repos = new Repos(db);

const events = repos.listRooms().flatMap((room) =>
  repos.listEvents(room.id).filter((e) => (e.kind === "assistant.reply" || e.kind === "t3.turn") && e.sourceRef?.turnId),
);
const byThread = new Map<string, typeof events>();
for (const event of events) byThread.set(event.sourceRef!.threadId, [...(byThread.get(event.sourceRef!.threadId) ?? []), event]);

let fixed = 0;
for (const [threadId, threadEvents] of byThread) {
  const detail = await adapter.getThreadDetail(threadId, { turnLimit: 20 });
  if (!detail) continue;
  for (const event of threadEvents) {
    const turnId = event.sourceRef!.turnId!;
    const messages = detail.messages.filter((m) => m.turnId === turnId && m.role === "assistant" && !m.streaming && m.text.trim().length > 0);
    const last = messages[messages.length - 1];
    if (event.kind === "t3.turn") {
      const prompt = promptForTurn(detail.messages, turnId);
      if (prompt !== event.prompt) {
        console.log(`#${event.sequence} (t3.turn) prompt was ${JSON.stringify(event.prompt?.slice(0, 40) ?? null)} → ${JSON.stringify(prompt?.slice(0, 40) ?? null)}`);
        if (!dryRun) db.raw.prepare("UPDATE events SET prompt = ? WHERE id = ?").run(prompt, event.id);
        fixed += 1;
      }
    }
    if (!last || last.id === event.sourceRef!.messageId) continue;
    const progress = messages.slice(0, -1).map((m) => ({ text: m.text.trim(), at: m.createdAt }));
    console.log(`#${event.sequence} (${event.kind}) reply was "${event.text.slice(0, 50)}…" → "${last.text.trim().slice(0, 50)}…" (${progress.length} progress)`);
    if (!dryRun) {
      db.raw
        .prepare("UPDATE events SET text = ?, progress_json = ?, source_message_id = ? WHERE id = ?")
        .run(last.text.trim(), JSON.stringify(progress), last.id, event.id);
    }
    fixed += 1;
  }
}
console.log(`${dryRun ? "would fix" : "fixed"} ${fixed} of ${events.length} replies`);
db.close();
