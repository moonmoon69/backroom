/**
 * What a T3 thread's model calls used, from the raw Claude transcripts: the thread's sessions from T3's state database
 * (its provider threads' native ids), then each session's transcript and everything under its folder (subagents).
 *
 * Claude Code writes a message once per content block, all under the message's id. In a session's own transcript every
 * copy carries the same usage; in a subagent's transcript the copies are written while the message streams, and only
 * the last carries the final output count. So each message counts once, with the largest output count of its copies,
 * at the time of its first copy. (ThreadCosts, src/usage/threadCosts.ts, keeps the first copy, which undercounts
 * subagents' output; the comparison does not use it for tokens.)
 *
 * List price from T3's price table (usage-model-rates.json), as ThreadCosts prices it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface Call {
  id: string;
  at: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  subagent: boolean;
}

export interface Tokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** All four kinds. */
  total: number;
  calls: number;
  costUsd: number;
}

interface Rate {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function jsonlUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((name) => (statSync(join(dir, name)).isDirectory() ? jsonlUnder(join(dir, name)) : name.endsWith(".jsonl") ? [join(dir, name)] : []));
}

export class TranscriptTokens {
  private readonly stateDb: string;
  private readonly projectsDir: string;
  private readonly rates: Record<string, Rate>;
  private readonly byThread = new Map<string, Call[]>();

  constructor(sources: { stateDb: string; projectsDir: string; ratesPath: string }) {
    this.stateDb = sources.stateDb;
    this.projectsDir = sources.projectsDir;
    let rates: Record<string, Rate> = {};
    try {
      rates = (JSON.parse(readFileSync(sources.ratesPath, "utf8")) as { document?: Record<string, Rate> }).document ?? {};
    } catch {
      // No price table: tokens are counted, cost is 0.
    }
    this.rates = rates;
  }

  /** The thread's Claude sessions, as T3 names them on its provider threads. */
  sessions(threadId: string): string[] {
    const db = new DatabaseSync(this.stateDb, { readOnly: true });
    try {
      const rows = db.prepare("SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ? AND driver = 'claudeAgent'").all(threadId) as Array<{ payload_json: string }>;
      return rows
        .map((row) => (JSON.parse(row.payload_json) as { nativeThreadRef?: { nativeId?: unknown } }).nativeThreadRef?.nativeId)
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    } finally {
      db.close();
    }
  }

  /** Every call of the thread, all time: one per message id. */
  calls(threadId: string): Call[] {
    const known = this.byThread.get(threadId);
    if (known) return known;
    const messages = new Map<string, Call>();
    const projects = existsSync(this.projectsDir) ? readdirSync(this.projectsDir).sort() : [];
    for (const session of this.sessions(threadId)) {
      for (const project of projects) {
        const own = join(this.projectsDir, project, `${session}.jsonl`);
        const files = [...(existsSync(own) ? [own] : []), ...jsonlUnder(join(this.projectsDir, project, session))];
        for (const file of files) {
          const subagent = file !== own;
          for (const line of readFileSync(file, "utf8").split("\n")) {
            if (!line.includes('"usage"')) continue;
            let row: { timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
            try {
              row = JSON.parse(line) as typeof row;
            } catch {
              continue;
            }
            const message = row.message;
            if (!message?.usage || typeof message.id !== "string" || typeof message.model !== "string") continue;
            const at = Date.parse(String(row.timestamp));
            const usage = message.usage;
            const seen = messages.get(message.id);
            if (seen) {
              seen.at = Math.min(seen.at, at);
              seen.output = Math.max(seen.output, count(usage.output_tokens));
              continue;
            }
            messages.set(message.id, {
              id: message.id,
              at,
              model: message.model,
              input: count(usage.input_tokens),
              cacheRead: count(usage.cache_read_input_tokens),
              cacheWrite: count(usage.cache_creation_input_tokens),
              output: count(usage.output_tokens),
              subagent,
            });
          }
        }
      }
    }
    const calls = [...messages.values()].sort((a, b) => a.at - b.at);
    this.byThread.set(threadId, calls);
    return calls;
  }

  private cost(call: Call): number {
    const rate = this.rates[call.model] ?? this.rates[`anthropic/${call.model}`];
    if (!rate || typeof rate.input_cost_per_token !== "number") return 0;
    return call.input * rate.input_cost_per_token + call.cacheRead * (rate.cache_read_input_token_cost ?? 0) + call.cacheWrite * (rate.cache_creation_input_token_cost ?? 0) + call.output * (rate.output_cost_per_token ?? 0);
  }

  /** The threads' calls made in [fromMs, toMs]. */
  between(threadIds: string[], fromMs: number, toMs: number): Tokens {
    const out: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0, costUsd: 0 };
    for (const threadId of threadIds) {
      for (const call of this.calls(threadId)) {
        if (!(call.at >= fromMs && call.at <= toMs)) continue;
        out.input += call.input;
        out.cacheRead += call.cacheRead;
        out.cacheWrite += call.cacheWrite;
        out.output += call.output;
        out.calls += 1;
        out.costUsd += this.cost(call);
      }
    }
    out.total = out.input + out.cacheRead + out.cacheWrite + out.output;
    return out;
  }

  /** The thread's largest single call of its own (what it sent the model), in [fromMs, toMs]. */
  peak(threadId: string, fromMs: number, toMs: number): number | null {
    const sizes = this.calls(threadId)
      .filter((c) => !c.subagent && c.at >= fromMs && c.at <= toMs)
      .map((c) => c.input + c.cacheRead + c.cacheWrite);
    return sizes.length > 0 ? Math.max(...sizes) : null;
  }
}
