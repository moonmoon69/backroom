import { useState, type ReactNode } from "react";
import { money, type Books } from "../../street/books.ts";
import type { Lot, StreetWindow } from "../../street/layout.ts";
import type { BrowserListItem, Preset, RoomListItem, StatusResponse, T3Project } from "../../types.ts";
import { AppControls } from "../AppControls.tsx";
import { PresetIcon, usePresets, usePresetText } from "../presets.tsx";
import { CloseIcon } from "../icons.tsx";
import type { ThemeChoice } from "../../theme.ts";

function Card({ title, subtitle, onClose, className, children }: { title: string; subtitle?: ReactNode; onClose: () => void; className?: string; children: ReactNode }) {
  return (
    <section className={`st-card${className ? ` ${className}` : ""}`} role="dialog" aria-label={title}>
      <header className="st-card-head">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <button type="button" className="small ghost icon-only" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="st-card-body">{children}</div>
    </section>
  );
}

const DOT: Record<StreetWindow["state"], string> = {
  needs: "is-needs",
  failed: "is-failed",
  working: "is-working",
  background: "is-working",
  idle: "is-idle",
  dark: "is-dark",
};

function Row({ w, onOpen }: { w: StreetWindow; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="st-row" onClick={onOpen}>
        <span className={`st-dot ${DOT[w.state]}`} aria-hidden="true" />
        <span className="st-row-title">{w.title}</span>
        <span className="st-row-label">{w.label}</span>
      </button>
    </li>
  );
}

/**
 * The lobby directory of a building: every room and thread of the project, including the ones past its windows and
 * the settled threads, what the business has spent, and a new room or thread.
 */
