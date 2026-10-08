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
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { api, ApiError, attachmentUrl, useProviders } from "../api.ts";
import { COARSE_POINTER_QUERY, useMediaQuery } from "../useMediaQuery.ts";
import { useRoom } from "../context.tsx";
import { changeDraftImages, readDraftImages, useDraft } from "../drafts.ts";
import { roomKey } from "../news.ts";
import { parseDraft } from "../parser.ts";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_TOTAL_BYTES,
  ATTACHMENT_MIME_TYPES,
  isActiveParticipant,
  isRunActive,
  type Draft,
  type DraftAssignment,
  type MentionSpan,
  type Participant,
  type Unresolved,
} from "../types.ts";
import {
  insertMention,
  isNote,
  isSentenceStart,
  mentionToReference,
  replaceMention,
  setTiming,
  splitAtMention,
  timingFixes,
  toggleNote,
  type TextEdit,
} from "./composerText.ts";
import { ComposerStrip, useComposerOverlay } from "./composerOverlay.tsx";
import { identityStyle, Monogram } from "./Monogram.tsx";
import { RemoveParticipantDialog } from "./Crew.tsx";
import { ChevronIcon, CloseIcon, ImageIcon, NoteIcon } from "./icons.tsx";
import { useMenuFocus } from "../keys.ts";

interface Props {
  /** Look → Overview: closed to a strip until wanted, then over the conversation (composerOverlay.tsx). */
  overlay?: boolean;
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

/** The images kept with a room's draft: uploaded when they were attached, so the service has them by id. */
const keptAttachments = (roomId: string): PendingAttachment[] =>
  readDraftImages(roomKey(roomId)).map((kept) => ({ key: kept.id, name: kept.name, sizeBytes: kept.sizeBytes, status: "ready", id: kept.id, previewUrl: null, error: null }));

/** What the current draft would do, and whether it can be sent. */
interface Plan {
  ready: boolean;
  label: string;
  /** Why the button is disabled (tooltip). */
  reason: string | null;
}

type Edit = (make: (source: string) => TextEdit | null) => void;

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export function Composer({ overlay: asOverlay = false }: Props) {
  const { snapshot, runCommand, colorOf, aliasOf } = useRoom();
  const roomId = snapshot.room.id;
  const crew = useMemo(() => snapshot.participants.filter(isActiveParticipant), [snapshot.participants]);
  const consigliere = crew.find((p) => p.id === snapshot.room.consigliereId) ?? null;
  const { providers } = useProviders(true, 120_000);
  /** Examples built from this room's members, so every placeholder can be run as is. */
  const placeholders = useMemo(() => {
    // With a Consigliere the plain message is his; the other examples would teach the wrong habit.
    if (consigliere) return [`Message ${consigliere.alias}  ·  he hands the work to the others and reports back`, `@name tells ${consigliere.alias} who you want on it  ·  everything goes through him`];
    return roomPlaceholders(crew.map((p) => p.alias));
  }, [crew, consigliere]);
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

  // The unsent text is the room's draft: it outlives the composer, the page and a reload (drafts.ts).
  const [text, setText] = useDraft(roomKey(roomId));
  const textRef = useRef(text);
  textRef.current = text;
  const overlay = useComposerOverlay(asOverlay, textarea, text);
  // Its images are the draft's too: each is kept by its upload's id once uploaded, until sent or removed.
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => keptAttachments(roomId));
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;
  /** Attachments removed while uploading: their upload must not land in the draft after all. */
  const removedKeys = useRef(new Set<string>());
  const [submitting, setSubmitting] = useState(false);
  const [mention, setMention] = useState<MentionState | null>(null);
  /** "/" typed: the room's commands, plus the addressed members' T3 commands after an @name. */
  const [slashPick, setSlashPick] = useState<(MentionState & { recipients: string[]; atStart: boolean }) | null>(null);
  const [dragging, setDragging] = useState(false);
  const [focusAssignment, setFocusAssignment] = useState<number | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  // Parsed in the browser on every keystroke: the plan, the highlighting and D2's refusals (/after, /hold and implied
  // waits are gone) always match the text exactly, before anything is sent.
  const { participants, participantStatus } = snapshot;
  const consigliereId = snapshot.room.consigliereId;
  const parsedDraft = useMemo(
    () => (text.trim().length === 0 ? null : parseDraft(text, { participants, participantStatus, room: { consigliereId } })),
    [text, participants, participantStatus, consigliereId],
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

  // Reset when switching rooms (the text and the images follow the room: they are that room's draft).
  useEffect(() => {
    setMention(null);
    setFocusAssignment(null);
    for (const item of attachmentsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setAttachments(keptAttachments(roomId));
  }, [roomId]);

  const { reveal } = overlay;
  const applyEdit = useCallback((edit: TextEdit) => {
    setText(edit.text);
    setMention(null);
    reveal();
    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(edit.caret, edit.caret);
    });
  }, [setText, reveal]);

