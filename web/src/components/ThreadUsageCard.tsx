import { useEffect, useState } from "react";
import { api, useProviders } from "../api.ts";
import type { Desk, Participant, ThreadCost, UsageToday } from "../types.ts";
import { contextReadout, costReason, fmtTokens, money, timeOf } from "./deskFormat.ts";

/** One shared, minute-old copy of today's usage: T3 scans transcripts to answer, so every card reuses it. */
let usageCache: { at: number; value: Promise<UsageToday> } | null = null;
function usageToday(): Promise<UsageToday> {
  if (!usageCache || Date.now() - usageCache.at > 60_000) usageCache = { at: Date.now(), value: api.usageToday() };
  return usageCache.value;
}

const duration = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
};
const resetsIn = (iso: string | null): string => {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 ? `resets in ${duration(ms)}` : "resetting";
};

/**
 * Usage for one participant, from what T3 exposes: the thread's own numbers (context, tokens processed, subagents,
 * turns, files), today's usage for its model across all threads (T3 does not split cost by thread), and the
 * provider's plan limits.
 */
/**
 * What a thread used and what it is worth at list price, from its harness transcripts (own calls and subagents,
 * per model, with input and output tokens). Shown for a participant and for a thread used on its own.
 */
export function SpendSection({ cost, title = "Estimated spend · this thread", pricesFetchedAt }: { cost: ThreadCost | null; title?: string; pricesFetchedAt?: string | null }) {
  if (!cost) {
    return (
      <section>
        <h4 className="mono">{title}</h4>
        <div className="usage-line muted">
          <span>Reading transcripts…</span>
        </div>
      </section>
    );
  }
  if (!cost.available) {
    return (
      <section>
        <h4 className="mono">{title}</h4>
        <div className="usage-line muted">
          <span>No estimate: {costReason(cost.reason, cost.provider)}.</span>
        </div>
      </section>
    );
  }
  const input = (t: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }) => t.inputTokens + t.cachedInputTokens + t.cacheWriteTokens;
  const inputTitle = (t: { inputTokens: number; cachedInputTokens: number; cacheWriteTokens: number }) =>
    `input ${t.inputTokens.toLocaleString()} uncached · ${t.cachedInputTokens.toLocaleString()} from cache · ${t.cacheWriteTokens.toLocaleString()} written to cache`;
  const split = cost.subagents.calls > 0;
  return (
    <section>
      <h4 className="mono">{title}</h4>
      <div className="usage-line">
        <span>Total</span>
        <span className="mono">{cost.priced ? "≈ " : "at least "}{money(cost.total.costUsd)}</span>
      </div>
      {split ? (
        <div className="usage-line muted">
          <span>Own · subagents</span>
          <span className="mono">
            {money(cost.own.costUsd)} · {money(cost.subagents.costUsd)}
          </span>
        </div>
      ) : null}
      <table className="spend-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="num">In</th>
            <th className="num">Out</th>
            <th className="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          {cost.models.map((model) => (
            <tr key={model.model} title={`${model.calls} calls${model.subagents.calls > 0 ? ` · own ${money(model.own.costUsd)}, subagents ${money(model.subagents.costUsd)}` : ""}`}>
              <td className="mono spend-model">
                {model.model}
                {model.subagents.calls > 0 && model.own.calls === 0 ? <span className="muted"> (subagents)</span> : model.subagents.calls > 0 ? <span className="muted"> (+ subagents)</span> : null}
              </td>
              <td className="num mono" title={inputTitle(model)}>
                {fmtTokens(input(model))}
              </td>
              <td className="num mono">{fmtTokens(model.outputTokens)}</td>
              <td className="num mono">{model.priced ? money(model.costUsd) : "unpriced"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="usage-note muted" title={inputTitle(cost.total)}>
        {fmtTokens(input(cost.total))} in · {fmtTokens(cost.total.outputTokens)} out over {cost.total.calls.toLocaleString()} calls
        {cost.firstAt ? ` since ${new Date(cost.firstAt).toLocaleDateString()}` : ""}. List price from T3&rsquo;s table
        {pricesFetchedAt ? ` (${new Date(pricesFetchedAt).toLocaleDateString()})` : ""}, not what a subscription charges.
      </div>
    </section>
  );
}

