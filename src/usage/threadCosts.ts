/**
 * What a thread has used, and what that would cost at list price: per model, split into the thread's own calls and
 * its subagents', with input and output tokens.
 *
 * T3 reports usage per day and model only (server.getUsageSummary), never per thread. The pieces to split it by thread
 * are on this machine, and this module reads them, never writes:
 *
 *   thread  -> session     T3's state database: provider_session_runtime.resume_cursor_json
 *   session -> calls       the harness's own transcripts (Claude: ~/.claude/projects, Codex: ~/.codex/sessions)
 *   calls   -> money       T3's price table (usage-model-rates.json, LiteLLM's document)
 *
 * The same calls priced the same way give T3's own daily totals to the cent (checked for Claude and Codex), so the
 * numbers here and in T3's usage page agree. Cursor reports usage through its account, not per session, and
 * Antigravity keeps a database per conversation that T3 prices only in part: neither has an estimate here.
 *
 * T3's database and the transcripts are not public interfaces. Every read fails to "no estimate", never to a guess.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface TokenTotals {
  /** Input sent uncached. */
  inputTokens: number;
  /** Input read from the provider's cache (billed at a fraction). */
  cachedInputTokens: number;
  /** Input written to the cache. */
  cacheWriteTokens: number;
  outputTokens: number;
  /** Model calls counted. */
  calls: number;
  /** List-price value of the priced calls; calls on a model without a rate add tokens but no cost. */
  costUsd: number;
}

export interface ModelCost extends TokenTotals {
  model: string;
  /** False when the price table has no rate for the model: its tokens are counted, its cost is not. */
  priced: boolean;
  own: TokenTotals;
  subagents: TokenTotals;
}

export type CostUnavailable = "unsupported_provider" | "no_session" | "no_transcript" | "unreadable";

export interface ThreadCost {
  available: boolean;
  /** Why there is no estimate, when there is none. */
  reason: CostUnavailable | null;
  /** T3's provider for the thread (claudeAgent, codex, cursor, …), when T3 knows the thread. */
  provider: string | null;
  total: TokenTotals;
  own: TokenTotals;
  subagents: TokenTotals;
  /** Largest cost first. */
  models: ModelCost[];
  /** False when some model had no rate, so the cost is a lower bound. */
  priced: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ThreadCostSources {
  /** T3's state database (read-only). */
  t3StateDb: string;
  /** T3's price table. */
  ratesPath: string;
  claudeProjectsDir: string;
  codexSessionsDir: string;
  /** Sessions a thread has had, kept by the room: T3 remembers only the current one. */
  remember?: (threadId: string, provider: string, sessionId: string) => void;
  remembered?: (threadId: string) => Array<{ provider: string; sessionId: string }>;
}

interface Call {
  at: number;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  subagent: boolean;
}

interface FileState {
  /** Bytes read so far: transcripts only grow, so the next read starts here. */
  offset: number;
  /** A last line still being written. */
  carry: string;
  calls: Call[];
  /** Codex names the model per turn, not per call. */
  model: string | null;
}

interface Rate {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

const zero = (): TokenTotals => ({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, calls: 0, costUsd: 0 });

const add = (into: TokenTotals, call: Call, cost: number): void => {
  into.inputTokens += call.input;
  into.cachedInputTokens += call.cacheRead;
  into.cacheWriteTokens += call.cacheWrite;
  into.outputTokens += call.output;
  into.calls += 1;
  into.costUsd += cost;
};

const unavailable = (reason: CostUnavailable, provider: string | null): ThreadCost => ({
  available: false,
  reason,
  provider,
  total: zero(),
  own: zero(),
  subagents: zero(),
  models: [],
  priced: true,
  firstAt: null,
  lastAt: null,
});

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** T3's provider names to the harness whose transcripts hold the calls, and the field of the cursor naming the session. */
const HARNESS: Record<string, { harness: "claude" | "codex"; session: (cursor: Record<string, unknown>) => unknown }> = {
  claudeAgent: { harness: "claude", session: (cursor) => cursor.resume },
  codex: { harness: "codex", session: (cursor) => cursor.threadId },
};

export class ThreadCosts {
  private readonly files = new Map<string, FileState>();
  /** Claude repeats a message's usage on every block of it: each message counts once per session. */
  private readonly seen = new Map<string, Set<string>>();
  private readonly claudeDirs = new Map<string, string>();
  private codexIndex: { at: number; paths: Map<string, string> } = { at: 0, paths: new Map() };
  private rates: { mtimeMs: number; document: Record<string, Rate> } | null = null;
  private sessionsMemo: { at: number; rows: Map<string, { provider: string; cursor: Record<string, unknown> }> } | null = null;

