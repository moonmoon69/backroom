/**
 * Presets: a participant's settings under a name (model and its options, permission mode, role, where it works), so
 * the same few combinations are not chosen again each time. A preset is seated in a room on a new thread (dragged
 * onto the room, or picked in the Add participant dialog) or used to start a thread on its own.
 */
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { api } from "../api.ts";
import type { CatalogEntry, CommandResult, ModelSelection, Preset, Role, RoomCommand, RuntimeMode } from "../types.ts";
import { defaultOptionValue, useCatalog } from "./catalog.ts";
import { Dialog } from "./Dialog.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { RUNTIME_MODE_INFO, ThreadSettingsRow } from "./pickers.tsx";

export interface PresetsValue {
  presets: Preset[];
  reload: () => void;
}

export const PresetsContext = createContext<PresetsValue>({ presets: [], reload: () => undefined });
export const usePresets = (): PresetsValue => useContext(PresetsContext);

// ---- dragging a preset ----
const PRESET_MIME = "application/x-t3rooms-preset";

export function startPresetDrag(event: DragEvent, preset: Preset): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(PRESET_MIME, preset.id);
  event.dataTransfer.setData("text/plain", `@${preset.name}`);
}

/** True while what is dragged over is a preset (its id is only readable on drop). */
export const carriesPreset = (event: DragEvent): boolean => event.dataTransfer.types.includes(PRESET_MIME);
export const droppedPresetId = (event: DragEvent): string | null => event.dataTransfer.getData(PRESET_MIME) || null;

