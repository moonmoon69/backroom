/**
 * What Backroom shows of a T3 thread, read from its projection (T3's Orchestrator V2): the conversation as one reply
 * per run, the run in progress as it streams, the approvals and questions it waits on, its context reading, the work
 * it left running, and what its runs changed. Pure functions over a thread detail; a room's desk and a thread on its
 * own use the same ones.
 */
import type { T3Message, T3Run, T3RuntimeRequest, T3Subagent, T3ThreadDetail, T3TurnItem } from "../adapter/types.ts";
import { isRunActive, openRequests } from "../adapter/types.ts";

// ---------------- the conversation ----------------

export type ThreadItem =
  | { kind: "user"; id: string; text: string; attachmentIds: string[]; at: string }
  | {
      kind: "reply";
      id: string;
      /** The T3 run that produced it (for a conversation imported from T3 V1, which has no runs, a stand-in key). */
      runId: string;
      /** The run's last message: the answer. */
      text: string;
      /** Earlier messages of the run (notes between tool calls). */
      progress: Array<{ text: string; at: string }>;
      at: string;
      /** How the run ended when it did not complete normally. */
      state: "error" | "interrupted" | null;
      files: { count: number; additions: number; deletions: number } | null;
    };

/** The run in progress, once the provider is on it or about to be: what the view streams. */
export function runningRun(detail: T3ThreadDetail): T3Run | null {
  return detail.runs.find((run) => run.status !== "queued" && isRunActive(run.status)) ?? null;
}

/**
 * The conversation as T3 shows it: each message a person wrote, then one reply per run (its last assistant message,
 * with the earlier ones as progress). The run in progress is left out; the view streams it separately. A message
 * steered into a run splits that run's reply around it, as it happened. Notices T3 writes for the agent (a
 * background command finished) are not the user's messages and are left out.
 */
export function threadTranscript(detail: T3ThreadDetail): ThreadItem[] {
  const running = runningRun(detail)?.id ?? null;
  const items: ThreadItem[] = [];
  const messages = [...detail.messages].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  let importedGroup = 0;
  for (const message of messages) {
    if (message.role === "user") {
      importedGroup += 1;
      if (message.createdBy !== "user") continue;
      const attachmentIds = message.attachments.filter((a) => a.type === "image").map((a) => a.id);
      if (message.text.trim().length === 0 && attachmentIds.length === 0) continue;
      items.push({ kind: "user", id: message.id, text: message.text, attachmentIds, at: message.createdAt });
      continue;
    }
    if (message.role !== "assistant" || message.text.trim().length === 0) continue;
    if (message.runId !== null && message.runId === running) continue;
    // T3's V1 import keeps messages without runs: the assistant messages after a user message are one reply.
    const runId = message.runId ?? `imported:${importedGroup}`;
    const last = items[items.length - 1];
    if (last?.kind === "reply" && last.runId === runId) {
      last.progress.push({ text: last.text, at: last.at });
      last.text = message.text;
      last.at = message.createdAt;
      last.id = message.id;
      continue;
    }
    items.push({ kind: "reply", id: message.id, runId, text: message.text, progress: [], at: message.createdAt, state: null, files: null });
  }
  // Outcome and changed files belong on the run's last reply.
  const lastReplyOfRun = new Map<string, Extract<ThreadItem, { kind: "reply" }>>();
  for (const item of items) if (item.kind === "reply") lastReplyOfRun.set(item.runId, item);
  for (const checkpoint of detail.checkpoints) {
    const reply = checkpoint.runId ? lastReplyOfRun.get(checkpoint.runId) : undefined;
    if (!reply || checkpoint.files.length === 0) continue;
    reply.files = {
      count: checkpoint.files.length,
      additions: checkpoint.files.reduce((sum, f) => sum + f.additions, 0),
      deletions: checkpoint.files.reduce((sum, f) => sum + f.deletions, 0),
    };
  }
  for (const run of detail.runs) {
    const reply = lastReplyOfRun.get(run.id);
    if (!reply) continue;
    if (run.status === "failed" || run.status === "rolled_back") reply.state = "error";
    else if (run.status === "interrupted" || run.status === "cancelled") reply.state = "interrupted";
  }
  return items;
}

