/** What the drawer over the overview shows: a room, a thread used on its own, or a browser. */
export type Selection = { kind: "room"; id: string } | { kind: "thread"; id: string } | { kind: "browser"; id: string };
