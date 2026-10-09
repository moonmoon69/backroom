/**
 * Presets: a participant's settings under a name (model and its options, permission mode, role, where it works), so
 * the same few combinations are not chosen again each time. A preset is seated in a room on a new thread (dragged
 * onto the room, picked in the Add member dialog, several at once if you like, or from its Edit dialog's Seat in a
 * room…) or used to start a thread on its own.
 */
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { resolveLook, type Look } from "../../../src/domain/look.ts";
import { LookPicker } from "./LookPicker.tsx";
import type { CatalogEntry, CommandResult, ModelSelection, Preset, RoomCommand, RoomListItem, RuntimeMode, T3Project } from "../types.ts";
import { defaultOptionValue, useCatalog } from "./catalog.ts";
import { Dialog } from "./Dialog.tsx";
import { Popover } from "./Popover.tsx";
import { NameInput } from "./NameInput.tsx";
import { MemberMark } from "./MemberMark.tsx";
import { RUNTIME_MODE_INFO, ThreadSettingsRow } from "./pickers.tsx";
import { reloadConsigliereSetting, useConsigliereSetting } from "../consigliere.ts";
import { tabbables } from "../keys.ts";

export interface PresetsValue {
  presets: Preset[];
  reload: () => void;
}

export const PresetsContext = createContext<PresetsValue>({ presets: [], reload: () => undefined });
export const usePresets = (): PresetsValue => useContext(PresetsContext);

// ---- dragging a preset ----
const PRESET_MIME = "application/x-backroom-crew";

export function startPresetDrag(event: DragEvent, preset: Preset): void {
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(PRESET_MIME, preset.id);
  event.dataTransfer.setData("text/plain", `@${preset.name}`);
}

/** True while what is dragged over is a preset (its id is only readable on drop). */
export const carriesPreset = (event: DragEvent): boolean => event.dataTransfer.types.includes(PRESET_MIME);
export const droppedPresetId = (event: DragEvent): string | null => event.dataTransfer.getData(PRESET_MIME) || null;

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

/**
 * A preset in words. `what` is what it is known by, the model and its options ("Claude Fable 5.1 · High · 1M");
 * `detail` adds the permission mode and where it works.
 */
export function usePresetText(): (preset: Preset) => { model: string; what: string; detail: string; entry: CatalogEntry | undefined } {
  const catalog = useCatalog();
  return (preset) => {
    const entry = entryOf(catalog, preset.modelSelection);
    const model = entry?.label || preset.modelSelection.model;
    const options = optionsSummary(preset.modelSelection, entry);
    const what = [model, options].filter(Boolean).join(" · ");
    const detail = [options, RUNTIME_MODE_INFO[preset.runtimeMode].label, preset.workspaceMode === "worktree" ? "new worktree" : null].filter(Boolean).join(" · ");
    return { model, what, detail, entry };
  };
}

export function PresetIcon({ preset, size = 14 }: { preset: Preset; size?: number }) {
  return <MemberMark seed={preset.id} selection={preset.modelSelection} size={size} presetId={preset.id} />;
}

const sameSelection = (a: ModelSelection | null, b: ModelSelection | null): boolean => JSON.stringify(a) === JSON.stringify(b);
const sameLook = (a: Look, b: Look): boolean => Object.keys({ ...a, ...b }).every((key) => a[key as keyof Look] === b[key as keyof Look]);

/**
 * The presets as a row of buttons above a form's settings: one click fills them in. `model` and `runtimeMode` are the
 * form's current values, so the preset they equal reads as chosen. With `pickedId`, only the preset picked reads as
 * chosen while the settings are still its own, a line under the row says what confirms (`pickedNote`), and clicking
 * it again calls `onClear` (back to the defaults) instead of filling it in once more. With `pickedIds`, several read as
 * chosen at once: the form keeps the list, and a click on any of them is its to handle (`onPick` picks or unpicks);
 * `note` is the line under the row.
 */
