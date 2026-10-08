/**
 * The Z1 gate on constructed data: the relabelling counts the plan computed exhaustively (and the reviewer's
 * stage45-review-r6.md reproduced), N and K from R0's spread, and the registered gate.json.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GATE_RULES, chooseNK, compareCell, evaluate, isAllowedSetting, relabel, spread, verdict, type Gate, type GateRun, type Metric } from "./gate.ts";
import type { TaskId } from "./tasks.ts";

const TASKS: TaskId[] = ["T1", "T2", "T3", "T4"];

/** N runs per side per task, every run of a side equal on every metric. */
function constant(N: number, old: Partial<Record<Metric, number>>, next: Partial<Record<Metric, number>>): GateRun[] {
  const base: Record<Metric, number> = { wakes: 3, tokens: 100_000, turns: 8, wallToReportMs: 600_000 };
  const runs: GateRun[] = [];
  for (const task of TASKS) {
    for (let i = 0; i < N; i++) {
      runs.push({ task, side: "old", correct: true, premature: false, metrics: { ...base, ...old } });
      runs.push({ task, side: "new", correct: true, premature: false, metrics: { ...base, ...next } });
    }
  }
  return runs;
}

const gate = (N: number, K: number): Gate => ({ ...GATE_RULES, N, K });
const pct = (share: number) => Math.round(share * 10000) / 100;

describe("cells", () => {
  test("better and worse need no overlap; ties are neither", () => {
    assert.equal(compareCell([1, 2], [3, 4]), "better");
    assert.equal(compareCell([3, 4], [1, 2]), "worse");
    assert.equal(compareCell([2, 3], [3, 4]), "neither");
    assert.equal(compareCell([0, 0], [0, 0]), "neither");
  });
});

describe("relabelling", () => {
  test("identical runs: the observed labelling does not pass, and chance-pass is 0", () => {
    for (const [N, K] of [[2, 3], [3, 2]] as const) {
      const runs = constant(N, {}, {});
      const result = verdict(gate(N, K), runs);
      assert.equal(result.evaluation.g2, false);
      assert.notEqual(result.verdict, "PASS");
      assert.equal(result.chance.chancePass, 0);
    }
  });

  test("moderate consistent effect (wakes 2 vs 3, tokens 80k vs 100k) passes at both registered settings", () => {
    const moderate = (N: number) => constant(N, { wakes: 3, tokens: 100_000 }, { wakes: 2, tokens: 80_000 });
    const n2 = verdict(gate(2, 3), moderate(2));
    assert.equal(n2.verdict, "PASS");
    assert.equal(n2.chance.labellings, 1296);
    assert.equal(pct(n2.chance.chancePass), 1.62);
    assert.equal(pct(n2.chance.chanceG3Fail), 1.62);
    const n3 = verdict(gate(3, 2), moderate(3));
    assert.equal(n3.verdict, "PASS");
    assert.equal(n3.chance.labellings, 160_000);
    assert.equal(pct(n3.chance.chancePass), 1.4);
    assert.equal(pct(n3.chance.chanceG3Fail), 1.4);
  });

  test("large effect (wakes 1 vs 4, tokens 100k vs 200k)", () => {
    const large = (N: number) => constant(N, { wakes: 4, tokens: 200_000 }, { wakes: 1, tokens: 100_000 });
    const n2 = verdict(gate(2, 3), large(2));
    assert.equal(n2.verdict, "PASS");
    assert.equal(pct(n2.chance.chancePass), 1.31);
    assert.equal(pct(n2.chance.chanceG3Fail), 51.77);
    const n3 = verdict(gate(3, 2), large(3));
    assert.equal(n3.verdict, "PASS");
    assert.equal(pct(n3.chance.chancePass), 1.26);
    assert.equal(pct(n3.chance.chanceG3Fail), 18.55);
  });

  test("the rejected setting N = 2, K = 2 reads 12.73% on the moderate data: not distinguishable from chance", () => {
    const result = verdict(gate(2, 2), constant(2, { wakes: 3, tokens: 100_000 }, { wakes: 2, tokens: 80_000 }));
    assert.equal(pct(result.chance.chancePass), 12.73);
    assert.equal(result.verdict, "NOT DISTINGUISHABLE FROM CHANCE");
    assert.equal(isAllowedSetting(2, 2), false);
  });

  test("G1: fewer correct runs or more premature reports on the new side fail, whatever the metrics", () => {
    const runs = constant(2, { wakes: 4, tokens: 200_000 }, { wakes: 1, tokens: 100_000 });
    const first = runs.find((r) => r.side === "new");
    assert.ok(first);
    first.correct = false;
    assert.equal(evaluate(gate(2, 3), runs).g1, false);
    assert.equal(verdict(gate(2, 3), runs).verdict, "FAIL");
  });

  test("G3: a material regression on one task fails even when everything else is better", () => {
    const runs = constant(2, { wakes: 3, tokens: 100_000 }, { wakes: 2, tokens: 80_000 });
    for (const run of runs) if (run.task === "T4" && run.side === "new") run.metrics.turns = 10; // old 8: 10 >= 8 + 2
    const result = evaluate(gate(2, 3), runs);
    assert.equal(result.g3, false);
    assert.deepEqual(result.perTask.T4?.material, ["turns"]);
  });
});

describe("N and K from R0's spread", () => {
  const oldRuns = (pairs: Record<TaskId, [number, number]>, metric: Metric): GateRun[] =>
    TASKS.flatMap((task) =>
      pairs[task].map((v) => ({ task, side: "old" as const, correct: true, premature: false, metrics: { wakes: 2, tokens: 100, turns: 5, wallToReportMs: 100, [metric]: v } })),
    );

  test("spread above 1.5x on tokens or wall-clock in 2 or more tasks gives N = 3, K = 2", () => {
    const tokens = spread(oldRuns({ T1: [100, 200], T2: [100, 120], T3: [100, 151], T4: [100, 100] }, "tokens"));
    assert.deepEqual(chooseNK(tokens), { N: 3, K: 2, wideTasks: ["T1", "T3"] });
  });

  test("otherwise N = 2, K = 3; exactly 1.5x is not above it", () => {
    const wall = spread(oldRuns({ T1: [100, 150], T2: [100, 300], T3: [100, 110], T4: [100, 100] }, "wallToReportMs"));
    assert.deepEqual(chooseNK(wall), { N: 2, K: 3, wideTasks: ["T2"] });
  });

  test("a wide spread on wakes or turns does not count", () => {
    const wakes = spread(oldRuns({ T1: [1, 5], T2: [1, 5], T3: [1, 5], T4: [1, 5] }, "wakes"));
    assert.equal(chooseNK(wakes).N, 2);
  });
});

describe("gate.json", () => {
  const path = join(import.meta.dirname, "gate.json");
  test("when registered, it carries the plan's rules and an allowed N and K, never N = 2 with K = 2", { skip: !existsSync(path) }, () => {
    const registered = JSON.parse(readFileSync(path, "utf8")) as Gate & Record<string, unknown>;
    assert.deepEqual(registered.primary, GATE_RULES.primary);
    assert.deepEqual(registered.secondary, GATE_RULES.secondary);
    assert.deepEqual(registered.material, GATE_RULES.material);
    assert.equal(registered.chancePassTarget, 0.1);
    assert.ok(isAllowedSetting(registered.N, registered.K), `N = ${registered.N}, K = ${registered.K}`);
  });
});
