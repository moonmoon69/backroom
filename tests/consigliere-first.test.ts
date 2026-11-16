import assert from "node:assert/strict";
import { test } from "node:test";
import { consigliereFirst } from "../web/src/chat.ts";

test("a room's members are listed with its Consigliere first, the others as they were seated", () => {
  const seated = ["ada", "bo", "cy", "dee"];
  assert.deepEqual(consigliereFirst(seated, (alias) => alias === "cy"), ["cy", "ada", "bo", "dee"]);
  // Seated last by a reseat, first all the same.
  assert.deepEqual(consigliereFirst(seated, (alias) => alias === "dee"), ["dee", "ada", "bo", "cy"]);
  assert.deepEqual(consigliereFirst(seated, (alias) => alias === "ada"), seated);
});

test("a room without a Consigliere keeps its seating order", () => {
  const seated = ["ada", "bo"];
  assert.deepEqual(consigliereFirst(seated, () => false), seated);
  assert.deepEqual(consigliereFirst([], () => true), []);
});
