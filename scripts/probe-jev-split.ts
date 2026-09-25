/**
 * Live probe: can Jev decide how one message splits into assignments? Compares against the deterministic parser.
 *
 * Jev answers only bounded questions (the TypeSafe API has Choice and Noul question types; it cannot write text):
 *   - per name occurrence: is the user assigning a task to this person here, or only mentioning them?
 *   - per ordered pair of people: must X's task wait for Y's task from this same message?
 * Code finds the occurrences, cuts the text at the occurrences Jev marks as assignments, and applies thresholds.
 *
 * Usage: node scripts/probe-jev-split.ts [--cases research/jev-split-cases.json] [--repeat 1..3] [--only id,id]
 * Results go next to the cases file with a -results suffix.
 * Reads JEV_API_KEY from the environment or .env; never prints or saves it. Sends only the synthetic fixture messages.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseExplicit } from "../src/parser/explicit.ts";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-1.13.0";
const CHOICE_CONFIDENCE = 0.8;
const EDGE_YES = 0.85;
const EDGE_NO = 0.15;
const ROOT = new URL("..", import.meta.url).pathname;

interface Case { id: string; message: string; expected: Plan }
type Plan = Array<{ to: string[]; after: string[] }>;
interface Occurrence { id: string; name: string; written: string; start: number; end: number }

function readKey(): string {
  const fromEnv = process.env.JEV_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  for (const line of readFileSync(`${ROOT}.env`, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?JEV_API_KEY\s*=\s*(.*)$/.exec(line);
    if (match) {
      let value = (match[1] ?? "").trim();
      if (/^["']/.test(value)) value = value.slice(1, value.indexOf(value[0] as string, 1));
      else value = value.split(" #")[0]!.trim();
      if (value) return value;
    }
  }
  throw new Error("JEV_API_KEY is missing");
}

function occurrences(message: string, names: string[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const name of names) {
    // @mentions (same URL/path exclusion as the parser) and plain names.
    const at = new RegExp(`(?<![\\w@/.])@${name}(?![\\w/.-]*[\\w/])`, "gi");
    for (const m of message.matchAll(at)) found.push({ id: "", name, written: m[0], start: m.index!, end: m.index! + m[0].length });
    const plain = new RegExp(`(?<![\\w@/.])${name}(?![\\w-])`, "gi");
    for (const m of message.matchAll(plain)) found.push({ id: "", name, written: m[0], start: m.index!, end: m.index! + m[0].length });
  }
  found.sort((a, b) => a.start - b.start);
  found.forEach((o, i) => (o.id = `o${i + 1}`));
  return found;
}

function marked(message: string, occurrence: Occurrence): string {
  return `${message.slice(0, occurrence.start)}⟦${occurrence.written}⟧${message.slice(occurrence.end)}`;
}

function questions(message: string, names: string[], occs: Occurrence[]): Record<string, unknown> {
  const prefix =
    "state.message is one chat message a user sent to a room of coding agents named " + names.join(", ") + ". " +
    "One message can give tasks to several agents. ";
  const result: Record<string, unknown> = {};
  for (const occurrence of occs) {
    result[`role:${occurrence.id}`] = {
      type: "choice",
      instructions:
        prefix +
        `Look only at this occurrence of the name "${occurrence.name}", marked with ⟦ ⟧: ${JSON.stringify(marked(message, occurrence))}. ` +
        `At this marked point, is the user starting to give ${occurrence.name} a task (telling ${occurrence.name} to do something, now or later), ` +
        `or only mentioning ${occurrence.name} (someone whose work, files, or changes are referred to, someone to talk to, or text inside a link)?`,
      criteria: {
        assign: `The marked occurrence addresses ${occurrence.name} with a task.`,
        mention: `The marked occurrence only refers to ${occurrence.name}; the task (if any) belongs to someone else.`,
        unclear: "Cannot tell.",
      },
    };
  }
  for (const x of names) {
    for (const y of names) {
      if (x === y) continue;
      result[`wait:${x}:${y}`] = {
        type: "noul",
        instructions:
          prefix +
          `Must ${x}'s task from this message start only after ${y}'s task from this same message is finished? ` +
          `True when the user says or clearly implies ${x} waits for ${y}: "then", "once done", "after", or ${x} reviewing, checking, or testing ${y}'s result. ` +
          `False when they can work at the same time, when ${x} or ${y} has no task in this message, or when ${y} is only mentioned.`,
        criteria: {
          true: `${x} must wait for ${y}'s task from this message.`,
          false: `${x} does not need to wait for ${y}, or one of them has no task here.`,
        },
      };
    }
  }
  return result;
}

interface ChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
interface NoulAnswer { type: "noul"; noul: number }

function interpret(message: string, occs: Occurrence[], answers: Record<string, ChoiceAnswer | NoulAnswer>) {
  const concerns: string[] = [];
  const addresses: Occurrence[] = [];
  for (const occurrence of occs) {
    const answer = answers[`role:${occurrence.id}`] as ChoiceAnswer;
    if (answer.choice === "unclear" || answer.confidence < CHOICE_CONFIDENCE) concerns.push(`uncertain ${occurrence.written}@${occurrence.start}`);
    else if (answer.choice === "assign") addresses.push(occurrence);
  }
  // Adjacent addresses joined only by "and", commas, or "&" share one assignment.
  const groups: Occurrence[][] = [];
  for (const address of addresses) {
    const last = groups[groups.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous && /^[\s,&]*(?:and)?[\s,]*$/i.test(message.slice(previous.end, address.start))) last.push(address);
    else groups.push([address]);
  }
  const plan: Plan = [];
  const texts: string[] = [];
  groups.forEach((group, index) => {
    const to = [...new Set(group.map((o) => o.name))];
    const after = new Set<string>();
    for (let other = 0; other < groups.length; other += 1) {
      if (other === index) continue;
      for (const x of to) {
        for (const y of new Set(groups[other]!.map((o) => o.name))) {
          if (x === y) continue;
          const p = (answers[`wait:${x}:${y}`] as NoulAnswer).noul;
          if (p >= EDGE_YES) after.add(y);
          else if (p > EDGE_NO) concerns.push(`uncertain wait ${x}→${y} (${p})`);
        }
      }
    }
    plan.push({ to, after: [...after].sort() });
    const end = groups[index + 1]?.[0]?.start ?? message.length;
    texts.push(message.slice(group[group.length - 1]!.end, end).trim());
  });
  if (plan.length === 0) concerns.push("no assignment found");
  for (const a of plan) for (const y of a.after) if (plan.some((b) => b.to.includes(y) && a.to.some((x) => b.after.includes(x)))) concerns.push(`cycle ${a.to.join("+")}↔${y}`);
  return { status: concerns.length > 0 ? "clarify" : "ready", plan, texts, concerns };
}

function deterministic(message: string, names: string[]): Plan {
  const participants = names.map((name) => ({ id: name, alias: name }));
  const draft = parseExplicit(message, participants, []);
  return draft.assignments.map((a) => ({
    to: a.recipients,
    after: [...new Set(a.after.flatMap((d) => draft.assignments[d.index]!.recipients))].sort(),
  }));
}

const same = (a: Plan, b: Plan) => JSON.stringify(a.map((x) => ({ to: [...x.to].sort(), after: x.after }))) === JSON.stringify(b.map((x) => ({ to: [...x.to].sort(), after: [...x.after].sort() })));

async function main() {
  const args = process.argv.slice(2);
  const repeat = Math.min(3, Math.max(1, Number(args[args.indexOf("--repeat") + 1] ?? 1) || 1));
  const only = args.includes("--only") ? new Set((args[args.indexOf("--only") + 1] ?? "").split(",")) : null;
  const casesFile = args.includes("--cases") ? (args[args.indexOf("--cases") + 1] as string) : "research/jev-split-cases.json";
  const outFile = casesFile.replace(/\.json$/, "") + "-results.json";
  const fixture = JSON.parse(readFileSync(`${ROOT}${casesFile}`, "utf8")) as { participants: string[]; cases: Case[] };
  const cases = fixture.cases.filter((c) => !only || only.has(c.id));
  const key = readKey();
  const runs: unknown[] = [];
  let jevExact = 0, jevReady = 0, jevWrongReady = 0, ruleExact = 0, inputTokens = 0;
  const latencies: number[] = [];
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    for (const testCase of cases) {
      const names = fixture.participants;
      const occs = occurrences(testCase.message, names);
      const payload = { model: MODEL, state: { message: testCase.message, participants: names }, questions: questions(testCase.message, names, occs) };
      const started = performance.now();
      const response = await fetch(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(payload) });
      const latency = Math.round(performance.now() - started);
      if (!response.ok) throw new Error(`Jev returned HTTP ${response.status} for ${testCase.id}; body omitted`);
      const body = (await response.json()) as { answers: Record<string, ChoiceAnswer | NoulAnswer>; usage?: { input_tokens?: number } };
      latencies.push(latency);
      inputTokens += body.usage?.input_tokens ?? 0;
      const jev = interpret(testCase.message, occs, body.answers);
      const rules = deterministic(testCase.message, names);
      const jevOk = jev.status === "ready" && same(jev.plan, testCase.expected);
      const rulesOk = same(rules, testCase.expected);
      if (jevOk) jevExact += 1;
      if (jev.status === "ready") jevReady += 1;
      if (jev.status === "ready" && !jevOk) jevWrongReady += 1;
      if (rulesOk && repetition === 1) ruleExact += 1;
      const fmt = (p: Plan) => p.map((a) => a.to.join("+") + (a.after.length ? `←${a.after.join("+")}` : "")).join(" | ");
      console.log(
        `${jevOk ? "✔" : jev.status === "clarify" ? "?" : "✖"} jev  ${rulesOk ? "✔" : "✖"} rules  ${testCase.id.padEnd(20)} jev: ${jev.status === "ready" ? fmt(jev.plan) : `clarify (${jev.concerns.join("; ")})`}   rules: ${fmt(rules)}   expected: ${fmt(testCase.expected)}  ${latency}ms`,
      );
      runs.push({ caseId: testCase.id, repetition, message: testCase.message, occurrences: occs, answers: body.answers, jev, rules, expected: testCase.expected, jevOk, rulesOk, latencyMs: latency });
    }
  }
  const total = cases.length * repeat;
  const summary = {
    model: MODEL,
    runs: total,
    jevExact,
    jevReady,
    jevWrongWhenReady: jevWrongReady,
    jevClarify: total - jevReady,
    rulesExact: ruleExact,
    cases: cases.length,
    medianLatencyMs: latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)],
    inputTokens,
    estimatedUsd: Math.round((inputTokens / 1_000_000) * 0.042 * 1e6) / 1e6,
  };
  console.log(JSON.stringify(summary));
  const report = JSON.stringify({ createdAt: new Date().toISOString(), endpoint: ENDPOINT, thresholds: { CHOICE_CONFIDENCE, EDGE_YES, EDGE_NO }, summary, runs }, null, 2);
  if (report.includes(key)) throw new Error("refusing to save a report containing the credential");
  writeFileSync(`${ROOT}${outFile}`, `${report}\n`);
}

main().catch((error) => {
  console.error(String((error as Error).message));
  process.exit(1);
});
