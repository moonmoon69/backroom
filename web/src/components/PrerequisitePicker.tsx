import { useRoom } from "../context.tsx";
import { taskLabel, type PrerequisiteRef, type Task } from "../types.ts";

interface Props {
  value: PrerequisiteRef[];
  onChange: (next: PrerequisiteRef[]) => void;
  /** Task ids to hide (e.g. the task being edited). */
  exclude?: string[];
  /** Restrict to these candidates when the parser supplied a list. */
  candidates?: Array<{ taskId: string; revision: number; label: string }>;
  invalid?: boolean;
}

/** Multi-select over non-cancelled tasks shown as `task{n}: instruction` with the current revision. */
export function PrerequisitePicker({ value, onChange, exclude = [], candidates, invalid }: Props) {
  const { snapshot, aliasOf } = useRoom();
  const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
  const options: Array<{ task: Task | undefined; taskId: string; revision: number; label: string }> = candidates
    ? candidates.map((c) => ({ task: taskById.get(c.taskId), taskId: c.taskId, revision: c.revision, label: c.label }))
    : snapshot.tasks
        .filter((t) => t.state !== "cancelled" && !exclude.includes(t.id))
        .map((t) => ({ task: t, taskId: t.id, revision: t.revision, label: `${taskLabel(t)}: ${t.instruction}` }));

  const toggle = (taskId: string, revision: number, checked: boolean) => {
    if (checked) onChange([...value.filter((p) => p.taskId !== taskId), { taskId, revision }]);
    else onChange(value.filter((p) => p.taskId !== taskId));
  };

  return (
    <div className={`prereq-picker${invalid ? " invalid" : ""}`} role="group" aria-label="Prerequisite tasks">
      {options.length === 0 ? <span className="muted">No tasks available as prerequisites.</span> : null}
      {options.map((option) => {
        const checked = value.some((p) => p.taskId === option.taskId);
        return (
          <label key={option.taskId} className={`prereq-item${checked ? " selected" : ""}`}>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => toggle(option.taskId, option.revision, event.target.checked)}
            />
            <span className="tag mono">{option.task ? taskLabel(option.task) : option.taskId}</span>
            <span className="prereq-label" title={option.label}>
              {option.task ? option.task.instruction : option.label}
            </span>
            <span className="prereq-meta mono">
              {option.task ? `${aliasOf(option.task.participantId)} · ${option.task.state} · ` : ""}r{option.revision}
            </span>
          </label>
        );
      })}
    </div>
  );
}
