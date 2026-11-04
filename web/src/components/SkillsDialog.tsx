import { useCallback, useEffect, useState } from "react";
import { reloadAgentsFiles } from "../agentsFiles.ts";
import { api } from "../api.ts";
import { PRESET_DESCRIPTION_MAX, type LinkFolder, type PackState, type PackUpdateDetail, type RoomCommand, type SkillKind, type SkillRow, type SkillsResponse } from "../types.ts";
import { Dialog } from "./Dialog.tsx";
import { DiffView } from "./GitTab.tsx";
import { useToast } from "./Toast.tsx";

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const when = (at: string | null): string => (at ? new Date(at).toLocaleString() : "never");
const short = (commit: string | null): string => (commit ? commit.slice(0, 7) : "—");
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The roster's groups, in the order the composer draws them too. */
export const KIND_LABEL: Record<SkillKind, string> = { directive: "Room directives", command: "Harness commands", skill: "Skills", pack: "Pack skills" };
const KINDS: SkillKind[] = ["directive", "command", "skill", "pack"];

/** A row's restriction as its tag says it. */
export function restriction(row: Pick<SkillRow, "userInvocationOnly" | "userInvocable">): string | null {
  if (!row.userInvocable) return "model only";
  return row.userInvocationOnly ? "user-invoked only" : null;
}

/**
 * Settings → Skills (src/app/skillRoster.ts, src/app/packs.ts): the roster, every directive, harness command, skill and
 * pack skill the user can name, grouped, each with who has it, the author's line and the user's two lines; then the packs,
 * each with its pin, standing line, update, skills and the folders each is linked into. Everything is read from the
 * service (GET /api/skills), again after each command and each second while a pack is busy.
 */
