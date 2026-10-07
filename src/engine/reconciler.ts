import { z } from "zod";
import { EngineStore } from "./store.ts";
import { activeStatus, hash, terminalStatus } from "./provider.ts";
import type { CommandEvidence, NativeToolSource, ProviderAdapter, ProviderContract, ProviderEmission, ProviderSnapshot } from "./provider.ts";
import { canonicalJSON, exactAlias, sourceKey, sourceIdentity, sourceContradiction, resultDigest, ordinaryOutcomeCoherent, toolClosure } from "./result.ts";
import { originalNativeEvidence, originalNativeSourceMatches, validateOperationSource, localReceipts } from "./operations.ts";
import { declarationContradictions } from "./declared.ts";
import type { Command, Control, FrozenTransport, ProviderHold, Run, TransportTarget } from "./types.ts";

const responseSchema = z.union([
  z.object({ answers: z.record(z.string().min(1), z.unknown()) }).strict(),
  z.object({ decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]) }).strict(),
]);
type SystemPayload<C = Command> = C extends Command ? Omit<C, "id" | "actor"> : never;

export type ReconcilerBoundary = "after_freeze" | "before_send" | "after_send" | "after_import";
export interface ReconcilerOptions {
  /** Bounded SAME-ID attempts, requiring explicit external evidence for every resend. */
  maxAttempts?: number;
  onBoundary?: (boundary: ReconcilerBoundary, target: TransportTarget) => void;
}
export interface ReconciliationResult { sent: number; imported: number; held: ProviderHold[] }
const activeTicks = new WeakMap<EngineStore, Map<string, Promise<ReconciliationResult>>>();

/**
 * App-owned recovery around the journal. No scheduler, future return task, timer or fresh-ID retry.
 * Each call makes one bounded observation and at most one send per unresolved transport.
 */