export function PresetChips({
  model,
  runtimeMode,
  onPick,
  pickedId,
  onClear,
  pickedNote,
  pickedIds,
  note,
  children,
}: {
  model: ModelSelection | null;
  runtimeMode: RuntimeMode;
  onPick: (preset: Preset) => void;
  pickedId?: string | null;
  onClear?: () => void;
  pickedNote?: string;
  pickedIds?: string[];
  note?: ReactNode;
  children?: ReactNode;
}) {
  const { presets } = usePresets();
  const text = usePresetText();
  if (presets.length === 0 && !children) return null;
  const isOn = (preset: Preset) =>
    pickedIds ? pickedIds.includes(preset.id) : (pickedId === undefined || pickedId === preset.id) && sameSelection(model, preset.modelSelection) && runtimeMode === preset.runtimeMode;
  const picked = pickedId ? (presets.find((p) => p.id === pickedId && isOn(p)) ?? null) : null;
  return (
    <div className="form-field preset-field">
      <span>Crew</span>
      <div className="preset-chips">
        {presets.map((preset) => {
          const { model: modelName, what, detail } = text(preset);
          const on = isOn(preset);
          const clears = on && onClear !== undefined;
          const title = clears
            ? `${preset.name}: ${modelName} · ${detail}. Click again to start from the defaults instead.`
            : on && pickedIds
              ? `${preset.name}: ${modelName} · ${detail}. Click again to leave them out.`
              : `${modelName} · ${detail}`;
          return (
            <button
              key={preset.id}
              type="button"
              className={`preset-chip${on ? " on" : ""}`}
              aria-pressed={on}
              title={title}
              onClick={() => (clears ? onClear() : onPick(preset))}
            >
              <PresetIcon preset={preset} />
              <span className="preset-chip-name">{preset.name}</span>
              <span className="preset-chip-what">{what}</span>
            </button>
          );
        })}
        {children}
      </div>
      {presets.length === 0 ? <span className="hint">Save the settings you use often to your crew; next time one click fills them in.</span> : null}
      {picked ? (
        <span className="hint preset-picked-note">
          <strong>{picked.name}</strong>&rsquo;s settings are filled in below; change anything you like. {pickedNote ?? ""}
        </span>
      ) : null}
      {note && presets.length > 0 ? <span className="hint preset-picked-note">{note}</span> : null}
    </div>
  );
}

// ---- seating ----

