/**
 * Turn correlation against T3's read model (verified live on 0.0.43-nightly.20260923):
 * T3 does NOT set `turnId` on the user message that started a turn. The turn id appears on
 * `session.activeTurnId` while running and on the assistant/reasoning messages of that turn afterwards.
 * Messages are returned in creation order, so the room's own user message is correlated by adjacency:
 * the provider messages between it and the next user message belong to its turn.
 *
 * Exact match first (verified live 2026-09-24): a turn's `requestedAt` equals the createdAt of the user message that
 * requested it. That matters for a message sent while a turn runs: some providers steer it into the running turn
 * (Cursor, Grok: no new turn, so no requestedAt match, and adjacency finds the running turn), others start a new
 * turn for it (Claude: the new turn's requestedAt matches the message). `knownTurns` maps requestedAt → turnId for
 * turns seen as latestTurn on earlier polls, since T3 only exposes the latest one.
 */
import type { T3ThreadDetail } from "./types.ts";

export type TurnResolution =
  | { kind: "missing" }
  | { kind: "not_started" }
  | { kind: "active"; turnId: string }
  | { kind: "resolved"; turnId: string }
  | { kind: "superseded" };

export function resolveTurnForMessage(detail: T3ThreadDetail, messageId: string, knownTurns: ReadonlyMap<string, string> = new Map()): TurnResolution {
  const messages = detail.messages;
  const index = messages.findIndex((m) => m.id === messageId);
  if (index < 0) return { kind: "missing" };
  const own = messages[index];
  if (own?.turnId) return { kind: "resolved", turnId: own.turnId };
  const latest = detail.shell.latestTurn;
  const exact = latest?.requestedAt && own && latest.requestedAt === own.createdAt ? latest.turnId : own ? knownTurns.get(own.createdAt) : undefined;
  if (exact) {
    const running = detail.shell.session?.activeTurnId === exact || (latest?.turnId === exact && latest.state === "running");
    return running ? { kind: "active", turnId: exact } : { kind: "resolved", turnId: exact };
  }
  let nextUser = -1;
  for (let i = index + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === "user") {
      nextUser = i;
      break;
    }
  }
  const between = messages.slice(index + 1, nextUser === -1 ? undefined : nextUser);
  const provider = between.find((m) => m.role !== "user" && m.turnId);
  if (provider?.turnId) return { kind: "resolved", turnId: provider.turnId };
  if (nextUser === -1) {
    const active = detail.shell.session?.activeTurnId ?? null;
    if (active) return { kind: "active", turnId: active };
    return { kind: "not_started" };
  }
  // A later user message exists and nothing from the provider was recorded for ours.
  return { kind: "superseded" };
}

/**
 * The prompt that started a turn, or null when the turn started itself (for example a background task finishing
 * wakes the agent). T3 does not link user messages to turns, so the prompt is the user message directly before the
 * turn's first output, and only if no output of an earlier turn lies between them.
 */
export function promptForTurn(messages: T3ThreadDetail["messages"], turnId: string): string | null {
  const first = messages.findIndex((m) => m.turnId === turnId && m.role !== "user");
  if (first < 0) return null;
  for (let index = first - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") return message.text;
    if (message.turnId && message.turnId !== turnId) return null;
  }
  return null;
}