export function DirectoryCard({
  lot,
  spend,
  partial,
  onOpen,
  onNewRoom,
  onNewThread,
  onClose,
}: {
  lot: Lot;
  spend: number | undefined;
  partial: boolean;
  onOpen: (w: StreetWindow) => void;
  onNewRoom: () => void;
  onNewThread: () => void;
  onClose: () => void;
}) {
  const [settledOpen, setSettledOpen] = useState(false);
  const all = [...lot.windows, ...lot.hidden];
  const rooms = all.filter((w) => w.kind === "room");
  const threads = all.filter((w) => w.kind === "thread");
  return (
    <Card
      className="st-directory"
      title={lot.project?.title || "Directory"}
      subtitle={
        <>
          {lot.business?.word}
          {lot.project?.workspaceRoot ? <span className="mono"> · {lot.project.workspaceRoot}</span> : null}
        </>
      }
      onClose={onClose}
    >
      <p className="st-books">
        <span>The books</span>
        <strong>{spend !== undefined ? money(spend) : "…"}</strong>
        <span className="muted">estimated at list price{partial ? ", some threads not counted" : ""}</span>
      </p>
      <h3>Rooms · {rooms.length}</h3>
      {rooms.length > 0 ? (
        <ul className="st-rows">
          {rooms.map((w) => (
            <Row key={w.id} w={w} onOpen={() => onOpen(w)} />
          ))}
        </ul>
      ) : (
        <p className="muted">No rooms yet.</p>
      )}
      <h3>Threads on their own · {threads.length}</h3>
      {threads.length > 0 ? (
        <ul className="st-rows">
          {threads.map((w) => (
            <Row key={w.id} w={w} onOpen={() => onOpen(w)} />
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      {lot.settled.length > 0 ? (
        <>
          <h3>
            <button type="button" className="st-link" aria-expanded={settledOpen} onClick={() => setSettledOpen((open) => !open)}>
              Settled · {lot.settled.length} {settledOpen ? "▾" : "▸"}
            </button>
          </h3>
          {settledOpen ? (
            <ul className="st-rows">
              {lot.settled.map((thread) => (
                <Row key={thread.id} w={{ kind: "thread", id: thread.id, title: thread.title, state: "dark", label: "settled", unseen: 0, members: 1 }} onOpen={() => onOpen({ kind: "thread", id: thread.id, title: thread.title, state: "dark", label: "settled", unseen: 0, members: 1 })} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      <div className="st-card-actions">
        <button type="button" onClick={onNewRoom}>
          + New room
        </button>
        <button type="button" onClick={onNewThread}>
          + New thread
        </button>
      </div>
    </Card>
  );
}

/**
 * The social club on the corner: the family (the crew, ready to be seated in a room or to start a thread), the
 * shared browsers, the books for the whole street, the settings, and the way back to the desk.
 */
export function ClubCard({
  books,
  rooms,
  projects,
  browsers,
  status,
  theme,
  onTheme,
  onOpenConnection,
  onSeat,
  onNewThread,
  onEditPreset,
  onBrowser,
  onDesk,
  onClose,
}: {
  books: Books;
  rooms: RoomListItem[];
  projects: T3Project[] | null;
  browsers: BrowserListItem[] | null;
  status: StatusResponse | null;
  theme: ThemeChoice;
  onTheme: (choice: ThemeChoice) => void;
  onOpenConnection: () => void;
  onSeat: (roomId: string, presetId: string) => void;
  onNewThread: (preset: Preset) => void;
  onEditPreset: (preset: Preset | null) => void;
  onBrowser: (browserId: string) => void;
  onDesk: () => void;
  onClose: () => void;
}) {
  const { presets } = usePresets();
  const presetText = usePresetText();
  const projectTitle = (id: string) => projects?.find((p) => p.id === id)?.title ?? "";
  return (
    <Card className="st-club" title="The Social Club" subtitle="The family, the books and the house rules" onClose={onClose}>
      <p className="st-books">
        {books.today !== null ? (
          <>
            <span>Today</span>
            <strong>{money(books.today)}</strong>
          </>
        ) : null}
        <span>On the street</span>
        <strong>{money(books.total)}</strong>
        <span className="muted">estimated at list price{books.partial ? ", some threads not counted" : ""}</span>
      </p>
      <h3>House rules</h3>
      <div className="st-club-controls">
        <AppControls status={status} onOpenConnection={onOpenConnection} theme={theme} onTheme={onTheme} />
        <button type="button" className="primary small" onClick={onDesk}>
          Back to the desk
        </button>
      </div>
      <h3>The family · {presets.length}</h3>
      {presets.length === 0 ? <p className="muted">Nobody yet. Add someone: a name with a model and where they work.</p> : null}
      <ul className="st-rows">
        {presets.map((preset) => {
          const text = presetText(preset);
          return (
            <li key={preset.id} className="st-crew">
              <button type="button" className="st-row" onClick={() => onEditPreset(preset)} title="Edit">
                <PresetIcon preset={preset} />
                <span className="st-row-title">{preset.name}</span>
                <span className="st-row-label">{text.model}</span>
              </button>
              <span className="st-crew-actions">
                <select
                  aria-label={`Seat ${preset.name} in a room`}
                  value=""
                  onChange={(event) => {
                    if (event.target.value) onSeat(event.target.value, preset.id);
                  }}
                >
                  <option value="">Seat in…</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {projectTitle(room.projectId) ? `${projectTitle(room.projectId)} · ` : ""}
                      {room.title}
                    </option>
                  ))}
                </select>
                <button type="button" className="small" onClick={() => onNewThread(preset)}>
                  New thread
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      <div className="st-card-actions">
        <button type="button" onClick={() => onEditPreset(null)}>
          + New member of the family
        </button>
      </div>
      {browsers && browsers.length > 0 ? (
        <>
          <h3>Browsers · {browsers.length}</h3>
          <ul className="st-rows">
            {browsers.map((browser) => (
              <li key={browser.id}>
                <button type="button" className="st-row" onClick={() => onBrowser(browser.id)}>
                  <span className={`st-dot ${browser.status.state === "running" ? "is-working" : "is-dark"}`} aria-hidden="true" />
                  <span className="st-row-title">{browser.name}</span>
                  <span className="st-row-label">{browser.status.state === "running" ? "on" : "off"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}