  const edit: Edit = (make) => {
    const result = make(text);
    if (result) applyEdit(result);
  };

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
        const scope = roomKey(roomId);
        api
          .uploadAttachment(roomId, file)
          .then((stored) => {
            setAttachments((current) => current.map((a) => (a.key === key ? { ...a, status: "ready", id: stored.id } : a)));
            if (!removedKeys.current.has(key)) changeDraftImages(scope, (kept) => [...kept.filter((k) => k.id !== stored.id), { id: stored.id, name: base.name, sizeBytes: base.sizeBytes }]);
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
    removedKeys.current.add(key);
    setAttachments((list) => list.filter((a) => a.key !== key));
    if (item?.id) changeDraftImages(roomKey(roomId), (kept) => kept.filter((k) => k.id !== item.id));
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
      const named = aliases.includes("all") ? crew.map((p) => p.id) : crew.filter((p) => aliases.includes(p.alias.toLowerCase())).map((p) => p.id);
      const atStart = /(^|\n)\s*$/.test(before.slice(0, start));
      // A room with one participant needs no @name, so its T3 commands are offered at the start too.
      const recipients = named.length === 0 && atStart && crew.length === 1 ? [(crew[0] as Participant).id] : named;
      if (recipients.length > 0 || atStart) setSlashPick({ start, query: (slash[2] ?? "").toLowerCase(), index: 0, recipients, atStart });
      else setSlashPick(null);
    } else {
      setSlashPick(null);
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

  const slashMatches = useMemo(() => {
    if (!slashPick) return [];
    const room = (slashPick.atStart ? ROOM_COMMANDS : ADDRESSED_ROOM_COMMANDS).map((c) => ({ ...c, group: "room" as const }));
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

  const acceptMention = (alias: string) => {
    if (!mention) return;
    const caret = textarea.current?.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${alias} ${text.slice(caret)}`;
    applyEdit({ text: next, caret: mention.start + alias.length + 2 });
  };

  const insertMentionAtCaret = (alias: string) => {
    applyEdit(insertMention(text, textarea.current?.selectionStart ?? text.length, alias));
  };

  // ---- plan + submit ----

  const crewDraft = draft && (draft.kind === "participant.add" || draft.kind === "participant.remove") ? draft : null;
  const noteOn = isNote(text);
  const plan = evaluate(draft, readyIds.length, uploading, attachedCount);
  const canSubmit = plan.ready && !submitting;
  const assignmentCount = draft?.kind === "task" ? draft.assignments.length : 0;

  /** Participants mid-turn (a room run, or a turn in T3): a plain send waits for them; /steer goes into the turn. */
  const isBusy = (id: string): boolean => {
    const status = snapshot.participantStatus[id];
    return Boolean(status && (status.activeRunId !== null || status.externalActivity || isRunActive(status.status)));
  };

  /**
   * The message's own ID (message.create's clientMessageId): kept while the same message (text and images) is sent
   * again (a send that failed on the way, a second click), so the service records it once; another message gets a new one.
   */
  const messageId = useRef<{ key: string; id: string } | null>(null);

  const submit = async () => {
    if (!draft || submitting || !evaluate(draft, readyIds.length, uploading, attachedCount).ready) return;
    if (draft.kind === "participant.remove") {
      if (draft.participant) setRemoveTarget(draft.participant.participantId);
      return;
    }
    setSubmitting(true);
    try {
      const result =
        draft.kind === "participant.add" && draft.add
          ? await runCommand({ type: "participant.create", roomId, alias: draft.add.alias, thread: { mode: "create" } })
          : draft.kind === "note"
              ? await runCommand({ type: "room.note.create", roomId, text: draft.instruction })
              : draft.kind === "task"
                ? await runCommand({
                    type: "message.create",
                    roomId,
                    sourceText: text,
                    preamble: draft.preamble,
                    clientMessageId: (messageId.current = messageId.current?.key === JSON.stringify([text, readyIds]) ? messageId.current : { key: JSON.stringify([text, readyIds]), id: newMessageId() }).id,
                    attachmentIds: readyIds,
                    assignments: draft.assignments.map((a) => ({
                      recipients: a.recipients,
                      instruction: a.instruction,
                      slashCommand: Boolean(a.slashCommand),
                      // Steering is a property of the message (/steer, or the plan row's choice), not of the key pressed.
                      delivery: a.delivery === "steer" ? ("steer" as const) : ("queue" as const),
                    })),
                  })
                : null;
      if (result) {
        messageId.current = null;
        setText("");
        setMention(null);
        setFocusAssignment(null);
        for (const item of attachmentsRef.current) removedKeys.current.add(item.key);
        clearAttachments();
        changeDraftImages(roomKey(roomId), () => []);
        if (overlay.enabled) overlay.hide();
        else textarea.current?.focus();
      }
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * A mention of a participant (or @all) is one token: Backspace right after it, or Delete right before it, removes the
   * whole "@alias" (and a doubled space left behind). Partly typed or unknown names still delete one letter at a time.
   * The browser's own delete is used so ⌘/Ctrl+Z brings the mention back.
   */
  const deleteWholeMention = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((event.key !== "Backspace" && event.key !== "Delete") || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return false;
    const el = event.currentTarget;
    if (el.selectionStart !== el.selectionEnd || !draft || draft.kind !== "task") return false;
    const caret = el.selectionStart;
    const span = draft.mentions.find(
      (m) => (m.participantId !== null || m.alias.toLowerCase() === "all") && (event.key === "Backspace" ? m.end === caret : m.start === caret),
    );
    if (!span) return false;
    let start = span.start;
    let end = span.end;
    if (text[start - 1] === " " && text[end] === " ") end += 1;
    else if (start > 0 && text[start - 1] === " " && (end === text.length || text[end] === "\n")) start -= 1;
    event.preventDefault();
    el.setSelectionRange(start, end);
    if (!document.execCommand("delete")) applyEdit({ text: text.slice(0, start) + text.slice(end), caret: start });
    return true;
  };

  const touchKeyboard = useMediaQuery(COARSE_POINTER_QUERY);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // In the overlay Escape belongs to the composer (a menu first, then closing it), never to the room around it.
    if (event.key === "Escape" && overlay.enabled) event.stopPropagation();
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
    if (deleteWholeMention(event)) {
      setMention(null);
      return;
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
    if (overlay.fieldKey(event)) return;
    // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an IME is composing (e.g. Chinese or Japanese input).
    // On touch devices the on-screen keyboard's Enter is a newline and the Send button sends.
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !touchKeyboard && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submit();
    }
  };

  const showPlan = text.trim().length > 0 || attachments.length > 0;
  // Someone addressed (without /steer) is mid-turn: say that the message waits for the turn, and how to steer instead.
  const busyAddressed =
    draft?.kind === "task"
      ? [...new Set(draft.assignments.filter((a) => a.delivery !== "steer" && !a.slashCommand).flatMap((a) => a.recipients.filter(isBusy)))]
      : [];

  // The strip says who a message goes to: whoever the draft addresses, else who a plain message reaches.
  const addressed = draft?.kind === "task" ? [...new Set(draft.assignments.flatMap((a) => a.recipients))] : [];
  const plainTo = consigliere ?? (crew.length === 1 ? (crew[0] as Participant) : null);
  const stripTo =
    draft?.kind === "note" || noteOn ? (
      <span className="mono">note for the room</span>
    ) : crewDraft ? (
      <span className="mono">{crewSummary(crewDraft)}</span>
    ) : addressed.length > 0 || plainTo ? (
      <>
        to{" "}
        {(addressed.length > 0 ? addressed : [(plainTo as Participant).id]).map((id) => (
          <span key={id} className="identity mono strip-recipient">
            @{aliasOf(id)}
            {isBusy(id) ? <span className="dot dot-working" aria-label="working" /> : null}
          </span>
        ))}
      </>
    ) : (
      <span className="muted">start with @name to address someone</span>
    );
  // What the strip says about the room: requests still open, and members with posts they have not been given yet.
  const openRequests = snapshot.counts.openRequests;
  const waiting = snapshot.counts.waiting;
  const stripFacts = [
    openRequests > 0 ? `${openRequests} open request${openRequests === 1 ? "" : "s"}` : "nothing open",
    ...(waiting > 0 ? [`${waiting} waiting`] : []),
    ...(attachedCount > 0 ? [`${attachedCount} image${attachedCount === 1 ? "" : "s"}`] : []),
  ];

  const composer = (
    <div
      ref={overlay.panel}
      className={`composer${overlay.enabled ? " composer-overlay" : ""}${dragging ? " dragging" : ""}`}
      aria-label="Composer"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onWheel={overlay.enabled ? overlay.onWheel : undefined}
    >
      {/* Who it goes to, on the overlay's frame (drawn in the pixel look only). */}
      {overlay.enabled ? <span className="composer-nameplate">{stripTo}</span> : null}
      {crew.length > 0 ? (
        <MentionChips
          crew={crew}
          addressed={new Set(draft?.kind === "task" ? draft.assignments.flatMap((a) => a.recipients) : [])}
          allAddressed={draft?.kind === "task" && /(^|\s)@all\b/i.test(text)}
          isBusy={isBusy}
          colorOf={colorOf}
          onPick={insertMentionAtCaret}
        />
      ) : null}
      <div className="composer-text">
        <div className="composer-field">
          <div className={`composer-backdrop${focusAssignment !== null ? " focusing" : ""}`} ref={backdrop} aria-hidden="true">
            <Highlights text={text} draft={draft} focus={focusAssignment} typingAt={mention?.start ?? null} colorOf={colorOf} />
          </div>
          <textarea
            ref={textarea}
            value={text}
            rows={overlay.enabled ? 1 : 3}
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
        {mention && mentionMatches.length > 0 ? (
          <ul className="mention-menu" role="listbox" aria-label="Mention a member">
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
                <CloseIcon small />
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
        <button
          type="button"
          className="composer-tool"
          onClick={() => fileInput.current?.click()}
          aria-label="Attach images"
          title="Attach images: PNG, JPEG, GIF or WebP (or paste or drop them here)"
        >
          <ImageIcon />
          <span className="composer-tool-label">Image</span>
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
          className={`composer-tool note-button${noteOn ? " active" : ""}`}
          aria-pressed={noteOn}
          aria-label="Room note"
          title="Room note: shared context for everyone, no member is invoked"
          onClick={() => applyEdit(toggleNote(text))}
        >
          <NoteIcon />
          <span className="composer-tool-label">Note</span>
        </button>
        <span className="spacer" />
        {/* Keys mean nothing on a touch screen; there the keys hint is hidden (styles.css), the waiting note is not. */}
        {busyAddressed.length > 0 ? (
          <span className="muted hint mono composer-hint">
            Waits for {busyAddressed.map((id) => `@${aliasOf(id)}`).join(", ")} to finish · add /steer to send into the running turn
          </span>
        ) : (
          <span className="muted hint mono composer-hint composer-keys">{overlay.enabled ? "Enter to send · Shift+Enter new line · Esc to close" : "Enter to send · Shift+Enter new line"}</span>
        )}
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
  if (!overlay.enabled) return composer;
  return (
    <>
      <ComposerStrip
        overlay={overlay}
        to={stripTo}
        facts={stripFacts}
        draft={text}
        images={attachedCount}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(event) => {
          onDrop(event);
          overlay.reveal();
        }}
      />
      {overlay.open ? composer : null}
    </>
  );
}

/** Whether the draft can be sent and what the button says. Incomplete drafts just disable the button. */
function evaluate(draft: Draft | null, readyImages: number, uploading: boolean, attached: number): Plan {
  const blocked = (label: string, reason: string | null): Plan => ({ ready: false, label, reason });
  if (!draft || draft.kind === "empty") return blocked("Send", attached > 0 ? "Address someone with @name" : null);
  if (draft.kind === "participant.add") return draft.add && draft.unresolved.length === 0 ? { ready: true, label: "Add", reason: null } : blocked("Add", firstMessage(draft.unresolved));
  if (draft.kind === "participant.remove") return draft.participant ? { ready: true, label: "Remove…", reason: null } : blocked("Remove…", firstMessage(draft.unresolved));
  if (draft.kind === "note") {
    if (attached > 0) return blocked("Post note", "Notes cannot carry images");
    return draft.instruction.length > 0 ? { ready: true, label: "Post note", reason: null } : blocked("Post note", "Write the note");
  }
  const { assignments } = draft;
  const count = assignments.reduce((sum, a) => sum + a.recipients.length, 0);
  const label = `Send${count > 1 ? ` ${count}` : ""}`;
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
            {body ? truncate(body, 160) : <span className="plan-placeholder">shared context for the room; nobody is invoked</span>}
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
                assignment.recipients.map((id) => (
                  <span key={id} className="identity plan-recipient" style={identityStyle(colorOf(id))}>
                    <Monogram participant={{ id, alias: aliasOf(id) }} size="xs" />@{aliasOf(id)}
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
            <TimingPill assignment={assignment} aliasOf={aliasOf} edit={edit} />
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

/**
 * When an assignment starts, decision D2: "now", or "next" when a recipient is mid-turn (it starts when that turn
 * ends). Nothing waits on other work, so there is no third answer. A busy recipient can instead be sent into its
 * running turn (/steer), which is "now" too.
 */
function TimingPill({ assignment, aliasOf, edit }: { assignment: DraftAssignment; aliasOf: (id: string) => string; edit: Edit }) {
  const { snapshot } = useRoom();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLSpanElement>(null);
  useDismiss(wrapper, open, () => setOpen(false));
  useMenuFocus(wrapper, open, () => setOpen(false));

  const busy = assignment.recipients.filter((id) => {
    const status = snapshot.participantStatus[id];
    return Boolean(status && (status.activeRunId !== null || status.externalActivity || isRunActive(status.status)));
  });
  const steering = assignment.delivery === "steer";
  // A slash command never goes into a running turn: to a busy member it is next too.
  const next = busy.length > 0 && !steering;
  const label = next ? "next" : "now";
  const who = busy.map((id) => `@${aliasOf(id)}`).join(", ");
  const title = next
    ? `${who} ${busy.length === 1 ? "is" : "are"} working; this starts when the current turn ends`
    : steering && busy.length > 0
      ? `Sent to ${who} now, mid-turn. Cursor, Grok and OpenCode take it into the running turn (one reply answers both); Claude answers it in its own turn right after.`
      : steering
        ? "/steer: if the recipient is mid-turn when this is sent, it goes into that turn"
        : "Starts right away";

  const choose = (timing: "now" | "steer" | null) => {
    setOpen(false);
    edit((source) => setTiming(source, assignment, timing));
  };
  const offerSteer = busy.length > 0 && !assignment.slashCommand;
  // The fixes for what D2 refuses: a retired /hold or /after is removed; a wait the text implies is overridden by /now.
  const { remove: retired, sendNow: implied } = timingFixes(assignment);
  const menu = offerSteer || steering || retired !== null || implied;

  return (
    <span className="plan-timing" ref={wrapper}>
      <button type="button" className={`plan-pill mono tone-${retired || implied ? "warn" : next ? "next" : steering ? "steer" : "now"}`} title={title} aria-haspopup={menu ? "menu" : undefined} aria-expanded={open} onClick={() => setOpen((v) => !v)} disabled={!menu}>
        {label}
        {menu ? <ChevronIcon dir="down" small /> : null}
      </button>
      {open && menu ? (
        <div className="menu menu-up menu-right" role="menu">
          {retired ? (
            <button type="button" role="menuitem" onClick={() => choose(null)} title={`/${retired} is gone: nothing waits on other work`}>
              Remove /{retired}
            </button>
          ) : null}
          {implied ? (
            <button type="button" role="menuitem" onClick={() => choose("now")} title="Adds /now: send it now instead of after the work it names">
              Send it now <span className="muted mono">/now</span>
            </button>
          ) : null}
          {!offerSteer && !steering ? null : steering ? (
            <button type="button" role="menuitem" onClick={() => choose(null)} title="Removes /steer: wait for the current turn to end">
              Wait for the turn to end <span className="muted mono">remove /steer</span>
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => choose("steer")} title="Adds /steer: sent now, mid-turn. Cursor, Grok and OpenCode take it into the running turn; Claude answers it in its own turn right after">
              Send into the running turn <span className="muted mono">/steer</span>
            </button>
          )}
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
    if (!draft.add) return "Add a member on a new thread";
    return `Add @${draft.add.alias} with T3's default model`;
  }
  return draft.participant ? `Remove @${draft.participant.alias}` : "Remove a crew member";
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

/**
 * Room commands for the "/" menu. At the start of a message: all of them; right after an @name: the per-assignment
 * ones. /after and /hold are gone (D2): nothing waits on other work.
 */
const ROOM_COMMANDS: Array<{ name: string; description: string; hint: string | null }> = [
  { name: "now", description: "Start now", hint: null },
  { name: "steer", description: "If they are mid-turn, send into the running turn", hint: null },
  { name: "note", description: "Room note for everyone; nobody is woken", hint: "text" },
  { name: "add", description: "Seat a new member on a new T3 thread", hint: "name" },
  { name: "remove", description: "Remove a member from the room", hint: "@name" },
];
const ADDRESSED_ROOM_COMMANDS = ROOM_COMMANDS.filter((c) => ["now", "steer"].includes(c.name));

/** Placeholder examples from the room's own participants (generic names only when the room is empty). */
function roomPlaceholders(aliases: string[]): string[] {
  const [a = "alice", b = aliases.length > 1 ? (aliases[1] as string) : "bob"] = aliases;
  if (aliases.length === 1) {
    // One participant: every message is for them, so the examples need no @name.
    return [
      `review the diff  ·  with one member here, no @${a} needed`,
      `/steer also check the logs  ·  /note keep the public API`,
      `/compact  ·  type / for the room's and ${a}'s commands`,
      `/add new-name  ·  /remove @${a}`,
    ];
  }
  return [
    `@${a} fix the failing test  ·  @${b} review the open pull request`,
    aliases.length > 1 ? `@all review the diff  ·  @${a} do this @${b} do that` : `@${a} review the diff  ·  @${a} /steer also check the logs`,
    `@${a} /compact  ·  type / for the room's and ${a}'s commands`,
    `/note keep the public API  ·  @${a} /steer also check the logs`,
    `/add new-name  ·  /remove @${b}`,
  ];
}

/** A v4 UUID for a message. crypto.randomUUID exists only on secure origins; the page may be served over plain HTTP. */
function newMessageId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The room's participants above the text field: a click inserts "@alias " at the caret (or starts the message with
 * it). Chips already addressed by the draft are marked; a dot marks participants mid-turn.
 */
function MentionChips({
  crew,
  addressed,
  allAddressed,
  isBusy,
  colorOf,
  onPick,
}: {
  crew: Participant[];
  addressed: Set<string>;
  allAddressed: boolean;
  isBusy: (id: string) => boolean;
  colorOf: (id: string) => string;
  onPick: (alias: string) => void;
}) {
  // mousedown keeps the textarea focused and its caret where it was.
  const keepFocus = (event: ReactMouseEvent) => event.preventDefault();
  return (
    <div className="mention-chips" role="toolbar" aria-label="Mention a member">
      {crew.length > 1 ? (
        <button
          type="button"
          className={`mention-chip mention-chip-all${allAddressed ? " on" : ""}`}
          onMouseDown={keepFocus}
          onClick={() => onPick("all")}
          title={`Insert @all: everyone in the room (${crew.length})`}
        >
          @all
        </button>
      ) : null}
      {crew.map((p) => {
        const on = allAddressed || addressed.has(p.id);
        return (
          <button
            key={p.id}
            type="button"
            className={`mention-chip${on ? " on" : ""}`}
            style={identityStyle(colorOf(p.id))}
            onMouseDown={keepFocus}
            onClick={() => onPick(p.alias)}
            title={`Insert @${p.alias} (${p.modelSelection.model})${isBusy(p.id) ? " · working now" : ""}`}
          >
            <Monogram participant={p} size="xs" />
            <span className="identity">@{p.alias}</span>
            {isBusy(p.id) ? <span className="dot dot-working" aria-label="working" /> : null}
          </button>
        );
      })}
    </div>
  );
}