// ---------------- approvals and questions ----------------

/** A T3 request as the request cards read it: what is asked, the provider's choices, and whether it holds the run. */
export function requestPayload(request: T3RuntimeRequest): Record<string, unknown> {
  return {
    requestId: request.id,
    requestType: request.kind,
    detail: request.prompt,
    options: request.options,
    questions: request.questions,
    responseMode: request.responseMode,
  };
}

export interface RequestCard {
  requestId: string;
  kind: "approval" | "user-input";
  payload: unknown;
  createdAt: string;
}

/** Approvals and questions the thread is waiting on. */
export function requestCards(detail: T3ThreadDetail): RequestCard[] {
  return openRequests(detail).map((request) => ({ requestId: request.id, kind: request.type, payload: requestPayload(request), createdAt: request.createdAt }));
}

// ---------------- the run in progress ----------------

export type LiveFeedItem =
  | { kind: "message"; id: string; text: string; streaming: boolean; at: string }
  | { kind: "tools"; count: number; errors: number; labels: string[]; /** The tools still running, by label. */ running: string[]; at: string }
  /** Something the harness does besides answering: the context being compacted. `active` while it runs. */
  | { kind: "notice"; id: string; text: string; active: boolean; at: string };

type ToolItem = Extract<T3TurnItem, { type: "command_execution" | "file_change" | "file_search" | "web_search" | "dynamic_tool" | "subagent" }>;

const isTool = (item: T3TurnItem): item is ToolItem =>
  item.type === "command_execution" || item.type === "file_change" || item.type === "file_search" || item.type === "web_search" || item.type === "dynamic_tool" || item.type === "subagent";

/** A tool call's name as the feed lists it: the tool, not its input. */
export function toolLabel(item: ToolItem): string {
  switch (item.type) {
    case "command_execution":
      return item.title ?? "Command";
    case "file_change":
      return "Edit";
    case "file_search":
      return "Search";
    case "web_search":
      return "Web search";
    case "subagent":
      return "Agent";
    case "dynamic_tool":
      return item.toolName ?? item.title ?? "Tool";
  }
}

const toolFailed = (item: ToolItem): boolean => item.status === "failed" || (item.type === "command_execution" && item.outputIndicatesFailure);
const toolRunningStatus = (status: T3TurnItem["status"]): boolean => status === "running" || status === "pending" || status === "waiting";
const toolRunning = (item: ToolItem): boolean => toolRunningStatus(item.status);
const itemAt = (item: T3TurnItem): string => item.completedAt ?? item.startedAt ?? item.updatedAt;

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A compaction as T3 words it: running, how it ended, and the context before and after when the provider said. */
function compactionText(item: Extract<T3TurnItem, { type: "compaction" }>): string {
  if (item.status === "failed") return "Context compaction failed";
  if (item.status === "cancelled" || item.status === "interrupted") return "Context compaction stopped";
  if (item.status !== "completed") return "Compacting context…";
  return item.beforeTokenCount !== null && item.afterTokenCount !== null ? `Context compacted ${tokens(item.beforeTokenCount)} → ${tokens(item.afterTokenCount)} tokens` : "Context compacted";
}

/**
 * The run as T3 shows it: each assistant message separately, with the tool calls between them collapsed into one
 * item per burst ("ran 4 tools: Command, Edit, ..."), in the order T3 recorded them, and the context's compactions.
 * A run whose message is "/compact" is compacting until its compaction item arrives (T3 sends nothing sooner; its
 * own page infers the same).
 */
