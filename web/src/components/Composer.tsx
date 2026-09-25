import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { api, ApiError, attachmentUrl, useProviders } from "../api.ts";
import { useRoom, type FollowUpPrefill } from "../context.tsx";
import { parseDraft } from "../parser.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MIME_TYPES,
  isActiveParticipant,
  taskLabel,
  type Draft,
  type DraftAssignment,
  type MentionSpan,
  type Unresolved,
} from "../types.ts";
import {
  insertMention,
  isNote,
  isSentenceStart,
  mentionToReference,
  pickPrerequisite,
  prependAfter,
  replaceMention,
  setTiming,
  splitAtMention,
  toggleNote,
  type TextEdit,
} from "./composerText.ts";
import { identityStyle } from "./Monogram.tsx";
import { RemoveParticipantDialog } from "./ParticipantBar.tsx";

interface Props {
  followUp: FollowUpPrefill | null;
}

interface MentionState {
  start: number;
  query: string;
  index: number;
}

interface PendingAttachment {
  key: string;
  name: string;
  sizeBytes: number;
  status: "uploading" | "ready" | "error";
  /** Server id once uploaded. */
  id: string | null;
  /** Local preview while uploading. */
  previewUrl: string | null;
  error: string | null;
}

/** What the current draft would do, and whether it can be sent. */
interface Plan {
  ready: boolean;
  label: string;
  /** Why the button is disabled (tooltip). */
  reason: string | null;
}

