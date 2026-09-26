import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useRoom } from "../context.tsx";
import { isActiveParticipant, type CommandResult, type Room, type RoomCommand, type RoomListItem, type RoomSnapshot, type ThreadLifecycleChoice } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { CopyButton } from "./pickers.tsx";
import { useToast } from "./Toast.tsx";

type RunCommand = (command: RoomCommand) => Promise<{ type: string; roomId?: string } | CommandResult | null>;

/** The ⋯ menu on a room in the sidebar: rename or delete. */
export function RoomMenu({ room, onCommand }: { room: RoomListItem; onCommand: RunCommand }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="room-menu" ref={wrapper}>
      <button
        type="button"
        className="room-menu-button"
        aria-label={`${room.title} options`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Rename or delete"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open ? (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => (setOpen(false), setDialog("rename"))}>
            Rename…
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => (setOpen(false), setDialog("delete"))}>
            Delete room…
          </button>
        </div>
      ) : null}
      {dialog === "rename" ? <RenameRoomDialog room={room} onCommand={onCommand} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? <DeleteRoomDialog room={room} onCommand={onCommand} onClose={() => setDialog(null)} /> : null}
    </span>
  );
}

type RoomRef = Pick<Room, "id" | "title">;

/** The ⋯ menu in the room header: the T3 project the room works in (name and id), and the same rename and delete as the sidebar's menu. */
export function RoomHeaderMenu({ projectTitle }: { projectTitle: string | null }) {
  const { snapshot, runCommand } = useRoom();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const wrapper = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const { room } = snapshot;
  const pick = (next: "rename" | "delete") => {
    setOpen(false);
    setDialog(next);
  };
  return (
    <span className="room-header-menu" ref={wrapper}>
      <button
        type="button"
        className={`small ghost icon-only${open ? " active" : ""}`}
        aria-label="Room options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Room options"
        onClick={() => setOpen((v) => !v)}
      >
        ⋯
      </button>
      {open ? (
        <div className="menu" role="menu">
          <div className="menu-info" role="none">
            <span className="label">T3 project</span>
            <span className="menu-info-name">{projectTitle ?? "not listed by T3"}</span>
            <span className="menu-info-id">
              <code title={room.projectId}>{room.projectId}</code>
              <CopyButton text={room.projectId} label="Copy the project id" />
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => pick("rename")}>
            Rename…
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => pick("delete")}>
            Delete room…
          </button>
        </div>
      ) : null}
      {dialog === "rename" ? <RenameRoomDialog room={room} onCommand={runCommand} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? <DeleteRoomDialog room={room} onCommand={runCommand} onClose={() => setDialog(null)} /> : null}
    </span>
  );
}

function RenameRoomDialog({ room, onCommand, onClose }: { room: RoomRef; onCommand: RunCommand; onClose: () => void }) {
  const [title, setTitle] = useState(room.title);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || title.trim() === room.title) return onClose();
    setBusy(true);
    const result = await onCommand({ type: "room.update", roomId: room.id, title: title.trim() });
    setBusy(false);
    if (result) onClose();
  };
  return (
    <Dialog title="Rename room" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span className="label">Title</span>
          <input data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !title.trim()}>
            Rename
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export const THREAD_CHOICES: Array<{ key: ThreadLifecycleChoice; label: string; help: string }> = [
  { key: "keep", label: "Keep in T3", help: "The thread stays as it is in T3 Code" },
  { key: "settle", label: "Settle", help: "Moves it to T3's settled list; it can still be opened and continued" },
  { key: "archive", label: "Archive", help: "Hides it in T3; it can be unarchived" },
  { key: "delete", label: "Delete in T3", help: "Deletes the thread and its history in T3 permanently" },
];

/**
 * Delete a room: the room's own record (messages, tasks, images) goes; each participant's T3 thread is kept, settled,
 * archived, or deleted in T3, chosen per thread (default keep).
 */
