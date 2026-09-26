import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, ApiError, useProviders } from "../api.ts";
import type { CatalogEntry, ModelOptionDescriptor, ModelSelection, ProjectRefs, ProviderInfo, RuntimeMode, T3ThreadShell, ThreadBindingInput, WorkspaceChoice } from "../types.ts";
import { Popover } from "./Popover.tsx";
import { optionLabel } from "./deskFormat.ts";
import { ProviderLine } from "./Providers.tsx";
import { useToast } from "./Toast.tsx";
import { BranchIcon, ChevronIcon } from "./icons.tsx";

/** Default value for one descriptor: the isDefault option (else the first) for selects, defaultValue === true for booleans. */
function defaultOptionValue(descriptor: ModelOptionDescriptor): unknown {
  if (descriptor.type === "boolean") return descriptor.defaultValue === true;
  const choices = descriptor.options ?? [];
  const preset = choices.find((o) => o.isDefault) ?? choices[0];
  if (preset) return preset.id;
  return descriptor.defaultValue;
}

/** Selection for a catalog entry with every option set explicitly (as T3's own client does); no `options` key without descriptors. */
export function selectionFor(entry: Pick<CatalogEntry, "instanceId" | "model" | "optionDescriptors">): ModelSelection {
  const descriptors = entry.optionDescriptors ?? [];
  if (descriptors.length === 0) return { instanceId: entry.instanceId, model: entry.model };
  return {
    instanceId: entry.instanceId,
    model: entry.model,
    options: descriptors.map((d) => ({ id: d.id, value: defaultOptionValue(d) })),
  };
}

const entryKey = (entry: Pick<CatalogEntry, "instanceId" | "model">): string => `${entry.instanceId}\u0000${entry.model}`;

// T3's model catalog, read once per page and shared by every picker and options menu.
let catalogLoad: Promise<CatalogEntry[]> | null = null;
function loadCatalog(): Promise<CatalogEntry[]> {
  catalogLoad ??= api.catalog().catch((error: unknown) => {
    catalogLoad = null;
    throw error;
  });
  return catalogLoad;
}

