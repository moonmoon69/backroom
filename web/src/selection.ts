import type { EngineShelfThread } from "./types.ts";

/**
 * What the drawer over the overview shows: a room, a thread used on its own, or a browser. An archived thread carries
 * its shelf row: T3 serves an archived thread by id to nobody, so the row is all its panel shows.
 */
export type Selection = { kind: "room"; id: string } | { kind: "thread"; id: string; archived?: EngineShelfThread } | { kind: "browser"; id: string };
