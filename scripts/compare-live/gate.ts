/**
 * The Z1 gate (plan stage45, item Z1), registered in advance in gate.json during R0: per task and metric, whether the
 * new side is better or worse than the old; G1 (correct), G2 (better), G3 (not worse); and the chance calibration by
 * exhaustive relabelling. Also R0's spread and the N and K it fixes.
 */
import type { TaskId } from "./tasks.ts";

export type Metric = "wakes" | "tokens" | "turns" | "wallToReportMs";
export const METRICS: Metric[] = ["wakes", "tokens", "turns", "wallToReportMs"];

export interface Gate {
  N: number;
  K: number;
  primary: Metric[];
  secondary: Metric[];
  /** A material regression: the new side's best is above ratio × the old side's worst, or at least plus above it. */
  material: Partial<Record<Metric, { ratio?: number; plus?: number }>>;
  chancePassTarget: number;
}

/** The registered values apart from N and K, which R0's spread fixes. */
export const GATE_RULES: Omit<Gate, "N" | "K"> = {
  primary: ["wakes", "tokens"],
  secondary: ["turns", "wallToReportMs"],
  material: { tokens: { ratio: 1.5 }, wallToReportMs: { ratio: 1.5 }, wakes: { plus: 2 }, turns: { plus: 2 } },
  chancePassTarget: 0.1,
};

/** One job as the gate sees it. A metric that has no value (no report: no wall-clock) counts as the worst value. */
export interface GateRun {
  task: TaskId;
  side: "old" | "new";
  correct: boolean;
  premature: boolean;
  metrics: Record<Metric, number | null>;
}

export type Cell = "better" | "worse" | "neither";

const value = (v: number | null): number => (v === null ? Number.POSITIVE_INFINITY : v);

/** Better: every new run is strictly below every old run. Worse: every new run strictly above every old run. */
export function compareCell(newValues: number[], oldValues: number[]): Cell {
  if (newValues.length === 0 || oldValues.length === 0) return "neither";
  if (Math.max(...newValues) < Math.min(...oldValues)) return "better";
  if (Math.min(...newValues) > Math.max(...oldValues)) return "worse";
  return "neither";
}

export function isMaterial(gate: Gate, metric: Metric, newValues: number[], oldValues: number[]): boolean {
  const rule = gate.material[metric];
  if (!rule || newValues.length === 0 || oldValues.length === 0) return false;
  const newBest = Math.min(...newValues);
  const oldWorst = Math.max(...oldValues);
  if (rule.ratio !== undefined && newBest > rule.ratio * oldWorst) return true;
  if (rule.plus !== undefined && newBest >= oldWorst + rule.plus) return true;
  return false;
}

interface TaskOutcome {
  cells: Record<Metric, Cell>;
  material: Metric[];
}

function taskOutcome(gate: Gate, newRuns: GateRun[], oldRuns: GateRun[]): TaskOutcome {
  const cells = {} as Record<Metric, Cell>;
  const material: Metric[] = [];
  for (const metric of [...gate.primary, ...gate.secondary]) {
    const n = newRuns.map((r) => value(r.metrics[metric]));
    const o = oldRuns.map((r) => value(r.metrics[metric]));
    cells[metric] = compareCell(n, o);
    if (isMaterial(gate, metric, n, o)) material.push(metric);
  }
  return { cells, material };
}

function g2g3(gate: Gate, outcomes: TaskOutcome[]): { g2: boolean; g3: boolean } {
  const count = (metric: Metric, cell: Cell) => outcomes.filter((o) => o.cells[metric] === cell).length;
  const g2 = gate.primary.some((metric) => count(metric, "better") >= gate.K);
  const g3 = [...gate.primary, ...gate.secondary].every((metric) => count(metric, "worse") < gate.K) && outcomes.every((o) => o.material.length === 0);
  return { g2, g3 };
}

const byTask = (runs: GateRun[]): Map<TaskId, GateRun[]> => {
  const tasks = new Map<TaskId, GateRun[]>();
  for (const run of runs) tasks.set(run.task, [...(tasks.get(run.task) ?? []), run]);
  return tasks;
};

export interface Evaluation {
  g1: boolean;
  g2: boolean;
  g3: boolean;
  perTask: Record<string, TaskOutcome & { correct: { old: number; new: number }; premature: { old: number; new: number } }>;
}

