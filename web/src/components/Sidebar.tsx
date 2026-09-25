import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import type { RoomCommand, RoomListItem, T3Project } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { titleMonogram } from "./Monogram.tsx";
import { RoomMenu } from "./RoomActions.tsx";
import { useToast } from "./Toast.tsx";

interface Props {
  rooms: RoomListItem[];
  selectedRoomId: string | null;
  onSelect: (roomId: string) => void;
  onCommand: (command: RoomCommand) => Promise<{ type: string; roomId?: string } | null>;
  disabled: boolean;
}

export function Sidebar({ rooms, selectedRoomId, onSelect, onCommand, disabled }: Props) {
  const [creating, setCreating] = useState(false);
  // Drag to reorder: the order shown while dragging, committed on drop.
  const [dragId, setDragId] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const shown = order ? order.map((id) => rooms.find((r) => r.id === id)).filter((r): r is RoomListItem => Boolean(r)) : rooms;
  const moveOver = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = (order ?? rooms.map((r) => r.id)).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    setOrder(ids);
  };
  const finishDrag = async () => {
    const ids = order;
    setDragId(null);
    if (ids && ids.join() !== rooms.map((r) => r.id).join()) await onCommand({ type: "room.reorder", roomIds: ids });
    setOrder(null);
  };
  return (
    <aside className="sidebar" aria-label="Rooms">
      <div className="sidebar-header">
        <span className="brand serif">T3 Rooms</span>
        <button type="button" className="small ghost" onClick={() => setCreating(true)} disabled={disabled} title="Create a room">
          + New room
        </button>
      </div>
      <ul className="room-list">
        {rooms.length === 0 ? (
          <li className="room-empty">
            <p className="serif muted">No rooms yet.</p>
            <p className="mono muted">+ New room</p>
          </li>
        ) : null}
        {shown.map((room) => (
          <li
            key={room.id}
            className={`room-item${dragId === room.id ? " dragging" : ""}`}
            draggable
            onDragStart={(event) => {
              setDragId(room.id);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", room.id);
            }}
            onDragOver={(event) => {
              if (!dragId) return;
              event.preventDefault();
              moveOver(room.id);
            }}
            onDrop={(event) => {
              event.preventDefault();
              void finishDrag();
            }}
            onDragEnd={() => void finishDrag()}
          >
            <button
              type="button"
              className={`room-tile${room.id === selectedRoomId ? " selected" : ""}`}
              onClick={() => onSelect(room.id)}
              aria-current={room.id === selectedRoomId ? "true" : undefined}
            >
              <span className="room-mono serif" aria-hidden="true">
                {titleMonogram(room.title)}
              </span>
              <span className="tile-body">
                <span className="room-title">{room.title}</span>
                <span className="room-meta mono">
                  <span title="Participants">{room.participantCount} crew</span>
                  {room.activity && room.activity.needsInput > 0 ? (
                    <span className="pill pill-input" title="Waiting for your approval or answer">
                      {room.activity.needsInput} needs you
                    </span>
                  ) : null}
                  {room.working > 0 || (room.activity?.turn ?? 0) > 0 ? (
                    <span className="pill pill-working" title="Mid-turn (room tasks or typed in T3)">
                      {Math.max(room.working, room.activity?.turn ?? 0)} working
                    </span>
                  ) : null}
                  {room.activity && room.activity.background > 0 ? (
                    <span className="pill pill-background" title="Between turns, with subagents or background jobs running: not done yet">
                      {room.activity.background} background
                    </span>
                  ) : null}
                  {room.activity && room.activity.monitoring > 0 ? (
                    <span className="pill pill-background" title="Only watch loops running">
                      {room.activity.monitoring} monitoring
                    </span>
                  ) : null}
                  {room.waiting > 0 ? (
                    <span className="pill pill-waiting" title="Waiting">
                      {room.waiting} waiting
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
            <RoomMenu room={room} onCommand={onCommand} />
          </li>
        ))}
      </ul>
      {creating ? (
        <NewRoomDialog
          onClose={() => setCreating(false)}
          onCreate={async (projectId, title) => {
            const result = await onCommand({ type: "room.create", projectId, title });
            if (result) {
              setCreating(false);
              if (result.roomId) onSelect(result.roomId);
            }
          }}
        />
      ) : null}
    </aside>
  );
}

function NewRoomDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (projectId: string, title: string) => Promise<void>;
}) {
  const { toast } = useToast();
  const [projects, setProjects] = useState<T3Project[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .projects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        const first = list[0];
        if (first) {
          setProjectId(first.id);
          setTitle((t) => t || first.title);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setProjects([]);
          toast(error instanceof ApiError ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!projectId || !title.trim()) return;
    setBusy(true);
    try {
      await onCreate(projectId, title.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="New room" onClose={onClose}>
      <form onSubmit={submit} className="form" id="new-room-form">
        <label>
          T3 project
          <select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              const project = projects?.find((p) => p.id === event.target.value);
              if (project && !title) setTitle(project.title);
            }}
            disabled={!projects}
          >
            {!projects ? <option value="">Loading projects…</option> : null}
            {projects && projects.length === 0 ? <option value="">No projects available</option> : null}
            {projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title} — {project.workspaceRoot}
              </option>
            ))}
          </select>
        </label>
        <label>
          Room title
          <input type="text" value={title} onChange={(event) => setTitle(event.target.value)} required data-autofocus />
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !projectId || !title.trim()}>
            Create room
          </button>
        </div>
      </form>
    </Dialog>
  );
}