/** Accept a dragged preset: spread on the element that takes the drop. `over` is true while one hovers it. */
export function usePresetDrop(onDropPreset: (presetId: string) => void): { over: boolean; handlers: { onDragEnter: (e: DragEvent) => void; onDragOver: (e: DragEvent) => void; onDragLeave: (e: DragEvent) => void; onDrop: (e: DragEvent) => void } } {
  const [over, setOver] = useState(false);
  // Entering a child fires enter before the parent's leave: count them.
  const depth = useRef(0);
  return {
    over,
    handlers: {
      onDragEnter: (event) => {
        if (!carriesPreset(event)) return;
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (event) => {
        if (!carriesPreset(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeave: (event) => {
        if (!carriesPreset(event)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (event) => {
        if (!carriesPreset(event)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        const id = droppedPresetId(event);
        if (id) onDropPreset(id);
      },
    },
  };
}

/** An area that takes a dropped preset, with a notice over it while one is dragged across. */
export function PresetDropZone({ className, label, onDropPreset, children }: { className?: string; label: string; onDropPreset: (presetId: string) => void; children: ReactNode }) {
  const { over, handlers } = usePresetDrop(onDropPreset);
  return (
    <div className={`${className ?? ""}${over ? " preset-drop-over" : ""}`} {...handlers}>
      {children}
      {over ? (
        <div className="preset-drop-notice" aria-hidden="true">
          <span>{label}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---- describing a preset ----
const entryOf = (catalog: CatalogEntry[] | null, selection: ModelSelection): CatalogEntry | undefined =>
  catalog?.find((e) => e.instanceId === selection.instanceId && e.model === selection.model);

/** The options as T3 Code's composer shows them: "High · 1M"; booleans by their label while on. */
function optionsSummary(selection: ModelSelection, entry: CatalogEntry | undefined): string {
  return (entry?.optionDescriptors ?? [])
    .map((d) => {
      const current = selection.options?.find((o) => o.id === d.id)?.value ?? defaultOptionValue(d);
      if (d.type === "boolean") return current === true ? d.label : null;
      return (d.options ?? []).find((o) => o.id === current)?.label ?? null;
    })
    .filter(Boolean)
    .join(" · ");
}

export function usePresetText(): (preset: Preset) => { model: string; detail: string; entry: CatalogEntry | undefined } {
  const catalog = useCatalog();
  return (preset) => {
    const entry = entryOf(catalog, preset.modelSelection);
    const model = entry?.label || preset.modelSelection.model;
    const detail = [optionsSummary(preset.modelSelection, entry), RUNTIME_MODE_INFO[preset.runtimeMode].label, preset.workspaceMode === "worktree" ? "new worktree" : null].filter(Boolean).join(" · ");
    return { model, detail, entry };
  };
}

export function PresetIcon({ preset, size = 14 }: { preset: Preset; size?: number }) {
  const entry = entryOf(useCatalog(), preset.modelSelection);
  return <ProviderIcon driver={entry?.driver} instanceId={preset.modelSelection.instanceId} name={entry?.providerName ?? preset.modelSelection.instanceId} size={size} />;
}

const sameSelection = (a: ModelSelection | null, b: ModelSelection | null): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The presets as a row of buttons above a form's settings: one click fills them in. `model` and `runtimeMode` are the
 * form's current values, so the preset they equal reads as chosen.
 */
export function PresetChips({ model, runtimeMode, onPick, children }: { model: ModelSelection | null; runtimeMode: RuntimeMode; onPick: (preset: Preset) => void; children?: ReactNode }) {
  const { presets } = usePresets();
  const text = usePresetText();
  if (presets.length === 0 && !children) return null;
  return (
    <div className="form-field preset-field">
      <span>Presets</span>
      <div className="preset-chips">
        {presets.map((preset) => {
          const { model: modelName, detail } = text(preset);
          const on = sameSelection(model, preset.modelSelection) && runtimeMode === preset.runtimeMode;
          return (
            <button key={preset.id} type="button" className={`preset-chip${on ? " on" : ""}`} aria-pressed={on} title={`${modelName} · ${detail}`} onClick={() => onPick(preset)}>
              <PresetIcon preset={preset} />
              <span className="preset-chip-name">{preset.name}</span>
            </button>
          );
        })}
        {children}
      </div>
      {presets.length === 0 ? <span className="hint">Save the settings you use often as a preset; next time one click fills them in.</span> : null}
    </div>
  );
}

// ---- creating and editing ----
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function PresetDialog({
  preset,
  runCommand,
  onClose,
}: {
  /** The preset to edit; null for a new one. */
  preset: Preset | null;
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  onClose: () => void;
}) {
  const { presets, reload } = usePresets();
  const [name, setName] = useState(preset?.name ?? "");
  const [model, setModel] = useState<ModelSelection | null>(preset?.modelSelection ?? null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(preset?.runtimeMode ?? "full-access");
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "worktree">(preset?.workspaceMode ?? "local");
  const [roleId, setRoleId] = useState<string | null>(preset?.roleId ?? null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.roles().then(
      (list) => !cancelled && setRoles(list),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const trimmed = name.trim();
  const taken = presets.some((p) => p.id !== preset?.id && p.name.toLowerCase() === trimmed.toLowerCase());
  const valid = NAME_PATTERN.test(trimmed) && trimmed.toLowerCase() !== "all";
  const ready = valid && !taken && model !== null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !model) return;
    setBusy(true);
    const values = { name: trimmed, modelSelection: model, runtimeMode, roleId, workspaceMode };
    const result = preset ? await runCommand({ type: "preset.update", presetId: preset.id, ...values }) : await runCommand({ type: "preset.create", ...values });
    setBusy(false);
    if (result) {
      reload();
      onClose();
    }
  };

  const remove = async () => {
    if (!preset) return;
    setBusy(true);
    const result = await runCommand({ type: "preset.delete", presetId: preset.id });
    setBusy(false);
    if (result) {
      reload();
      onClose();
    }
  };

  return (
    <Dialog title={preset ? `Edit preset ${preset.name}` : "New preset"} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" placeholder="sol" aria-invalid={taken} data-autofocus />
          {taken ? (
            <span className="field-error">A preset with this name exists.</span>
          ) : (
            <span className="hint">
              The name it takes in a room: @{trimmed || "sol"}, then @{trimmed || "sol"}2 when the room already has one.
            </span>
          )}
        </label>
        <div className="form-field">
          <span>Model</span>
          <ThreadSettingsRow model={model} onModel={setModel} runtimeMode={runtimeMode} onRuntimeMode={setRuntimeMode} />
        </div>
        <label>
          Where it works
          <select value={workspaceMode} onChange={(e) => setWorkspaceMode(e.target.value === "worktree" ? "worktree" : "local")}>
            <option value="local">Project folder</option>
            <option value="worktree">New worktree</option>
          </select>
          <span className="hint">
            {workspaceMode === "worktree"
              ? "A folder and branch of its own for every thread, made from the project's default branch."
              : "The project's own folder, shared with anyone else working there."}
          </span>
        </label>
        <label>
          Role
          <select value={roleId ?? ""} onChange={(e) => setRoleId(e.target.value || null)}>
            <option value="">none</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
          <span className="hint">Used when the preset is seated in a room; a thread on its own has no role.</span>
        </label>
        <div className="dialog-actions">
          {preset ? (
            confirmDelete ? (
              <>
                <button type="button" className="primary destructive" disabled={busy} onClick={() => void remove()}>
                  Confirm delete
                </button>
                <button type="button" className="ghost" onClick={() => setConfirmDelete(false)}>
                  Keep
                </button>
              </>
            ) : (
              <button type="button" className="ghost danger" disabled={busy} onClick={() => setConfirmDelete(true)} title="Participants and threads made from it stay as they are">
                Delete
              </button>
            )
          ) : null}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {preset ? "Save preset" : "Create preset"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
