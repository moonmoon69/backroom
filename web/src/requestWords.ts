/** How the page words the approvals, questions and secrets T3 waits on (a status chip, what is read aloud). */
import type { ApprovalDecision, NativeRequest } from "./types.ts";

const KIND_WORDS: Record<NativeRequest["kind"], string> = { approval: "approval", secret: "secret", "user-input": "question" };

/** What a member's requests are, in a status chip's words: "approval", "secret", "approval and question"… */
export function requestsWhat(kinds: ReadonlyArray<NativeRequest["kind"]>): string {
  const words = (["approval", "secret", "user-input"] as const).filter((kind) => kinds.includes(kind)).map((kind) => KIND_WORDS[kind]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "question");
}

/** What is read aloud when a request comes, after who asks. */
export const asksYou = (kind: NativeRequest["kind"]): string => (kind === "approval" ? "needs your approval." : kind === "secret" ? "is asking for a secret." : "has a question for you.");

const DECISIONS: Array<{ decision: ApprovalDecision; label: string; tone?: string }> = [
  { decision: "accept", label: "Accept", tone: "primary" },
  { decision: "acceptForSession", label: "Accept for session" },
  { decision: "acceptAlways", label: "Always accept" },
  { decision: "decline", label: "Decline", tone: "danger" },
  { decision: "cancel", label: "Cancel turn", tone: "danger" },
];

/** The decision a choice's button is coloured by: approving is the primary one, refusing a danger. */
const TONE: Partial<Record<ApprovalDecision, string>> = { accept: "primary", decline: "danger", cancel: "danger" };

/**
 * The choices an approval offers: its own, in its order and words, when the request names them (an MCP server's form
 * request offers Cancel, Decline and Approve, and a session or permanent approval only when the server allows it);
 * else T3's five decisions.
 */
export function approvalChoices(options: unknown): Array<{ decision: ApprovalDecision; label: string; tone?: string; warning?: string }> {
  const valid = Array.isArray(options) ? options.filter((o): o is { decision: ApprovalDecision; label: string; warning?: unknown } => Boolean(o) && DECISIONS.some((d) => d.decision === o.decision) && typeof o.label === "string" && o.label.length > 0) : [];
  if (valid.length === 0) return DECISIONS;
  return valid.map((o) => ({ decision: o.decision, label: o.label, ...(TONE[o.decision] ? { tone: TONE[o.decision]! } : {}), ...(typeof o.warning === "string" && o.warning ? { warning: o.warning } : {}) }));
}