  private readonly sources: ThreadCostSources;

  constructor(sources: ThreadCostSources) {
    this.sources = sources;
  }

  /** The calls of one or more threads (a participant rebound to another thread has several), all time. */
  cost(threadIds: string[]): ThreadCost {
    const read = this.calls(threadIds);
    if ("reason" in read) return unavailable(read.reason, read.provider);
    return this.summarise(read.calls, read.provider);
  }

  /** What the threads used between two moments: a task's run, from its start to its end. */
  costBetween(threadIds: string[], fromMs: number, toMs: number): ThreadCost {
    const read = this.calls(threadIds);
    if ("reason" in read) return unavailable(read.reason, read.provider);
    return this.summarise(
      read.calls.filter((call) => call.at >= fromMs && call.at <= toMs),
      read.provider,
    );
  }

  /** When T3 last fetched the prices, for the note under an estimate. */
  pricesFetchedAt(): string | null {
    try {
      const raw = JSON.parse(readFileSync(this.sources.ratesPath, "utf8")) as { fetchedAtMs?: number };
      return typeof raw.fetchedAtMs === "number" ? new Date(raw.fetchedAtMs).toISOString() : null;
    } catch {
      return null;
    }
  }

  private calls(threadIds: string[]): { calls: Call[]; provider: string | null } | { reason: CostUnavailable; provider: string | null } {
    let provider: string | null = null;
    let reason: CostUnavailable = "no_session";
    const calls: Call[] = [];
    let found = false;
    for (const threadId of threadIds) {
      const sessions = this.sessionsOf(threadId);
      if (sessions.provider) provider = sessions.provider;
      if (sessions.reason) {
        // The most telling reason wins: a provider without transcripts over a thread T3 has no session for.
        if (sessions.reason === "unsupported_provider" || reason === "no_session") reason = sessions.reason;
        continue;
      }
      for (const session of sessions.list) {
        const read = session.harness === "claude" ? this.readClaude(session.id) : this.readCodex(session.id);
        if (read === null) {
          if (reason === "no_session") reason = "no_transcript";
          continue;
        }
        found = true;
        calls.push(...read);
      }
    }
    return found ? { calls, provider } : { reason, provider };
  }

  private summarise(calls: Call[], provider: string | null): ThreadCost {
    const rates = this.priceTable();
    const byModel = new Map<string, ModelCost>();
    const total = zero();
    const own = zero();
    const subagents = zero();
    let first = Infinity;
    let last = 0;
    for (const call of calls) {
      const rate = rateOf(rates, call.model);
      const cost = rate
        ? call.input * (rate.input_cost_per_token ?? 0) +
          call.cacheRead * (rate.cache_read_input_token_cost ?? 0) +
          call.cacheWrite * (rate.cache_creation_input_token_cost ?? 0) +
          call.output * (rate.output_cost_per_token ?? 0)
        : 0;
      let model = byModel.get(call.model);
      if (!model) {
        model = { model: call.model, priced: rate !== null, ...zero(), own: zero(), subagents: zero() };
        byModel.set(call.model, model);
      }
      add(model, call, cost);
      add(call.subagent ? model.subagents : model.own, call, cost);
      add(total, call, cost);
      add(call.subagent ? subagents : own, call, cost);
      if (call.at < first) first = call.at;
      if (call.at > last) last = call.at;
    }
    const models = [...byModel.values()].filter((m) => m.inputTokens + m.cachedInputTokens + m.cacheWriteTokens + m.outputTokens > 0).sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens);
    return {
      available: true,
      reason: null,
      provider,
      total,
      own,
      subagents,
      models,
      priced: models.every((m) => m.priced),
      firstAt: calls.length > 0 ? new Date(first).toISOString() : null,
      lastAt: calls.length > 0 ? new Date(last).toISOString() : null,
    };
  }

