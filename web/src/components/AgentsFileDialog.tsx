import { useState } from "react";
import { api, ApiError } from "../api.ts";
import type { AgentsFileQuestion } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { useToast } from "./Toast.tsx";

/** Which harness reads each one-line file that imports AGENTS.md (src/app/agentsFile.ts, CLAUDE_FILE). */
const HARNESS_OF: Record<string, string> = { "CLAUDE.md": "Claude" };

/**
 * The commit question for the agents file Backroom wrote in a project's folder (src/app/agentsFile.ts), asked once per
 * project: when the room that wrote it is created, and from the project's heading on the overview until it is
 * answered. Committing is the suggested answer, with the reason; closing the dialog answers nothing, and it cannot be
 * closed while an answer is on its way (what the answer opens or focuses would land wherever the user had gone).
 */
export function AgentsFileDialog({
  question,
  projectTitle,
  onClose,
  onAnswered,
  onChanged,
}: {
  question: AgentsFileQuestion;
  projectTitle: string;
  onClose: () => void;
  /** Answered: the dialog closes. */
  onAnswered: () => void;
  /** The question changed (git refused the commit): it stays open, with the reason. */
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(question.error);
  const imports = question.files.filter((file) => file !== "AGENTS.md");
  // What a commit would hold: the files Backroom wrote that git does not ignore.
  const committed = question.files.filter((file) => !question.ignored.includes(file));
  const files = (
    <>
      {question.files.map((file, index) => (
        <span key={file}>
          {index > 0 ? (index === question.files.length - 1 ? " and " : ", ") : null}
          <code>{file}</code>
        </span>
      ))}
    </>
  );

  const answer = async (commit: boolean) => {
    setBusy(true);
    try {
      const result = await api.command({ type: "project.agentsFile.answer", projectId: question.projectId, commit });
      if (commit && result.type === "project.agentsFile.answered") {
        const answered = result as Extract<typeof result, { type: "project.agentsFile.answered" }>;
        // The answer remembered may be another page's, given first.
        if (answered.answer === "leave") toast("Already answered on another page: left uncommitted");
        else if (answered.commit) toast(`Committed ${committed.join(" and ")} on ${question.branch ?? "the branch"} (${answered.commit.slice(0, 7)})`, "success");
        else toast("Nothing left to commit: the files were committed or removed meanwhile");
      }
      onAnswered();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : failure instanceof Error ? failure.message : String(failure));
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Commit the agents file?" onClose={() => (busy ? undefined : onClose())} wide>
      <div className="agents-file">
        {question.files.includes("AGENTS.md") ? (
          <p>
            Backroom wrote {files} in <span className="mono">{question.folder}</span>: the habits of every agent working in {projectTitle}, whoever assigned the work
            {imports.length > 0 ? `; ${imports.map((file) => `${file} is one line importing AGENTS.md, for ${HARNESS_OF[file] ?? "the harness that reads it"}`).join("; ")}` : ""}.
          </p>
        ) : (
          <p>
            Backroom wrote {files} in <span className="mono">{question.folder}</span>: one line importing AGENTS.md, so {imports.map((file) => HARNESS_OF[file] ?? file).join(" and ")} reads it too.
          </p>
        )}
        <p>
          <strong>Why commit it:</strong> members who work in a new worktree get only committed files. Until it is committed, only those working in the project folder read it.
        </p>
        <span className="hint">
          {question.blocked ? (
            question.blocked
          ) : (
            <>
              Commit adds {committed.join(" and ")} alone, on <code>{question.branch}</code>, with your git name, hooks and signing; nothing else is committed, and nothing is pushed. Once that branch is pushed, the files go with it to everyone who uses the repository.
            </>
          )}{" "}
          Backroom asks once per project and remembers your answer.
        </span>
        {question.ignored.length > 0 && committed.length > 0 ? (
          <span className="hint">
            {question.ignored.join(" and ")} {question.ignored.length > 1 ? "are" : "is"} ignored by git here (.gitignore), so {question.ignored.length > 1 ? "they stay" : "it stays"} out of the commit.
          </span>
        ) : null}
        <details className="agents-file-text">
          <summary>AGENTS.md</summary>
          <pre className="mono">{question.text}</pre>
        </details>
        {error && error !== question.blocked ? (
          <p className="status-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="dialog-actions">
        <button type="button" disabled={busy} data-autofocus={question.blocked ? true : undefined} onClick={() => void answer(false)}>
          Leave uncommitted
        </button>
        <button type="button" className="primary" disabled={busy || question.blocked !== null} data-autofocus={question.blocked ? undefined : true} onClick={() => void answer(true)}>
          Commit (suggested)
        </button>
      </div>
    </Dialog>
  );
}