export function liveFeed(detail: T3ThreadDetail, runId: string | null): LiveFeedItem[] {
  if (!runId) return [];
  const feed: LiveFeedItem[] = [];
  let compactCommandAt: string | null = null;
  let compactionSeen = false;
  for (const item of detail.turnItems) {
    if (item.runId !== runId) continue;
    if (item.type === "user_message") {
      if (item.text.trim().toLowerCase() === "/compact" && item.attachments.length === 0) compactCommandAt = itemAt(item);
      continue;
    }
    if (item.type === "compaction") {
      compactionSeen = true;
      feed.push({ kind: "notice", id: item.id, text: compactionText(item), active: toolRunningStatus(item.status), at: itemAt(item) });
      continue;
    }
    if (item.type === "assistant_message") {
      if (item.text.trim().length > 0) feed.push({ kind: "message", id: item.messageId, text: item.text, streaming: item.streaming, at: item.startedAt ?? item.updatedAt });
      continue;
    }
    if (!isTool(item)) continue;
    const label = toolLabel(item);
    const last = feed[feed.length - 1];
    if (last?.kind === "tools") {
      last.count += 1;
      if (toolFailed(item)) last.errors += 1;
      if (!last.labels.includes(label) && last.labels.length < 6) last.labels.push(label);
      if (toolRunning(item) && !last.running.includes(label)) last.running.push(label);
      last.at = itemAt(item);
    } else {
      feed.push({ kind: "tools", count: 1, errors: toolFailed(item) ? 1 : 0, labels: [label], running: toolRunning(item) ? [label] : [], at: itemAt(item) });
    }
  }
  const run = detail.runs.find((r) => r.id === runId);
  if (compactCommandAt !== null && !compactionSeen && run && isRunActive(run.status)) feed.push({ kind: "notice", id: `compacting:${runId}`, text: "Compacting context…", active: true, at: compactCommandAt });
  return feed.slice(-40);
}

/** Tool calls over the items read: how many started, finished and failed, and the last one's name. */
export function toolSummary(detail: T3ThreadDetail): { started: number; completed: number; errors: number; lastTool: string | null } {
  const summary = { started: 0, completed: 0, errors: 0, lastTool: null as string | null };
  for (const item of detail.turnItems) {
    if (item.type === "error") summary.errors += 1;
    if (!isTool(item)) continue;
    summary.started += 1;
    if (item.status !== "running" && item.status !== "pending" && item.status !== "waiting") {
      summary.completed += 1;
      summary.lastTool = toolLabel(item);
    }
    if (toolFailed(item)) summary.errors += 1;
  }
  return summary;
}

/** The recent items of the thread as a plain list (the desk's "recent activity"): tools, requests, errors, notices. */
export function recentActivity(detail: T3ThreadDetail, limit = 80): Array<{ id: string; tone: "info" | "tool" | "approval" | "error"; kind: string; summary: string; payload: unknown; runId: string | null; createdAt: string }> {
  const rows: ReturnType<typeof recentActivity> = [];
  for (const item of detail.turnItems) {
    const base = { id: item.id, payload: {}, runId: item.runId, createdAt: itemAt(item) };
    if (isTool(item)) {
      const what = item.type === "command_execution" ? item.input : item.type === "file_change" ? item.fileName : item.type === "file_search" ? (item.pattern ?? "") : item.type === "web_search" ? item.patterns.join(", ") : item.type === "subagent" ? item.prompt : "";
      rows.push({ ...base, tone: toolFailed(item) ? "error" : "tool", kind: item.type, summary: [toolLabel(item), what.split("\n")[0]?.slice(0, 120)].filter(Boolean).join(": ") });
    } else if (item.type === "approval_request") rows.push({ ...base, tone: "approval", kind: item.type, summary: `Approval requested: ${item.prompt ?? item.requestKind}` });
    else if (item.type === "user_input_request") rows.push({ ...base, tone: "approval", kind: item.type, summary: `Question: ${item.questions.map((q) => q.question).join(" / ")}` });
    else if (item.type === "error") rows.push({ ...base, tone: "error", kind: item.type, summary: item.message });
    else if (item.type === "compaction") rows.push({ ...base, tone: "info", kind: item.type, summary: "Context compacted" });
    else if (item.type === "checkpoint") rows.push({ ...base, tone: "info", kind: item.type, summary: `Checkpoint (${item.files.length} file${item.files.length === 1 ? "" : "s"})` });
    else if (item.type === "system_notice" || item.type === "run_interrupt_request" || item.type === "run_interrupt_result") rows.push({ ...base, tone: "info", kind: item.type, summary: item.message });
  }
  return rows.slice(-limit);
}

// ---------------- context ----------------