function useCatalog(): CatalogEntry[] | null {
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadCatalog().then(
      (entries) => !cancelled && setCatalog(entries),
      () => !cancelled && setCatalog([]),
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return catalog;
}

/** Default first, legacy last, otherwise the server's order. */
const rankEntry = (entry: CatalogEntry): number => (entry.isDefault ? 0 : entry.isLegacy ? 2 : 1);

interface ProviderGroup {
  instanceId: string;
  name: string;
  provider: ProviderInfo | undefined;
  entries: CatalogEntry[];
}

/**
 * Model picker fed by /api/t3/catalog and /api/t3/providers: a listbox popover grouped by provider,
 * each group headed by the provider's auth/status line and usage meters. Disabled providers are omitted.
 */
export function ModelPicker({
  value,
  onChange,
  id,
  providerFilter,
}: {
  value: ModelSelection | null;
  onChange: (selection: ModelSelection) => void;
  id?: string;
  /** When set, only this provider instance is offered (T3 cannot switch a thread's provider). */
  providerFilter?: string;
}) {
  const { toast } = useToast();
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const { providers } = useProviders(true);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapper = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useMemo(() => `model-list-${Math.random().toString(36).slice(2, 8)}`, []);

  useEffect(() => {
    let cancelled = false;
    loadCatalog()
      .then((entries) => {
        if (cancelled) return;
        setCatalog(entries);
      })
      .catch((error) => {
        if (!cancelled) {
          setCatalog([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const providerById = useMemo(() => new Map((providers ?? []).map((p) => [p.instanceId, p])), [providers]);

  const groups = useMemo<ProviderGroup[]>(() => {
    const map = new Map<string, ProviderGroup>();
    for (const entry of catalog ?? []) {
      if (providerFilter && entry.instanceId !== providerFilter) continue;
      const provider = providerById.get(entry.instanceId);
      if (provider && !provider.enabled) continue;
      const name = entry.providerName ?? provider?.displayName ?? entry.instanceId;
      const group = map.get(entry.instanceId) ?? { instanceId: entry.instanceId, name, provider, entries: [] };
      group.entries.push(entry);
      map.set(entry.instanceId, group);
    }
    for (const group of map.values()) {
      group.entries = group.entries.map((entry, index) => ({ entry, index })).sort((a, b) => rankEntry(a.entry) - rankEntry(b.entry) || a.index - b.index).map((x) => x.entry);
    }
    return [...map.values()];
  }, [catalog, providerById, providerFilter]);

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups]);

  // Pick a sensible initial model once the catalog is in: the first default entry, else the first entry.
  useEffect(() => {
    if (value || flat.length === 0) return;
    const first = flat.find((e) => e.isDefault) ?? flat[0];
    if (first) onChange(selectionFor(first));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  const selected = value ? (catalog ?? []).find((e) => e.instanceId === value.instanceId && e.model === value.model) : undefined;
  const selectedIndex = selected ? flat.findIndex((e) => entryKey(e) === entryKey(selected)) : -1;

  const choose = (entry: CatalogEntry) => {
    onChange(selectionFor(entry));
    setOpen(false);
    wrapper.current?.querySelector<HTMLButtonElement>(".model-trigger")?.focus();
  };

  const openList = () => {
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
    requestAnimationFrame(() => listRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`#${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const onListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(flat.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const entry = flat[active];
      if (entry) choose(entry);
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.stopPropagation();
      setOpen(false);
      wrapper.current?.querySelector<HTMLButtonElement>(".model-trigger")?.focus();
    }
  };

  let runningIndex = -1;
  return (
    <div className="model-picker" ref={wrapper}>
      <button
        type="button"
        id={id}
        className="model-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        disabled={!catalog}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openList();
          }
        }}
      >
        {!catalog ? (
          <span className="muted">Loading catalog…</span>
        ) : catalog.length === 0 ? (
          <span className="muted">Catalog is empty</span>
        ) : selected ? (
          <>
            <span className="model-provider muted">{selected.providerName ?? selected.instanceId}</span>
            <span className="model-label" title={`${selected.instanceId} · ${selected.model}`}>
              {selected.label || selected.model}
            </span>
          </>
        ) : (
          <span className="muted">Choose a model…</span>
        )}
        <span className="spacer" />
        <ChevronIcon dir={open ? "up" : "down"} />
      </button>
      {open ? (
        <div
          className="model-menu"
          role="listbox"
          id={listId}
          tabIndex={-1}
          ref={listRef}
          aria-label="Models by provider"
          aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
          onKeyDown={onListKey}
        >
          {groups.map((group) => (
            <div key={group.instanceId} className="model-group" role="group" aria-label={group.name}>
              <div className="model-group-head">
                <span className="model-group-name">{group.name}</span>
                {group.provider ? <ProviderLine provider={group.provider} /> : null}
              </div>
              {group.entries.map((entry) => {
                runningIndex += 1;
                const index = runningIndex;
                const isSelected = selected ? entryKey(entry) === entryKey(selected) : false;
                return (
                  <div
                    key={entryKey(entry)}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={isSelected}
                    className={`model-option-row${index === active ? " active" : ""}${isSelected ? " selected" : ""}${entry.isLegacy ? " legacy" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(entry);
                    }}
                    title={entry.aliases && entry.aliases.length > 0 ? `aliases: ${entry.aliases.join(", ")}` : undefined}
                  >
                    <span className="model-label">{entry.label || entry.model}</span>
                    <span className="model-slug mono muted">{entry.model}</span>
                    {entry.isDefault ? <span className="tag mono tag-default">default</span> : null}
                    {entry.isLegacy ? <span className="tag mono tag-legacy">legacy</span> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

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
