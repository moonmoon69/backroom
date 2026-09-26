import { useState, type ReactNode } from "react";
import { useRoom } from "../context.tsx";
import type { ApprovalDecision, NativeRequest } from "../types.ts";
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

export function NativeRequestsPanel() {
  const { snapshot } = useRoom();
  if (snapshot.nativeRequests.length === 0) return null;
  return (
    <div className="native-requests" role="group" aria-label="Native requests">
      {snapshot.nativeRequests.map((request) =>
        request.kind === "approval" ? (
          <ApprovalCard key={`${request.threadId}:${request.requestId}`} request={request} />
        ) : (
          <UserInputCard key={`${request.threadId}:${request.requestId}`} request={request} />
        ),
      )}
    </div>
  );
}

function ApprovalCard({ request }: { request: NativeRequest }) {
  const { runCommand, aliasOf, colorOf } = useRoom();
  return (
    <ApprovalRequestCard
      payload={request.payload}
      speaker={
        <span className="speaker mono identity" style={identityStyle(colorOf(request.participantId))}>
          {aliasOf(request.participantId)}
        </span>
      }
      onRespond={async (decision) => {
        await runCommand({ type: "native.approval.respond", participantId: request.participantId, requestId: request.requestId, decision });
      }}
    />
  );
}

/** An approval T3 is waiting on, with T3's decisions. `speaker` names who asks; used by rooms and direct threads. */
export function ApprovalRequestCard({ payload: raw, speaker, onRespond }: { payload: unknown; speaker: ReactNode; onRespond: (decision: ApprovalDecision) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const payload = asRecord(raw);
  const requestType = asString(payload.requestType) ?? asString(payload.type) ?? "approval";
  const detail = asString(payload.detail) ?? asString(payload.summary) ?? asString(payload.command) ?? null;
  const respond = async (decision: ApprovalDecision) => {
    setBusy(true);
    try {
      await onRespond(decision);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="native-card">
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

function UserInputCard({ request }: { request: NativeRequest }) {
  const { runCommand, aliasOf, colorOf } = useRoom();
  return (
    <UserInputRequestCard
      requestId={request.requestId}
      payload={request.payload}
      speaker={
        <span className="speaker mono identity" style={identityStyle(colorOf(request.participantId))}>
          {aliasOf(request.participantId)}
        </span>
      }
      onSubmit={async (answers) => {
        await runCommand({ type: "native.userInput.respond", participantId: request.participantId, requestId: request.requestId, answers });
      }}
    />
  );
}

/** Questions T3 is waiting on (options, multi-select, custom answers). Used by rooms and direct threads. */
export function UserInputRequestCard({
  requestId,
  payload: raw,
  speaker,
  onSubmit,
}: {
  requestId: string;
  payload: unknown;
  speaker: ReactNode;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const payload = asRecord(raw);
  const questions = (Array.isArray(payload.questions) ? payload.questions : []) as Question[];
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});

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
    setBusy(true);
    try {
      await onSubmit(final);
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="native-card">
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
                <input type="radio" name={`${requestId}-${q.id}`} checked={answers[q.id] === label} onChange={() => setAnswer(q.id, label)} />
                {label}
              </label>
            );
          })}
          {q.allowCustomAnswer || (q.options ?? []).length === 0 ? (
            <label className="custom-answer">
              {!q.multiSelect && (q.options ?? []).length > 0 ? (
                <input
                  type="radio"
                  name={`${requestId}-${q.id}`}
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
      </div>
    </article>
  );
}