type Edit = (make: (source: string) => TextEdit | null) => void;

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export function Composer({ followUp }: Props) {
  const { snapshot, runCommand, colorOf, aliasOf } = useRoom();
  const roomId = snapshot.room.id;
  const crew = useMemo(() => snapshot.participants.filter(isActiveParticipant), [snapshot.participants]);
  const { providers } = useProviders(true, 120_000);
  /** Examples built from this room (its participants and latest task), so every placeholder can be run as is. */
  const placeholders = useMemo(() => roomPlaceholders(crew.map((p) => p.alias), snapshot.tasks[snapshot.tasks.length - 1]?.number ?? null), [crew, snapshot.tasks]);
  /** T3 slash commands offered to every one of these participants (a command must exist for each recipient). */
  const commandsFor = useCallback(
    (participantIds: string[]) => {
      const lists = participantIds.map((id) => {
        const participant = crew.find((p) => p.id === id);
        return providers?.find((p) => p.instanceId === participant?.modelSelection.instanceId)?.slashCommands ?? [];
      });
      if (lists.length === 0) return [];
      return (lists[0] ?? []).filter((command) => lists.every((list) => list.some((c) => c.name === command.name)));
    },
    [crew, providers],
  );
  const textarea = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [submitting, setSubmitting] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  /** "/" typed: the room's commands, plus the addressed participants' T3 commands after an @name. */
  const [slashPick, setSlashPick] = useState<(MentionState & { recipients: string[] }) | null>(null);
  /** "/after " typed: pick a task by what it says instead of remembering its number. */
  const [taskPick, setTaskPick] = useState<MentionState | null>(null);
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focusAssignment, setFocusAssignment] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const mentionMenu = useRef<HTMLSpanElement>(null);
  useDismiss(mentionMenu, mentionMenuOpen, () => setMentionMenuOpen(false));

  // Parsed in the browser on every keystroke: the plan and the highlighting always match the text exactly.
  const { participants, tasks, roles, participantStatus } = snapshot;
  const parsedDraft = useMemo(
    () => (text.trim().length === 0 ? null : parseDraft(text, { participants, tasks, roles, participantStatus })),
    [text, participants, tasks, roles, participantStatus],
  );
  // A leading slash command must be one of the recipients' T3 commands (checked once T3's list is loaded).
  const draft = useMemo(() => {
    if (!parsedDraft || parsedDraft.kind !== "task" || !providers) return parsedDraft;
    const assignments = parsedDraft.assignments.map((assignment) => {
      if (!assignment.slashCommand) return assignment;
      const offered = commandsFor(assignment.recipients).some((command) => command.name === assignment.slashCommand);
      if (offered) return assignment;
      const who = assignment.recipients.map((id) => `@${aliasOf(id)}`).join(" ");
      const problem: Unresolved = { field: "instruction", severity: "error", message: `/${assignment.slashCommand} is not a T3 command for ${who}; type / to see what is available` };
      return { ...assignment, unresolved: [...assignment.unresolved, problem] };
    });
    return { ...parsedDraft, assignments, unresolved: [...parsedDraft.unresolved, ...assignments.flatMap((a) => a.unresolved.filter((u) => !parsedDraft.unresolved.includes(u)))] };
  }, [parsedDraft, providers, commandsFor, aliasOf]);

  const clearAttachments = useCallback(() => {
    for (const item of attachmentsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setAttachments([]);
  }, []);

  // Reset when switching rooms.
  useEffect(() => {
    setText("");
    setMention(null);
    setFocusAssignment(null);
    clearAttachments();
  }, [roomId, clearAttachments]);

  const applyEdit = useCallback((edit: TextEdit) => {
    setText(edit.text);
    setMention(null);
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.caret, edit.caret);
    });
  }, []);

  const edit: Edit = (make) => {
    const result = make(text);
    if (result) applyEdit(result);
  };

  // Follow-up prefill from a task card: write `/after taskN ` at the start of the text.
  const lastNonce = useRef(0);
  useEffect(() => {
    if (!followUp || followUp.nonce === lastNonce.current) return;
    lastNonce.current = followUp.nonce;
    const labels = followUp.prerequisites.map((p) => {
      const task = snapshot.tasks.find((t) => t.id === p.taskId);
      return task ? taskLabel(task) : (/^task\d+/.exec(p.label)?.[0] ?? p.taskId);
    });
    applyEdit(prependAfter(textarea.current?.value ?? "", labels));
  }, [followUp, snapshot.tasks, applyEdit]);

  // Keep the mirror scrolled with the textarea (typing can scroll it without a scroll event on some engines).
  useLayoutEffect(() => {
    if (backdrop.current && textarea.current) backdrop.current.scrollTop = textarea.current.scrollTop;
  });

  // ---- attachments ----

  const attachFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      let total = attachmentsRef.current.filter((a) => a.status !== "error").reduce((sum, a) => sum + a.sizeBytes, 0);
      const added: PendingAttachment[] = [];
      for (const file of files) {
        const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const base = { key, name: file.name || "image", sizeBytes: file.size, id: null, previewUrl: null };
        if (!ATTACHMENT_MIME_TYPES.has(file.type)) {
          added.push({ ...base, status: "error", error: "only PNG, JPEG, GIF, or WebP images" });
          continue;
        }
        if (file.size > ATTACHMENT_MAX_BYTES) {
          added.push({ ...base, status: "error", error: "larger than 10 MB" });
          continue;
        }
        if (total + file.size > ATTACHMENT_MAX_TOTAL_BYTES) {
          added.push({ ...base, status: "error", error: "images can total 80 MB per message" });
          continue;
        }
        total += file.size;
        added.push({ ...base, status: "uploading", previewUrl: URL.createObjectURL(file), error: null });
        api
          .uploadAttachment(roomId, file)
          .then((stored) => {
            setAttachments((current) => current.map((a) => (a.key === key ? { ...a, status: "ready", id: stored.id } : a)));
          })
          .catch((error: unknown) => {
            const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
            setAttachments((current) => current.map((a) => (a.key === key ? { ...a, status: "error", error: message } : a)));
          });
      }
      setAttachments((list) => [...list, ...added]);
    },
    [roomId],
  );

  const removeAttachment = (key: string) => {
    const item = attachmentsRef.current.find((a) => a.key === key);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setAttachments((list) => list.filter((a) => a.key !== key));
  };

  const readyIds = attachments.filter((a) => a.status === "ready" && a.id).map((a) => a.id as string);
  const uploading = attachments.some((a) => a.status === "uploading");
  const attachedCount = attachments.filter((a) => a.status !== "error").length;

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) {
      // Pasted multi-line text that contains @names or /commands (a transcript, a briefing, a log) is quoted in a code
      // block, so it is read as text and addresses nobody. Ctrl/⌘+Z undoes it like any paste.
      const pasted = event.clipboardData.getData("text/plain");
      const hasSyntax = /(^|[\s(])@[a-z0-9][a-z0-9_-]*/i.test(pasted) || /^\s*\/(after|hold|now|steer|note|add|role|remove)\b/im.test(pasted);
      if (pasted.includes("\n") && hasSyntax && !/```/.test(pasted)) {
        event.preventDefault();
        const el = event.currentTarget;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const before = text.slice(0, start);
        const block = `${before.length > 0 && !before.endsWith("\n") ? "\n" : ""}\`\`\`\n${pasted.replace(/\s+$/, "")}\n\`\`\`\n`;
        // execCommand keeps the browser's undo stack; fall back to a plain edit where it is unavailable.
        el.setSelectionRange(start, end);
        if (!document.execCommand("insertText", false, block)) {
          applyEdit({ text: `${before}${block}${text.slice(end)}`, caret: start + block.length });
        }
      }
      return;
    }
    // Keep plain-text pastes (e.g. from a web page that also offers an image) as text.
    if (!event.clipboardData.getData("text/plain")) event.preventDefault();
    attachFiles(files);
  };

  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!dragging) setDragging(true);
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    setDragging(false);
    attachFiles([...event.dataTransfer.files]);
  };

  // ---- mentions (autocomplete + toolbar menu) ----

  const onTextChange = (value: string) => {
    setText(value);
    updateMention(value, textarea.current?.selectionStart ?? value.length);
  };

  const updateMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const slash = /(^|\s)\/([a-z0-9:._-]*)$/i.exec(before);
    if (slash && !/\/after\s+\S*$/i.test(before)) {
      const start = caret - (slash[2]?.length ?? 0) - 1;
      // Addressed participants just before this slash ("@claude /c", "@claude /hold /c", "@all /r").
      const head = /(?:^|\s)((?:@[a-z0-9_-]+[\s,]*(?:and\s+)?)+)(?:\/(?:after|hold|now|steer)\b[^\s]*\s+(?:task\d+\s+|@[a-z0-9_-]+\s+)?)*$/i.exec(before.slice(0, start));
      const aliases = head ? [...(head[1] ?? "").matchAll(/@([a-z0-9_-]+)/gi)].map((m) => (m[1] as string).toLowerCase()) : [];
      const recipients = aliases.includes("all") ? crew.map((p) => p.id) : crew.filter((p) => aliases.includes(p.alias.toLowerCase())).map((p) => p.id);
      const atStart = /(^|\n)\s*$/.test(before.slice(0, start));
      if (recipients.length > 0 || atStart) setSlashPick({ start, query: (slash[2] ?? "").toLowerCase(), index: 0, recipients });
      else setSlashPick(null);
    } else {
      setSlashPick(null);
    }
    const afterRef = /\/after\s+(?:(?:task\d+|#\d+|@[a-z0-9_-]+)\s*,\s*)*((?:task|#)?\d*)$/i.exec(before);
    if (afterRef && !/@[a-z0-9_-]*$/i.test(before)) {
      const token = afterRef[1] ?? "";
      setTaskPick({ start: caret - token.length, query: token.replace(/^(?:task|#)/i, ""), index: 0 });
    } else {
      setTaskPick(null);
    }
    const match = /(^|\s)@([a-z0-9_-]*)$/i.exec(before);
    if (!match) {
      setMention(null);
      return;
    }
    const start = caret - (match[2]?.length ?? 0) - 1;
    setMention({ start, query: (match[2] ?? "").toLowerCase(), index: 0 });
  };

  // "@all" (everyone in the room) is offered first when it matches and there is more than one participant.
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const people: Array<{ id: string; alias: string; modelSelection: { model: string } }> = crew
      .filter((p) => p.alias.toLowerCase().startsWith(mention.query))
      .slice(0, 8);
    return crew.length > 1 && "all".startsWith(mention.query) ? [{ id: "@all", alias: "all", modelSelection: { model: `everyone (${crew.length})` } }, ...people] : people;
  }, [mention, crew]);

  const taskMatches = useMemo(() => {
    if (!taskPick) return [];
    const open = new Set(["queued", "held", "blocked", "dispatching", "running", "needs_input"]);
    return [...snapshot.tasks]
      .filter((t) => t.state !== "cancelled" && (taskPick.query === "" || String(t.number).startsWith(taskPick.query)))
      .sort((a, b) => Number(open.has(b.state)) - Number(open.has(a.state)) || b.number - a.number)
      .slice(0, 8);
  }, [taskPick, snapshot.tasks]);

  const slashMatches = useMemo(() => {
    if (!slashPick) return [];
    const room = (slashPick.recipients.length > 0 ? ADDRESSED_ROOM_COMMANDS : ROOM_COMMANDS).map((c) => ({ ...c, group: "room" as const }));
    const t3 = slashPick.recipients.length > 0
      ? commandsFor(slashPick.recipients).map((c) => ({ name: c.name, description: c.description ?? "", hint: c.hint, group: "t3" as const }))
      : [];
    return [...room, ...t3].filter((c) => c.name.toLowerCase().includes(slashPick.query)).slice(0, 12);
  }, [slashPick, commandsFor]);

  const acceptSlash = (name: string) => {
    if (!slashPick) return;
    const caret = textarea.current?.selectionStart ?? text.length;
    const token = `/${name} `;
    applyEdit({ text: `${text.slice(0, slashPick.start)}${token}${text.slice(caret).replace(/^\s+/, "")}`, caret: slashPick.start + token.length });
    setSlashPick(null);
  };

  const acceptTask = (number: number) => {
    if (!taskPick) return;
    const caret = textarea.current?.selectionStart ?? text.length;
    const token = `task${number} `;
    applyEdit({ text: `${text.slice(0, taskPick.start)}${token}${text.slice(caret).replace(/^\s+/, "")}`, caret: taskPick.start + token.length });
    setTaskPick(null);
  };

  const acceptMention = (alias: string) => {
    if (!mention) return;
    const caret = textarea.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${alias} ${text.slice(caret)}`;
    applyEdit({ text: next, caret: mention.start + alias.length + 2 });
  };

  const insertMentionAtCaret = (alias: string) => {
    setMentionMenuOpen(false);
    applyEdit(insertMention(text, textarea.current?.selectionStart ?? text.length, alias));
  };

  // ---- plan + submit ----

  const crewDraft = draft && (draft.kind === "participant.add" || draft.kind === "participant.remove" || draft.kind === "participant.role") ? draft : null;
  const noteOn = isNote(text);
  const plan = evaluate(draft, readyIds.length, uploading, attachedCount);
  const canSubmit = plan.ready && !submitting;
  const assignmentCount = draft?.kind === "task" ? draft.assignments.length : 0;

  /** Participants mid-turn (room work or typing in T3): a plain send waits for them; /steer or ⌘Enter goes into the turn. */
  const isBusy = (id: string): boolean =>
    snapshot.tasks.some((t) => t.participantId === id && (t.state === "dispatching" || t.state === "running" || t.state === "needs_input")) ||
    Boolean(snapshot.participantStatus[id]?.externalActivity);

  const submit = async (options: { steerBusy?: boolean } = {}) => {
    if (!draft || submitting || !evaluate(draft, readyIds.length, uploading, attachedCount).ready) return;
    if (draft.kind === "participant.remove") {
      if (draft.participant) setRemoveTarget(draft.participant.participantId);
      return;
    }
    setSubmitting(true);
    try {
      const result =
        draft.kind === "participant.add" && draft.add
          ? await runCommand({ type: "participant.create", roomId, alias: draft.add.alias, roleId: draft.add.roleId ?? null, thread: { mode: "create" } })
          : draft.kind === "participant.role" && draft.participant && draft.role
            ? await runCommand({ type: "participant.update", participantId: draft.participant.participantId, roleId: draft.role.roleId || null })
            : draft.kind === "note"
              ? await runCommand({ type: "room.note.create", roomId, text: draft.instruction })
              : draft.kind === "task"
                ? await runCommand({
                    type: "message.create",
                    roomId,
                    sourceText: text,
                    attachmentIds: readyIds,
                    assignments: draft.assignments.map((a) => ({
                      recipients: a.recipients,
                      instruction: a.instruction,
                      schedule: a.schedule ?? { mode: "now" },
                      after: a.after.map((ref) => ref.index),
                      // ⌘/Ctrl+Enter: send into the running turn of anyone who is mid-turn, for this send only.
                      slashCommand: Boolean(a.slashCommand),
                      delivery:
                        a.delivery === "steer" ||
                        (options.steerBusy && a.schedule?.mode === "now" && a.after.length === 0 && a.recipients.some(isBusy))
                          ? ("steer" as const)
                          : ("queue" as const),
                    })),
                  })
                : null;
      if (result) {
        setText("");
        setMention(null);
        setFocusAssignment(null);
        clearAttachments();
        textarea.current?.focus();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashPick && slashMatches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setSlashPick({ ...slashPick, index: (slashPick.index + step + slashMatches.length) % slashMatches.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const pick = slashMatches[slashPick.index] ?? slashMatches[0];
        if (pick) acceptSlash(pick.name);
        return;
      }
      if (event.key === "Escape") {
        setSlashPick(null);
        return;
      }
    }
    if (taskPick && taskMatches.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setTaskPick({ ...taskPick, index: (taskPick.index + step + taskMatches.length) % taskMatches.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const pick = taskMatches[taskPick.index] ?? taskMatches[0];
        if (pick) acceptTask(pick.number);
        return;
      }
      if (event.key === "Escape") {
        setTaskPick(null);
        return;
      }
    }
    if (mention && mentionMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMention({ ...mention, index: (mention.index + 1) % mentionMatches.length });
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMention({ ...mention, index: (mention.index - 1 + mentionMatches.length) % mentionMatches.length });
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const pick = mentionMatches[mention.index] ?? mentionMatches[0];
        if (pick) acceptMention(pick.alias);
        return;
      }
      if (event.key === "Escape") {
        setMention(null);
        return;
      }
    }
    // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an IME is composing (e.g. Chinese or Japanese input).
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submit({ steerBusy: event.metaKey || event.ctrlKey });
    }
  };

  const showPlan = text.trim().length > 0 || attachments.length > 0;
  // Only relevant when someone addressed (without /steer or a wait) is mid-turn: then Enter and ⌘Enter differ.
  const busyAddressed =
    draft?.kind === "task"
      ? [...new Set(draft.assignments.filter((a) => a.delivery !== "steer" && a.schedule?.mode === "now" && a.after.length === 0).flatMap((a) => a.recipients.filter(isBusy)))]
      : [];

  return (
    <div className={`composer${dragging ? " dragging" : ""}`} aria-label="Composer" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="composer-text">
        <div className="composer-field">
          <div className={`composer-backdrop${focusAssignment !== null ? " focusing" : ""}`} ref={backdrop} aria-hidden="true">
            <Highlights text={text} draft={draft} focus={focusAssignment} typingAt={mention?.start ?? null} colorOf={colorOf} />
          </div>
          <textarea
            ref={textarea}
            value={text}
            rows={3}
            spellCheck={false}
            placeholder={placeholders[placeholderIndex % placeholders.length] as string}
            onFocus={() => setPlaceholderIndex((i) => i + 1)}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onScroll={(e) => {
              if (backdrop.current) backdrop.current.scrollTop = e.currentTarget.scrollTop;
            }}
            onClick={() => updateMention(text, textarea.current?.selectionStart ?? text.length)}
            onBlur={() =>
              setTimeout(() => {
                setMention(null);
                setTaskPick(null);
                setSlashPick(null);
              }, 150)
            }
            aria-label="Message"
          />
        </div>
        {slashPick && slashMatches.length > 0 ? (
          <ul className="mention-menu slash-menu" role="listbox" aria-label="Commands">
            {slashMatches.map((command, index) => (
              <li
                key={`${command.group}:${command.name}`}
                role="option"
                aria-selected={index === slashPick.index}
                className={`${index === slashPick.index ? "active" : ""}${index > 0 && slashMatches[index - 1]?.group !== command.group ? " group-start" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptSlash(command.name);
                }}
              >
                <span className="mono slash-name">/{command.name}</span>
                {command.hint ? <span className="muted mono"> {command.hint}</span> : null}
                <span className="slash-desc muted">{command.description}</span>
                <span className="slash-group mono">
                  {command.group === "room" ? "room" : `T3 · ${slashPick.recipients.map((id) => `@${aliasOf(id)}`).join(" ")}`}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {taskPick && taskMatches.length > 0 ? (
          <ul className="mention-menu task-menu" role="listbox" aria-label="Wait for a task">
            {taskMatches.map((t, index) => (
              <li
                key={t.id}
                role="option"
                aria-selected={index === taskPick.index}
                className={index === taskPick.index ? "active" : ""}
                style={identityStyle(colorOf(t.participantId))}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptTask(t.number);
                }}
              >
                <span className="identity mono">@{aliasOf(t.participantId)}</span> <span className="task-menu-text">{t.instruction}</span>{" "}
                <span className="muted mono">
                  {t.state.replace("_", " ")} · task{t.number}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {mention && mentionMatches.length > 0 ? (
          <ul className="mention-menu" role="listbox" aria-label="Mention a participant">
            {mentionMatches.map((p, index) => (
              <li
                key={p.id}
                role="option"
                aria-selected={index === mention.index}
                className={index === mention.index ? "active" : ""}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(p.alias);
                }}
              >
                @{p.alias} <span className="muted">{p.modelSelection.model}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {attachments.length > 0 ? (
        <div className="attach-strip" aria-label="Attached images">
          {attachments.map((a) => (
            <figure key={a.key} className={`attach-thumb status-${a.status}`}>
              <div className="attach-image">
                {a.id || a.previewUrl ? <img src={a.id ? attachmentUrl(a.id) : (a.previewUrl as string)} alt={a.name} /> : <span className="attach-missing mono">?</span>}
                {a.status === "uploading" ? <span className="spinner" aria-label="Uploading" /> : null}
              </div>
              <figcaption>
                <span className="attach-name" title={a.name}>
                  {a.name}
                </span>
                {a.status === "error" ? <span className="attach-error">{a.error}</span> : <span className="muted mono">{formatBytes(a.sizeBytes)}</span>}
              </figcaption>
              <button type="button" className="attach-remove" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => removeAttachment(a.key)}>
                ×
              </button>
            </figure>
          ))}
          {attachedCount > 0 && assignmentCount >= 2 ? <span className="attach-caption muted">Images go to every assignment in this message.</span> : null}
        </div>
      ) : null}

      {showPlan ? (
        <PlanPreview
          text={text}
          draft={draft}
          typingMention={mention !== null}
          hasImages={readyIds.length > 0 || uploading}
          noteOn={noteOn}
          crewDraft={crewDraft}
          edit={edit}
          onFocusAssignment={setFocusAssignment}
        />
      ) : null}

      {draft && draft.hints.length > 0 ? (
        <ul className="hints" aria-label="Hints">
          {draft.hints.map((hint, index) => (
            <li key={index}>{hint}</li>
          ))}
        </ul>
      ) : null}

      <div className="composer-row composer-toolbar">
        <span className="tool-adder" ref={mentionMenu}>
          <button
            type="button"
            className="small ghost"
            aria-haspopup="menu"
            aria-expanded={mentionMenuOpen}
            disabled={crew.length === 0}
            title={crew.length === 0 ? "Add a participant first" : "Mention a crew member"}
            onClick={() => setMentionMenuOpen((v) => !v)}
          >
            @ Mention
          </button>
          {mentionMenuOpen ? (
            <div className="menu menu-up" role="menu">
              {crew.length > 1 ? (
                <button type="button" role="menuitem" className="mono" onClick={() => insertMentionAtCaret("all")}>
                  <span>@all</span>
                  <span className="muted"> everyone ({crew.length})</span>
                </button>
              ) : null}
              {crew.map((p) => (
                <button key={p.id} type="button" role="menuitem" className="mono" style={identityStyle(colorOf(p.id))} onClick={() => insertMentionAtCaret(p.alias)}>
                  <span className="identity">@{p.alias}</span>
                  <span className="muted"> {p.modelSelection.model}</span>
                </button>
              ))}
            </div>
          ) : null}
        </span>
        <button type="button" className="small ghost" onClick={() => fileInput.current?.click()} title="Attach PNG, JPEG, GIF, or WebP images (or paste / drop them here)">
          Attach image
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            attachFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={`small ghost note-button${noteOn ? " active" : ""}`}
          aria-pressed={noteOn}
          title="Post a room note: shared context, no participant is invoked"
          onClick={() => applyEdit(toggleNote(text))}
        >
          Note
        </button>
        <span className="spacer" />
        <span className="muted hint mono">
          {busyAddressed.length > 0 ? (
            <>
              Enter: waits for {busyAddressed.map((id) => `@${aliasOf(id)}`).join(", ")} to finish · {MOD_KEY}+Enter: send into the running turn
            </>
          ) : (
            "Enter to send · Shift+Enter new line"
          )}
        </span>
        <button type="button" className="primary" disabled={!canSubmit} title={plan.reason ?? undefined} onClick={() => void submit()}>
          {submitting ? "…" : plan.label}
        </button>
      </div>
      {removeTarget ? (
        (() => {
          const participant = snapshot.participants.find((p) => p.id === removeTarget);
          return participant ? (
            <RemoveParticipantDialog
              participant={participant}
              onClose={() => {
                setRemoveTarget(null);
                if (!snapshot.participants.some((p) => p.id === removeTarget && !p.retiredAt)) setText("");
              }}
            />
          ) : null;
        })()
      ) : null}
    </div>
  );
}

/** Whether the draft can be sent and what the button says. Incomplete drafts just disable the button. */
function evaluate(draft: Draft | null, readyImages: number, uploading: boolean, attached: number): Plan {
  const blocked = (label: string, reason: string | null): Plan => ({ ready: false, label, reason });
  if (!draft || draft.kind === "empty") return blocked("Send", attached > 0 ? "Address someone with @name" : null);
  if (draft.kind === "participant.add") return draft.add && draft.unresolved.length === 0 ? { ready: true, label: "Add", reason: null } : blocked("Add", firstMessage(draft.unresolved));
  if (draft.kind === "participant.role") {
    return draft.participant && draft.role && draft.unresolved.length === 0 ? { ready: true, label: "Apply", reason: null } : blocked("Apply", firstMessage(draft.unresolved));
  }
  if (draft.kind === "participant.remove") return draft.participant ? { ready: true, label: "Remove…", reason: null } : blocked("Remove…", firstMessage(draft.unresolved));
  if (draft.kind === "note") {
    if (attached > 0) return blocked("Post note", "Notes cannot carry images");
    return draft.instruction.length > 0 ? { ready: true, label: "Post note", reason: null } : blocked("Post note", "Write the note");
  }
  const { assignments } = draft;
  const count = assignments.reduce((sum, a) => sum + a.recipients.length, 0);
  const held = assignments.length > 0 && assignments.every((a) => a.schedule?.mode === "manual");
  const startsNow = assignments.some((a) => a.schedule?.mode === "now" && a.after.length === 0);
  const label = `${held ? "Hold" : startsNow ? "Send" : "Queue"}${count > 1 ? ` ${count}` : ""}`;
  if (assignments.length === 0) return blocked(label, firstMessage(draft.unresolved));
  const blocking = assignments.flatMap((a) => issuesOf(a, readyImages > 0));
  if (blocking.length > 0) return blocked(label, firstMessage(blocking));
  if (uploading) return blocked(label, "Waiting for images to upload");
  return { ready: true, label, reason: null };
}

/** The assignment's unresolved items; an empty instruction is fine when the message carries images. */
function issuesOf(assignment: DraftAssignment, hasImages: boolean): Unresolved[] {
  return assignment.unresolved.filter((u) => !(hasImages && u.field === "instruction" && assignment.instruction.length === 0));
}

const firstMessage = (list: Unresolved[]): string | null => list[0]?.message ?? null;

// ---- plan preview ----

function PlanPreview({
  text,
  draft,
  typingMention,
  hasImages,
  noteOn,
  crewDraft,
  edit,
  onFocusAssignment,
}: {
  text: string;
  draft: Draft | null;
  typingMention: boolean;
  hasImages: boolean;
  noteOn: boolean;
  crewDraft: Draft | null;
  edit: Edit;
  onFocusAssignment: (index: number | null) => void;
}) {
  const { colorOf, aliasOf } = useRoom();

  if (crewDraft) {
    return (
      <ol className="plan" aria-label="Plan">
        <li className="plan-row plan-single">
          <span className="plan-num mono">·</span>
          <span className="plan-text serif">{crewSummary(crewDraft)}</span>
          <span />
        </li>
        <IssueLine issues={crewDraft.unresolved} />
      </ol>
    );
  }

  if (noteOn || draft?.kind === "note") {
    const body = draft?.kind === "note" ? draft.instruction : text.replace(/^\s*\/note\b\s*/i, "");
    return (
      <ol className="plan" aria-label="Plan">
        <li className="plan-row plan-single">
          <span className="plan-num mono">·</span>
          <span className="plan-text serif">
            <span className="note-mark mono">note</span>{" "}
            {body ? truncate(body, 160) : <span className="plan-placeholder">shared context for the room; no participant is invoked</span>}
          </span>
          <span />
        </li>
        {hasImages ? (
          <li className="plan-notes">
            <span className="plan-error">notes cannot carry images; remove them or address someone</span>
          </li>
        ) : null}
      </ol>
    );
  }

  if (!draft || draft.kind !== "task" || draft.assignments.length === 0) {
    return (
      <ol className="plan" aria-label="Plan">
        <li className="plan-row plan-single">
          <span className="plan-num mono">1</span>
          <span className="plan-to plan-placeholder mono">who?</span>
          <span className="plan-text plan-placeholder">{draft?.preamble ? truncate(draft.preamble, 120) : "start with @name to address someone"}</span>
          <span />
        </li>
      </ol>
    );
  }

  const { assignments } = draft;
  return (
    <ol className="plan" aria-label="Plan" onMouseLeave={() => onFocusAssignment(null)}>
      {draft.preamble ? (
        <li className="plan-row plan-preamble">
          <span className="plan-num mono">·</span>
          <span className="plan-text">
            <span className="plan-label mono">Context for everyone:</span> {truncate(draft.preamble, 160)}
          </span>
          <span />
        </li>
      ) : null}
      {assignments.map((assignment, index) => {
        const mentions = draft.mentions.filter((m) => m.assignment === index);
        const firstAddress = mentions.find((m) => m.role === "address");
        // A bare mid-sentence @mention split the text here. At a sentence or line start an @mention always addresses,
        // and a lead like "then @bob" or "/hold @bob" is deliberate, so neither offers "it's a reference".
        const splitMention =
          index > 0 && firstAddress && firstAddress.start === assignment.start && !isSentenceStart(draft.sourceText, assignment.start) ? firstAddress : null;
        const references = mentions.filter((m) => m.role === "reference" && m.participantId);
        const issues = issuesOf(assignment, hasImages);
        const incomplete = issues.filter((u) => u.severity === "incomplete");
        // Unknown names are errors, but not while the user is still typing one.
        const errors = issues.filter((u) => u.severity === "error" && !(typingMention && u.field === "recipients"));
        const missingWho = incomplete.find((u) => u.field === "recipients");
        const missingWhat = incomplete.find((u) => u.field === "instruction");
        const otherIncomplete = incomplete.filter((u) => u !== missingWho && u !== missingWhat);
        const color = assignment.recipients[0] ? colorOf(assignment.recipients[0]) : "var(--fg-dim)";
        const hover = {
          onMouseEnter: () => onFocusAssignment(index),
          onFocus: () => onFocusAssignment(index),
          onBlur: () => onFocusAssignment(null),
        };
        const notes = (
          <>
            {missingWho && assignment.instruction ? <span className="plan-quiet">{missingWho.message}</span> : null}
            {otherIncomplete.map((u, i) => (
              <span key={`i${i}`} className="plan-quiet">
                {u.message}
              </span>
            ))}
            {errors.map((u, i) => (
              <span key={`e${i}`} className="plan-error">
                {u.message}
                {u.candidates && u.candidates.length > 0 ? (
                  <CandidateOptions
                    options={u.candidates.map((c) => ({ key: c.taskId, label: c.label }))}
                    onPick={(key) => {
                      const alias = /^@([a-z0-9][a-z0-9_-]*)/i.exec(u.message)?.[1];
                      const number = /^task(\d+)/.exec(u.candidates?.find((c) => c.taskId === key)?.label ?? "")?.[1];
                      if (alias && number) edit((source) => pickPrerequisite(source, assignment, alias, `task${number}`));
                    }}
                  />
                ) : null}
                {u.participantCandidates && u.participantCandidates.length > 0 ? (
                  <CandidateOptions
                    options={u.participantCandidates.map((c) => ({ key: c.alias, label: `@${c.alias}${c.busy ? " (busy)" : ""}` }))}
                    onPick={(alias) => {
                      const pool = /@([a-z0-9][a-z0-9_-]*) pool/i.exec(u.message)?.[1]?.toLowerCase();
                      const span = mentions.find((m) => m.role === "address" && m.alias.toLowerCase() === pool);
                      if (span) edit((source) => replaceMention(source, span, alias));
                    }}
                  />
                ) : null}
              </span>
            ))}
            {references.map((m) => (
              <MentionAction key={`r${m.start}`} mention={m} colorOf={colorOf} label="mentioned" action="make it a new assignment" onClick={() => edit((source) => splitAtMention(source, m))} />
            ))}
            {splitMention ? (
              <MentionAction mention={splitMention} colorOf={colorOf} label="starts a new assignment" action="it's a reference" onClick={() => edit((source) => mentionToReference(source, splitMention))} />
            ) : null}
          </>
        );
        return (
          <PlanRow key={index} index={index} color={color} hover={hover} notes={notes}>
            <span className="plan-to mono">
              {assignment.recipients.length > 0 ? (
                assignment.recipients.map((id, i) => (
                  <span key={id} className="identity" style={identityStyle(colorOf(id))}>
                    {i > 0 ? " " : ""}@{aliasOf(id)}
                  </span>
                ))
              ) : (
                <span className="plan-placeholder">who?</span>
              )}
            </span>
            <span className="plan-text serif">
              {assignment.slashCommand ? (
                <span className="tag mono t3-command-tag" title="Runs in their T3 thread exactly as typed, without a room briefing">
                  T3 command
                </span>
              ) : null}
              {assignment.instruction ? (
                truncate(assignment.instruction, 200)
              ) : hasImages ? (
                <span className="plan-placeholder">see the attached image</span>
              ) : (
                <span className="plan-placeholder">{missingWhat?.message ?? "…"}</span>
              )}
            </span>
            <TimingPill assignment={assignment} assignments={assignments} aliasOf={aliasOf} edit={edit} />
          </PlanRow>
        );
      })}
    </ol>
  );
}

function PlanRow({
  index,
  color,
  hover,
  notes,
  children,
}: {
  index: number;
  color: string;
  hover: { onMouseEnter: () => void; onFocus: () => void; onBlur: () => void };
  notes: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <li className="plan-row" style={identityStyle(color)} {...hover}>
        <span className="plan-num mono">{index + 1}</span>
        {children}
      </li>
      <li className="plan-notes" aria-live="polite" {...hover}>
        {notes}
      </li>
    </>
  );
}

function TimingPill({ assignment, assignments, aliasOf, edit }: { assignment: DraftAssignment; assignments: DraftAssignment[]; aliasOf: (id: string) => string; edit: Edit }) {
  const { snapshot } = useRoom();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));

  const names = (index: number) => (assignments[index]?.recipients ?? []).map((id) => `@${aliasOf(id)}`).join(" ");
  const external = assignment.schedule?.mode === "after_all" ? assignment.schedule.prerequisites : [];
  const externalLabels = external.map((p) => {
    const task = snapshot.tasks.find((t) => t.id === p.taskId);
    return task ? taskLabel(task) : p.taskId;
  });
  const waits = [...externalLabels, ...assignment.after.map((ref) => String(ref.index + 1))];
  const reasons = [
    ...externalLabels.map((label) => `waits for ${label}`),
    ...assignment.after.map(
      (ref) => `waits for ${ref.index + 1}: ${ref.because === "then" ? "follows 'then'" : ref.because === "after" ? `/after ${names(ref.index)}` : ref.because === "condition" ? `waits until ${names(ref.index)} finishes` : `names ${names(ref.index)}`}`,
    ),
  ];
  const unresolved = assignment.schedule === null;
  const held = assignment.schedule?.mode === "manual";
  const implicitWait = assignment.timing === null && assignment.after.length > 0;
  const isNow = !unresolved && !held && waits.length === 0;
  // Sending to someone who is mid-turn is fine: the task queues and starts when their current turn ends.
  const busy = assignment.recipients.filter(
    (id) =>
      snapshot.tasks.some((t) => t.participantId === id && (t.state === "dispatching" || t.state === "running" || t.state === "needs_input" || t.state === "queued")) ||
      Boolean(snapshot.participantStatus[id]?.externalActivity),
  );
  const steering = assignment.delivery === "steer";
  const queuedBehind = isNow && busy.length > 0 && !steering;
  const intoTurn = isNow && busy.length > 0 && steering;
  const label = unresolved
    ? assignment.timing === "after" ? "after ?" : "timing ?"
    : held ? "held" : waits.length > 0 ? `after ${waits.join(", ")}` : intoTurn ? "into turn" : queuedBehind ? "next" : "now";
  const title = unresolved
    ? "Timing is not resolved yet"
    : held
      ? "Held until you release it"
      : reasons.length > 0
        ? reasons.join("\n")
        : intoTurn
          ? `Sent to ${busy.map((id) => `@${aliasOf(id)}`).join(", ")} now, mid-turn. Cursor, Grok and OpenCode take it into the running turn (one reply answers both); Claude answers it in its own turn right after.`
          : queuedBehind
            ? `${busy.map((id) => `@${aliasOf(id)}`).join(", ")} ${busy.length === 1 ? "is" : "are"} working; this starts when the current turn ends`
            : steering
              ? "/steer: if the recipient is mid-turn when this is sent, it goes into that turn"
              : "Starts right away";
  const tone = unresolved ? "warn" : held ? "held" : waits.length > 0 ? "after" : intoTurn ? "steer" : "now";

  const choose = (timing: "now" | "hold" | "steer" | null) => {
    setOpen(false);
    edit((source) => setTiming(source, assignment, timing));
  };

  return (
    <span className="plan-timing" ref={wrapper}>
      <button type="button" className={`plan-pill mono tone-${tone}`} title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="menu menu-up menu-right" role="menu">
          {implicitWait ? (
            <button type="button" role="menuitem" onClick={() => choose("now")} title="Adds /now: start without waiting">
              Don't wait <span className="muted mono">/now</span>
            </button>
          ) : assignment.timing === "now" ? (
            <>
              <button type="button" role="menuitemradio" aria-checked="true" disabled>
                Now ✓
              </button>
              <button type="button" role="menuitem" onClick={() => choose(null)}>
                Default timing <span className="muted mono">remove /now</span>
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitemradio"
              aria-checked={isNow}
              disabled={isNow}
              onClick={() => choose(assignment.timing === "hold" || assignment.timing === "after" ? null : "now")}
              title={assignment.timing ? `Remove /${assignment.timing}` : "Start now"}
            >
              Now{isNow ? " ✓" : ""}
            </button>
          )}
          <button type="button" role="menuitemradio" aria-checked={held} disabled={held} onClick={() => choose("hold")} title="Adds /hold: saved until you release it">
            Hold{held ? " ✓" : ""} <span className="muted mono">/hold</span>
          </button>
          {queuedBehind || (steering && !held) ? (
            steering ? (
              <button type="button" role="menuitem" onClick={() => choose(null)} title="Removes /steer: wait for the current turn to end">
                Wait for the turn to end <span className="muted mono">remove /steer</span>
              </button>
            ) : (
              <button type="button" role="menuitem" onClick={() => choose("steer")} title="Adds /steer: the agent reads it mid-turn; one reply answers both (⌘/Ctrl+Enter does this for one send)">
                Send into the running turn <span className="muted mono">/steer</span>
              </button>
            )
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

function MentionAction({ mention, colorOf, label, action, onClick }: { mention: MentionSpan; colorOf: (id: string) => string; label: string; action: string; onClick: () => void }) {
  return (
    <span className="plan-action">
      <span className="identity mono" style={identityStyle(mention.participantId ? colorOf(mention.participantId) : "var(--fg-muted)")}>
        @{mention.alias}
      </span>{" "}
      {label} ·{" "}
      <button type="button" className="link-button" onClick={onClick}>
        {action}
      </button>
    </span>
  );
}

function CandidateOptions({ options, onPick }: { options: Array<{ key: string; label: string }>; onPick: (key: string) => void }) {
  return (
    <span className="plan-candidates">
      {options.map((option) => (
        <button key={option.key} type="button" className="small ghost mono" onClick={() => onPick(option.key)} title={option.label}>
          {truncate(option.label, 48)}
        </button>
      ))}
    </span>
  );
}

function IssueLine({ issues }: { issues: Unresolved[] }) {
  if (issues.length === 0) return null;
  return (
    <li className="plan-notes">
      {issues.map((u, i) => (
        <span key={i} className={u.severity === "error" ? "plan-error" : "plan-quiet"}>
          {u.message}
        </span>
      ))}
    </li>
  );
}

function crewSummary(draft: Draft): string {
  if (draft.kind === "participant.add") {
    if (!draft.add) return "Add a participant on a new thread";
    const base = `Add @${draft.add.alias} with T3's default model`;
    return draft.add.roleName ? `${base} as ${draft.add.roleName}` : base;
  }
  if (draft.kind === "participant.remove") return draft.participant ? `Remove @${draft.participant.alias}` : "Remove a crew member";
  if (!draft.participant || !draft.role) return "Change a crew member's role";
  return draft.role.roleId ? `Give @${draft.participant.alias} the role ${draft.role.name}` : `Remove @${draft.participant.alias}'s role`;
}

// ---- in-text highlighting (mirrored backdrop behind a transparent-text textarea) ----

interface Token {
  start: number;
  end: number;
  className: string;
  style?: CSSProperties;
}

const REF = String.raw`(?:(?:task|#)\d+|@[a-z0-9][a-z0-9_-]*)`;
const HEAD_DIRECTIVE = new RegExp(String.raw`\/(?:hold|now)\b|\/after\b(?:\s*${REF}(?:\s*,\s*${REF})*)?`, "gi");
const LEADING_COMMAND = /^\s*(\/(?:note|add|role|remove)\b)/i;

/**
 * The visible text of the composer. The textarea above it has transparent text and a visible caret, so this
 * layer must lay out identically: same font, size, line-height, padding, wrapping; highlights never change widths.
 */
function Highlights({
  text,
  draft,
  focus,
  typingAt,
  colorOf,
}: {
  text: string;
  draft: Draft | null;
  focus: number | null;
  typingAt: number | null;
  colorOf: (id: string) => string;
}) {
  const tokens: Token[] = [];
  const leading = LEADING_COMMAND.exec(text);
  if (leading) {
    const start = text.indexOf(leading[1] as string);
    tokens.push({ start, end: start + (leading[1] as string).length, className: "hl-directive" });
  }
  for (const m of draft?.mentions ?? []) {
    if (m.start === typingAt) continue;
    if (!m.participantId && m.role === "address" && m.alias.toLowerCase() === "all") tokens.push({ start: m.start, end: m.end, className: "hl-address hl-all" });
    else if (!m.participantId) tokens.push({ start: m.start, end: m.end, className: "hl-unknown" });
    else if (m.role === "address") tokens.push({ start: m.start, end: m.end, className: "hl-address", style: identityStyle(colorOf(m.participantId)) });
    else tokens.push({ start: m.start, end: m.end, className: "hl-reference" });
  }
  const assignments = draft?.kind === "task" ? draft.assignments : [];
  for (const a of assignments) {
    const head = text.slice(a.start, a.insertAt);
    for (const match of head.matchAll(HEAD_DIRECTIVE)) {
      const start = a.start + (match.index ?? 0);
      tokens.push({ start, end: start + match[0].length, className: "hl-directive" });
    }
  }
  tokens.sort((x, y) => x.start - y.start);

  const renderRange = (from: number, to: number): ReactNode[] => {
    const out: ReactNode[] = [];
    let cursor = from;
    for (const token of tokens) {
      if (token.start < cursor || token.start < from || token.end > to) continue;
      if (token.start > cursor) out.push(text.slice(cursor, token.start));
      out.push(
        <span key={token.start} className={`hl ${token.className}`} style={token.style}>
          {text.slice(token.start, token.end)}
        </span>,
      );
      cursor = token.end;
    }
    if (cursor < to) out.push(text.slice(cursor, to));
    return out;
  };

  const parts: ReactNode[] = [];
  let cursor = 0;
  const firstStart = assignments[0]?.start ?? text.length;
  if (draft?.kind === "task" && draft.preamble && firstStart > 0) {
    parts.push(
      <span key="preamble" className="hl-preamble">
        {renderRange(0, firstStart)}
      </span>,
    );
    cursor = firstStart;
  }
  const numbered = assignments.length >= 2;
  assignments.forEach((a, index) => {
    const start = Math.max(a.start, cursor);
    const end = Math.max(start, Math.min(a.end, text.length));
    if (start > cursor) parts.push(...renderRange(cursor, start));
    const color = a.recipients[0] ? colorOf(a.recipients[0]) : "var(--fg-dim)";
    parts.push(
      <span key={`a${index}`} className={`hl-assignment${focus === index ? " focus" : ""}`} style={identityStyle(color)}>
        {numbered ? <span className="hl-marker" data-n={index + 1} /> : null}
        {renderRange(start, end)}
      </span>,
    );
    cursor = end;
  });
  if (cursor < text.length) parts.push(...renderRange(cursor, text.length));
  // A trailing newline in a textarea still takes a line; keep the mirror the same height.
  parts.push("​");
  return <>{parts}</>;
}

// ---- helpers ----

function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void): void {
  const closer = useRef(close);
  closer.current = close;
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) closer.current();
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closer.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, ref]);
}

const truncate = (value: string, max: number): string => {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const formatBytes = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Placeholder examples rotate on each focus so the syntax is discoverable without crowding one line. */
const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

/** Room commands for the "/" menu. At the start of a message: all of them; right after an @name: the per-assignment ones. */
const ROOM_COMMANDS: Array<{ name: string; description: string; hint: string | null }> = [
  { name: "after", description: "Wait for tasks to finish first", hint: "task41 or @name" },
  { name: "hold", description: "Save for later; send when you release it", hint: null },
  { name: "now", description: "Start now, without waiting for anything", hint: null },
  { name: "steer", description: "If they are mid-turn, send into the running turn", hint: null },
  { name: "note", description: "Room note for everyone; no task", hint: "text" },
  { name: "add", description: "Seat a new participant on a new T3 thread", hint: "name [role <role>]" },
  { name: "role", description: "Give a participant a role (or none)", hint: "@name role" },
  { name: "remove", description: "Remove a participant from the room", hint: "@name" },
];
const ADDRESSED_ROOM_COMMANDS = ROOM_COMMANDS.filter((c) => ["after", "hold", "now", "steer"].includes(c.name));

/** Placeholder examples from the room's own participants and tasks (generic names only when the room is empty). */
function roomPlaceholders(aliases: string[], lastTask: number | null): string[] {
  const [a = "alice", b = aliases.length > 1 ? (aliases[1] as string) : "bob"] = aliases;
  const examples = [
    `@${a} fix the failing test. @${b} check ${a}'s fix`,
    aliases.length > 1 ? `@all review the diff  ·  @${a} do this @${b} do that` : `@${a} review the diff  ·  @${a} /steer also check the logs`,
    `@${a} /compact  ·  type / for the room's and ${a}'s commands`,
    lastTask ? `/after task${lastTask} @${b} review it  ·  /hold @${a} save this for later` : `/hold @${a} save this for later  ·  /note keep the public API`,
    `/add new-name role accountant  ·  /role @${a} none  ·  /remove @${b}`,
  ];
  return examples;
}