export class EngineReconciler {
  readonly store: EngineStore;
  readonly adapter: ProviderAdapter;
  private readonly options: ReconcilerOptions;
  private readonly maxAttempts: number;
  constructor(store: EngineStore, adapter: ProviderAdapter, options: ReconcilerOptions = {}) {
    this.store = store; this.adapter = adapter; this.options = options;
    this.maxAttempts = options.maxAttempts ?? 2;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 5) throw new Error("bounded transport attempt limit required");
  }
  private execute(room: string, payload: SystemPayload, identity: unknown): ReturnType<EngineStore["execute"]> {
    return this.store.execute(room, { ...payload, actor: "$system", id: `provider:${hash(JSON.stringify(identity))}` } as Command);
  }
  private hold(room: string, seatId: string, runId: string | null, code: string, detail: string, held = true): void {
    const key = JSON.stringify([seatId, runId, code]);
    const p = this.store.project(room), prior = p.providerHolds.get(key), run = runId ? p.runs.get(runId) : undefined;
    const control = [...p.controls.values()].find((c) => c.runId === runId
      && (["control_effect", "unbound_control", "reply_format"].some((prefix) => code === `${prefix}:${c.id}`)
        || ["unfrozen", "contract", "unknown", "attempt_limit", "coverage", "question", "interrupt"].some((prefix) => code === `${prefix}:control:${c.id}`)));
    const scope = code === "native_pending" || code.startsWith("own_delivery:") || code.startsWith("own_source_unavailable:")
      || code.startsWith("recorded_result_unavailable:") || code.startsWith("native_activity:") && runId === null
      ? "reseat" : code.startsWith("native_activity:") || code.startsWith("recorded_result_revision:") || control ? "work" : "dispatch";
    const causal: string[] = [];
    if (control) { let q = p.requests.get(control.requestId); while (q) { causal.push(q.id); q = q.parentId ? p.requests.get(q.parentId) : undefined; } }
    const recorded = [...p.toolResults.values(), ...p.toolClosures.values()].find((t) => t.runId === runId && code === `recorded_result_revision:${t.source.itemId}`);
    const requestIds = scope === "reseat" ? [] : prior?.requestIds ?? recorded?.requestIds ?? (control ? causal : run
      ? [...new Set([...run.envelope.openRequests, ...run.receipts.filter((r) => r.confirmed).flatMap((r) => r.envelope.openRequests)].map((q) => q.id))] : []);
    const hold: ProviderHold = { key, seatId, runId, code, detail, held, scope, requestIds };
    const previous = this.store.load(room).findLast((e) => e.data.kind === "provider.hold" && e.data.hold.key === key);
    this.execute(room, { type: "provider_hold", hold }, ["hold", hold, previous?.seq ?? 0]);
  }
  private clear(room: string, seatId: string, runId: string | null, code: string): void {
    const h = this.store.project(room).providerHolds.get(JSON.stringify([seatId, runId, code]));
    if (h?.held) this.hold(room, seatId, runId, code, `Resolved ${code} by exact provider evidence.`, false);
  }
  private conflict(room: string, seatId: string, runId: string, source: import("./provider.ts").NativeToolSource, code: string): void {
    const identity = canonicalJSON({ ...source, sequence: 0 });
    if (this.store.load(room).some((e) => e.data.kind === "provider.conflict" && e.data.code === code
      && e.data.runId === runId && canonicalJSON({ ...e.data.source, sequence: 0 }) === identity)) return;
    this.execute(room, { type: "source_conflict", seatId, runId, source, code }, ["native-conflict", runId, code, identity]);
  }
  private target(room: string, target: TransportTarget): Run | Control {
    const p = this.store.project(room), t = target.kind === "run" ? p.runs.get(target.id) : p.controls.get(target.id);
    if (!t) throw new Error("unknown transport target");
    return t;
  }
  private freeze(room: string, target: TransportTarget, wire: Record<string, unknown>, c: ProviderContract): void {
    const t = this.target(room, target);
    if (t.transport) return;
    const wireJSON = JSON.stringify(wire);
    const transport = { wireJSON, digest: hash(wireJSON), environmentId: c.environmentId, serverVersion: c.serverVersion, contract: c.id, ...(target.kind === "run" && c.reservedDispatchPolicy ? { dispatchPolicy: c.reservedDispatchPolicy } : {}) };
    this.execute(room, { type: "freeze_transport", target, transport }, ["freeze", target]);
    this.options.onBoundary?.("after_freeze", target);
  }
  /** Reserve first through EngineStore. This freezes the entire input and model selection before I/O. */
  async prepareRun(room: string, runId: string, modelSelection: { instanceId: string; model: string; options?: Record<string, unknown> }): Promise<void> {
    const p = this.store.project(room), r = p.runs.get(runId);
    if (!r) throw new Error("reserve before preparing transport");
    if (r.transport) return; // Never rerender recovered bytes using changed settings.
    const c = await this.adapter.contract();
    const text = JSON.stringify({ schema: "backroom.envelope.v1", runId, envelope: r.envelope,
      outputContract: "Return an explicit backroom.output.v1 body/disposition/receipts object; no normal-final completion default." });
    this.freeze(room, { kind: "run", id: runId }, { type: "message.dispatch", commandId: r.dispatchCommandId,
      threadId: p.seats.get(r.seatId)!.threadId, messageId: r.dispatchMessageId, text, attachments: [],
      modelSelection, createdBy: "user", creationSource: "server", dispatchMode: { type: "start_immediately" } }, c);
  }
  private phase(room: string, runId: string, phase: "accepted" | "uncertain" | "rejected", evidence: string): void {
    const r = this.store.project(room).runs.get(runId)!;
    if (r.phase === phase || r.phase === "terminal" || r.phase === "rejected") return;
    if (phase === "accepted" && ["accepted", "running"].includes(r.phase)) return;
    const prior = this.store.load(room).findLast((e) => e.data.kind === "run.phase" && e.data.runId === runId);
    this.execute(room, { type: "phase", runId, phase, evidence }, ["phase", runId, phase, evidence, prior?.seq ?? 0]);
  }
  private controlPhase(room: string, controlId: string, phase: "accepted" | "uncertain" | "obsolete", evidence: string): void {
    const c = this.store.project(room).controls.get(controlId)!;
    if (c.phase === phase || ["accepted", "obsolete"].includes(c.phase)) return;
    const prior = this.store.load(room).findLast((e) => e.data.kind === "control.phase" && e.data.controlId === controlId);
    this.execute(room, { type: "control_phase", controlId, phase, evidence }, ["control-phase", controlId, phase, evidence, prior?.seq ?? 0]);
  }
  private matches(t: FrozenTransport, c: ProviderContract): boolean {
    return c.supported && t.environmentId === c.environmentId && t.serverVersion === c.serverVersion && t.contract === c.id && hash(t.wireJSON) === t.digest;
  }
  /** Shared by reconciliation and transfer proof; persist the floor before trusting any snapshot facts. */
  private acceptObservation(room: string, seatId: string, c: ProviderContract, s: ProviderSnapshot): boolean {
    const p = this.store.project(room), seat = p.seats.get(seatId)!;
    if (!c.supported) { this.hold(room, seatId, null, "contract", c.evidence); return false; }
    const targets = [
      ...[...p.runs.values()].filter((r) => r.seatId === seatId).map((r) => ({ t: r, runId: r.id, scope: `run:${r.id}` })),
      ...[...p.controls.values()].filter((ctl) => p.runs.get(ctl.runId)!.seatId === seatId)
        .map((ctl) => ({ t: ctl, runId: ctl.runId, scope: `control:${ctl.id}` })),
    ];
    for (const { t, runId, scope } of targets) if (t.transport && !this.matches(t.transport, c)) {
      this.hold(room, seatId, runId, `contract:${scope}`, "Endpoint/version/contract differs from frozen transport; no provider observation or quiescence is trusted.");
      return false;
    }
    const prior = p.providerObservations.get(seatId);
    if (prior && (prior.environmentId !== c.environmentId || prior.serverVersion !== c.serverVersion
      || prior.contract !== c.id || prior.threadId !== seat.threadId)) {
      this.hold(room, seatId, null, "origin", "Provider origin differs from the durable observed thread; no rebinding or quiescence proof.");
      return false;
    }
    if (s.threadId !== seat.threadId || !s.complete || s.issues.length || !Number.isSafeInteger(s.sequence) || s.sequence < 0) {
      this.hold(room, seatId, null, "history", `History/identity/sequence is incomplete: ${s.issues.join(", ") || "invalid full snapshot"}.`);
      return false;
    }
    if (prior && s.sequence < prior.sequence) {
      this.hold(room, seatId, null, "snapshot_order", `Stale provider sequence ${s.sequence} is below durable observed floor ${prior.sequence}; known work remains held.`);
      return false;
    }
    const observation = { seatId, threadId: seat.threadId, environmentId: c.environmentId,
      serverVersion: c.serverVersion, contract: c.id, sequence: s.sequence, activities: s.activities, ...(s.toolSources ? { sources: s.toolSources } : {}) };
    const knownRuns = new Set([...p.runs.values()].filter((r) => r.seatId === seatId).map((r) => r.providerRunId));
    const liveBoundRuns = new Set(s.runs.filter((r) => knownRuns.has(r.id) && activeStatus(r.status)).map((r) => r.id));
    const rootKeys = new Set([...liveBoundRuns].map((id) => `runs:${id}`));
    for (const relation of s.rootWork ?? []) if (liveBoundRuns.has(relation.runId)) rootKeys.add(relation.key);
    const pending = [...new Set([...s.pending.filter((key) => !rootKeys.has(key)),
      ...s.runs.filter((r) => activeStatus(r.status) && !knownRuns.has(r.id)).map((r) => `runs:${r.id}`)])].sort();
    const settled = [...new Set([...(s.settled ?? []), ...rootKeys,
      ...s.runs.filter((r) => terminalStatus(r.status)).map((r) => `runs:${r.id}`),
      ...s.activities.filter((a) => terminalStatus(a.status)
        && !(s.toolSources ?? []).some((source) => source.type === "tool_node" && source.itemId === null
          && source.nodeId === a.id && source.providerRunId === a.runId))
        .map((a) => `activity:${a.id}`)])].sort();
    // The store rechecks origin/order under its write lock, including after another reader advanced it.
    try { this.execute(room, { type: "observe_provider", observation, pending, settled }, ["observation", observation, pending, settled]); }
    catch { this.hold(room, seatId, null, "snapshot_order", "Provider observation conflicts with the committed origin/sequence floor; no snapshot facts applied."); return false; }
    for (const code of ["unavailable", "contract", "origin", "history", "snapshot_order"]) this.clear(room, seatId, null, code);
    for (const { runId, scope } of targets) this.clear(room, seatId, runId, `contract:${scope}`);
    return true;
  }
  private async transport(room: string, target: TransportTarget, c: ProviderContract, s: ProviderSnapshot): Promise<number> {
    let t = this.target(room, target);
    const r = target.kind === "run" ? t as Run : this.store.project(room).runs.get((t as Control).runId)!;
    const scope = `${target.kind}:${target.id}`;
    if (!t.transport) { this.hold(room, r.seatId, r.id, `unfrozen:${scope}`, "Exact transport bytes must be frozen before dispatch."); return 0; }
    this.clear(room, r.seatId, r.id, `unfrozen:${scope}`);
    if (!this.matches(t.transport, c)) { this.hold(room, r.seatId, r.id, `contract:${scope}`, "Endpoint/version/contract changed; same identity cannot be sent to another environment."); return 0; }
    this.clear(room, r.seatId, r.id, `contract:${scope}`);
    if (target.kind === "control" && t.phase === "accepted") {
      if (!c.controlCompletion) this.hold(room, r.seatId, r.id, `control_effect:${target.id}`, "App command accepted; public T3 state does not prove its provider runtime effect settled. Finish/transfer remain held.");
      else this.clear(room, r.seatId, r.id, `control_effect:${target.id}`);
    }
    if (["terminal", "rejected", "accepted", "running", "obsolete"].includes(t.phase)) return 0;
    let evidence: CommandEvidence = { kind: "unknown", evidence: "No dispatch attempt recorded." };
    if (t.transport.attempts > 0 || t.phase !== "prepared") {
      evidence = await this.adapter.lookup(t.transport.wireJSON);
      if (!this.acceptObservation(room, r.seatId, c, s)) return 0;
      if (evidence.kind === "accepted") {
        if (target.kind === "run") this.phase(room, r.id, "accepted", evidence.evidence);
        else {
          this.controlPhase(room, target.id, "accepted", evidence.evidence);
          if (c.controlCompletion) this.clear(room, r.seatId, r.id, `control_effect:${target.id}`);
        }
        this.clear(room, r.seatId, r.id, `unknown:${scope}`);
        return 0;
      }
      if (evidence.kind === "rejected") {
        if (target.kind === "run") this.phase(room, r.id, "rejected", evidence.evidence);
        else this.controlPhase(room, target.id, "obsolete", evidence.evidence);
        this.clear(room, r.seatId, r.id, `unknown:${scope}`);
        return 0;
      }
      const reservedReplay = target.kind === "run" && t.transport.dispatchPolicy && c.reservedDispatchPolicy
        && canonicalJSON(t.transport.dispatchPolicy) === canonicalJSON(c.reservedDispatchPolicy) && c.durableSameId
        && !this.store.project(room).providerHolds.get(JSON.stringify([r.seatId, r.id, "binding"]))?.held;
      if (!reservedReplay && (evidence.kind !== "absent" || !c.durableSameId || !c.receiptLookup || !c.authoritativeAbsence)) {
        if (target.kind === "run") this.phase(room, r.id, "uncertain", evidence.evidence);
        else this.controlPhase(room, target.id, "uncertain", evidence.evidence);
        this.hold(room, r.seatId, r.id, `unknown:${scope}`, evidence.evidence);
        return 0;
      }
    }
    t = this.target(room, target);
    const frozen = t.transport!;
    if (frozen.attempts >= Math.min(this.maxAttempts, frozen.dispatchPolicy?.maxPackets ?? this.maxAttempts)) { this.hold(room, r.seatId, r.id, `attempt_limit:${scope}`, "Bounded same-ID attempts exhausted; explicit reconciliation required."); return 0; }
    if (!s.complete || s.issues.length) { this.hold(room, r.seatId, r.id, `coverage:${scope}`, "Partial or invalid history cannot prove a dispatch/control precondition."); return 0; }
    this.clear(room, r.seatId, r.id, `coverage:${scope}`);
    if (target.kind === "run") {
      if (this.store.project(room).providerHolds.get(JSON.stringify([r.seatId, r.id, "binding"]))?.held) return 0;
      const reserved = frozen.dispatchPolicy && c.reservedDispatchPolicy && c.durableSameId
        && canonicalJSON(frozen.dispatchPolicy) === canonicalJSON(c.reservedDispatchPolicy);
      if (!reserved && !c.atomicIdleStart) { this.hold(room, r.seatId, r.id, `idle_start:${scope}`, "Unsupported atomic idle start; T3 start_immediately can enqueue after an idle-read race. No send."); return 0; }
      const current = this.store.project(room);
      const knownNativeWork = current.providerObservations.get(r.seatId)?.pending.length
        || [...current.providerHolds.values()].some((h) => h.seatId === r.seatId && h.held && h.code === "native_pending");
      if (!reserved && (!s.idle || knownNativeWork)) { this.hold(room, r.seatId, r.id, `busy:${scope}`, "Current or durable unresolved native work/queued input prevents run send; board arrivals remain unread."); return 0; }
      this.clear(room, r.seatId, r.id, `busy:${scope}`);
    } else {
      const control = t as Control;
      if (control.kind === "runtime_reply") {
        const q = this.store.project(room).requests.get(control.requestId)!;
        const runtime = s.questions.find((x) => x.id === q.live?.providerRequestId);
        if (!runtime || runtime.runId !== r.providerRunId) { this.hold(room, r.seatId, r.id, `question:${scope}`, "Runtime question association/coverage is unproven."); return 0; }
        if (runtime.status !== "pending") {
          // Closed request plus serialized authoritative command absence proves this answer was unapplied.
          // Public T3 lacks that absence evidence; terminal/closed state alone always remains unknown.
          if (frozen.attempts === 0 && control.phase === "prepared" || evidence.kind === "absent") {
            this.controlPhase(room, control.id, "obsolete", `Closed runtime request and proven unapplied command: ${evidence.evidence}`);
            this.clear(room, r.seatId, r.id, `unknown:${scope}`);
            this.clear(room, r.seatId, r.id, `question:${scope}`);
          }
          else this.hold(room, r.seatId, r.id, `unknown:${scope}`, "Closed request does not attribute application to this response command.");
          return 0;
        }
        if (runtime.mode !== "live") { this.hold(room, r.seatId, r.id, `question:${scope}`, `Runtime mode ${runtime.mode} requires an ordinary board answer/new input; it is not a live resume.`); return 0; }
        if (r.phase === "terminal") {
          this.hold(room, r.seatId, r.id, `unknown:${scope}`, "Terminal run with pending runtime request cannot establish a live delivery; no new control send.");
          return 0;
        }
        this.clear(room, r.seatId, r.id, `question:${scope}`);
      } else if (!r.providerRunId) { this.hold(room, r.seatId, r.id, `interrupt:${scope}`, "Interrupt needs the exact bound provider run."); return 0; }
    }
    // Compare attempts under SQLite's write lock. Duplicate concurrent ticks cannot both own this send.
    const receipt = this.execute(room, { type: "transport_attempt", target, expectedAttempts: frozen.attempts,
      evidence: frozen.attempts === 0 ? "First send of journaled bytes with established preconditions." : evidence.evidence },
    ["attempt", target, frozen.attempts + 1]);
    if (receipt.replayed) return 0;
    this.options.onBoundary?.("before_send", target);
    const result = await this.adapter.send(frozen.wireJSON, target, this.target(room, target).transport!);
    this.options.onBoundary?.("after_send", target);
    if (result.kind === "accepted") {
      if (target.kind === "run") this.phase(room, r.id, "accepted", result.evidence);
      else {
        this.controlPhase(room, target.id, "accepted", result.evidence);
        if (c.controlCompletion) this.clear(room, r.seatId, r.id, `control_effect:${target.id}`);
      }
      this.clear(room, r.seatId, r.id, `unknown:${scope}`);
    } else if (result.kind === "rejected") {
      if (target.kind === "run") this.phase(room, r.id, "rejected", result.evidence);
      else this.controlPhase(room, target.id, "obsolete", result.evidence);
    } else {
      if (target.kind === "run") this.phase(room, r.id, "uncertain", result.evidence);
      else this.controlPhase(room, target.id, "uncertain", result.evidence);
      this.hold(room, r.seatId, r.id, `unknown:${scope}`, result.evidence);
    }
    return 1;
  }
  private prepareControl(room: string, c: Control, contract: ProviderContract): void {
    if (c.transport) return;
    const p = this.store.project(room), r = p.runs.get(c.runId)!;
    if (!r.providerRunId) { this.hold(room, r.seatId, r.id, `unbound_control:${c.id}`, "Recover original provider run before preparing its control."); return; }
    let wire: Record<string, unknown>;
    if (c.kind === "interrupt") wire = { type: "run.interrupt", commandId: c.commandId, threadId: p.seats.get(r.seatId)!.threadId, runId: r.providerRunId };
    else {
      let body: z.infer<typeof responseSchema>;
      try { body = responseSchema.parse(JSON.parse(c.body)); }
      catch { this.hold(room, r.seatId, r.id, `reply_format:${c.id}`, "Live response body must retain exact structured answers or authorized decision JSON."); return; }
      wire = { type: "runtime-request.respond", commandId: c.commandId, threadId: p.seats.get(r.seatId)!.threadId,
        requestId: p.requests.get(c.requestId)!.live!.providerRequestId, ...body };
    }
    this.freeze(room, { kind: "control", id: c.id }, wire, contract);
    this.clear(room, r.seatId, r.id, `unbound_control:${c.id}`);
  }
  private bind(room: string, r: Run, s: ProviderSnapshot): void {
    if (!r.transport) return;
    const wire = JSON.parse(r.transport.wireJSON) as { text: string };
    const matches = s.runs.filter((p) => p.userMessageId === r.dispatchMessageId);
    if (matches.length !== 1 || matches[0]!.inputText !== wire.text || r.providerRunId && r.providerRunId !== matches[0]!.id) {
      if (matches.length || r.providerRunId) this.hold(room, r.seatId, r.id, "binding", "Same message ID has conflicting/missing frozen content or provider run association.");
      return;
    }
    const native = matches[0]!;
    this.execute(room, { type: "bind_provider", runId: r.id, providerRunId: native.id,
      evidence: `Full local user-message identity and frozen text bind ${r.dispatchMessageId} to ${native.id}.` }, ["bind", r.id, native.id]);
    this.execute(room, { type: "provider_status", runId: r.id, providerRunId: native.id, status: native.status,
      queueHeld: native.queueHeld === true, sequence: s.sequence }, ["native-status", r.id, native.id, native.status, native.queueHeld === true, s.sequence]);
    this.phase(room, r.id, "accepted", `Exact persisted input observed on provider run ${native.id}.`);
    for (const code of ["binding", `unknown:run:${r.id}`, `idle_start:run:${r.id}`, `busy:run:${r.id}`]) this.clear(room, r.seatId, r.id, code);
  }
  private importEmission(room: string, seatId: string, e: ProviderEmission): boolean {
    const p = this.store.project(room);
    const run = [...p.runs.values()].find((r) => r.seatId === seatId && r.providerRunId === e.runId);
    const sourceKey = JSON.stringify(["provider", p.seats.get(seatId)!.threadId, e.id]);
    if (!e.complete) { this.hold(room, seatId, run?.id ?? null, `source:${e.id}`, "Streaming/truncated/inconsistent source cannot be frozen as an emission."); return false; }
    this.clear(room, seatId, run?.id ?? null, `source:${e.id}`);
    if (!run) {
      // Proven source identity, unknown causality: visible orphan, never latest-run guessing.
      this.execute(room, { type: "output", author: seatId, sourceKey, association: { kind: "orphan" },
        body: e.body, disposition: { kind: "yield" } }, ["orphan", sourceKey, hash(e.body)]);
      return !p.sourceKeys.has(sourceKey);
    }
    if (!e.disposition) { this.hold(room, seatId, run.id, `disposition:${e.id}`, "No explicit structured output disposition; no completion/cursor advance inferred from prose."); return false; }
    this.clear(room, seatId, run.id, `disposition:${e.id}`);
    const activity = e.activityId ? p.activities.get(e.activityId) : undefined;
    if (e.activityId && (!activity || activity.runId !== run.id)) {
      this.hold(room, seatId, run.id, `activity_source:${e.id}`, "Native activity output lacks its exact registered association."); return false;
    }
    const payload = { type: "output" as const, author: seatId, sourceKey,
      association: activity ? { kind: "activity" as const, id: activity.id } : { kind: "run" as const, id: run.id },
      body: e.body, disposition: e.disposition, terminal: false, receipts: e.receipts };
    const before = p.sourceKeys.has(sourceKey);
    this.execute(room, payload, ["emission", payload]);
    this.options.onBoundary?.("after_import", { kind: "run", id: run.id });
    return !before;
  }
  private registerNativeWork(room: string, seatId: string, s: ProviderSnapshot): void {
    const initial = this.store.project(room), seat = initial.seats.get(seatId)!;
    const history = initial.events;
    for (const a of s.activities) {
      const current = this.store.project(room);
      const localId = JSON.stringify(["native", seat.threadId, a.id]);
      const prior = current.activities.get(localId);
      const continuation = [...current.capabilities.values()].find((c) => c.seatId === seatId && c.nativeRunId === a.runId && c.activityId);
      const source = s.toolSources?.find((source) => source.itemId === a.id || source.nodeId === a.id);
      const sameInvocation = (old: NativeToolSource) => source && (source.itemId !== null && old.itemId === source.itemId
        || source.nodeId !== null && old.nodeId === source.nodeId);
      const oldBinding = [...current.operationBindings.values()].find((b) => b.source.threadId === seat.threadId && sameInvocation(b.source));
      const oldResult = [...current.toolResults.values(), ...current.toolClosures.values()].find((t) => t.source.threadId === seat.threadId && sameInvocation(t.source));
      // The authoritative first observation survives newer projections and index
      // rebuilds, including before there is any consumed result or local receipt.
      const evidence = source ? originalNativeEvidence(current, source) : undefined;
      const firstSource = evidence?.origin;
      const firstHold = history.find((e) => e.data.kind === "provider.hold" && e.data.hold.seatId === seatId
        && e.data.hold.code === `native_activity:${a.id}` && e.data.hold.runId !== null)?.data;
      const firstRun = firstSource && [...current.runs.values()].find((r) => r.seatId === seatId && r.providerRunId === firstSource.providerRunId);
      const originalRunId = oldBinding ? localReceipts(current).find((r) => r.key === oldBinding.receiptKey)!.runId : oldResult?.runId
        ?? firstRun?.id ?? (firstHold?.kind === "provider.hold" ? firstHold.hold.runId : null);
      // A contradictory projection cannot move an already bound invocation onto a newer request/run.
      const r = originalRunId ? current.runs.get(originalRunId) : continuation ? current.runs.get(continuation.runId)
        : [...current.runs.values()].find((x) => x.seatId === seatId && x.providerRunId === a.runId);
      if (r && source && firstSource && evidence && !originalNativeSourceMatches(evidence, source))
        this.conflict(room, seatId, r.id, source, `native_source_conflict:${firstSource.itemId ?? firstSource.nodeId ?? a.id}`);
      const matches = (original: NativeToolSource) => source && !sourceContradiction(source)
        && (source.itemId ? source.complete && sourceIdentity(original) === sourceIdentity(source) : exactAlias(original, source));
      const classified = source && ([...current.operationBindings.values()].some((b) => matches(b.source)
        // Closed local effects are already committed; an intact node awaiting its
        // missing native response is delivery uncertainty, independent of lifecycle.
        || !source.itemId && exactAlias(b.source, { ...source, status: b.source.status }))
        || [...current.toolResults.values(), ...current.toolClosures.values()].some((t) => matches(t.source) && source.status === t.source.status
          && (source.itemId ? ordinaryOutcomeCoherent(source) && source.nodeStatus === t.source.nodeStatus : source.nodeStatus === t.source.nodeStatus)
          && (!source.itemId || source.type !== "command_execution" || source.exitCode === t.source.exitCode)));
      if (prior && (prior.runId !== r?.id || !["pending", "uncertain"].includes(prior.status) && activeStatus(a.status))) {
        this.hold(room, seatId, prior.runId, `activity_conflict:${a.id}`, "Native activity identity changed origin or reopened after logical result; no guessed continuation.");
      } else if (!classified && (!prior || ["pending", "uncertain"].includes(prior.status))) {
        // Lifecycle terminal is not result recording. Even a row discovered late keeps
        // its original causal hold until authenticated result/closed local effects commit.
        this.hold(room, seatId, r?.id ?? null, `native_activity:${a.id}`, "Native invocation/child lacks an authenticated original-generation recorded result.");
      } else if (classified || prior && !["pending", "uncertain"].includes(prior.status)) {
        this.clear(room, seatId, r?.id ?? null, `native_activity:${a.id}`);
      }
    }
    for (const a of this.store.project(room).activities.values()) if (a.seatId === seatId && a.declaration) {
      for (const source of declarationContradictions(this.store.project(room), a, s.toolSources ?? []))
        this.conflict(room, seatId, a.runId, source, `declared_source_conflict:${a.id}`);
    }
  }
  /** Local protocol uses the same observation guard without dispatching or importing prose. */
  observe(room: string, seatId: string, contract: ProviderContract, snapshot: ProviderSnapshot): boolean {
    const accepted = this.acceptObservation(room, seatId, contract, snapshot);
    if (accepted) {
      for (const r of this.store.project(room).runs.values()) if (r.seatId === seatId) this.bind(room, r, snapshot);
      this.registerNativeWork(room, seatId, snapshot);
    }
    return accepted;
  }
  /** Validate prior immutable sources before a fresh local effect/claim, never before raw receipt recovery. */
  async reconcileSources(room: string, seatId: string, snapshot: ProviderSnapshot): Promise<ProviderSnapshot> {
    let latest = snapshot;
    const refresh = async () => {
      let current: ProviderSnapshot, contract: ProviderContract;
      try { current = await this.adapter.inspect(snapshot.threadId); contract = await this.adapter.contract(); }
      catch { this.hold(room, seatId, null, "unavailable", "Fresh source checkpoint unavailable; known work and reservations retained."); throw new Error("source checkpoint unavailable"); }
      if (!this.acceptObservation(room, seatId, contract, current)) throw new Error("source checkpoint unavailable");
      latest = current; this.registerNativeWork(room, seatId, latest);
    };
    const currentSource = (original: NativeToolSource) => (latest.toolSources ?? []).find((s) => s.itemId !== null && s.itemId === original.itemId)
      ?? (latest.toolSources ?? []).find((s) => s.nodeId !== null && s.nodeId === original.nodeId);
    // Detail reads prove the invocation outcome, independently of optional byte consumption.
    // Each detail is followed by a current metadata checkpoint; a later read can invalidate it.
    for (const candidate of snapshot.toolSources ?? []) {
      if (!candidate.itemId || !["command_execution", "dynamic_tool", "file_change"].includes(candidate.type)
        || !terminalStatus(candidate.status)) continue;
      const p = this.store.project(room);
      if ([...p.operationBindings.values()].some((b) => b.source.threadId === candidate.threadId && b.source.itemId === candidate.itemId)) continue;
      const local = [...p.capabilities.values()].some((c) => c.threadId === candidate.threadId
        && ["own_run_view", "consume_tool_result", "finish", "register_activity", "bind_activity", "record_activity_result"].some((name) => candidate.toolName === `${c.server}.${name}`));
      if (local) continue; // A local operation closes through its authenticated committed receipt.
      const original = [...p.toolClosures.values(), ...p.toolResults.values()].find((r) => r.source.threadId === candidate.threadId
        && (r.source.itemId === candidate.itemId || r.source.nodeId === candidate.nodeId));
      const first = originalNativeEvidence(p, candidate).origin;
      const providerRunId = first?.providerRunId ?? candidate.providerRunId;
      const cap = [...p.capabilities.values()].find((c) => c.threadId === candidate.threadId && c.nativeRunId === providerRunId);
      const run = original ? p.runs.get(original.runId) : cap ? p.runs.get(cap.runId)
        : [...p.runs.values()].find((r) => r.seatId === seatId && r.providerRunId === providerRunId);
      if (!run || original) continue;
      let full: NativeToolSource | undefined;
      if (this.adapter.detail) try { full = await this.adapter.detail(snapshot.threadId, candidate.itemId); } catch { /* retain native activity hold */ }
      await refresh();
      if (!full || !toolClosure(full)) continue;
      try {
        this.execute(room, { type: "close_tool", runId: run.id, source: full, sequence: latest.sequence,
          sourceCheckpointDigest: hash(canonicalJSON(latest.toolSources ?? [])) }, ["tool-closure", run.id, full, latest.sequence]);
      } catch {
        const observed = currentSource(candidate);
        if (observed && !originalNativeSourceMatches(originalNativeEvidence(this.store.project(room), observed), observed))
          this.conflict(room, seatId, run.id, observed, `native_source_conflict:${candidate.itemId}`);
      }
    }
    const p = this.store.project(room), receipts = localReceipts(p);
    const known = [
      ...[...p.operationBindings.values()].filter((b) => receipts.find((r) => r.key === b.receiptKey)?.seatId === seatId)
        .map((b) => ({ original: b.source, receipt: receipts.find((r) => r.key === b.receiptKey)!, ordinary: null })),
      ...[...p.toolResults.values(), ...p.toolClosures.values()].filter((t) => t.source.threadId === snapshot.threadId)
        .map((t) => ({ original: t.source, receipt: null, ordinary: t })),
    ];
    type Known = typeof known[number];
    const key = (k: Known) => canonicalJSON([k.receipt?.runId ?? k.ordinary!.runId, k.original.itemId, k.original.nodeId]);
    const checkpoint = (v: NativeToolSource) => canonicalJSON([sourceIdentity(v), v.updatedAt, v.status, v.nodeStatus ?? null, v.exitCode ?? null]);
    const attempts = new Map<string, number>(), coverage = new Map<string, NativeToolSource>(), attemptedFloors = new Map<string, number>();
    const invalidated = new Set<string>();
    const codes = (k: Known) => ({
      unavailable: k.receipt ? `own_source_unavailable:${k.original.itemId}` : `recorded_result_unavailable:${k.original.itemId}`,
      revision: k.receipt ? `own_source_unavailable:${k.original.itemId}` : `recorded_result_revision:${k.original.itemId}`,
      conflict: k.receipt ? `own_source_conflict:${k.original.itemId}` : `recorded_result_conflict:${k.original.itemId}`,
    });
    const changed = (k: Known, v: NativeToolSource) => sourceContradiction(v)
      || !(v.itemId ? sourceIdentity(k.original) === sourceIdentity(v)
        : exactAlias(k.original, k.receipt ? { ...v, status: k.original.status } : v))
      || k.ordinary !== null && (v.status !== k.original.status || v.nodeStatus !== k.original.nodeStatus
        || v.itemId !== null && !ordinaryOutcomeCoherent(v)
        || v.itemId !== null && v.type === "command_execution" && Object.hasOwn(v, "exitCode") && v.exitCode !== k.original.exitCode);
    const revalidate = async (k: Known) => {
      const { original, receipt, ordinary } = k, runId = receipt?.runId ?? ordinary!.runId, code = codes(k);
      attempts.set(key(k), (attempts.get(key(k)) ?? 0) + 1);
      attemptedFloors.set(key(k), latest.sequence);
      const before = currentSource(original);
      if (before && changed(k, before)) this.conflict(room, seatId, runId, before, code.conflict);
      let full: NativeToolSource | undefined;
      if (original.itemId && this.adapter.detail) try { full = await this.adapter.detail(snapshot.threadId, original.itemId); } catch { /* refresh preserves present contradictory metadata even on detail failure */ }
      await refresh();
      const observed = currentSource(original);
      if (full ? full.sequence !== latest.sequence : latest.sequence > attemptedFloors.get(key(k))!) invalidated.add(key(k));
      if (full) coverage.set(key(k), full); else coverage.delete(key(k));
      if (observed && changed(k, observed)) this.conflict(room, seatId, runId, observed, code.conflict);
      if (full && changed(k, full)) this.conflict(room, seatId, runId, full, code.conflict);
      if (before && changed(k, before) || observed && changed(k, observed) || full && changed(k, full)) return;
      try {
        if (!full) throw new Error("detail unavailable");
        if (receipt) {
          const cap = this.store.project(room).capabilities.get(receipt.capabilityId)!;
          validateOperationSource(this.store.project(room), cap, receipt.packet.intent, full);
          if (Object.hasOwn(full, "output") && canonicalJSON(full.output) !== receipt.responseJSON) {
            this.conflict(room, seatId, runId, full, `own_response_conflict:${original.itemId}`); return;
          }
        } else if (Object.hasOwn(full, "output") && canonicalJSON(full.output) !== canonicalJSON(original.output)) {
          this.conflict(room, seatId, runId, full, code.conflict); return;
        }
        // A detail is usable only for the exact mutable revision/outcome still
        // present in the checkpoint imported AFTER that detail returned.
        if (!observed || full.sequence !== latest.sequence || checkpoint(full) !== checkpoint(observed)) {
          this.hold(room, seatId, runId, code.revision, "Observed source supersedes result detail; bounded revalidation required."); return;
        }
        if (receipt) {
          const confirmed = terminalStatus(full.status) && ordinaryOutcomeCoherent(full); if (confirmed && !toolClosure(full)) throw new Error("local return outcome unavailable");
          this.execute(room, { type: "bind_operation", receiptKey: receipt.key, source: full, confirmed }, ["own-binding", receipt.key, full, confirmed]);
        } else if (ordinary && "evidence" in ordinary) { if (!toolClosure(full)) throw new Error("positive closure unavailable"); } else resultDigest(full);
        invalidated.delete(key(k));
        this.clear(room, seatId, runId, code.unavailable);
        this.clear(room, seatId, runId, code.revision);
      } catch {
        // Diagnostic changed bodies remain visible even if their delivery form is
        // unsupported; no such body is consumed or treated as an effect receipt.
        if (receipt && full && Object.hasOwn(full, "output") && canonicalJSON(full.output) !== receipt.responseJSON)
          this.conflict(room, seatId, runId, full, `own_response_conflict:${original.itemId}`);
        const newerOrdinary = ordinary && observed && observed.itemId !== null && checkpoint(observed) !== checkpoint(original);
        this.hold(room, seatId, runId, newerOrdinary ? code.revision : code.unavailable,
          "Known original effects retained; current source revision or native delivery remains unvalidated.");
      }
    };
    for (const k of known) await revalidate(k);
    // Another exact native invocation of the SAME raw local intent binds to its
    // original receipt. Its reads participate in the same final coverage fence.
    for (const source of latest.toolSources ?? []) {
      if (!source.itemId || source.type !== "dynamic_tool" || sourceContradiction(source)) continue;
      const current = this.store.project(room);
      if ([...current.operationBindings.values()].some((b) => b.source.itemId === source.itemId && b.source.threadId === latest.threadId)) continue;
      const receipts = localReceipts(current).filter((r) => r.seatId === seatId && r.packet.source.providerRunId === source.providerRunId
        && Object.hasOwn(source, "input") && canonicalJSON(source.input) === r.intentJSON);
      if (receipts.length !== 1) continue;
      const k: Known = { original: source, receipt: receipts[0]!, ordinary: null };
      known.push(k); await revalidate(k);
    }
    // A later source read can invalidate an earlier proof. Revisit each affected
    // source at most ONCE, then retain an explicit original-scope hold if the final
    // checkpoint still supersedes any relied-on detail. No timer or self-wake.
    const stale = (k: Known) => {
      if (invalidated.has(key(k))) return true;
      const observed = currentSource(k.original), proved = coverage.get(key(k));
      return !observed ? proved !== undefined : proved ? proved.sequence !== latest.sequence || checkpoint(observed) !== checkpoint(proved)
        : latest.sequence > (attemptedFloors.get(key(k)) ?? latest.sequence)
          || observed.itemId !== null && k.ordinary !== null && checkpoint(observed) !== checkpoint(k.original);
    };
    for (const k of known) if (stale(k) && (attempts.get(key(k)) ?? 0) < 2) {
      invalidated.add(key(k)); await revalidate(k);
    }
    for (const k of known) {
      const observed = currentSource(k.original), runId = k.receipt?.runId ?? k.ordinary!.runId;
      if (observed && changed(k, observed)) this.conflict(room, seatId, runId, observed, codes(k).conflict);
      if (stale(k)) this.hold(room, seatId, runId, invalidated.has(key(k)) || observed?.itemId ? codes(k).revision : codes(k).unavailable,
        "Final source revision is newer than bounded result validation; retain original work/delivery scope.");
    }
    return latest;
  }
  tick(room: string, seatId: string): Promise<ReconciliationResult> {
    let ticks = activeTicks.get(this.store);
    if (!ticks) { ticks = new Map(); activeTicks.set(this.store, ticks); }
    const key = JSON.stringify([room, seatId]);
    const existing = ticks.get(key);
    if (existing) return existing;
    const work = this.reconcile(room, seatId).finally(() => { ticks!.delete(key); });
    ticks.set(key, work);
    return work;
  }
  private async reconcile(room: string, seatId: string): Promise<ReconciliationResult> {
    let sent = 0, imported = 0;
    let p = this.store.project(room);
    const seat = p.seats.get(seatId);
    if (!seat) throw new Error("unknown seat");
    let c: ProviderContract, s: ProviderSnapshot;
    try { c = await this.adapter.contract(); s = await this.adapter.inspect(seat.threadId); }
    catch { this.hold(room, seatId, null, "unavailable", "Provider read unavailable/invalid; keep exact reservations and controls."); return this.result(room, seatId, sent, imported); }
    if (!this.acceptObservation(room, seatId, c, s)) return this.result(room, seatId, sent, imported);
    p = this.store.project(room);
    // Bind every historical run, not merely the newest; later native output may belong to old work.
    for (const r of p.runs.values()) if (r.seatId === seatId) this.bind(room, r, s);
    try { s = await this.reconcileSources(room, seatId, s); }
    catch { return this.result(room, seatId, sent, imported); }
    this.registerNativeWork(room, seatId, s);
    // Exact binding may resolve a previously unassociated root. Other known keys persist
    // atomically with the sequence floor until explicit settlement, including after restart.
    if (!this.acceptObservation(room, seatId, c, s)) return this.result(room, seatId, sent, imported);
    for (const ctl of this.store.project(room).controls.values()) {
      const r = this.store.project(room).runs.get(ctl.runId)!;
      if (r.seatId === seatId && ctl.phase === "accepted") {
        if (!c.controlCompletion) this.hold(room, seatId, r.id, `control_effect:${ctl.id}`, "App command accepted; public state does not prove provider runtime effect completion. Finish/transfer held.");
        else this.clear(room, seatId, r.id, `control_effect:${ctl.id}`);
      }
    }
    for (const ctl of this.store.recovery(room).controls) if (this.store.project(room).runs.get(ctl.runId)!.seatId === seatId) {
      this.prepareControl(room, ctl, c);
      sent += await this.transport(room, { kind: "control", id: ctl.id }, c, s);
    }
    for (const r of this.store.recovery(room).runs) if (r.seatId === seatId) sent += await this.transport(room, { kind: "run", id: r.id }, c, s);
    if (!this.acceptObservation(room, seatId, c, s)) return this.result(room, seatId, sent, imported);
    for (const e of s.emissions) {
      try { if (this.importEmission(room, seatId, e)) imported++; }
      catch { this.hold(room, seatId, null, `source_conflict:${e.id}`, "Provider emission identity/receipt/association conflicts with committed immutable content; no replacement claim."); }
    }
    // Later turn end observes an already-imported emission without mutating its identity or re-claiming work.
    for (const r of this.store.recovery(room).runs) {
      if (r.seatId !== seatId || !r.providerRunId) continue;
      const native = s.runs.find((x) => x.id === r.providerRunId);
      const emissions = s.emissions.filter((e) => e.runId === r.providerRunId);
      if (native && terminalStatus(native.status) && emissions.length && emissions.every((e) => e.complete && e.disposition)) {
        const last = emissions.at(-1)!;
        try {
          const sourceKey = JSON.stringify(["provider", seat.threadId, last.id]);
          this.execute(room, { type: "observe_end", runId: r.id, sourceKey,
            failure: native.status === "completed" ? (last.disposition?.kind === "error" ? last.body : null) : `Provider run ${native.status}.`,
            evidence: `Exact provider run ${native.id} terminal status ${native.status} at snapshot ${s.sequence}.` }, ["end", r.id, native.status, sourceKey]);
        }
        catch { this.hold(room, seatId, r.id, "terminal_import", "Terminal observation conflicts with source/receipt evidence; reservation held."); }
      }
    }
    // Terminal with no stable output is a bounded visible failure, not fabricated success or a replay.
    for (const r of this.store.recovery(room).runs) {
      if (r.seatId !== seatId || !r.providerRunId) continue;
      const native = s.runs.find((x) => x.id === r.providerRunId);
      if (native && terminalStatus(native.status) && !s.emissions.some((e) => e.runId === native.id)) {
        this.execute(room, { type: "output", author: seatId, sourceKey: JSON.stringify(["missing-output", seat.threadId, native.id]),
          association: { kind: "run", id: r.id }, body: `Provider run ${native.status}; terminal output unavailable in complete history.`,
          disposition: { kind: "error", requestIds: [] }, terminal: true }, ["missing-output", r.id, native.status]);
      }
    }
    return this.result(room, seatId, sent, imported);
  }
  private result(room: string, seatId: string, sent: number, imported: number): ReconciliationResult {
    return { sent, imported, held: [...this.store.project(room).providerHolds.values()].filter((h) => h.seatId === seatId && h.held) };
  }
  /** Read fresh native evidence; caller must append transfer against the same local head. */
  async quiescence(room: string, seatId: string): Promise<{ proven: boolean; evidence: string }> {
    const seat = this.store.project(room).seats.get(seatId);
    if (!seat) throw new Error("unknown seat");
    try {
      const c = await this.adapter.contract(); let s = await this.adapter.inspect(seat.threadId);
      if (!this.acceptObservation(room, seatId, c, s)) return { proven: false, evidence: "Provider origin/thread/coverage/sequence is unproven; durable known work retained." };
      this.registerNativeWork(room, seatId, s);
      s = await this.reconcileSources(room, seatId, s);
      const p = this.store.project(room);
      const recovery = this.store.recovery(room);
      const observed = p.providerObservations.get(seatId);
      if (!observed || observed.sequence !== s.sequence || canonicalJSON(observed.sources ?? []) !== canonicalJSON(s.toolSources ?? [])
        || this.store.load(room).length !== p.events.length)
        return { proven: false, evidence: "A concurrent journal/source checkpoint superseded result validation; quiescence is unproven." };
      const unresolved = recovery.runs.some((r) => r.seatId === seatId)
        || recovery.controls.some((ctl) => p.runs.get(ctl.runId)!.seatId === seatId)
        || recovery.activities.some((a) => a.seatId === seatId)
        || [...p.providerHolds.values()].some((h) => h.held && h.seatId === seatId);
      const unprovenControlEffects = !c.controlCompletion && [...p.controls.values()].some((ctl) => ctl.phase === "accepted" && p.runs.get(ctl.runId)!.seatId === seatId);
      if (!c.supported || !c.nativeCoverage || !s.complete || s.issues.length || !s.idle || unresolved || unprovenControlEffects) return { proven: false, evidence: "Known run/control/activity/queued input or unresolved provider coverage prevents quiescence." };
      return { proven: true, evidence: `Reported native quiescence at ${c.environmentId}/${s.threadId}/sequence:${s.sequence}; local head:${p.events.length}. Unreported processes are outside this proof.` };
    } catch { return { proven: false, evidence: "Provider unavailable; quiescence unproven." }; }
  }
}