function DeleteRoomDialog({ room, onCommand, onClose }: { room: RoomRef; onCommand: RunCommand; onClose: () => void }) {
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [choices, setChoices] = useState<Record<string, ThreadLifecycleChoice>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.room(room.id).then(setSnapshot).catch(() => setSnapshot(null));
  }, [room.id]);
  const crew = snapshot ? snapshot.participants.filter(isActiveParticipant) : [];
  const running = snapshot ? snapshot.tasks.filter((t) => t.state === "running" || t.state === "dispatching" || t.state === "needs_input").length : 0;
  const pending = snapshot ? snapshot.tasks.filter((t) => t.state === "queued" || t.state === "held" || t.state === "blocked").length : 0;
  const deleting = Object.values(choices).includes("delete");
  const setAll = (choice: ThreadLifecycleChoice) => setChoices(Object.fromEntries(crew.map((p) => [p.id, choice])));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (deleting && !confirmed) return;
    setBusy(true);
    const result = (await onCommand({ type: "room.delete", roomId: room.id, threads: choices })) as CommandResult | null;
    setBusy(false);
    if (!result) return;
    if (result.type === "room.deleted" && "threads" in result) {
      const threads = (result as Extract<CommandResult, { type: "room.deleted" }>).threads;
      const done = threads.filter((t) => t.result === "done").map((t) => `@${t.alias} ${t.action === "delete" ? "deleted" : `${t.action}d`}`);
      const failed = threads.filter((t) => t.result === "failed").map((t) => `@${t.alias}: ${t.detail ?? "failed"}`);
      toast(
        [`Deleted "${room.title}".`, done.length > 0 ? `Threads: ${done.join(", ")}.` : "Threads kept in T3.", failed.length > 0 ? `Not changed in T3: ${failed.join("; ")}.` : ""]
          .filter(Boolean)
          .join(" "),
      );
    }
    onClose();
  };

  return (
    <Dialog title={`Delete "${room.title}"?`} onClose={onClose} wide>
      <form onSubmit={submit} className="form">
        <p className="muted">
          This removes the room's conversation, tasks and images from T3 Rooms. The participants' threads live in T3 Code; choose what happens to each.
          {running > 0 ? ` ${running} task${running === 1 ? " is" : "s are"} running: those turns keep running in T3, the room just stops following them.` : ""}
          {pending > 0 ? ` ${pending} waiting task${pending === 1 ? "" : "s"} will not be sent.` : ""}
        </p>
        {!snapshot ? (
          <p className="muted mono">Loading participants…</p>
        ) : crew.length === 0 ? (
          <p className="muted">No participants, so no threads to handle.</p>
        ) : (
          <>
            <div className="thread-choices" role="group" aria-label="Threads">
              {crew.map((participant) => (
                <label key={participant.id} className="thread-choice">
                  <span className="mono identity">@{participant.alias}</span>
                  <span className="muted mono">{participant.modelSelection.model}</span>
                  <select
                    value={choices[participant.id] ?? "keep"}
                    onChange={(e) => setChoices({ ...choices, [participant.id]: e.target.value as ThreadLifecycleChoice })}
                    title={THREAD_CHOICES.find((c) => c.key === (choices[participant.id] ?? "keep"))?.help}
                  >
                    {THREAD_CHOICES.map((choice) => (
                      <option key={choice.key} value={choice.key}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            {crew.length > 1 ? (
              <p className="muted mono set-all">
                All:{" "}
                {THREAD_CHOICES.map((choice) => (
                  <button key={choice.key} type="button" className="link" onClick={() => setAll(choice.key)}>
                    {choice.label.toLowerCase()}
                  </button>
                ))}
              </p>
            ) : null}
            <p className="muted small-print">{THREAD_CHOICES.map((c) => `${c.label}: ${c.help}.`).join(" ")} A thread also used in another room is always kept.</p>
          </>
        )}
        {deleting ? (
          <label className="checkbox">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I understand the selected threads are deleted in T3 permanently.
          </label>
        ) : null}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary danger" disabled={busy || !snapshot || (deleting && !confirmed)}>
            {busy ? "Deleting…" : "Delete room"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
