import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, useProviders } from "../api.ts";
import type { CatalogEntry, ModelOptionDescriptor, ModelSelection, ProviderInfo, T3ThreadShell, ThreadBindingInput } from "../types.ts";
import { optionLabel } from "./deskFormat.ts";
import { ProviderLine } from "./Providers.tsx";
import { useToast } from "./Toast.tsx";

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
    api
      .catalog()
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
            <span className="model-label">{selected.label || selected.model}</span>
            <span className="model-slug mono muted">{selected.model}</span>
            {selected.isDefault ? <span className="tag mono tag-default">default</span> : null}
            {selected.isLegacy ? <span className="tag mono tag-legacy">legacy</span> : null}
          </>
        ) : (
          <span className="muted">Choose a model…</span>
        )}
        <span className="spacer" />
        <span className="chevron mono" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
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
      {selected ? (
        <span className="hint">
          {selected.instanceId} · {selected.model}
          {(selected.optionDescriptors?.length ?? 0) === 0 ? " · no options" : ""}
        </span>
      ) : null}
      {selected && value && (selected.optionDescriptors?.length ?? 0) > 0 ? (
        <div className="model-options" role="group" aria-label="Model options">
          {selected.optionDescriptors!.map((descriptor) => {
            const current = value.options?.find((o) => o.id === descriptor.id)?.value ?? defaultOptionValue(descriptor);
            const setOption = (next: unknown) => {
              const rest = (value.options ?? []).filter((o) => o.id !== descriptor.id);
              const ordered = selected.optionDescriptors!.map((d) =>
                d.id === descriptor.id ? { id: d.id, value: next } : (rest.find((o) => o.id === d.id) ?? { id: d.id, value: defaultOptionValue(d) }),
              );
              onChange({ instanceId: value.instanceId, model: value.model, options: ordered });
            };
            if (descriptor.type === "boolean") {
              return (
                <label key={descriptor.id} className="checkbox model-option">
                  <input type="checkbox" checked={current === true} onChange={(event) => setOption(event.target.checked)} />
                  {descriptor.label}
                </label>
              );
            }
            return (
              <label key={descriptor.id} className="model-option">
                <span className="model-option-label">{descriptor.label}</span>
                <select value={typeof current === "string" ? current : String(current ?? "")} onChange={(event) => setOption(event.target.value)}>
                  {(descriptor.options ?? []).map((choice) => (
                    <option key={choice.id} value={choice.id} title={choice.description ?? undefined}>
                      {choice.label}
                      {choice.isDefault ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ) : null}
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
