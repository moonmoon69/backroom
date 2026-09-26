/**
 * A browser's name and what it is for: both are what agents read when a room or thread lists its browsers, so the
 * description should say what the browser holds (its logins) and when to use it.
 */
import { useState, type FormEvent } from "react";
import { Dialog } from "./Dialog.tsx";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Browser names are what agents type: lowercase letters, digits and dashes. */
export const browserNameFrom = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40);

/** Name and purpose of a browser; used to create one and to edit one. */
export function BrowserFormDialog({
  title,
  submitLabel,
  initial,
  onClose,
  onSubmit,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string };
  onClose: () => void;
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [busy, setBusy] = useState(false);
  const cleanName = name.replace(/-+$/, "");
  const valid = NAME_PATTERN.test(cleanName);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await onSubmit({ name: cleanName, description: description.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Name
          <input
            type="text"
            className="mono"
            value={name}
            onChange={(e) => setName(browserNameFrom(e.target.value))}
            placeholder="t3-rooms-testing"
            spellCheck={false}
            autoCapitalize="off"
            data-autofocus
          />
          <span className="hint">What agents call it: lowercase letters, digits and dashes.</span>
        </label>
        <label>
          What it is for
          <textarea
            rows={3}
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Logged into staging T3 Rooms as the test user; use for integration tests."
          />
          <span className="hint">Shown to agents with the list of browsers, so they pick the right one. Mention the logins it holds.</span>
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !valid}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