export interface ContextReading {
  usedTokens: number;
  maxTokens: number;
  percent: number;
  inputTokens?: number;
  outputTokens?: number;
  at: string;
}

/** The latest context-window reading T3 has for the thread: the newest provider turn's, else the conversation's. */
export function contextReading(detail: T3ThreadDetail): ContextReading | null {
  const turns = detail.providerTurns.filter((turn) => turn.tokenUsage !== null && (turn.tokenUsage.maxTokens ?? 0) > 0);
  const latest = turns.sort((a, b) => (a.tokenUsage?.updatedAt ?? "").localeCompare(b.tokenUsage?.updatedAt ?? "")).pop()?.tokenUsage ?? null;
  const usage = latest ?? detail.providerThreads.map((thread) => thread.contextUsage).filter((u) => u !== null && (u.maxTokens ?? 0) > 0).pop() ?? null;
  if (!usage || !usage.maxTokens) return null;
  return {
    usedTokens: usage.usedTokens,
    maxTokens: usage.maxTokens,
    percent: Math.round((usage.usedTokens / usage.maxTokens) * 1000) / 10,
    ...(usage.inputTokens !== null ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== null ? { outputTokens: usage.outputTokens } : {}),
    at: usage.updatedAt || detail.shell.updatedAt,
  };
}

/** The compactions T3 recorded, with the context before and after when the provider said. */
export function compactions(detail: T3ThreadDetail): Array<{ beforeTokens: number; afterTokens: number; at: string }> {
  return detail.turnItems.flatMap((item) =>
    item.type === "compaction" && item.beforeTokenCount !== null && item.afterTokenCount !== null ? [{ beforeTokens: item.beforeTokenCount, afterTokens: item.afterTokenCount, at: itemAt(item) }] : [],
  );
}

// ---------------- work beside the run ----------------

export interface BackgroundTask {
  taskId: string;
  title: string;
  /** "agent" (a subagent) or "background" (a command, a monitor), as the members panel counts them. */
  kind: "agent" | "background";
  /** T3's kind for the work: subagent, command, monitor or background_task. */
  type: string | null;
  detail: string | null;
  lastTool: string | null;
  startedAt: string;
  updatedAt: string;
}

const SUBAGENT_OPEN = new Set<T3Subagent["status"]>(["pending", "running", "waiting"]);

/**
 * Work still running on the thread: its subagents that have not finished, and what T3 lists as running after the run
 * settled (commands and monitors the provider left in the background).
 */
export function backgroundTasks(detail: T3ThreadDetail): BackgroundTask[] {
  const tasks = new Map<string, BackgroundTask>();
  for (const subagent of detail.subagents) {
    if (!SUBAGENT_OPEN.has(subagent.status)) continue;
    tasks.set(subagent.id, {
      taskId: subagent.id,
      title: subagent.title ?? subagent.prompt.split("\n")[0]?.slice(0, 80) ?? "subagent",
      kind: "agent",
      type: "subagent",
      detail: subagent.progress,
      lastTool: null,
      startedAt: subagent.startedAt ?? subagent.updatedAt,
      updatedAt: subagent.updatedAt,
    });
  }
  for (const task of detail.shell.pendingBackgroundTasks) {
    if (tasks.has(task.taskId)) continue;
    tasks.set(task.taskId, {
      taskId: task.taskId,
      title: task.description ?? (task.kind === "subagent" ? "subagent" : task.kind === "monitor" ? "monitor" : "background task"),
      kind: task.kind === "subagent" ? "agent" : "background",
      type: task.kind,
      detail: null,
      lastTool: null,
      startedAt: detail.shell.latestRunCompletedAt ?? detail.shell.updatedAt,
      updatedAt: detail.shell.updatedAt,
    });
  }
  return [...tasks.values()];
}

export interface SubagentRow {
  taskId: string;
  title: string;
  model: string | null;
  /** T3 does not report a subagent's tokens apart from its parent's; kept for the card, zero. */
  tokens: number;
  toolUses: number;
  durationMs: number;
  status: "running" | "completed" | "failed";
}

