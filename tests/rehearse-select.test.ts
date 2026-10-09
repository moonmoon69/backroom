import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { forStep, forSteps, functionSource, matching, sectionNames, Selection, SelectionDone, stateNames } from "../scripts/rehearse-select.ts";

const names = ["the overview opens", "Esc closes a menu", "a post's detail", "Esc in a dialog", "the end"];

describe("rehearsal state selection (T2: --only, --until)", () => {
  it("reads every kind of state call from the source, in order, and nothing else", () => {
    const source = [
      'await state("first, with \\"quotes\\"", where);',
      "await check.state(",
      '  "second", (x) => x, []);',
      'await two.state("third", (x) => x, []);',
      'check.begin("fourth");',
      'room.board("fable", "state", "not a state");',
      "const state = async (name: string) => {};",
      'await barSays("not a state either", {});',
    ].join("\n");
    assert.deepEqual(stateNames(source), ['first, with "quotes"', "second", "third", "fourth"]);
  });

  it("cuts a top-level function out of a module", () => {
    const source = "const a = 1;\nasync function one() {\n  state(\"x\");\n}\n\nfunction two() {\n  state(\"y\");\n}\n";
    assert.deepEqual(stateNames(functionSource(source, "one")), ["x"]);
    assert.deepEqual(stateNames(functionSource(source, "two")), ["y"]);
    assert.throws(() => functionSource(source, "three"), /no function three/);
  });

  it("names a state by number, range, /pattern/ or any part of its name", () => {
    assert.deepEqual(matching(names, "2"), [1]);
    assert.deepEqual(matching(names, "2-4"), [1, 2, 3]);
    assert.deepEqual(matching(names, "/^Esc/"), [1, 3]);
    assert.deepEqual(matching(names, "esc"), [1, 3]);
    assert.deepEqual(matching(names, "post's DETAIL"), [2]);
    assert.deepEqual(matching(names, "nothing like it"), []);
    assert.deepEqual(matching(names, "9"), []);
  });

  it("with no flags, checks every state and never stops early", () => {
    const selection = new Selection(names);
    assert.equal(selection.whole, true);
    for (const name of names) {
      const { index, loud } = selection.enter(name);
      assert.equal(loud, true);
      selection.leave(index);
    }
  });

  it("--only checks the states it names, sets up the ones before them silently, and stops after the last", () => {
    const selection = new Selection(names, ["Esc"]);
    assert.equal(selection.first, 1);
    assert.equal(selection.last, 3);
    const seen = names.slice(0, 4).map((name) => {
      const { index, loud } = selection.enter(name);
      if (index < 3) selection.leave(index);
      return loud;
    });
    assert.deepEqual(seen, [false, true, false, true]);
    assert.throws(() => selection.leave(3), (error: unknown) => error instanceof SelectionDone && /2 states checked .*; 2 set up silently; stopped after state 4 of 5/.test(error.message));
  });

  it("a state whose checks go on after its call stops the step only when the next state begins", () => {
    const selection = new Selection(names, ["2"]);
    assert.equal(selection.enter(names[0]!).loud, false);
    assert.equal(selection.enter(names[1]!).loud, true);
    assert.throws(() => selection.enter(names[2]!), (error: unknown) => error instanceof SelectionDone && /1 state checked .*; 1 set up silently; stopped after state 2 of 5/.test(error.message));
  });

  it("past the last state played, work that leads only to later states is not started", () => {
    const selection = new Selection(names, [], "1");
    selection.stopIfDone();
    selection.enter(names[0]!);
    assert.throws(() => selection.stopIfDone(), SelectionDone);
    const whole = new Selection(names);
    for (const name of names) whole.enter(name);
    assert.doesNotThrow(() => whole.stopIfDone());
  });

  it("--until checks every state up to the one it names and stops there", () => {
    const selection = new Selection(names, [], "post's detail");
    assert.equal(selection.whole, false);
    assert.deepEqual([0, 1, 2, 3].map((i) => selection.loud(i)), [true, true, true, false]);
    selection.enter(names[0]!);
    selection.leave(0);
    selection.enter(names[1]!);
    selection.leave(1);
    selection.enter(names[2]!);
    assert.throws(() => selection.leave(2), SelectionDone);
  });

  it("counts a section a jump skips, and keeps its place in the list", () => {
    const selection = new Selection(names, ["4"]);
    selection.skip(2);
    assert.equal(selection.at, 2);
    assert.equal(selection.enter(names[2]!).loud, false);
    const { index, loud } = selection.enter(names[3]!);
    assert.equal(loud, true);
    assert.throws(() => selection.leave(index), (error: unknown) => error instanceof SelectionDone && /1 state checked .*; 1 set up silently, 2 not played; stopped after state 4 of 5/.test(error.message));
  });

  it("refuses what it cannot honour: no match, --until before every --only, two states of one name, a list out of step", () => {
    assert.throws(() => new Selection(names, ["nothing like it"]), /no state matches --only "nothing like it"/);
    assert.throws(() => new Selection(names, [], "99"), /no state matches --until "99"/);
    assert.throws(() => new Selection(names, ["the end"], "1"), /stops before every state --only names/);
    assert.throws(() => new Selection(["a", "b", "a"]), /two states share the name "a"/);
    assert.throws(() => new Selection(names).enter("Esc closes a menu"), /out of step with the script: state 1 is "the overview opens" in the source, but the script runs "Esc closes a menu"/);
  });

  it("--step all refuses a name no step has, rather than leaving every step out", () => {
    const steps = { ui: ["a turn fails", "Retry from the page"], keys: ["Esc closes a menu", "a post's actions"] };
    assert.throws(() => forSteps(steps, ["zzzz"], null), /no state of any step matches --only "zzzz"/);
    assert.throws(() => forSteps(steps, ["Retry", "typo"], null), /no state of any step matches --only "typo"/);
    assert.throws(() => forSteps(steps, [], "zzzz"), /no state of any step matches --until "zzzz"/);
    assert.deepEqual(forSteps(steps, ["Retry"], null), { ui: { run: true, only: ["Retry"], until: null }, keys: { run: false, only: [], until: null } });
    assert.deepEqual(forSteps(steps, ["2"], null).keys, { run: true, only: ["2"], until: null });
  });

  it("reads the sections' first states from the source", () => {
    assert.deepEqual(sectionNames('if (await section("a", {})) {\n  await state("a", w);\n}\nif (await section(\n  "b")) {}'), ["a", "b"]);
  });

  it("a step in sections: a run jumps into the section of the first state checked, skipping those before it", () => {
    const sections = [names[0]!, names[2]!, names[4]!];
    const selection = new Selection(names, ["Esc in a dialog"], null, sections);
    assert.equal(selection.jumps, true);
    assert.equal(selection.section(names[0]!), "skip");
    assert.equal(selection.at, 2);
    assert.equal(selection.section(names[2]!), "jump");
    assert.equal(selection.enter(names[2]!).loud, false);
    const { index, loud } = selection.enter(names[3]!);
    assert.equal(loud, true);
    assert.throws(() => selection.leave(index), (error: unknown) => error instanceof SelectionDone && /1 state checked .*; 1 set up silently, 2 not played; stopped after state 4 of 5/.test(error.message));
  });

  it("a step in sections plays them all from the start when the first state checked is in the first one", () => {
    const sections = [names[0]!, names[2]!];
    for (const selection of [new Selection(names, [], null, sections), new Selection(names, ["2"], null, sections), new Selection(names, [], "4", sections)]) {
      assert.equal(selection.jumps, false);
      assert.equal(selection.section(names[0]!), "play");
      selection.enter(names[0]!);
      selection.enter(names[1]!);
      if (selection.loud(2)) assert.equal(selection.section(names[2]!), "play");
    }
  });

  it("refuses sections that do not fit the states", () => {
    assert.throws(() => new Selection(names, [], null, ["nothing like it"]), /a section starts at "nothing like it", which is no state's name/);
    assert.throws(() => new Selection(names, [], null, [names[1]!]), /the first section must start at the step's first state/);
    assert.throws(() => new Selection(names, [], null, [names[0]!, names[3]!, names[2]!]), /not in the order of their states/);
    const selection = new Selection(names, [], null, [names[0]!, names[2]!]);
    selection.section(names[0]!);
    selection.enter(names[0]!);
    assert.throws(() => selection.section(names[2]!), /begins with the script at state 2: the sections are out of step/);
  });

  it("--step all: each step runs with the flags that name its own states, or not at all", () => {
    const keys = ["Esc closes a menu", "a post's actions"];
    const ui = ["a turn fails", "Retry from the page"];
    assert.deepEqual(forStep(ui, [], null), { run: true, only: [], until: null });
    assert.deepEqual(forStep(keys, ["Esc closes", "Retry"], null), { run: true, only: ["Esc closes"], until: null });
    assert.deepEqual(forStep(ui, ["Esc closes", "Retry"], null), { run: true, only: ["Retry"], until: null });
    assert.deepEqual(forStep(ui, ["Esc closes"], null), { run: false, only: [], until: null });
    assert.deepEqual(forStep(ui, [], "2"), { run: true, only: [], until: "2" });
    assert.deepEqual(forStep(keys, [], "Retry"), { run: false, only: [], until: null });
    assert.deepEqual(forStep(ui, ["Retry"], "fails"), { run: true, only: ["Retry"], until: "fails" });
  });

  it("finds the rehearsal scripts' states, each named once", () => {
    const rehearse = readFileSync(new URL("../scripts/rehearse.ts", import.meta.url), "utf8");
    const steps = {
      ui: [...stateNames(functionSource(rehearse, "rehearseUi")), ...stateNames(functionSource(rehearse, "rehearseAgentsFile"))],
      room: [...stateNames(functionSource(rehearse, "rehearseRoom")), ...stateNames(functionSource(rehearse, "rehearseBrowserPanel"))],
      keys: stateNames(readFileSync(new URL("../scripts/rehearse-keys.ts", import.meta.url), "utf8")),
    };
    for (const [step, list] of Object.entries(steps)) {
      assert.ok(list.length > 20, `${step}: ${list.length} states`);
      assert.doesNotThrow(() => new Selection(list), step);
    }
    const sections = {
      ui: [...sectionNames(functionSource(rehearse, "rehearseUi")), ...sectionNames(functionSource(rehearse, "rehearseAgentsFile"))],
      room: [...sectionNames(functionSource(rehearse, "rehearseRoom")), ...sectionNames(functionSource(rehearse, "rehearseBrowserPanel"))],
      keys: sectionNames(readFileSync(new URL("../scripts/rehearse-keys.ts", import.meta.url), "utf8")),
    };
    for (const [step, firsts] of Object.entries(sections)) {
      assert.ok(firsts.length > 5, `${step}: ${firsts.length} sections`);
      assert.doesNotThrow(() => new Selection(steps[step as keyof typeof steps], [], null, firsts), `${step}'s sections`);
    }
  });
});