export function SkillsDialog({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const read = useCallback(
    () =>
      api.skills().then(
        (next) => {
          setData(next);
          setLoadError(null);
        },
        (error: unknown) => setLoadError(message(error)),
      ),
    [],
  );
  useEffect(() => {
    void read();
  }, [read]);
  const busy = data?.packs.some((pack) => pack.busy) ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [busy, read]);
  /** A command, then the roster and packs read again; the written projects too, since the agents file follows the packs. */
  const run = async (command: RoomCommand): Promise<boolean> => {
    try {
      const result = await api.command(command);
      const unlinked = "unlinked" in result && Array.isArray(result.unlinked) ? (result.unlinked as string[]) : [];
      if (unlinked.length > 0) toast(`Links taken out: ${unlinked.join(", ")}`, "success");
      await read();
      reloadAgentsFiles();
      return true;
    } catch (error) {
      toast(message(error));
      await read();
      return false;
    }
  };
  return (
    <Dialog title="Skills" onClose={onClose} large>
      {loadError ? <p className="status-error">{loadError}</p> : null}
      {data === null && !loadError ? <p className="mono muted">reading the skills…</p> : null}
      {data ? (
        <>
          <Roster data={data} run={run} />
          <Packs data={data} run={run} />
        </>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}

type Run = (command: RoomCommand) => Promise<boolean>;

function Roster({ data, run }: { data: SkillsResponse; run: Run }) {
  return (
    <section className="skills-part" aria-label="Roster">
      <h3>Roster</h3>
      <p className="muted">
        Everything you can name to a member: the room&rsquo;s directives, each harness&rsquo;s commands and skills as T3 lists them, and the pack skills Backroom linked. Write when to use one and what to avoid it for, as for a crew member: the composer&rsquo;s
        &ldquo;/&rdquo; list shows your line, and the Consigliere is told of every skill you wrote one for. T3 lists what a harness found when its session started: a newly linked skill reaches a member after a reseat.
      </p>
      {data.t3Error ? <p className="status-error">T3 did not answer ({data.t3Error}): its commands and skills are missing below.</p> : null}
      {KINDS.map((kind) => {
        const rows = data.rows.filter((row) => row.kind === kind);
        if (rows.length === 0) return null;
        return (
          <details key={kind} className="skills-group" open data-kind={kind}>
            <summary>
              {KIND_LABEL[kind]} <span className="muted">({rows.length})</span>
            </summary>
            <ul className="skills-rows">
              {rows.map((row) => (
                <RosterRow key={row.id} row={row} folders={data.folders} run={run} />
              ))}
            </ul>
          </details>
        );
      })}
    </section>
  );
}

function RosterRow({ row, folders, run }: { row: SkillRow; folders: LinkFolder[]; run: Run }) {
  const [useWhen, setUseWhen] = useState(row.useWhen);
  const [avoid, setAvoid] = useState(row.avoid);
  useEffect(() => setUseWhen(row.useWhen), [row.useWhen]);
  useEffect(() => setAvoid(row.avoid), [row.avoid]);
  const save = () => {
    const next = { useWhen: oneLine(useWhen), avoid: oneLine(avoid) };
    if (next.useWhen === row.useWhen && next.avoid === row.avoid) return;
    void run({ type: "skill.hint.set", skillId: row.id, ...next });
  };
  const tag = restriction(row);
  const linkedIn = folders.filter((folder) => row.linked.includes(folder.id));
  return (
    <li className="skill-row" data-skill-id={row.id} data-kind={row.kind}>
      <span className="skill-head">
        <span className="mono skill-name">{row.kind === "directive" || row.kind === "command" ? `/${row.name}` : row.name}</span>
        {row.label ? <span className="skill-label">{row.label}</span> : null}
        <span className="tag skill-source" title={row.path ?? undefined}>
          {row.source}
        </span>
        {tag ? <span className="tag skill-restriction">{tag}</span> : null}
      </span>
      {row.description ? <span className="skill-author muted">{row.description}</span> : null}
      {row.kind === "pack" ? (
        <span className="skill-links hint">
          {linkedIn.length > 0 ? `Linked in ${linkedIn.map((folder) => `${folder.label} (read by ${folder.readBy.join(", ")})`).join("; ")}.` : "Not linked."} {row.instances.length === 0 ? "No harness lists it yet: a member sees it after a reseat." : ""}
          {row.path ? <span className="mono"> {row.path}</span> : null}
        </span>
      ) : null}
      <span className="skill-members" aria-label="Who has it">
        {row.kind === "directive" ? (
          <span className="muted">every room</span>
        ) : row.members.length > 0 ? (
          row.members.map((name) => (
            <span key={name} className="tag skill-member">
              {name}
            </span>
          ))
        ) : (
          <span className="muted">no crew member</span>
        )}
      </span>
      <span className="skill-lines">
        <label>
          <span className="hint">Use when</span>
          <input type="text" value={useWhen} maxLength={PRESET_DESCRIPTION_MAX} onChange={(e) => setUseWhen(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="—" />
        </label>
        <label>
          <span className="hint">Avoid</span>
          <input type="text" value={avoid} maxLength={PRESET_DESCRIPTION_MAX} onChange={(e) => setAvoid(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === "Enter" && save()} placeholder="—" />
        </label>
      </span>
    </li>
  );
}

function Packs({ data, run }: { data: SkillsResponse; run: Run }) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    if (await run({ type: "pack.add", url: url.trim() })) setUrl("");
    setAdding(false);
  };
  return (
    <section className="skills-part" aria-label="Packs">
      <h3>Packs</h3>
      <p className="muted">
        A pack is a git repository of skills Backroom keeps in its data folder, pinned at a commit: it runs none of its scripts, and links only the skills you tick. A folder is read by every harness listed beside it, so a link reaches all of them. The
        daily check only fetches; an update is taken when you have seen what it changes.
      </p>
      {data.packs.map((pack) => (
        <PackCard key={pack.name} pack={pack} folders={data.folders} run={run} />
      ))}
      <form
        className="skills-add"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void add();
        }}
      >
        <label>
          <span className="hint">Add pack: a repository URL</span>
          <input type="text" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/skills" spellCheck={false} />
        </label>
        <button type="submit" className="small primary" disabled={adding || !url.trim()}>
          {adding ? "Cloning…" : "Add pack"}
        </button>
      </form>
    </section>
  );
}

function PackCard({ pack, folders, run }: { pack: PackState; folders: LinkFolder[]; run: Run }) {
  const [standing, setStanding] = useState(pack.standing ?? "");
  useEffect(() => setStanding(pack.standing ?? ""), [pack.standing]);
  const [detail, setDetail] = useState<PackUpdateDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [acting, setActing] = useState(false);
  const act = async (command: RoomCommand) => {
    setActing(true);
    await run(command);
    setActing(false);
  };
  const updateCommit = pack.update?.commit ?? null;
  useEffect(() => {
    // An update shown is for one commit: another one is looked at afresh.
    if (detail && detail.commit !== updateCommit) setDetail(null);
  }, [updateCommit, detail]);
  const look = () => {
    if (!updateCommit) return;
    setDetailError(null);
    api.packUpdate(pack.name, updateCommit).then(setDetail, (error: unknown) => setDetailError(message(error)));
  };
  const dirty = standing.trim() !== (pack.standing ?? "");
  return (
    <article className="pack-card" data-pack={pack.name} aria-label={`Pack ${pack.name}`}>
      <header className="pack-head">
        <strong>{pack.name}</strong>
        <span className="mono muted pack-url">{pack.url}</span>
        {pack.busy ? <span className="tag">working…</span> : null}
      </header>
      <dl className="pack-facts">
        <dt>Pinned at</dt>
        <dd className="mono" title={pack.pinned ?? undefined}>
          {pack.pinned ? `${short(pack.pinned)} ${pack.pinnedSubject ?? ""}` : pack.ready ? "—" : "not installed yet"}
          {pack.checkedOut ? <span className="tag pack-moved">checked out at {short(pack.checkedOut)} by hand</span> : null}
        </dd>
        <dt>Last check</dt>
        <dd>{when(pack.checkedAt)}</dd>
        <dt>Folder</dt>
        <dd className="mono">{pack.folder}</dd>
      </dl>
      {pack.error ? (
        <p className="status-error pack-error">
          The last {pack.error.during} failed ({when(pack.error.at)}): {pack.error.reason}. It is tried again within the hour.
        </p>
      ) : null}
      <label className="pack-standing">
        <span className="hint">
          Standing line: every seat is given it, by the agents file&rsquo;s <code>{"{skills}"}</code> and the briefing&rsquo;s Skills section; <code>{"{folder}"}</code> is the pack&rsquo;s folder. Empty: none.
        </span>
        <textarea className="mono" rows={3} value={standing} spellCheck={false} onChange={(e) => setStanding(e.target.value)} />
      </label>
      <span className="task-actions">
        <button type="button" className="small primary" disabled={acting || !dirty} onClick={() => void act({ type: "pack.standing.set", name: pack.name, text: standing.trim() || null })}>
          Save line
        </button>
        {pack.presets.map((preset) => (
          <button key={preset.label} type="button" className={`small ${pack.standing === preset.text ? "" : "ghost"}`} aria-pressed={pack.standing === preset.text} disabled={acting} onClick={() => void act({ type: "pack.standing.set", name: pack.name, text: preset.text })}>
            {preset.label}
          </button>
        ))}
        <button type="button" className={`small ${pack.standing === null ? "" : "ghost"}`} aria-pressed={pack.standing === null} disabled={acting || pack.standing === null} onClick={() => void act({ type: "pack.standing.set", name: pack.name, text: null })}>
          No line
        </button>
      </span>
      {pack.update ? (
        <div className="pack-update">
          <p>
            <strong>Update available:</strong> <span className="mono">{short(pack.update.commit)}</span> {pack.update.subject}
          </p>
          {detail ? (
            <UpdateDetail detail={detail} />
          ) : (
            <button type="button" className="small" onClick={look}>
              Show what changes
            </button>
          )}
          {detailError ? <p className="status-error">{detailError}</p> : null}
          {detail ? (
            <button type="button" className="small primary" disabled={acting || pack.busy} title={`Check out ${detail.commit} and pin it`} onClick={() => void act({ type: "pack.update.take", name: pack.name, commit: detail.commit })}>
              Take update {short(detail.commit)}
            </button>
          ) : null}
        </div>
      ) : null}
      <details className="pack-skills">
        <summary>
          Skills <span className="muted">({pack.skills.length})</span>
        </summary>
        {pack.skills.length === 0 ? <p className="muted">{pack.ready ? "No SKILL.md in its checkout." : "Not installed yet."}</p> : null}
        <ul>
          {pack.skills.map((skill) => (
            <li key={skill.path} className="pack-skill" data-path={skill.path}>
              <span className="pack-skill-head">
                <strong>{skill.name}</strong> <span className="mono muted">{skill.path}</span>
              </span>
              {skill.description ? <span className="skill-author muted">{skill.description}</span> : null}
              <span className="pack-skill-folders">
                {folders
                  .filter((folder) => skill.folders.includes(folder.id))
                  .map((folder) => {
                    const linked = skill.linked.includes(folder.id);
                    return (
                      <label key={folder.id} className="checkbox">
                        <input
                          type="checkbox"
                          checked={linked}
                          disabled={acting || pack.busy}
                          onChange={() => void act({ type: linked ? "skill.unlink" : "skill.link", pack: pack.name, path: skill.path, folder: folder.id })}
                        />
                        <span>
                          <span className="mono">{folder.label}</span> <span className="hint">read by {folder.readBy.join(", ")}</span>
                        </span>
                      </label>
                    );
                  })}
              </span>
            </li>
          ))}
        </ul>
      </details>
      <span className="task-actions">
        <button type="button" className="small ghost" disabled={acting || pack.busy} title="Fetch now; nothing moves" onClick={() => void act({ type: "pack.check", name: pack.name })}>
          Check now
        </button>
        {confirmRemove ? (
          <>
            <button type="button" className="small danger" disabled={acting || pack.busy} onClick={() => void act({ type: "pack.remove", name: pack.name })}>
              Remove {pack.name} and its links
            </button>
            <button type="button" className="small ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button type="button" className="small ghost" disabled={acting || pack.busy} onClick={() => setConfirmRemove(true)}>
            Remove…
          </button>
        )}
      </span>
    </article>
  );
}

function UpdateDetail({ detail }: { detail: PackUpdateDetail }) {
  return (
    <div className="pack-update-detail">
      <p className="hint mono">
        {short(detail.from)} → {detail.commit}
      </p>
      {detail.descriptions.length > 0 ? (
        <ul className="pack-descriptions" aria-label="Description changes">
          {detail.descriptions.map((change) => (
            <li key={change.path}>
              <span className="mono">{change.path}</span>
              <span className="diff-del">− {change.before ?? "(none)"}</span>
              <span className="diff-add">+ {change.after ?? "(none)"}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {detail.unlinks.length > 0 ? (
        <p className="status-error pack-unlinks">
          Taking it removes {detail.unlinks.length === 1 ? "this link, whose skill is" : "these links, whose skills are"} no longer in it: <span className="mono">{detail.unlinks.join(", ")}</span>
        </p>
      ) : null}
      <pre className="mono pack-stat">{detail.stat || "No change in the files Backroom keeps."}</pre>
      <ul className="pack-files mono" aria-label="Files">
        {detail.files.map((file) => (
          <li key={`${file.status}:${file.path}`}>
            {file.status} {file.path}
          </li>
        ))}
      </ul>
      <details>
        <summary>The full diff{detail.truncated ? " (cut at 2 MB)" : ""}</summary>
        <DiffView diff={detail.diff} label="The update's diff" />
      </details>
    </div>
  );
}
