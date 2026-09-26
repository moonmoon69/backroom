import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import type { ModelOptionDescriptor, ModelSelection, ProjectRefs, RuntimeMode, T3ThreadShell, ThreadBindingInput, WorkspaceChoice } from "../types.ts";
import { defaultOptionValue, selectionFor, useCatalog } from "./catalog.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { Popover } from "./Popover.tsx";
import { optionLabel } from "./deskFormat.ts";
import { useToast } from "./Toast.tsx";
import { BranchIcon, ChevronIcon } from "./icons.tsx";

export { ModelPicker, selectionFor };

/** T3's permission modes, with T3 Code's own names and descriptions. */
export const RUNTIME_MODE_INFO: Record<RuntimeMode, { label: string; description: string }> = {
  "approval-required": { label: "Supervised", description: "Ask before commands and file changes." },
  "auto-accept-edits": { label: "Auto-accept edits", description: "Auto-approve edits, ask before other actions." },
  auto: { label: "Auto", description: "Supported providers approve routine actions; others still ask." },
  "full-access": { label: "Full access", description: "Allow commands and edits without prompts." },
};
const RUNTIME_MODE_ORDER: RuntimeMode[] = ["approval-required", "auto-accept-edits", "auto", "full-access"];

/** A button that opens a menu below it; `children` gets a close function. */
function DropdownButton({ label, title, className, children }: { label: ReactNode; title: string; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`setting-button${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
        <ChevronIcon dir={open ? "up" : "down"} />
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="menu" className="setting-menu" onClose={() => setOpen(false)}>
          {children(() => setOpen(false))}
        </Popover>
      ) : null}
    </>
  );
}

/**
 * The model's options (reasoning effort, context window, fast mode, …) as one dropdown, like T3 Code's composer: the
 * button shows the current choices, the menu has a section per option. Nothing when the model has no options.
 */
export function ModelOptionsMenu({ value, onChange }: { value: ModelSelection | null; onChange: (selection: ModelSelection) => void }) {
  const catalog = useCatalog();
  const entry = value ? catalog?.find((e) => e.instanceId === value.instanceId && e.model === value.model) : undefined;
  const descriptors = entry?.optionDescriptors ?? [];
  if (!value || !entry || descriptors.length === 0) return null;
  const currentOf = (descriptor: ModelOptionDescriptor) => value.options?.find((o) => o.id === descriptor.id)?.value ?? defaultOptionValue(descriptor);
  const setOption = (descriptor: ModelOptionDescriptor, next: unknown) => {
    const ordered = descriptors.map((d) => (d.id === descriptor.id ? { id: d.id, value: next } : { id: d.id, value: currentOf(d) }));
    onChange({ instanceId: value.instanceId, model: value.model, options: ordered });
  };
  const summary = descriptors
    .map((d) => {
      const current = currentOf(d);
      if (d.type === "boolean") return current === true ? d.label : null;
      return (d.options ?? []).find((o) => o.id === current)?.label ?? String(current ?? "");
    })
    .filter(Boolean)
    .join(" · ");
  const detail = descriptors.map((d) => `${d.label}: ${d.type === "boolean" ? (currentOf(d) === true ? "on" : "off") : ((d.options ?? []).find((o) => o.id === currentOf(d))?.label ?? "")}`).join(", ");
  return (
    <DropdownButton label={<span className="setting-value">{summary || "Options"}</span>} title={`Model options: ${detail}`}>
      {() =>
        descriptors.map((descriptor) => (
          <div key={descriptor.id} className="setting-section" role="group" aria-label={descriptor.label}>
            <span className="setting-section-head">{descriptor.label}</span>
            {descriptor.type === "boolean" ? (
              <button type="button" role="menuitemcheckbox" aria-checked={currentOf(descriptor) === true} onClick={() => setOption(descriptor, currentOf(descriptor) !== true)}>
                <span className="setting-check">{currentOf(descriptor) === true ? "✓" : ""}</span>
                {currentOf(descriptor) === true ? "On" : "Off"}
              </button>
            ) : (
              (descriptor.options ?? []).map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={currentOf(descriptor) === choice.id}
                  title={choice.description ?? undefined}
                  onClick={() => setOption(descriptor, choice.id)}
                >
                  <span className="setting-check">{currentOf(descriptor) === choice.id ? "✓" : ""}</span>
                  {choice.label}
                  {choice.isDefault ? <span className="muted"> default</span> : null}
                </button>
              ))
            )}
          </div>
        ))
      }
    </DropdownButton>
  );
}

/** T3's permission mode for the thread, as one dropdown with T3 Code's names and descriptions. */
export function PermissionMenu({ value, onChange }: { value: RuntimeMode; onChange: (mode: RuntimeMode) => void }) {
  return (
    <DropdownButton label={<span className="setting-value">{RUNTIME_MODE_INFO[value].label}</span>} title={`Permission mode: ${RUNTIME_MODE_INFO[value].label}. ${RUNTIME_MODE_INFO[value].description}`}>
      {(close) =>
        RUNTIME_MODE_ORDER.map((mode) => (
          <button
            key={mode}
            type="button"
            role="menuitemradio"
            aria-checked={value === mode}
            className="setting-choice"
            onClick={() => {
              onChange(mode);
              close();
            }}
          >
            <span className="setting-check">{value === mode ? "✓" : ""}</span>
            <span>
              {RUNTIME_MODE_INFO[mode].label}
              <span className="hint">{RUNTIME_MODE_INFO[mode].description}</span>
            </span>
          </button>
        ))
      }
    </DropdownButton>
  );
}

/**
 * The thread's T3 settings in one row, like T3 Code's composer: model, the model's options, and permission mode. All
 * three are T3's own settings; the room only passes them on.
 */
export function ThreadSettingsRow({
  model,
  onModel,
  runtimeMode,
  onRuntimeMode,
  providerFilter,
  pending,
}: {
  model: ModelSelection | null;
  onModel: (selection: ModelSelection) => void;
  runtimeMode: RuntimeMode;
  onRuntimeMode: (mode: RuntimeMode) => void;
  providerFilter?: string | undefined;
  /** While T3's default model is being looked up, the picker waits so it cannot pick one first. */
  pending?: boolean;
}) {
  return (
    <div className="thread-settings-row">
      {pending ? <span className="muted model-pending">looking up T3&rsquo;s default model…</span> : <ModelPicker value={model} onChange={onModel} {...(providerFilter ? { providerFilter } : {})} />}
      <ModelOptionsMenu value={model} onChange={onModel} />
      <PermissionMenu value={runtimeMode} onChange={onRuntimeMode} />
    </div>
  );
}

/** A branch-name fragment, as the server makes them: lowercase letters, digits and dashes. */
export const branchSlug = (text: string, fallback: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || fallback;

/** A new worktree needs its base branch; the other choices are complete. */
export const workspaceReady = (choice: WorkspaceChoice): boolean => choice.mode !== "worktree" || choice.baseBranch.length > 0;

/** The project's branches and worktrees, read when the form opens (they change as worktrees are made). */
function useProjectRefs(projectId: string): { refs: ProjectRefs | null; error: string | null } {
  const [state, setState] = useState<{ projectId: string; refs: ProjectRefs | null; error: string | null }>({ projectId, refs: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ projectId, refs: null, error: null });
    api
      .projectRefs(projectId)
      .then((refs) => !cancelled && setState({ projectId, refs, error: null }))
      .catch((error) => !cancelled && setState({ projectId, refs: null, error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return state.projectId === projectId ? state : { refs: null, error: null };
}

/**
 * Where a new thread works, like T3 Code's new-thread toolbar: the project folder (shared with anyone else there), a
 * new worktree made now from a base branch, or an existing worktree. Starts on T3's default for the project. With a
 * new worktree, the base branch and the new branch's name sit beside the dropdown; `newBranchHint` says what an empty
 * name becomes.
 */
export function WorkspacePicker({
  projectId,
  value,
  onChange,
  newBranchHint,
}: {
  projectId: string;
  value: WorkspaceChoice;
  onChange: (choice: WorkspaceChoice) => void;
  newBranchHint: string;
}) {
  const { refs, error } = useProjectRefs(projectId);
  const root = refs?.workspaceRoot ?? null;
  const rootBranch = refs?.refs.find((r) => r.worktreePath === root)?.name ?? null;
  const worktrees = (refs?.refs ?? []).filter((r) => r.worktreePath && r.worktreePath !== root);
  const bases = (refs?.refs ?? []).filter((r) => !r.isRemote).concat((refs?.refs ?? []).filter((r) => r.isRemote));
  const defaultBase = (bases.find((r) => r.isDefault) ?? bases.find((r) => r.current) ?? bases[0])?.name ?? "";
  // T3's project default applies once, when the branches arrive; after that the choice is the user's.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!refs || applied.current === projectId) return;
    applied.current = projectId;
    if (refs.defaultMode === "worktree" && refs.isRepo && value.mode === "local" && defaultBase) onChange({ mode: "worktree", baseBranch: defaultBase });
  }, [refs, projectId, value.mode, defaultBase, onChange]);

  const existing = value.mode === "existing" ? worktrees.find((r) => r.worktreePath === value.worktreePath) : undefined;
  const label = value.mode === "local" ? "Project folder" : value.mode === "worktree" ? "New worktree" : `Worktree · ${existing?.name ?? value.worktreePath}`;
  const hint = error
    ? `Couldn't read the project's branches (${error}); it works in the project folder.`
    : refs && !refs.isRepo
      ? "The project folder isn't a git repository, so there are no worktrees; it works in the project folder."
      : value.mode === "local"
        ? `The project folder${root ? ` (${root})` : ""}${rootBranch ? `, on ${rootBranch}` : ""}: shared with anyone else working there.`
        : value.mode === "worktree"
          ? `A folder and branch of its own, made in T3's worktrees folder now, from ${value.baseBranch || "a base branch"}.`
          : `${value.worktreePath}${existing ? `, on ${existing.name}` : ""}: shared with anyone else working there.`;
  const choose = (choice: WorkspaceChoice, close: () => void) => {
    onChange(choice);
    close();
  };
  const disabled = !refs || !refs.isRepo;
  return (
    <div className="form-field">
      <span>Where it works</span>
      <div className="thread-settings-row workspace-row">
        {disabled ? (
          <button type="button" className="setting-button" disabled title={hint}>
            <span className="setting-value">Project folder</span>
            {!refs && !error ? <span className="muted"> reading branches…</span> : null}
          </button>
        ) : (
          <DropdownButton label={<span className="setting-value">{label}</span>} title={`Where it works: ${hint}`}>
            {(close) => (
              <>
                <div className="setting-section" role="group" aria-label="Where it works">
                  <span className="setting-section-head">Where it works</span>
                  <button type="button" role="menuitemradio" aria-checked={value.mode === "local"} className="setting-choice" onClick={() => choose({ mode: "local" }, close)}>
                    <span className="setting-check">{value.mode === "local" ? "✓" : ""}</span>
                    <span>
                      Project folder
                      <span className="hint">
                        {rootBranch ? `On ${rootBranch}, ` : ""}shared with anyone else working there.
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={value.mode === "worktree"}
                    className="setting-choice"
                    onClick={() => choose(value.mode === "worktree" ? value : { mode: "worktree", baseBranch: defaultBase }, close)}
                  >
                    <span className="setting-check">{value.mode === "worktree" ? "✓" : ""}</span>
                    <span>
                      New worktree
                      <span className="hint">A folder and branch of its own, made now from a base branch.</span>
                    </span>
                  </button>
                </div>
                {worktrees.length > 0 ? (
                  <div className="setting-section" role="group" aria-label="Existing worktrees">
                    <span className="setting-section-head">Existing worktrees</span>
                    {worktrees.map((ref) => (
                      <button
                        key={ref.worktreePath}
                        type="button"
                        role="menuitemradio"
                        aria-checked={value.mode === "existing" && value.worktreePath === ref.worktreePath}
                        className="setting-choice"
                        onClick={() => choose({ mode: "existing", worktreePath: ref.worktreePath as string }, close)}
                      >
                        <span className="setting-check">{value.mode === "existing" && value.worktreePath === ref.worktreePath ? "✓" : ""}</span>
                        <span>
                          <BranchIcon /> {ref.name}
                          <span className="hint mono">{ref.worktreePath}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </DropdownButton>
        )}
        {value.mode === "worktree" && refs ? (
          <>
            <label className="inline-field">
              <span className="muted">from</span>
              <select value={value.baseBranch} onChange={(e) => onChange({ ...value, baseBranch: e.target.value })} aria-label="Base branch">
                {bases.map((ref) => (
                  <option key={`${ref.isRemote ? "r" : "l"}:${ref.name}`} value={ref.name}>
                    {ref.name}
                    {ref.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="branch-input mono"
              value={value.branch ?? ""}
              onChange={(e) => {
                const branch = e.target.value.trim();
                onChange(branch ? { mode: "worktree", baseBranch: value.baseBranch, branch } : { mode: "worktree", baseBranch: value.baseBranch });
              }}
              placeholder={newBranchHint}
              aria-label="New branch name"
              title={`The new branch's name; empty: ${newBranchHint}`}
              pattern="[A-Za-z0-9][A-Za-z0-9._/\-]{0,99}"
            />
          </>
        ) : null}
      </div>
      <span className="hint">{hint}</span>
    </div>
  );
}

/** Attachable threads of a project (unbound, not deleted), prefetched once. */
export function useAttachableThreads(projectId: string): T3ThreadShell[] | null {
  const { toast } = useToast();
  const [threads, setThreads] = useState<T3ThreadShell[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .threads(projectId)
      .then((list) => {
        if (!cancelled) setThreads(list.filter((t) => !t.boundToRoom && !t.deletedAt));
      })
      .catch((error) => {
        if (!cancelled) {
          setThreads([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, toast]);
  return threads;
}

/** What T3 already holds for a thread; an attached participant follows it rather than the room's form. */
export function InheritedLine({ thread }: { thread: T3ThreadShell }) {
  const options = thread.modelSelection.options ?? [];
  return (
    <div className="inherited" role="note">
      <span className="label">Inherited from T3</span>
      <span className="inherited-values">
        <span className="mono">{thread.modelSelection.model}</span>
        {options.map((option) => (
          <span key={option.id} className="pill pill-option" title={`${option.id}: ${String(option.value)}`}>
            {optionLabel(option.id)}: {String(option.value)}
          </span>
        ))}
        <span className={`pill pill-mode mode-${thread.runtimeMode}`}>{thread.runtimeMode}</span>
        {thread.interactionMode === "plan" ? <span className="pill pill-plan">plan</span> : null}
      </span>
      <span className="hint">Change these in T3 Code; the room follows the thread.</span>
    </div>
  );
}

/** Radio rows of attachable threads (title, model, branch, session status). */
export function ThreadList({
  threads,
  selectedId,
  onSelect,
  name = "thread-id",
}: {
  threads: T3ThreadShell[] | null;
  selectedId: string | null;
  onSelect: (thread: T3ThreadShell) => void;
  name?: string;
}) {
  return (
    <div className="thread-list" role="radiogroup" aria-label="Existing threads">
      {threads === null ? <span className="muted">Loading threads…</span> : null}
      {threads && threads.length === 0 ? <span className="muted">No unbound threads in this project.</span> : null}
      {threads?.map((thread) => (
        <label key={thread.id} className={`thread-item${selectedId === thread.id ? " selected" : ""}`}>
          <input type="radio" name={name} checked={selectedId === thread.id} onChange={() => onSelect(thread)} />
          <span className="thread-title">{thread.title || "(untitled)"}</span>
          <span className="thread-meta">
            {thread.modelSelection.model}
            {thread.branch ? ` · ${thread.branch}` : ""}
            {thread.session?.status ? ` · ${thread.session.status}` : ""}
          </span>
        </label>
      ))}
    </div>
  );
}

/** Thread binding picker (Rebind): create a new thread or attach an existing one; attaching shows what is inherited. */
export function ThreadBindingPicker({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: ThreadBindingInput;
  onChange: (thread: ThreadBindingInput) => void;
}) {
  const threads = useAttachableThreads(projectId);
  const selected = value.mode === "attach" ? (threads ?? []).find((t) => t.id === value.threadId) ?? null : null;
  return (
    <fieldset className="thread-picker">
      <legend>Thread</legend>
      <label className="radio">
        <input type="radio" name="thread-mode" checked={value.mode === "create"} onChange={() => onChange({ mode: "create" })} />
        Create new thread
      </label>
      <label className="radio">
        <input
          type="radio"
          name="thread-mode"
          checked={value.mode === "attach"}
          onChange={() => onChange({ mode: "attach", threadId: "" })}
        />
        Attach an existing T3 thread
        {threads === null ? <span className="muted"> (loading…)</span> : <span className="muted"> ({threads.length} available in this project)</span>}
      </label>
      {value.mode === "attach" ? (
        <>
          <ThreadList threads={threads} selectedId={value.threadId || null} onSelect={(thread) => onChange({ mode: "attach", threadId: thread.id })} />
          {selected ? <InheritedLine thread={selected} /> : null}
        </>
      ) : null}
    </fieldset>
  );
}

export const threadBindingReady = (thread: ThreadBindingInput): boolean =>
  thread.mode === "create" || thread.threadId.length > 0;

export function CopyButton({ text, label }: { text: string; label: string }) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      className="small"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast("Copied", "success");
        } catch {
          toast("Clipboard unavailable; select and copy manually");
        }
      }}
    >
      Copy
    </button>
  );
}
