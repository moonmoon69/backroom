/**
 * The comparison's four tasks (plan stage45, item R0): the prompts, byte-identical on both sides, the members each
 * task seats, and the marker that names the Consigliere's final report.
 */
import type { TaskId } from "./checkers.ts";

export type { TaskId };

/** Every prompt ends with this sentence, after a blank line. */
export const JOB_DONE_SENTENCE = "When the whole task is done, end your report to me with a line that says JOB-DONE.";

export interface TaskSpec {
  id: TaskId;
  /** What the task exercises, for the report. */
  title: string;
  /** The members seated before the prompt, besides the Consigliere: W2 only in T4. */
  members: string[];
  /** The one user message the runner posts, verbatim. */
  prompt: string;
}

const prompt = (text: string) => `${text}\n\n${JOB_DONE_SENTENCE}`;

export const TASKS: Record<TaskId, TaskSpec> = {
  T1: {
    id: "T1",
    title: "one worker alone, with a subagent",
    members: ["W1", "V"],
    prompt: prompt("Have one member find which modules `src/cli.ts` imports and whether any is unused, using a subagent to read the imported files; answer with file:line."),
  },
  T2: {
    id: "T2",
    title: "review with a seeded defect",
    members: ["W1", "V"],
    prompt: prompt("Have W1 fix the failing test in `src/dates.ts`, and have V review the fix before you report."),
  },
  T3: {
    id: "T3",
    title: "background work",
    members: ["W1", "V"],
    prompt: prompt("Have W1 run `npm run slow-check` in the background, fix what it reports, and report when it passes."),
  },
  T4: {
    id: "T4",
    title: "two members in parallel",
    members: ["W1", "V", "W2"],
    prompt: prompt("Have W1 add `slugify` to `src/text.ts` and W2 add a `--json` flag to the CLI, in parallel; have V review both; then report."),
  },
};

export const TASK_IDS: TaskId[] = ["T1", "T2", "T3", "T4"];

/**
 * True when the text has a line that says JOB-DONE: the line, without list, quote or heading marks, emphasis and
 * closing punctuation, is exactly JOB-DONE. A sentence that mentions JOB-DONE is not such a line.
 */
export function hasJobDoneLine(text: string): boolean {
  return text.split(/\r?\n/).some((line) => line.trim().replace(/^[>#*_`\-\s]+/, "").replace(/[*_`.!\s]+$/, "") === "JOB-DONE");
}
