import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import type { CommandResult, Role, RoomCommand } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { useToast } from "./Toast.tsx";

interface Props {
  runCommand: (command: RoomCommand) => Promise<CommandResult | null>;
  onClose: () => void;
}

/** Roles: named sets of rules assigned to participants in a room (GET /api/roles, role.* commands). */
export function RolesDialog({ runCommand, onClose }: Props) {
  const { toast } = useToast();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [editing, setEditing] = useState<{ role: Role | null; name: string; rules: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api
      .roles()
      .then(setRoles)
      .catch((error) => {
        setRoles((current) => current ?? []);
        toast(error instanceof ApiError ? error.message : String(error));
      });
  }, [toast]);

  useEffect(() => {
    reload();
  }, [reload]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const { role, name, rules } = editing;
    if (name.trim().length === 0 || rules.trim().length === 0) return;
    setBusy(true);
    const result = role
      ? await runCommand({ type: "role.update", roleId: role.id, name: name.trim(), rules: rules.trim() })
      : await runCommand({ type: "role.create", name: name.trim(), rules: rules.trim() });
    setBusy(false);
    if (result) {
      setEditing(null);
      reload();
    }
  };

  const remove = async (role: Role) => {
    setBusy(true);
    const result = await runCommand({ type: "role.delete", roleId: role.id });
    setBusy(false);
    setConfirmDelete(null);
    if (result) reload();
  };

  if (editing) {
    const ready = editing.name.trim().length > 0 && editing.rules.trim().length > 0;
    return (
      <Dialog title={editing.role ? `Edit role ${editing.role.name}` : "New role"} onClose={() => setEditing(null)} wide>
        <form className="form" onSubmit={save}>
          <label>
            Name
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} required placeholder="accountant" />
            <span className="hint">Assign it with /role @alias {editing.name.trim() || "accountant"}, or from the participant's Edit dialog.</span>
          </label>
          <label>
            Rules
            <textarea value={editing.rules} onChange={(e) => setEditing({ ...editing, rules: e.target.value })} rows={6} required placeholder="Reconcile every figure twice." />
            <span className="hint">Delivered as plain text with every assignment for anyone holding this role; not an enforced permission.</span>
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy || !ready}>
              {editing.role ? "Save role" : "Create role"}
            </button>
          </div>
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog title="Roles" onClose={onClose} wide>
      <div className="library-head">
        <p className="serif library-lede">A role is a named set of rules assigned in the room; its text travels with every assignment to whoever holds it.</p>
        <button type="button" className="primary" onClick={() => setEditing({ role: null, name: "", rules: "" })}>
          + New role
        </button>
      </div>
      {roles === null ? <p className="muted mono">loading…</p> : null}
      {roles && roles.length === 0 ? (
        <div className="inspector-empty">
          <p className="serif">No roles yet; create one and assign it from a participant's Edit dialog or with /role.</p>
          <p className="mono muted">/role @alice accountant</p>
        </div>
      ) : null}
      {roles && roles.length > 0 ? (
        <ul className="role-list">
          {roles.map((role) => (
            <li key={role.id} className="role-card">
              <div className="role-card-head">
                <span className="role-title">{role.name}</span>
                <span className="spacer" />
                <span className="mono dim">{role.rules.length} chars</span>
              </div>
              <p className="role-excerpt">{role.rules.length > 240 ? `${role.rules.slice(0, 239)}…` : role.rules}</p>
              <div className="task-actions">
                <button type="button" className="small ghost" disabled={busy} onClick={() => setEditing({ role, name: role.name, rules: role.rules })}>
                  Edit
                </button>
                {confirmDelete === role.id ? (
                  <>
                    <button type="button" className="small primary destructive" disabled={busy} onClick={() => void remove(role)} title="Clears the role from everyone holding it">
                      Confirm delete
                    </button>
                    <button type="button" className="small ghost" onClick={() => setConfirmDelete(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="small ghost danger" disabled={busy} onClick={() => setConfirmDelete(role.id)}>
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </Dialog>
  );
}