export function ThreadUsageCard({ participant, desk, cost, pricesFetchedAt }: { participant: Participant; desk: Desk | null; cost?: ThreadCost | null; pricesFetchedAt?: string | null }) {
  const { providers } = useProviders(true, 60_000);
  const [usage, setUsage] = useState<UsageToday | null>(null);
  useEffect(() => {
    let live = true;
    usageToday()
      .then((value) => live && setUsage(value))
      .catch(() => live && setUsage(null));
    return () => {
      live = false;
    };
  }, []);

  const model = participant.modelSelection.model;
  const provider = providers?.find((p) => p.instanceId === participant.modelSelection.instanceId) ?? null;
  const buckets = usage?.buckets.filter((b) => b.model === model) ?? [];
  const today = buckets.reduce(
    (acc, b) => ({
      input: acc.input + b.totals.uncachedInputTokens + b.totals.cacheCreationTokens,
      cached: acc.cached + b.totals.cachedInputTokens,
      output: acc.output + b.totals.outputTokens,
      cost: acc.cost + b.costUsd,
      sessions: acc.sessions + b.sessions,
      priced: acc.priced || b.costSource !== "unpriced",
    }),
    { input: 0, cached: 0, output: 0, cost: 0, sessions: 0, priced: false },
  );
  const context = desk?.contextWindow ?? null;
  const subagents = desk?.subagents ?? [];
  const subagentTokens = subagents.reduce((sum, s) => sum + s.tokens, 0);
  const files = desk?.changedFiles ?? [];
  const additions = files.reduce((sum, f) => sum + f.additions, 0);
  const deletions = files.reduce((sum, f) => sum + f.deletions, 0);
  const lastCompaction = desk?.compactions?.[desk.compactions.length - 1] ?? null;

  return (
    <div className="usage-card" role="dialog" aria-label={`${participant.alias} usage`}>
      <section>
        <h4 className="mono">This thread</h4>
        {context ? (
          <>
            <div className="usage-line">
              <span>Context</span>
              <span className="mono">{contextReadout(context.usedTokens, context.maxTokens, context.percent)}</span>
            </div>
            <div className="usage-bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, context.percent)}%` }} />
            </div>
            {typeof context.totalProcessedTokens === "number" ? (
              <div className="usage-line muted">
                <span>Processed this session</span>
                <span className="mono">{fmtTokens(context.totalProcessedTokens)}</span>
              </div>
            ) : null}
          </>
        ) : (
          <div className="usage-line muted">
            <span>Context</span>
            <span className="mono">{desk?.contextReporting === false ? "not reported by this provider" : "no reading yet"}</span>
          </div>
        )}
        {lastCompaction ? (
          <div className="usage-line muted">
            <span>Last compaction</span>
            <span className="mono">
              {fmtTokens(lastCompaction.beforeTokens)} → {fmtTokens(lastCompaction.afterTokens)} · {timeOf(lastCompaction.at)}
            </span>
          </div>
        ) : null}
        {subagents.length > 0 ? (
          <div className="usage-line muted" title={subagents.map((s) => `${s.title}: ${fmtTokens(s.tokens)} tokens, ${s.toolUses} tool calls, ${duration(s.durationMs)}`).join("\n")}>
            <span>Subagents (recent)</span>
            <span className="mono">
              {subagents.length} · {fmtTokens(subagentTokens)} tokens
            </span>
          </div>
        ) : null}
        {files.length > 0 ? (
          <div className="usage-line muted">
            <span>Files changed (recent turns)</span>
            <span className="mono">
              {files.length} · <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
            </span>
          </div>
        ) : null}
      </section>

      <SpendSection cost={cost ?? null} pricesFetchedAt={pricesFetchedAt ?? null} />

      <section>
        <h4 className="mono">{model} today · all threads</h4>
        {!usage ? (
          <div className="usage-line muted">
            <span>Reading T3 usage…</span>
          </div>
        ) : !usage.available || buckets.length === 0 ? (
          <div className="usage-line muted">
            <span>No usage recorded for this model today</span>
          </div>
        ) : (
          <>
            <div className="usage-line">
              <span>Tokens</span>
              <span className="mono" title={`input ${today.input.toLocaleString()} · cached input ${today.cached.toLocaleString()} · output ${today.output.toLocaleString()}`}>
                {fmtTokens(today.input + today.cached)} in · {fmtTokens(today.output)} out
              </span>
            </div>
            <div className="usage-line">
              <span>API-equivalent cost</span>
              <span className="mono">{today.priced ? `≈ ${money(today.cost)}` : "unpriced"}</span>
            </div>
            <div className="usage-note muted">
              Across {today.sessions} session{today.sessions === 1 ? "" : "s"}. T3 does not split usage by thread, and this is list-price value, not what a subscription charges.
            </div>
          </>
        )}
      </section>

      {provider && provider.usageWindows.length > 0 ? (
        <section>
          <h4 className="mono">{provider.displayName} plan limits</h4>
          {provider.usageWindows.map((window) => (
            <div key={window.id}>
              <div className="usage-line">
                <span>{window.label}</span>
                <span className="mono">
                  {window.usedPercent === null ? "?" : `${Math.round(window.usedPercent)}%`}
                  <span className="muted"> {resetsIn(window.resetsAt)}</span>
                </span>
              </div>
              <div className={`usage-bar${(window.usedPercent ?? 0) >= 85 ? " hot" : ""}`} aria-hidden="true">
                <span style={{ width: `${Math.min(100, window.usedPercent ?? 0)}%` }} />
              </div>
            </div>
          ))}
        </section>
      ) : provider ? (
        <section>
          <h4 className="mono">{provider.displayName} plan limits</h4>
          <div className="usage-line muted">
            <span>Not reported by this provider</span>
          </div>
        </section>
      ) : null}
    </div>
  );
}
