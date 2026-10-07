import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { EngineStore } from "./store.ts";
import { EngineReconciler } from "./reconciler.ts";
import { hash, terminalStatus } from "./provider.ts";
import type { ProviderAdapter } from "./provider.ts";
import type { RunCapability, LocalOperationPacket, ToolView, DeclaredActivityView, ViewPage } from "./operation-types.ts";
import { parseActivity, parseOperation, validateCapability, validateCurrentOperationSource } from "./operations.ts";
import { canonicalJSON, resultDigest, toolClosure, sourceKey } from "./result.ts";

const requestSchema = z.object({ intent: z.unknown(), itemId: z.string().min(1).max(256) }).strict();
const viewBudget = 3500;
/** A large detail map must not make the first original entry disappear. */
function finiteViewBudget(clientId: string, intentDigest: string): number {
  const empty = { schema: "backroom.operation-result.v1", result: { recorded: true, operation: "own_run_view",
    tools: [], claims: [], view: [], activities: [] }, receipt: { clientId, intentDigest, resultDigest: "0".repeat(64) } };
  // Reserve the exact response/receipt overhead, including escaped and multibyte client IDs.
  return Math.min(viewBudget, Math.floor((8191 - Buffer.byteLength(canonicalJSON(empty)) + 4) / 2));
}
function appendView<T extends { page?: ViewPage }>(entries: T[], full: T, summary: () => T, page: ViewPage, budget: number): boolean {
  const withPage = { ...full, page };
  if (Buffer.byteLength(canonicalJSON([...entries, withPage])) <= budget) { entries.push(withPage); return true; }
  // Ordinary entries that fit a fresh page stay intact on the next page.
  if (entries.length && Buffer.byteLength(canonicalJSON([withPage])) <= budget) return false;
  const compact = { ...summary(), page };
  if (Buffer.byteLength(canonicalJSON([...entries, compact])) <= budget) { entries.push(compact); return true; }
  if (!entries.length) throw new Error("minimum original view entry exceeds finite response budget");
  return false;
}
function summarizeToolView(entry: ToolView): ToolView {
  if (!entry.availability || !entry.closureKey) return entry;
  const statusCounts = { complete: 0, partial: 0, omitted: 0, unavailable: 0 };
  for (const value of Object.values(entry.availability)) {
    const status = (value as { status: keyof typeof statusCounts }).status;
    if (Object.hasOwn(statusCounts, status)) statusCounts[status]++;
  }
  const availability = Object.fromEntries(["input", "output", "fileChange", "exitCode", "resultMetadata"]
    .filter((field) => Object.hasOwn(entry.availability!, field))
    .map((field) => [field, { status: (entry.availability![field] as { status: string }).status }]));
  const [threadId, , providerRunId, generation] = JSON.parse(entry.closureKey) as [string, string, string, number];
  const { closureKey: _key, ...bounded } = entry;
  return { ...bounded, availability, originalEvidenceRef: { kind: "tool.closed", threadId, providerRunId, generation, itemIdField: "itemId" },
    availabilitySummary: { mode: "top_level_and_counts",
    fieldCount: Object.keys(entry.availability).length, statusCounts,
    detailsRef: { kind: "tool.closed", refField: "originalEvidenceRef" } } };
}
function summarizeActivityView(entry: DeclaredActivityView): DeclaredActivityView {
  return { activityId: entry.activityId, status: entry.status, provenance: entry.provenance, generation: entry.generation,
    availability: entry.availability, correlation: entry.correlation, limitations: entry.limitations,
    detailSummary: { mode: "original_record_reference",
      omittedFields: ["registrationReceiptKey", "bindingReceiptKey", "resultReceiptKey", "nativeHandle", "unavailableReason", "originalResultRef"],
      originalEvidenceRef: { kind: "activity.declaration", keyField: "activityId" },
      unavailableReason: { present: entry.unavailableReason != null, utf8Bytes: Buffer.byteLength(entry.unavailableReason ?? "") } } };
}
/** An unwired HTTP handler: stage4 supplies its route and trusted MCP credential configuration. */
export class EngineLocalProtocol {
  private readonly store: EngineStore;
  private readonly adapter: ProviderAdapter;
  private readonly reconciler: EngineReconciler;
  constructor(store: EngineStore, adapter: ProviderAdapter) {
    this.store = store; this.adapter = adapter; this.reconciler = new EngineReconciler(store, adapter);
  }
  /** HOST ONLY, before native launch. Never exposed as an HTTP/member operation. */
  authorizeRun(room: string, runId: string, config: { generation: number; server: string; activityId?: string; nativeRunId?: string }): { authorization: string; capabilityId: string } {
    const p = this.store.project(room), run = p.runs.get(runId), seat = run && p.seats.get(run.seatId), transport = run?.transport;
    if (!run || !seat || !transport) throw new Error("freeze reserved transport before provisioning capability");
    const secret = randomBytes(32).toString("base64url"), capabilityId = `cap-${randomUUID()}`;
    const capability: RunCapability = { id: capabilityId, tokenHash: hash(secret), runId, seatId: seat.id, threadId: seat.threadId,
      generation: config.generation, server: config.server, environmentId: transport.environmentId,
      serverVersion: transport.serverVersion, contract: transport.contract,
      ...(config.activityId ? { activityId: config.activityId } : {}), ...(config.nativeRunId ? { nativeRunId: config.nativeRunId } : {}) };
    this.store.execute(room, { type: "authorize_run", actor: "$system", id: `authorize:${capabilityId}`, capability });
    return { authorization: `Bearer ${capabilityId}.${secret}`, capabilityId };
  }
  /** HOST ONLY: seal a preallocated native ID before launching registered work. */
  async bindActivity(room: string, activityId: string, config: { nativeId: string; generation: number }): Promise<void> {
    const p = this.store.project(room), a = p.activities.get(activityId), run = a && p.runs.get(a.runId), seat = run && p.seats.get(run.seatId);
    if (!a || !run || !seat || seat.status !== "active") throw new Error("original registered activity required");
    if (a.nativeSource?.nativeId === config.nativeId && a.generation === config.generation) return;
    const contract = await this.adapter.contract(), snapshot = await this.adapter.inspect(seat.threadId);
    if (!this.reconciler.observe(room, seat.id, contract, snapshot)) throw new Error("prelaunch activity checkpoint unavailable");
    this.store.execute(room, { type: "activity_bind", actor: "$system", id: `activity-bind:${hash(canonicalJSON([activityId, config]))}`,
      activityId, nativeId: config.nativeId, generation: config.generation, sequence: snapshot.sequence });
  }
  private authenticate(room: string, authorization: string | null): RunCapability {
    const match = /^Bearer (cap-[a-f0-9-]+)\.([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match) throw new Error("authentication required");
    const cap = this.store.project(room).capabilities.get(match[1]!);
    if (!cap || !timingSafeEqual(Buffer.from(cap.tokenHash, "hex"), Buffer.from(hash(match[2]!), "hex"))) throw new Error("authentication required");
    validateCapability(this.store.project(room), cap);
    return cap;
  }
  /** No listener is started and this class has no production service caller. */
  async handle(room: string, request: Request): Promise<Response> {
    const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    let cap: RunCapability;
    try { cap = this.authenticate(room, request.headers.get("authorization")); }
    catch { return json('{"error":"authentication_required"}', 401); }
    if (request.method !== "POST") return json('{"error":"method_not_allowed"}', 405);
    try {
      const text = await request.text();
      if (Buffer.byteLength(text) >= 8192) return json('{"error":"finite_intent_required"}', 413);
      const envelope = requestSchema.parse(JSON.parse(text));
      if (new URL(request.url).pathname.endsWith("/activities")) {
        const intent = parseActivity(envelope.intent), intentJSON = canonicalJSON(intent);
        const original = this.store.lookupActivity(room, cap.id, intentJSON);
        if (original) return json(original.responseJSON);
        if (!this.adapter.detail) throw new Error("lossless detail unavailable");
        const contract = await this.adapter.contract(), source = await this.adapter.detail(cap.threadId, envelope.itemId);
        validateCurrentOperationSource(this.store.project(room), cap, intent, source);
        const resultRef = intent.operation === "record_activity_result"
          ? intent.schema === "backroom.activity.v1" ? intent.toolRef : intent.resultRef : null;
        const resultSource = resultRef ? await this.adapter.detail(cap.threadId, resultRef.itemId) : null;
        const originalSource = intent.schema === "backroom.activity.v2" && intent.operation === "bind_activity" && intent.originalSourceRef
          ? await this.adapter.detail(cap.threadId, intent.originalSourceRef.itemId) : null;
        let snapshot = await this.adapter.inspect(cap.threadId);
        if (!this.reconciler.observe(room, cap.seatId, contract, snapshot)) throw new Error("activity source checkpoint unavailable");
        snapshot = await this.reconciler.reconcileSources(room, cap.seatId, snapshot);
        const aliases = (snapshot.toolSources ?? []).filter((s) => s.itemId !== source.itemId && s.type === "dynamic_tool"
          && s.providerRunId === source.providerRunId && s.generation === cap.generation && Object.hasOwn(s, "input")
          && canonicalJSON(s.input) === intentJSON);
        return json(this.store.commitActivity(room, { capabilityId: cap.id, intent, intentJSON, source, resultSource,
          ...(intent.schema === "backroom.activity.v2" ? { originalSource } : {}), aliases, sequence: snapshot.sequence,
          sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) }).receipt.responseJSON);
      }
      const intent = parseOperation(envelope.intent), intentJSON = canonicalJSON(intent);
      // This check is before contract/snapshot/detail I/O and before rebuilding a packet.
      const original = this.store.lookupOperation(room, cap.id, intentJSON);
      if (original) return json(original.responseJSON);
      if (!this.adapter.detail) throw new Error("lossless detail unavailable");
      const contract = await this.adapter.contract();
      let snapshot = await this.adapter.inspect(cap.threadId);
      if (!this.reconciler.observe(room, cap.seatId, contract, snapshot)) throw new Error("source checkpoint unavailable");
      const source = await this.adapter.detail(cap.threadId, envelope.itemId);
      validateCurrentOperationSource(this.store.project(room), cap, intent, source);
      const tools: LocalOperationPacket["tools"] = [], view: LocalOperationPacket["view"] = [];
      const budget = finiteViewBudget(intent.clientId, hash(intentJSON));
      if (intent.operation === "own_run_view") {
        const candidates = (snapshot.toolSources ?? []).filter((s) => s.itemId !== null && s.itemId !== source.itemId
          && s.providerRunId === source.providerRunId && s.generation === cap.generation && terminalStatus(s.status)
          && snapshot.activities.some((a) => a.id === s.itemId || a.id === s.nodeId)
          && ![...this.store.project(room).operationBindings.values()].some((b) => b.source.itemId === s.itemId && b.source.providerRunId === s.providerRunId));
        const offset = intent.offset ?? 0;
        for (const [index, candidate] of candidates.slice(offset, offset + 16).entries()) {
          let entry: ToolView;
          try {
            const full = await this.adapter.detail(cap.threadId, candidate.itemId!);
            let digest = ""; try { digest = resultDigest(full); } catch { /* strict optional consumption remains unavailable */ }
            const closed = toolClosure(full), stored = this.store.project(room).toolClosures.get(sourceKey(full));
            entry = { itemId: candidate.itemId!, digest, status: full.status,
              ...(closed ? { closed: !!stored, closureKey: sourceKey(full), outcome: closed.outcome,
                availability: closed.availability, limitations: closed.limitations } : { closed: false }) };
          } catch {
            entry = { itemId: candidate.itemId!, digest: "", status: "unavailable", closed: false };
            this.store.execute(room, { type: "provider_hold", actor: "$system", id: `unavailable:${hash(canonicalJSON([cap.id, candidate]))}`,
              hold: { key: JSON.stringify([cap.seatId, cap.runId, `result_unavailable:${candidate.itemId}`]), seatId: cap.seatId, runId: cap.runId,
                code: `result_unavailable:${candidate.itemId}`, detail: "Original result remains at provider source; lossless detail unavailable.",
                held: true, scope: "work", requestIds: this.store.project(room).runs.get(cap.runId)!.envelope.openRequests.map((r) => r.id) } });
          }
          if (!appendView(view, entry, () => summarizeToolView(entry),
            { offset: offset + index, nextOffset: offset + index + 1, total: candidates.length }, budget)) break;
        }
      } else for (const ref of intent.toolRefs) tools.push({ ref, source: await this.adapter.detail(cap.threadId, ref.itemId) });
      // Details can advance the projection. Capture complete current metadata, then
      // compare every original source again under the writer lock in commitOperation.
      snapshot = await this.adapter.inspect(cap.threadId);
      if (!this.reconciler.observe(room, cap.seatId, contract, snapshot)) throw new Error("source checkpoint changed");
      snapshot = await this.reconciler.reconcileSources(room, cap.seatId, snapshot);
      const aliases = (snapshot.toolSources ?? []).filter((s) => s.itemId !== source.itemId && s.type === "dynamic_tool"
        && s.providerRunId === source.providerRunId && s.generation === cap.generation && Object.hasOwn(s, "input")
        && canonicalJSON(s.input) === intentJSON);
      // Expose references and availability; original payloads remain journaled, outside the finite local response.
      const activities: NonNullable<LocalOperationPacket["activities"]> = [];
      const declared = [...this.store.project(room).activities.values()]
        .filter((a) => a.runId === cap.runId && a.declaration && (!cap.activityId || cap.activityId === a.id));
      if (intent.operation === "own_run_view") for (const [index, a] of declared.slice(intent.offset ?? 0).entries()) {
        const d = a.declaration!, original = d.result?.originalSource;
        const entry = { activityId: a.id, status: a.status, provenance: "member_declared" as const, generation: d.registration.generation,
          registrationReceiptKey: d.registration.registrationReceiptKey, bindingReceiptKey: d.binding?.bindingReceiptKey ?? null,
          resultReceiptKey: d.result?.resultReceiptKey ?? null, nativeHandle: d.binding?.nativeHandle ?? null,
          availability: d.binding?.availability ?? "unbound", correlation: d.binding?.correlation ?? "unverified",
          unavailableReason: d.result?.unavailableReason ?? null,
          originalResultRef: original ? { itemId: original.itemId, sourceKey: sourceKey(original) } : null,
          limitations: d.binding?.limitations ?? d.registration.limitations };
        if (!appendView(activities, entry, () => summarizeActivityView(entry),
          { offset: (intent.offset ?? 0) + index, nextOffset: (intent.offset ?? 0) + index + 1, total: declared.length }, budget)) break;
      }
      for (const item of view) item.closed = [...this.store.project(room).toolClosures.values()].some((c) => c.source.itemId === item.itemId);
      const packet: LocalOperationPacket = { capabilityId: cap.id, intent, intentJSON, source, aliases, tools, view,
        ...(intent.operation === "own_run_view" ? { activities } : {}), sequence: snapshot.sequence,
        sourceCheckpointDigest: hash(canonicalJSON(snapshot.toolSources ?? [])) };
      return json(this.store.commitOperation(room, packet).receipt.responseJSON);
    } catch { return json('{"error":"source_or_intent_unproven"}', 409); }
  }
}