/** G1–G3 on the runs as labelled. */
export function evaluate(gate: Gate, runs: GateRun[]): Evaluation {
  const perTask: Evaluation["perTask"] = {};
  const outcomes: TaskOutcome[] = [];
  let g1 = true;
  for (const [task, taskRuns] of byTask(runs)) {
    const newRuns = taskRuns.filter((r) => r.side === "new");
    const oldRuns = taskRuns.filter((r) => r.side === "old");
    const outcome = taskOutcome(gate, newRuns, oldRuns);
    outcomes.push(outcome);
    const correct = { old: oldRuns.filter((r) => r.correct).length, new: newRuns.filter((r) => r.correct).length };
    const premature = { old: oldRuns.filter((r) => r.premature).length, new: newRuns.filter((r) => r.premature).length };
    if (correct.new < correct.old || premature.new > premature.old) g1 = false;
    perTask[task] = { ...outcome, correct, premature };
  }
  return { g1, ...g2g3(gate, outcomes), perTask };
}

/** Every way to choose k of the indices 0..n-1. */
export function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const pick = (start: number, chosen: number[]) => {
    if (chosen.length === k) {
      out.push([...chosen]);
      return;
    }
    for (let i = start; i < n; i++) pick(i + 1, [...chosen, i]);
  };
  pick(0, []);
  return out;
}

export interface Chance {
  /** Labellings counted: the product over tasks of C(runs, new runs). */
  labellings: number;
  /** Share of labellings under which G2 and G3 both hold. */
  chancePass: number;
  /** Share of labellings under which G3 fails. */
  chanceG3Fail: number;
}

/**
 * Exhaustive relabelling: within each task, every way to call as many of its runs "new" as it has new runs; G2 and G3
 * are evaluated for every combination across tasks on the measured values.
 */
export function relabel(gate: Gate, runs: GateRun[]): Chance {
  const perTask: TaskOutcome[][] = [];
  for (const taskRuns of byTask(runs).values()) {
    const k = taskRuns.filter((r) => r.side === "new").length;
    perTask.push(
      combinations(taskRuns.length, k).map((chosen) => {
        const chosenSet = new Set(chosen);
        return taskOutcome(
          gate,
          taskRuns.filter((_, i) => chosenSet.has(i)),
          taskRuns.filter((_, i) => !chosenSet.has(i)),
        );
      }),
    );
  }
  let labellings = 0;
  let pass = 0;
  let g3Fail = 0;
  const walk = (index: number, chosen: TaskOutcome[]) => {
    if (index === perTask.length) {
      labellings += 1;
      const { g2, g3 } = g2g3(gate, chosen);
      if (g2 && g3) pass += 1;
      if (!g3) g3Fail += 1;
      return;
    }
    for (const outcome of perTask[index] ?? []) {
      chosen.push(outcome);
      walk(index + 1, chosen);
      chosen.pop();
    }
  };
  walk(0, []);
  return { labellings, chancePass: labellings === 0 ? 0 : pass / labellings, chanceG3Fail: labellings === 0 ? 0 : g3Fail / labellings };
}

export type Verdict = "PASS" | "NOT DISTINGUISHABLE FROM CHANCE" | "NOT BETTER" | "FAIL";

export function verdict(gate: Gate, runs: GateRun[]): { verdict: Verdict; evaluation: Evaluation; chance: Chance } {
  const evaluation = evaluate(gate, runs);
  const chance = relabel(gate, runs);
  const result: Verdict = !evaluation.g1 || !evaluation.g3 ? "FAIL" : !evaluation.g2 ? "NOT BETTER" : chance.chancePass <= gate.chancePassTarget ? "PASS" : "NOT DISTINGUISHABLE FROM CHANCE";
  return { verdict: result, evaluation, chance };
}

/** Run-to-run spread per task and metric on one side: max / min (1 when equal, Infinity when min is 0 and max is not). */
export function spread(runs: GateRun[]): Record<string, Record<Metric, number>> {
  const out: Record<string, Record<Metric, number>> = {};
  for (const [task, taskRuns] of byTask(runs)) {
    const row = {} as Record<Metric, number>;
    for (const metric of METRICS) {
      const values = taskRuns.map((r) => value(r.metrics[metric]));
      const max = Math.max(...values);
      const min = Math.min(...values);
      row[metric] = max === min ? 1 : min === 0 ? Number.POSITIVE_INFINITY : max / min;
    }
    out[task] = row;
  }
  return out;
}

/** The plan's rule: N = 3 (K = 2) when the spread exceeds 1.5× on tokens or on wall-clock in 2 or more tasks; else N = 2 (K = 3). */
export function chooseNK(spreadByTask: Record<string, Record<Metric, number>>): { N: number; K: number; wideTasks: string[] } {
  const wideTasks = Object.entries(spreadByTask)
    .filter(([, row]) => row.tokens > 1.5 || row.wallToReportMs > 1.5)
    .map(([task]) => task);
  return wideTasks.length >= 2 ? { N: 3, K: 2, wideTasks } : { N: 2, K: 3, wideTasks };
}

/** The two settings the plan allows; N = 2 with K = 2 is the rejected one. */
export function isAllowedSetting(N: number, K: number): boolean {
  return (N === 2 && K === 3) || (N === 3 && K === 2);
}
