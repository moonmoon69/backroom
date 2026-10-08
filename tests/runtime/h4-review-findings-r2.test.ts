/**
 * H4 review round 2 (Opus6): the bound's failure notice for a send that never got through says what is true. Copy into
 * <checkout>/tests/runtime/ and run with node --test. Fails on 34ced2b.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { T3OutcomeUnknown, T3Unavailable } from "../../src/adapter/types.ts";
import { Room } from "./helpers.ts";

let room: Room;
afterEach(() => room?.close());

async function failWith(error: () => Error): Promise<string> {
  room = await Room.create({ seats: ["W"], orchestrator: null });
  (room.fake as unknown as { sendMessage: () => Promise<void> }).sendMessage = async () => {
    throw error();
  };
  const a = room.user("W", "Job.");
  for (let i = 0; i < 20; i++) {
    room.clock += 15_000;
    await room.tick();
  }
  assert.equal(room.notices().length, 1, "the run failed after the bound");
  assert.equal(room.state(a), "open");
  return room.notices()[0]!.body;
}

test("R2-F1a: a send T3 never answered (its limit, or the socket went while it waited): the notice does not say it did not reach T3, nor that it is sent again, and says T3 may still run it", async () => {
  const body = await failWith(() => new T3OutcomeUnknown("T3 RPC orchestration.dispatchCommand timed out after 60000ms"));
  console.log("R2-F1a notice:", body);
  assert.doesNotMatch(body, /sent again/, "the run has stopped: nothing is sent again");
  assert.doesNotMatch(body, /did not reach T3|could not get .* to T3/, "T3 may have taken it: unknown, not undelivered");
  assert.match(body, /may still/, "like the reused-ID notice: T3 may still run the turn");
});

test("R2-F1b: a send that could not be made at all (no socket): the notice does not say it is sent again", async () => {
  const body = await failWith(() => new T3Unavailable("cannot reach T3 at http://127.0.0.1:3773: connect ECONNREFUSED"));
  console.log("R2-F1b notice:", body);
  assert.doesNotMatch(body, /sent again/, "the run has stopped: nothing is sent again");
});
