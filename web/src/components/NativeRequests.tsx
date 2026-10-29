import { useCallback, useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRoom } from "../context.tsx";
import type { ApprovalDecision, NativeRequest, SecretAnswer, SecretAsk } from "../types.ts";
import { identityStyle } from "./Monogram.tsx";

interface Question {
  id: string;
  header?: string;
  question?: string;
  options?: Array<string | { label: string; description?: string }>;
  allowCustomAnswer?: boolean;
  multiSelect?: boolean;
}

const DECISIONS: Array<{ decision: ApprovalDecision; label: string; tone?: string }> = [
  { decision: "accept", label: "Accept", tone: "primary" },
  { decision: "acceptForSession", label: "Accept for session" },
  { decision: "acceptAlways", label: "Always accept" },
  { decision: "decline", label: "Decline", tone: "danger" },
  { decision: "cancel", label: "Cancel turn", tone: "danger" },
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

// A request drawn in two places at once (a status chip's choices and its turn's bubble, each with its action strip) is
// one request: what is chosen so far on a question, and whether it is being answered, are kept by request, so the two
// agree whichever is pressed.
const shared = new Map<string, unknown>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const NO_ANSWERS: Record<string, string | string[]> = {};
const NO_CUSTOM: Record<string, string> = {};

/** What a room keeps of its approvals, questions and secrets (above; never a secret's text) for those still waiting: the rest go (a thread's own stay). */
export function keepAnswers(waiting: ReadonlyArray<{ participantId: string; requestId: string }>): void {
  const keep = new Set(waiting.map((request) => `${request.participantId}:${request.requestId}`));
  for (const key of [...shared.keys()]) {
    const request = key.slice(key.indexOf(":") + 1);
    if (!request.startsWith(":") && !keep.has(request)) shared.delete(key);
  }
}

function useShared<T>(key: string, empty: T): [T, (update: (previous: T) => T) => void] {
  const read = useCallback(() => (shared.has(key) ? (shared.get(key) as T) : empty), [key, empty]);
  const value = useSyncExternalStore(subscribe, read);
  const set = useCallback(
    (update: (previous: T) => T) => {
      shared.set(key, update(read()));
      for (const listener of [...listeners]) listener();
    },
    [key, read],
  );
  return [value, set];
}

export function NativeRequestsPanel() {
  const { snapshot, aliasOf, colorOf } = useRoom();
  if (snapshot.nativeRequests.length === 0) return null;
  return (
    <div className="native-requests" role="group" aria-label="Native requests">
      {snapshot.nativeRequests.map((request) => (
        <NativeRequestCard
          key={`${request.threadId}:${request.requestId}`}
          request={request}
          speaker={
            <span className="speaker mono identity" style={identityStyle(colorOf(request.participantId))}>
              {aliasOf(request.participantId)}
            </span>
          }
        />
      ))}
    </div>
  );
}

/**
 * An approval, a question or a secret a member's T3 thread is waiting on, answered through the room: the one place a
 * room says how (its status chip's choices and its turn's bubble both draw it, and their action strips press its buttons).
 */
export function NativeRequestCard({ request, speaker }: { request: NativeRequest; speaker: ReactNode }) {
  const { runCommand } = useRoom();
  const { participantId, requestId } = request;
  if (request.kind === "secret") {
    return (
      <SecretRequestCard
        requestId={requestId}
        participantId={participantId}
        payload={request.payload}
        speaker={speaker}
        onAnswer={async (answer) => {
          await runCommand({ type: "native.secret.respond", participantId, requestId, answer });
        }}
      />
    );
  }
  return request.kind === "approval" ? (
    <ApprovalRequestCard
      requestId={requestId}
      participantId={participantId}
      payload={request.payload}
      speaker={speaker}
      onRespond={async (decision) => {
        await runCommand({ type: "native.approval.respond", participantId, requestId, decision });
      }}
    />
  ) : (
    <UserInputRequestCard
      requestId={requestId}
      participantId={participantId}
      payload={request.payload}
      speaker={speaker}
      onSubmit={async (answers) => {
        await runCommand({ type: "native.userInput.respond", participantId, requestId, answers });
      }}
      onDismiss={async () => {
        await runCommand({ type: "native.userInput.dismiss", participantId, requestId });
      }}
    />
  );
}

/** An approval T3 is waiting on, with T3's decisions. `speaker` names who asks; used by rooms and direct threads. */
export function ApprovalRequestCard({
  requestId,
  participantId,
  payload: raw,
  speaker,
  onRespond,
}: {
  /** Drawn in two places at once, the two are busy together. */
  requestId?: string;
  /** The member asking, on the card (`data-participant`): a status chip's strip offers its own member's choices. Each
   *  card says its request (`data-request`): a strip's buttons are its request's. */
  participantId?: string;
  payload: unknown;
  speaker: ReactNode;
  onRespond: (decision: ApprovalDecision) => Promise<void>;
}) {
  const own = useId();
  const [busy, setBusy] = useShared(`busy:${participantId ?? ""}:${requestId ?? own}`, false);
  const payload = asRecord(raw);
  const requestType = asString(payload.requestType) ?? asString(payload.type) ?? "approval";
  const detail = asString(payload.detail) ?? asString(payload.summary) ?? asString(payload.command) ?? null;
  const respond = async (decision: ApprovalDecision) => {
    setBusy(() => true);
    try {
      await onRespond(decision);
    } finally {
      setBusy(() => false);
    }
  };
  return (
    <article className="native-card" data-participant={participantId} data-request={requestId}>
      <header>
        {speaker}
        <span className="stamp stamp-needs_input">approval · {requestType}</span>
      </header>
      {detail ? <pre className="native-detail">{detail}</pre> : <pre className="native-detail">{JSON.stringify(payload, null, 2)}</pre>}
      <div className="task-actions">
        {DECISIONS.map((d) => (
          <button key={d.decision} type="button" className={`small ${d.tone ?? ""}`} disabled={busy} onClick={() => respond(d.decision)}>
            {d.label}
          </button>
        ))}
      </div>
    </article>
  );
}

/** Questions T3 is waiting on (options, multi-select, custom answers). Used by rooms and direct threads. */
export function UserInputRequestCard({
  requestId,
  participantId,
  payload: raw,
  speaker,
  onSubmit,
  onDismiss,
}: {
  requestId: string;
  /** The member asking, on the card (`data-participant`). */
  participantId?: string;
  payload: unknown;
  speaker: ReactNode;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
  /** Drop the question without answering it, where that can be done. */
  onDismiss?: () => Promise<void>;
}) {
  const key = `${participantId ?? ""}:${requestId}`;
  // Each card's options are a radio group of its own: one named by the request alone would be one group across the
  // places it is drawn (the status chip's choices and the turn's bubble), so checking an option in both would leave it
  // checked in only one of them.
  const group = useId();
  const [busy, setBusy] = useShared(`busy:${key}`, false);
  const payload = asRecord(raw);
  const questions = (Array.isArray(payload.questions) ? payload.questions : []) as Question[];
  const [answers, setAnswers] = useShared(`answers:${key}`, NO_ANSWERS);
  const [custom, setCustom] = useShared(`custom:${key}`, NO_CUSTOM);

  const optionLabel = (option: string | { label: string }): string => (typeof option === "string" ? option : option.label);

  const setAnswer = (id: string, value: string | string[]) => setAnswers((prev) => ({ ...prev, [id]: value }));
  const toggleMulti = (id: string, value: string, checked: boolean) => {
    const current = Array.isArray(answers[id]) ? (answers[id] as string[]) : [];
    setAnswer(id, checked ? [...current, value] : current.filter((v) => v !== value));
  };

  const complete = questions.every((q) => {
    const value = answers[q.id];
    if (Array.isArray(value)) return value.length > 0 || (custom[q.id] ?? "").trim().length > 0;
    if (typeof value === "string") return value === "__custom__" ? (custom[q.id] ?? "").trim().length > 0 : value.length > 0;
    return (custom[q.id] ?? "").trim().length > 0;
  });

  const submit = async () => {
    const final: Record<string, unknown> = {};
    for (const q of questions) {
      const value = answers[q.id];
      const customValue = (custom[q.id] ?? "").trim();
      if (Array.isArray(value)) final[q.id] = customValue ? [...value, customValue] : value;
      else if (value === "__custom__" || value === undefined) final[q.id] = customValue;
      else final[q.id] = value;
    }
    setBusy(() => true);
    try {
      await onSubmit(final);
    } finally {
      setBusy(() => false);
    }
  };

  return (
    <article className="native-card" data-participant={participantId} data-request={requestId}>
      <header>
        {speaker}
        <span className="stamp stamp-needs_input">user input</span>
      </header>
      {questions.length === 0 ? <pre className="native-detail">{JSON.stringify(payload, null, 2)}</pre> : null}
      {questions.map((q) => (
        <fieldset key={q.id} className="question">
          <legend>{q.header ?? q.id}</legend>
          {q.question ? <p>{q.question}</p> : null}
          {(q.options ?? []).map((option, index) => {
            const label = optionLabel(option);
            const inputId = `${requestId}-${q.id}-${index}`;
            if (q.multiSelect) {
              const checked = Array.isArray(answers[q.id]) && (answers[q.id] as string[]).includes(label);
              return (
                <label key={inputId} className="checkbox">
                  <input type="checkbox" checked={checked} onChange={(e) => toggleMulti(q.id, label, e.target.checked)} />
                  {label}
                </label>
              );
            }
            return (
              <label key={inputId} className="radio">
                <input type="radio" name={`${group}-${q.id}`} checked={answers[q.id] === label} onChange={() => setAnswer(q.id, label)} />
                {label}
              </label>
            );
          })}
          {q.allowCustomAnswer || (q.options ?? []).length === 0 ? (
            <label className="custom-answer">
              {!q.multiSelect && (q.options ?? []).length > 0 ? (
                <input
                  type="radio"
                  name={`${group}-${q.id}`}
                  checked={answers[q.id] === "__custom__"}
                  onChange={() => setAnswer(q.id, "__custom__")}
                />
              ) : null}
              <input
                type="text"
                placeholder="Custom answer"
                value={custom[q.id] ?? ""}
                onChange={(e) => {
                  setCustom((prev) => ({ ...prev, [q.id]: e.target.value }));
                  if (!q.multiSelect && (q.options ?? []).length > 0) setAnswer(q.id, "__custom__");
                }}
              />
            </label>
          ) : null}
        </fieldset>
      ))}
      <div className="task-actions">
        <button type="button" className="small primary" disabled={busy || !complete} onClick={submit}>
          Submit answers
        </button>
        {onDismiss ? (
          <button
            type="button"
            className="small ghost"
            disabled={busy}
            title="Drop the question without answering: the agent goes on, or ends its turn, without it"
            onClick={async () => {
              setBusy(() => true);
              try {
                await onDismiss();
              } finally {
                setBusy(() => false);
              }
            }}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </article>
  );
}

const asSecret = (value: unknown): SecretAsk => {
  const secret = asRecord(value);
  return {
    label: asString(secret.label) ?? "A secret",
    reason: asString(secret.reason) ?? "",
    placeholder: asString(secret.placeholder),
    delivery: secret.delivery === "file" ? "file" : null,
  };
};

/**
 * A secret T3 is waiting on (an agent's request_secret), in T3's words: what it is, why, a password field, Save securely
 * and Decline. Used by rooms and direct threads. What is typed stays in this card's own field, never in the shared state
 * above: it is cleared once sent, and goes with the card when the request ends or the view closes.
 */
export function SecretRequestCard({
  requestId,
  participantId,
  payload: raw,
  speaker,
  onAnswer,
}: {
  requestId: string;
  /** The member asking, on the card (`data-participant`). */
  participantId?: string;
  payload: unknown;
  speaker: ReactNode;
  onAnswer: (answer: SecretAnswer) => Promise<void>;
}) {
  const [busy, setBusy] = useShared(`busy:${participantId ?? ""}:${requestId}`, false);
  const [secret, setSecret] = useState("");
  // Each copy of the request drawn (the status chip's, the turn's bubble) keeps what is typed in it to itself; an answer
  // sent from any of them empties all of them, told by a count of the attempts, never by sharing the text.
  const [sent, markSent] = useShared(`sent:${participantId ?? ""}:${requestId}`, 0);
  useEffect(() => setSecret(""), [sent]);
  const field = useId();
  const reason = useId();
  const ask = asSecret(asRecord(raw).secret);
  const answer = async (value: SecretAnswer) => {
    if (busy) return;
    setBusy(() => true);
    markSent((count) => count + 1);
    try {
      await onAnswer(value);
    } finally {
      setBusy(() => false);
    }
  };
  return (
    <article className="native-card secret-card" data-participant={participantId} data-request={requestId}>
      <header>
        {speaker}
        <span className="stamp stamp-needs_input">asking for a secret</span>
      </header>
      <form
        className="secret-form"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          if (secret.trim().length > 0) void answer({ type: "save", secret });
        }}
      >
        <label className="secret-label" htmlFor={field}>
          {ask.label}
        </label>
        {ask.reason ? (
          <p className="secret-reason" id={reason}>
            {ask.reason}
          </p>
        ) : null}
        <div className="secret-row">
          <input
            id={field}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={ask.placeholder ?? ""}
            aria-describedby={ask.reason ? reason : undefined}
            value={secret}
            disabled={busy}
            onChange={(event) => setSecret(event.target.value)}
          />
          <button type="submit" className="small primary" disabled={busy || secret.trim().length === 0}>
            Save securely
          </button>
        </div>
        <div className="secret-foot">
          <span className="muted">Stored in T3, never shown to the agent</span>
          <button type="button" className="small ghost" disabled={busy} onClick={() => void answer({ type: "decline" })}>
            Decline
          </button>
        </div>
      </form>
    </article>
  );
}