  // ---- thread -> sessions ----

  private sessionsOf(threadId: string): { provider: string | null; reason: CostUnavailable | null; list: Array<{ harness: "claude" | "codex"; id: string }> } {
    const list = new Map<string, { harness: "claude" | "codex"; id: string }>();
    let provider: string | null = null;
    let reason: CostUnavailable | null = null;
    const row = this.t3Sessions()?.get(threadId);
    if (row) {
      provider = row.provider;
      const known = HARNESS[row.provider];
      if (!known) reason = "unsupported_provider";
      else {
        const id = known.session(row.cursor);
        if (typeof id === "string" && id.length > 0) {
          list.set(`${known.harness}:${id}`, { harness: known.harness, id });
          this.sources.remember?.(threadId, row.provider, id);
        }
      }
    }
    // Sessions the thread had before its current one: T3 keeps only the current, the room remembers the rest.
    for (const past of this.sources.remembered?.(threadId) ?? []) {
      const known = HARNESS[past.provider];
      if (!known) continue;
      provider ??= past.provider;
      list.set(`${known.harness}:${past.sessionId}`, { harness: known.harness, id: past.sessionId });
    }
    if (list.size > 0) return { provider, reason: null, list: [...list.values()] };
    return { provider, reason: reason ?? (this.t3Sessions() === null ? "unreadable" : "no_session"), list: [] };
  }

