import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api.ts";
import { useToast } from "./Toast.tsx";
import type { StatusResponse } from "../types.ts";

interface Props {
  status: StatusResponse | null;
  onPaired: () => void;
  /** Rendered inside a dialog: skip the outer panel chrome. */
  embedded?: boolean;
}

const hostOf = (baseUrl: string | null): string => {
  if (!baseUrl) return "no host";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

/** Header chip for the T3 connection: dot + "T3" (plus the problem, if any); host, version and policy on hover. */
export function ConnectionChip({ status, onOpen }: { status: StatusResponse | null; onOpen: () => void }) {
  if (!status) {
    return (
      <button type="button" className="small ghost connection-chip" onClick={onOpen} title="Connecting to the room service…">
        <span className="dot dot-unknown" aria-hidden="true" />
        T3
      </button>
    );
  }
  const { adapter, t3 } = status;
  const tone = t3.error ? "err" : t3.paired ? "ok" : "warn";
  const detail = [
    `T3 ${hostOf(t3.baseUrl)}${t3.environment?.serverVersion ? ` · v${t3.environment.serverVersion}` : ""}`,
    `adapter: ${adapter}`,
    t3.paired ? "paired" : "not paired",
    t3.auth ? `policy: ${t3.auth.policy}` : null,
    t3.error ? `last error: ${t3.error}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const problem = t3.error ? "error" : t3.paired ? null : "not paired";
  return (
    <button type="button" className="small ghost connection-chip" onClick={onOpen} title={detail} aria-label={`T3 connection: ${detail}`}>
      <span className={`dot dot-${tone}`} aria-hidden="true" />
      T3{adapter === "fake" ? " (demo)" : ""}
      {problem ? <span className={tone === "err" ? "status-error" : "muted"}> · {problem}</span> : null}
    </button>
  );
}

export function PairingPanel({ status, onPaired, embedded }: Props) {
  const { toast } = useToast();
  const [pairingUrl, setPairingUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const policy = status?.t3.auth?.policy ?? null;
  const loopbackOnly = policy === "desktop-managed-local";
  const fake = status?.adapter === "fake";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!pairingUrl.trim()) return;
    setBusy(true);
    try {
      const result = await api.pair(pairingUrl.trim());
      toast(`Paired with T3 (scope ${result.scope})`, "success");
      setPairingUrl("");
      onPaired();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`pairing-panel${embedded ? " embedded" : ""}`} aria-label="Pair with T3 Code">
      {!embedded ? <h2 className="serif">Pair with T3 Code</h2> : null}
      {status ? (
        <dl className="kv">
          <dt>Adapter</dt>
          <dd>{status.adapter}</dd>
          <dt>Paired</dt>
          <dd>{status.t3.paired ? "yes" : "no"}</dd>
          <dt>Base URL</dt>
          <dd>{status.t3.baseUrl ? <code>{status.t3.baseUrl}</code> : <span className="muted">unset</span>}</dd>
          {status.t3.environment ? (
            <>
              <dt>Server</dt>
              <dd>
                {status.t3.environment.label} · v{status.t3.environment.serverVersion}
              </dd>
            </>
          ) : null}
          {status.t3.auth ? (
            <>
              <dt>Policy</dt>
              <dd>{status.t3.auth.policy}</dd>
            </>
          ) : null}
          {status.t3.error ? (
            <>
              <dt>Last error</dt>
              <dd className="status-error">{status.t3.error}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      <p>
        In T3 Code open <strong>Settings → Connections</strong>, enable <strong>Network access</strong>, create a
        pairing link, and paste it here.
      </p>
      <p className="muted">
        A Desktop app bound to loopback only (policy <code>desktop-managed-local</code>) cannot issue pairing links
        until Network access is enabled.
        {loopbackOnly ? " The connected server currently reports this policy." : ""}
      </p>
      {fake ? <p className="muted">The fake adapter is active; pairing is not available in demo mode.</p> : null}
      <form onSubmit={submit} className="row">
        <input
          type="text"
          placeholder="Paste the pairing link (t3code://… or https://…)"
          value={pairingUrl}
          onChange={(event) => setPairingUrl(event.target.value)}
          aria-label="Pairing link"
          autoComplete="off"
        />
        <button type="submit" className="primary" disabled={busy || pairingUrl.trim().length === 0}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </section>
  );
}