/** The thread's subagents with what T3 reports for each: its title, model, how long it ran and how it ended. */
export function subagentRows(detail: T3ThreadDetail): SubagentRow[] {
  return detail.subagents.map((subagent) => ({
    taskId: subagent.id,
    title: subagent.title ?? subagent.prompt.split("\n")[0]?.slice(0, 80) ?? "subagent",
    model: subagent.model,
    tokens: 0,
    toolUses: 0,
    durationMs: subagent.startedAt ? Math.max(0, Date.parse(subagent.completedAt ?? subagent.updatedAt) - Date.parse(subagent.startedAt)) : 0,
    status: SUBAGENT_OPEN.has(subagent.status) || subagent.status === "idle" ? "running" : subagent.status === "completed" ? "completed" : "failed",
  }));
}

// ---------------- plans and changes ----------------

/** Where the agent is in its to-do list, when it keeps one: the step in progress and how many are done. */
export function planProgress(detail: T3ThreadDetail): { step: string; completedSteps: number; totalSteps: number } | null {
  const plan = detail.plans.filter((p) => p.kind === "todo_list" && p.steps.length > 0 && (p.status === "active" || p.status === "draft")).pop();
  if (!plan) return null;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const current = plan.steps.find((step) => step.status === "running") ?? plan.steps.find((step) => step.status === "pending");
  if (!current) return null;
  return { step: current.text, completedSteps: completed, totalSteps: plan.steps.length };
}

/** The latest plan the agent proposed (plan mode), and whether it is still waiting to be acted on. */
export function proposedPlan(detail: T3ThreadDetail): { id: string; runId: string | null; implementedAt: string | null; createdAt: string; markdown: string } | null {
  const plan = detail.plans.filter((p) => p.kind === "proposed_plan" && p.markdown !== null).pop();
  if (!plan) return null;
  const item = detail.turnItems.find((i) => i.type === "proposed_plan" && i.planId === plan.id);
  const at = item ? itemAt(item) : detail.shell.updatedAt;
  return { id: plan.id, runId: plan.runId, implementedAt: plan.status === "completed" || plan.status === "superseded" ? at : null, createdAt: item?.startedAt ?? at, markdown: plan.markdown ?? "" };
}

/** The files each of the last runs changed, newest last. */
export function recentCheckpoints(detail: T3ThreadDetail, limit = 6): Array<{ runId: string | null; status: string; completedAt: string; files: Array<{ path: string; kind: string; additions: number; deletions: number }>; additions: number; deletions: number }> {
  return detail.checkpoints
    .filter((checkpoint) => checkpoint.runId !== null)
    .slice(-limit)
    .map((checkpoint) => ({
      runId: checkpoint.runId,
      status: checkpoint.status,
      completedAt: checkpoint.capturedAt,
      files: checkpoint.files,
      additions: checkpoint.files.reduce((sum, file) => sum + file.additions, 0),
      deletions: checkpoint.files.reduce((sum, file) => sum + file.deletions, 0),
    }));
}

/**
 * Every file the thread's runs changed, with when a run last did (the Git tab uses it to say who changed an
 * uncommitted file: a participant whose run touched it after the last commit).
 */
export function changedFiles(detail: T3ThreadDetail): Array<{ path: string; kind: string; additions: number; deletions: number; turns: number; lastAt: string | null }> {
  const files = new Map<string, { path: string; kind: string; additions: number; deletions: number; turns: number; lastAt: string | null }>();
  for (const checkpoint of detail.checkpoints) {
    for (const file of checkpoint.files) {
      const existing = files.get(file.path);
      if (existing) {
        existing.additions += file.additions;
        existing.deletions += file.deletions;
        existing.turns += 1;
        existing.kind = file.kind;
        if (!existing.lastAt || checkpoint.capturedAt > existing.lastAt) existing.lastAt = checkpoint.capturedAt;
      } else {
        files.set(file.path, { ...file, turns: 1, lastAt: checkpoint.capturedAt });
      }
    }
  }
  return [...files.values()];
}

/** A run's assistant messages joined, as they stand (streaming included). */
export function streamingText(detail: T3ThreadDetail, runId: string | null): string {
  if (!runId) return "";
  return detail.messages
    .filter((message: T3Message) => message.runId === runId && message.role === "assistant")
    .map((message) => message.text)
    .join("\n\n");
}