  /** Every thread's current session, as T3 has it; null when T3's database cannot be read. Kept for ten seconds. */
  private t3Sessions(): Map<string, { provider: string; cursor: Record<string, unknown> }> | null {
    if (this.sessionsMemo && Date.now() - this.sessionsMemo.at < 10_000) return this.sessionsMemo.rows;
    if (!existsSync(this.sources.t3StateDb)) return null;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.sources.t3StateDb, { readOnly: true });
      const rows = new Map<string, { provider: string; cursor: Record<string, unknown> }>();
      for (const row of db.prepare("SELECT thread_id, provider_name, resume_cursor_json FROM provider_session_runtime").all() as Array<Record<string, unknown>>) {
        let cursor: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(String(row.resume_cursor_json ?? "{}"));
          if (parsed && typeof parsed === "object") cursor = parsed as Record<string, unknown>;
        } catch {
          // A cursor that is not JSON names no session.
        }
        rows.set(String(row.thread_id), { provider: String(row.provider_name), cursor });
      }
      this.sessionsMemo = { at: Date.now(), rows };
      return rows;
    } catch {
      return null;
    } finally {
      db?.close();
    }
  }

  // ---- session -> calls ----

  private readClaude(sessionId: string): Call[] | null {
    const dir = this.claudeDirOf(sessionId);
    if (!dir) return null;
    const seen = this.seen.get(sessionId) ?? new Set<string>();
    this.seen.set(sessionId, seen);
    const calls: Call[] = [];
    const parse = (subagent: boolean) => (line: string, state: FileState) => {
      if (!line.includes('"usage"')) return;
      const row = parseJson(line);
      const message = row?.message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
      if (!row || !message?.usage || typeof message.model !== "string") return;
      const key = `${String(message.id)}:${String(row.requestId)}`;
      if (seen.has(key)) return;
      seen.add(key);
      state.calls.push({
        at: Date.parse(String(row.timestamp)) || 0,
        model: message.model,
        input: count(message.usage.input_tokens),
        cacheRead: count(message.usage.cache_read_input_tokens),
        cacheWrite: count(message.usage.cache_creation_input_tokens),
        output: count(message.usage.output_tokens),
        subagent,
      });
    };
    // The session's own transcript first, so a message in both is the thread's own.
    calls.push(...this.readFile(join(dir, `${sessionId}.jsonl`), parse(false)));
    for (const path of jsonlUnder(join(dir, sessionId))) calls.push(...this.readFile(path, parse(true)));
    return calls;
  }

  /** The project folder holding a session's transcript: Claude names the folder after the working directory. */
  private claudeDirOf(sessionId: string): string | null {
    const known = this.claudeDirs.get(sessionId);
    if (known) return known;
    let dirs: string[];
    try {
      dirs = readdirSync(this.sources.claudeProjectsDir);
    } catch {
      return null;
    }
    for (const name of dirs) {
      const dir = join(this.sources.claudeProjectsDir, name);
      if (existsSync(join(dir, `${sessionId}.jsonl`))) {
        this.claudeDirs.set(sessionId, dir);
        return dir;
      }
    }
    return null;
  }

  private readCodex(sessionId: string): Call[] | null {
    const path = this.codexPathOf(sessionId);
    if (!path) return null;
    return this.readFile(path, (line, state) => {
      if (line.includes('"turn_context"')) {
        const row = parseJson(line);
        const model = (row?.payload as { model?: unknown } | undefined)?.model;
        if (row?.type === "turn_context" && typeof model === "string") state.model = model;
        return;
      }
      if (!line.includes('"token_count"')) return;
      const row = parseJson(line);
      const payload = row?.payload as { type?: unknown; info?: { last_token_usage?: Record<string, unknown> } | null } | undefined;
      const usage = payload?.type === "token_count" ? payload.info?.last_token_usage : undefined;
      if (!row || !usage) return;
      const cached = count(usage.cached_input_tokens);
      state.calls.push({
        at: Date.parse(String(row.timestamp)) || 0,
        model: state.model ?? "unknown",
        // Codex counts cached input inside input.
        input: Math.max(0, count(usage.input_tokens) - cached),
        cacheRead: cached,
        cacheWrite: count(usage.cache_write_input_tokens),
        output: count(usage.output_tokens),
        subagent: false,
      });
    });
  }

  /** Codex files sessions by day (2026/09/25/rollout-<time>-<session>.jsonl): the tree is read again at most every 30s. */
  private codexPathOf(sessionId: string): string | null {
    const known = this.codexIndex.paths.get(sessionId);
    if (known) return known;
    if (Date.now() - this.codexIndex.at < 30_000) return null;
    const paths = new Map<string, string>();
    for (const path of jsonlUnder(this.sources.codexSessionsDir)) {
      const match = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
      if (match?.[1]) paths.set(match[1], path);
    }
    this.codexIndex = { at: Date.now(), paths };
    return paths.get(sessionId) ?? null;
  }

  /** The calls in a transcript, reading only what was appended since the last read. */
  private readFile(path: string, parse: (line: string, state: FileState) => void): Call[] {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return this.files.get(path)?.calls ?? [];
    }
    let state = this.files.get(path);
    // Smaller than what was read: not the file it was. Start over (its messages are counted again by their ids).
    if (!state || size < state.offset) {
      state = { offset: 0, carry: "", calls: [], model: null };
      this.files.set(path, state);
    }
    if (size === state.offset) return state.calls;
    let text: string;
    try {
      const handle = openSync(path, "r");
      try {
        const buffer = Buffer.alloc(size - state.offset);
        const got = readSync(handle, buffer, 0, buffer.length, state.offset);
        text = state.carry + buffer.subarray(0, got).toString("utf8");
        state.offset += got;
      } finally {
        closeSync(handle);
      }
    } catch {
      return state.calls;
    }
    const lines = text.split("\n");
    state.carry = lines.pop() ?? "";
    for (const line of lines) if (line.length > 0) parse(line, state);
    return state.calls;
  }

  // ---- calls -> money ----

  private priceTable(): Record<string, Rate> {
    try {
      const mtimeMs = statSync(this.sources.ratesPath).mtimeMs;
      if (this.rates?.mtimeMs === mtimeMs) return this.rates.document;
      const raw = JSON.parse(readFileSync(this.sources.ratesPath, "utf8")) as { document?: Record<string, Rate> };
      this.rates = { mtimeMs, document: raw.document ?? {} };
      return this.rates.document;
    } catch {
      return this.rates?.document ?? {};
    }
  }
}

function rateOf(rates: Record<string, Rate>, model: string): Rate | null {
  const rate = rates[model] ?? rates[`anthropic/${model}`] ?? rates[`openai/${model}`];
  return rate && typeof rate.input_cost_per_token === "number" ? rate : null;
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every .jsonl file under a folder, in a stable order; none when the folder is not there. */
function jsonlUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (folder: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && depth < 6) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  walk(dir, 0);
  return found;
}
