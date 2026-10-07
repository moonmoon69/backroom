import { hash } from "../engine/provider.ts";
import type { CommandEvidence, ProviderAdapter, ProviderContract, ProviderSnapshot } from "../engine/provider.ts";
import type { TransportTarget } from "../engine/types.ts";

/** Synthetic contract only. These capabilities are NOT evidence about T3 or any harness. */
export interface FakeProviderState {
  receipts: Record<string, { digest: string; result: CommandEvidence }>;
  snapshots: Record<string, ProviderSnapshot>;
  sends: string[];
}
export class FakeEngineProvider implements ProviderAdapter {
  readonly state: FakeProviderState;
  capabilities: ProviderContract = { id: "FAKE-contract-v1", environmentId: "FAKE-env", serverVersion: "FAKE-version", supported: true,
    durableSameId: true, receiptLookup: true, authoritativeAbsence: true, atomicIdleStart: true,
    nativeCoverage: true, controlCompletion: true, syncExposure: false, evidence: "FAKE test capabilities; no real provider guarantee." };
  loseResponse = false;
  reject = false;
  unknownWithoutAcceptance = false;
  onCommit?: () => void;
  constructor(state?: FakeProviderState) { this.state = state ?? { receipts: {}, snapshots: {}, sends: [] }; }
  async contract(): Promise<ProviderContract> { return structuredClone(this.capabilities); }
  async inspect(threadId: string): Promise<ProviderSnapshot> {
    return structuredClone(this.state.snapshots[threadId] ?? { threadId, sequence: 0, complete: true, idle: true, runs: [], emissions: [], activities: [], questions: [], pending: [], issues: [] });
  }
  async lookup(wireJSON: string): Promise<CommandEvidence> {
    if (!this.capabilities.receiptLookup) return { kind: "unknown", evidence: "FAKE receipt lookup disabled." };
    const wire = JSON.parse(wireJSON) as { commandId: string };
    const receipt = this.state.receipts[wire.commandId];
    if (receipt && receipt.digest !== hash(wireJSON)) return { kind: "unknown", evidence: "FAKE conflicting frozen command." };
    return receipt?.result ?? { kind: "absent", evidence: "FAKE authoritative never-accepted command, serialized with sends." };
  }
  async send(wireJSON: string, target: TransportTarget): Promise<CommandEvidence> {
    this.state.sends.push(wireJSON);
    const wire = JSON.parse(wireJSON) as { commandId: string; threadId: string; messageId: string; text: string };
    if (this.state.receipts[wire.commandId]) return this.lookup(wireJSON);
    if (this.unknownWithoutAcceptance) return { kind: "unknown", evidence: "FAKE send lost before acceptance, no local certainty." };
    const s = await this.inspect(wire.threadId);
    const result: CommandEvidence = this.reject || target.kind === "run" && !s.idle
      ? { kind: "rejected", evidence: "FAKE definitive preacceptance rejection." }
      : { kind: "accepted", evidence: "FAKE durable same-ID receipt." };
    this.state.receipts[wire.commandId] = { digest: hash(wireJSON), result };
    if (result.kind === "accepted" && target.kind === "run") {
      s.runs.push({ id: `FAKE:${wire.messageId}`, userMessageId: wire.messageId, inputText: wire.text, status: "running" });
      s.idle = false; s.sequence++; s.pending.push(`runs:FAKE:${wire.messageId}`);
      this.state.snapshots[wire.threadId] = s;
    }
    this.onCommit?.();
    return this.loseResponse ? { kind: "unknown", evidence: "FAKE acceptance response lost." } : result;
  }
}
