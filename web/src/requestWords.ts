/** How the page words the approvals, questions and secrets T3 waits on (a status chip, what is read aloud). */
import type { NativeRequest } from "./types.ts";

const KIND_WORDS: Record<NativeRequest["kind"], string> = { approval: "approval", secret: "secret", "user-input": "question" };

/** What a member's requests are, in a status chip's words: "approval", "secret", "approval and question"… */
export function requestsWhat(kinds: ReadonlyArray<NativeRequest["kind"]>): string {
  const words = (["approval", "secret", "user-input"] as const).filter((kind) => kinds.includes(kind)).map((kind) => KIND_WORDS[kind]);
  return words.length > 1 ? `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}` : (words[0] ?? "question");
}

/** What is read aloud when a request comes, after who asks. */
export const asksYou = (kind: NativeRequest["kind"]): string => (kind === "approval" ? "needs your approval." : kind === "secret" ? "is asking for a secret." : "has a question for you.");
