import type { Projection, RoomEvent } from "./types.ts";

const deleted = Symbol("deleted");
/** Only changed entries are copied; reads never grant ownership of the base value. */
export class EntryOverlay<K, V> extends Map<K, V> {
  readonly changes = new Map<K, V | typeof deleted>();
  private readonly appended = new Set<K>();
  readonly base: Map<K, V>;
  constructor(base: Map<K, V>) { super(); this.base = base; }
  override get(key: K): V | undefined {
    const value = this.changes.get(key);
    return value === deleted ? undefined : this.changes.has(key) ? value as V : this.base.get(key);
  }
  override has(key: K): boolean { return this.changes.has(key) ? this.changes.get(key) !== deleted : this.base.has(key); }
  override set(key: K, value: V): this {
    if (!this.has(key)) { this.appended.delete(key); this.appended.add(key); }
    this.changes.set(key, value); return this;
  }
  override delete(key: K): boolean { const had = this.has(key); this.appended.delete(key); this.changes.set(key, deleted); return had; }
  discardChanges(): void { this.changes.clear(); this.appended.clear(); }
  override clear(): void { for (const key of this.keys()) this.delete(key); }
  override get size(): number { let n = this.base.size; for (const [k, v] of this.changes) n += v === deleted ? -Number(this.base.has(k)) : Number(!this.base.has(k)); return n; }
  override *entries(): MapIterator<[K, V]> {
    // Preserve native Map insertion order, including delete followed by set.
    for (const [k, v] of this.base) if (!this.appended.has(k)) {
      if (!this.changes.has(k)) yield [k, v]; else if (this.changes.get(k) !== deleted) yield [k, this.changes.get(k) as V];
    }
    for (const k of this.appended) yield [k, this.get(k)!];
  }
  override *keys(): MapIterator<K> { for (const [k] of this.entries()) yield k; }
  override *values(): MapIterator<V> { for (const [, v] of this.entries()) yield v; }
  override [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
  override forEach(callback: (value: V, key: K, map: Map<K, V>) => void, thisArg?: unknown): void { for (const [k, v] of this) callback.call(thisArg, v, k, this); }
  edit(key: K): V {
    if (!this.has(key)) throw new Error("missing journal-derived entry");
    if (!this.changes.has(key)) this.set(key, structuredClone(this.base.get(key)!));
    return this.get(key)!;
  }
  publish(): void {
    for (const [k, v] of this.changes) if (v === deleted || this.appended.has(k)) this.base.delete(k); else this.base.set(k, v);
    for (const k of this.appended) this.base.set(k, this.get(k)!);
  }
}
class SetOverlay<T> extends Set<T> {
  readonly added = new Set<T>();
  readonly base: Set<T>;
  constructor(base: Set<T>) { super(); this.base = base; }
  override has(value: T): boolean { return this.added.has(value) || this.base.has(value); }
  override add(value: T): this { this.added.add(value); return this; }
  override get size(): number { let n = this.base.size; for (const v of this.added) if (!this.base.has(v)) n++; return n; }
  override *values(): SetIterator<T> { yield* this.base; for (const v of this.added) if (!this.base.has(v)) yield v; }
  override keys(): SetIterator<T> { return this.values(); }
  override *entries(): SetIterator<[T, T]> { for (const v of this.values()) yield [v, v]; }
  override [Symbol.iterator](): SetIterator<T> { return this.values(); }
  override forEach(callback: (value: T, value2: T, set: Set<T>) => void, thisArg?: unknown): void { for (const v of this) callback.call(thisArg, v, v, this); }
  publish(): void { for (const v of this.added) this.base.add(v); }
}
export const projectionMaps = ["seats", "requests", "runs", "activities", "sourceKeys", "blocked"] as const;
export type ProjectionMap = typeof projectionMaps[number];
export function editEntry<N extends ProjectionMap>(p: Projection, name: N, key: string): NonNullable<ReturnType<Projection[N]["get"]>> {
  const map = p[name] as Map<string, unknown>;
  return (map instanceof EntryOverlay ? map.edit(key) : map.get(key)) as NonNullable<ReturnType<Projection[N]["get"]>>;
}

interface History {
  events: Map<string, RoomEvent>;
  prefixes: Map<string, true>;
  errorNotices: Map<string, true>;
}
const histories = new WeakMap<Projection, History>();
function emptyHistory(): History { return { events: new Map(), prefixes: new Map(), errorNotices: new Map() }; }
export function initializeHistory(p: Projection): void { histories.set(p, emptyHistory()); }
export function journalHistory(p: Projection): History {
  let h = histories.get(p);
  if (!h) { h = emptyHistory(); histories.set(p, h); for (const e of p.events) rememberEvent(p, e); }
  return h;
}
export function rememberEvent(p: Projection, event: RoomEvent): void {
  const h = journalHistory(p);
  if (h.events.has(event.id)) throw new Error("invalid event order or identity");
  h.events.set(event.id, event);
  for (let i = event.id.indexOf("/"); i >= 0; i = event.id.indexOf("/", i + 1)) h.prefixes.set(event.id.slice(0, i), true);
  if (event.data.kind === "notice" && event.data.intent === "error") h.errorNotices.set(event.data.causeId, true);
}

/** A readonly array facade avoids copying the journal on every append. Rare prefix reads still replay. */
function eventView(base: readonly RoomEvent[], suffix: readonly RoomEvent[], length: () => number): readonly RoomEvent[] {
  const at = (i: number) => i < base.length ? base[i] : suffix[i - base.length];
  return new Proxy([] as RoomEvent[], {
    get(target, prop) {
      if (prop === "length") return length();
      if (typeof prop === "string" && /^(0|[1-9][0-9]*)$/.test(prop)) return Number(prop) < length() ? at(Number(prop)) : undefined;
      return Reflect.get(target, prop);
    },
    has(target, prop) { return typeof prop === "string" && /^(0|[1-9][0-9]*)$/.test(prop) ? Number(prop) < length() : Reflect.has(target, prop); },
  });
}

/** The committed projection is untouched until publish, including nested decision effects. */
export class ProjectionOverlay {
  p: Projection;
  readonly events: RoomEvent[] = [];
  private readonly layers: Projection[] = [];
  readonly base: Projection;
  constructor(base: Projection) { this.base = base; this.p = base; this.nextLayer(); }
  nextLayer(): Projection {
    const initial = this.p;
    // Freeze the prior layer's journal view when entering a nested decision.
    if (this.layers.length) { const n = this.base.events.length + this.events.length; initial.events = eventView(this.base.events, this.events, () => n); }
    const next = { ...initial, commandKeys: new SetOverlay(initial.commandKeys) };
    for (const name of projectionMaps) (next[name] as Map<string, unknown>) = new EntryOverlay(initial[name] as Map<string, unknown>);
    const prior = journalHistory(initial), h = emptyHistory();
    for (const name of Object.keys(h) as (keyof History)[]) (h[name] as Map<string, unknown>) = new EntryOverlay(prior[name] as Map<string, unknown>);
    histories.set(next, h);
    next.events = eventView(this.base.events, this.events, () => this.base.events.length + this.events.length);
    this.p = next; this.layers.push(next); return initial;
  }
  publish(): void {
    for (const layer of [...this.layers].reverse()) {
      for (const name of projectionMaps) (layer[name] as EntryOverlay<string, unknown>).publish();
      (layer.commandKeys as SetOverlay<string>).publish();
      for (const map of Object.values(journalHistory(layer))) (map as EntryOverlay<string, unknown>).publish();
    }
    (this.base.events as RoomEvent[]).push(...this.events);
    this.base.subscriptions = this.p.subscriptions; this.base.orchestrator = this.p.orchestrator;
  }
  /** SQL only needs final changed entries, never a clone or traversal of the complete map. */
  affected(name: ProjectionMap): Set<string> {
    const keys = new Set<string>();
    for (const layer of this.layers) for (const key of (layer[name] as EntryOverlay<string, unknown>).changes.keys()) keys.add(key);
    return keys;
  }
}
