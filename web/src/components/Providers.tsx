import { useProviders } from "../api.ts";
import type { ProviderInfo, UsageWindow } from "../types.ts";
import { meterTone, resetsIn, timeOf } from "./deskFormat.ts";

/** Tiny usage meter: "Weekly 61%" with the reset time as a tooltip. */
export function UsageMeter({ window }: { window: UsageWindow }) {
  const percent = window.usedPercent;
  const tone = percent === null ? "unknown" : meterTone(percent);
  const reset = resetsIn(window.resetsAt);
  const title = `${window.label} ${percent === null ? "unknown" : `${Math.round(percent)}% used`}${reset ? ` · ${reset}` : ""}`;
  return (
    <span className={`usage-meter meter-${tone}`} title={title} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-label={title}>
      <span className="usage-label mono">{window.label}</span>
      <span className="meter-bar">
        <span className="meter-fill" style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
      </span>
      <span className="usage-pct mono">{percent === null ? "—" : `${Math.round(percent)}%`}</span>
    </span>
  );
}

/** Compact provider line for a picker group header: "Claude Max Subscription · ready" plus usage meters. */
export function ProviderLine({ provider }: { provider: ProviderInfo }) {
  const status = provider.enabled ? provider.status : "disabled";
  return (
    <span className={`provider-line status-${status}`}>
      <span className="provider-auth">{provider.authLabel ?? provider.authStatus}</span>
      <span className="muted"> · {status}</span>
      {provider.usageWindows.map((window) => (
        <UsageMeter key={window.id} window={window} />
      ))}
    </span>
  );
}

/** Full provider list for the connection dialog. Polls every 60s while mounted. */
export function ProvidersSection() {
  const { providers, error } = useProviders(true);
  return (
    <section className="providers-section" aria-label="Providers">
      <h3 className="label">Providers</h3>
      {error ? <p className="status-error">{error}</p> : null}
      {!providers && !error ? <p className="muted mono">loading providers…</p> : null}
      {providers ? (
        <ul className="provider-list">
          {providers.map((provider) => (
            <li key={provider.instanceId} className={`provider-card${provider.enabled ? "" : " disabled"}`}>
              <div className="provider-head">
                <span className="provider-name">{provider.displayName}</span>
                <span className={`pill pill-status status-${provider.enabled ? provider.status : "disabled"}`}>{provider.enabled ? provider.status : "disabled"}</span>
                {provider.version ? <span className="mono dim">v{provider.version}</span> : null}
                <span className="spacer" />
                <span className="mono muted">{provider.instanceId}</span>
              </div>
              <div className="provider-meta">
                <span className="mono">{provider.authLabel ?? provider.authStatus}</span>
                {provider.message ? <span className="muted"> · {provider.message}</span> : null}
              </div>
              {provider.usageWindows.length > 0 ? (
                <div className="provider-usage">
                  {provider.usageWindows.map((window) => (
                    <UsageMeter key={window.id} window={window} />
                  ))}
                  {provider.usageCheckedAt ? <span className="muted mono checked-at">checked {timeOf(provider.usageCheckedAt)}</span> : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