/** The rooms to seat a crew member in, as a menu's items: each room's title, then its project and how many it holds. */
export function RoomChoices({ rooms, projects, onPick }: { rooms: RoomListItem[]; projects: T3Project[]; onPick: (roomId: string) => void }) {
  const projectTitle = new Map(projects.map((p) => [p.id, p.title]));
  return (
    <>
      {rooms.map((room) => (
        <button key={room.id} type="button" role="menuitem" className="menu-room" onClick={() => onPick(room.id)}>
          <span className="menu-room-title">{room.title}</span>
          <span className="menu-room-meta">{[projectTitle.get(room.projectId), `${room.participantCount} member${room.participantCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
        </button>
      ))}
    </>
  );
}

/** Where a crew member can be seated from their Edit dialog: every room, and what seats them. */
export interface SeatChoices {
  rooms: RoomListItem[];
  projects: T3Project[];
  onSeat: (roomId: string) => void;
}

/**
 * Seat in a room…: the rooms in a menu over the dialog; Enter on one seats the crew member there on a new thread with
 * their saved settings (the keyboard's version of dragging them onto a room's tile), and the dialog closes. Esc or
 * Backspace closes the menu, the focus back on the button; Tab closes it and goes on from the button, in the dialog.
 */
function SeatInRoom({ name, seat, why, onSeated }: { name: string; seat: SeatChoices; why: string | null; onSeated: () => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <>
      <button ref={anchor} type="button" aria-haspopup="menu" aria-expanded={open} disabled={why !== null} title={why ?? `Seat ${name} in a room, on a new thread with their saved settings: the same as dragging them onto the room's tile`} onClick={() => setOpen((current) => !current)}>
        Seat in a room…
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          menuRef={menuRef}
          role="menu"
          className="preset-menu"
          onClose={() => setOpen(false)}
          menuProps={{
            "aria-label": `Seat ${name} in a room`,
            onKeyDown: (event) => {
              if (event.key !== "Tab" || !anchor.current) return;
              event.preventDefault();
              // On from the button, before the menu goes (else the focus would go back to the button).
              const stops = tabbables(anchor.current.closest(".dialog") ?? document.body);
              const at = stops.indexOf(anchor.current);
              stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus();
              setOpen(false);
            },
          }}
        >
          <RoomChoices
            rooms={seat.rooms}
            projects={seat.projects}
            onPick={(roomId) => {
              setOpen(false);
              seat.onSeat(roomId);
              onSeated();
            }}
          />
        </Popover>
      ) : null}
    </>
  );
}

// ---- creating and editing ----
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export function PresetDialog({
  preset,
  runCommand,
  onClose,
  seat,
}: {
  /** The preset to edit; null for a new one. */
  preset: Preset | null;
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  onClose: () => void;
  /** Where an existing one can be seated from here (Seat in a room…; a new one has no such button). */
  seat?: SeatChoices;
}) {
  const { presets, reload } = usePresets();
  const consigliereSetting = useConsigliereSetting();
  const [name, setName] = useState(preset?.name ?? "");
  const [model, setModel] = useState<ModelSelection | null>(preset?.modelSelection ?? null);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(preset?.runtimeMode ?? "full-access");
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "worktree">(preset?.workspaceMode ?? "local");
  // Its pixel look: the one it has, or for a new crew member the default of a fresh id, sent with it so what is shown
  // is what it wears. A service older than looks sends presets without one and takes none.
  const looksSupported = presets.length === 0 || presets.some((p) => p.look !== undefined);
  const [look, setLook] = useState<Look>(() => resolveLook(preset?.id ?? crypto.randomUUID(), preset?.look ?? null));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const trimmed = name.trim();
  const taken = presets.some((p) => p.id !== preset?.id && p.name.toLowerCase() === trimmed.toLowerCase());
  const valid = NAME_PATTERN.test(trimmed) && trimmed.toLowerCase() !== "all";
  const ready = valid && !taken && model !== null;
  // Seated with their saved settings: not while the form says otherwise.
  const changed =
    preset !== null &&
    (trimmed !== preset.name || !sameSelection(model, preset.modelSelection) || runtimeMode !== preset.runtimeMode || workspaceMode !== (preset.workspaceMode ?? "local") || !sameLook(look, resolveLook(preset.id, preset.look ?? null)));
  const seatWhy = !seat || seat.rooms.length === 0 ? "There are no rooms yet" : changed ? "Save or cancel the changes first: they are seated with their saved settings" : null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || !model) return;
    setBusy(true);
    const values = { name: trimmed, modelSelection: model, runtimeMode, workspaceMode, ...(looksSupported ? { look } : {}) };
    const result = preset ? await runCommand({ type: "preset.update", presetId: preset.id, ...values }) : await runCommand({ type: "preset.create", ...values });
    setBusy(false);
    if (result) {
      reload();
      onClose();
    }
  };

  const remove = async () => {
    if (!preset) return;
    // Deleting the saved crew member new rooms are seated with is asked about first; seated members stay.
    if (consigliereSetting === preset.id && !window.confirm(`${preset.name} is your Consigliere for new rooms. Delete it anyway? The setting is cleared; members already seated in rooms stay.`)) return;
    setBusy(true);
    const result = await runCommand({ type: "preset.delete", presetId: preset.id });
    setBusy(false);
    if (result) {
      reloadConsigliereSetting();
      reload();
      onClose();
    }
  };

  return (
    <Dialog title={preset ? `Edit ${preset.name}` : "New crew member"} onClose={onClose} wide>
      <form className="form" onSubmit={save}>
        <label>
          Name
          <NameInput value={name} onValue={setName} required pattern="[A-Za-z0-9][A-Za-z0-9_\-]{0,31}" placeholder="sol" aria-invalid={taken} data-autofocus />
          {taken ? (
            <span className="field-error">Someone in your crew has this name.</span>
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
        {looksSupported ? (
          <div className="form-field">
            <span>Look</span>
            <LookPicker look={look} onLook={setLook} selection={model} />
            <span className="hint">How they are drawn in the pixel look, in every room. The pocket square is always their harness&rsquo;s colour.</span>
          </div>
        ) : null}
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
              <button type="button" className="ghost danger" disabled={busy} onClick={() => setConfirmDelete(true)} title="Members and threads made from them stay as they are">
                Delete
              </button>
            )
          ) : null}
          <span className="spacer" />
          {preset && seat ? <SeatInRoom name={preset.name} seat={seat} why={busy ? "Saving…" : seatWhy} onSeated={onClose} /> : null}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !ready}>
            {preset ? "Save" : "Add to crew"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
