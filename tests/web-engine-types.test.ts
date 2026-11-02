/**
 * The web keeps hand copies of the read API's shapes (web/src/types.ts, as it does for every server shape). These
 * checks make `npm run typecheck` fail when a copy and src/domain/engineView.ts drift apart: each pair must be
 * assignable both ways. The run-time test only says so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Server from "../src/domain/engineView.ts";
import type * as Web from "../web/src/types.ts";

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Shapes that embed rooms.sqlite rows (Room, Participant, …) are compared on their journal part. */
type Journal<T> = Omit<T, "room" | "participants" | "bindings" | "nativeRequests" | "browser" | "state" | "participantStatus">;
type RoomPart = keyof Server.EngineRoomListItem & keyof Web.Room;
type OverviewMember = Server.EngineOverviewRoom["members"][number];

const same: Array<true> = [
  true satisfies Same<Web.EngineTime, Server.EngineTime>,
  true satisfies Same<Web.EngineRef, Server.EngineRef>,
  true satisfies Same<Web.EngineT3Ref, Server.EngineT3Ref>,
  true satisfies Same<Web.EnginePostKind, Server.EnginePostKind>,
  true satisfies Same<Web.EngineClaim, Server.EngineClaim>,
  true satisfies Same<Web.EnginePost, Server.EnginePost>,
  true satisfies Same<Web.EngineNoticeState, Server.EngineNoticeState>,
  true satisfies Same<Web.EngineRequestView, Server.EngineRequestView>,
  true satisfies Same<Web.EngineRunPhase, Server.EngineRunPhase>,
  true satisfies Same<Web.EngineRunView, Server.EngineRunView>,
  true satisfies Same<Web.EngineRunDetail, Server.EngineRunDetail>,
  true satisfies Same<Web.EngineActivityView, Server.EngineActivityView>,
  true satisfies Same<Web.EngineBlockedView, Server.EngineBlockedView>,
  true satisfies Same<Web.EngineSeatView, Server.EngineSeatView>,
  true satisfies Same<Web.EngineRoomCounts, Server.EngineRoomCounts>,
  true satisfies Same<Web.RoomNews, Server.EngineNews>,
  true satisfies Same<Web.EngineNoticeMarks, Server.EngineNoticeMarks>,
  true satisfies Same<Web.EngineBoardPage, Server.EngineBoardPage>,
  true satisfies Same<Omit<Web.EngineMemberStatus, keyof Web.ParticipantStatus>, Omit<Server.EngineMemberStatus, keyof Web.ParticipantStatus>>,
  true satisfies Same<Journal<Web.RoomSnapshot>, Journal<Server.EngineRoomSnapshot>>,
  true satisfies Same<Omit<Web.RoomListItem, RoomPart>, Omit<Server.EngineRoomListItem, RoomPart>>,
  true satisfies Same<Omit<Web.OverviewRoom, "members">, Omit<Server.EngineOverviewRoom, "members">>,
  true satisfies Same<Web.EngineShelfCount, Server.EngineShelfCount>,
  true satisfies Same<Web.EngineShelfThread, Server.EngineShelfThread>,
  true satisfies Same<Omit<Web.Overview, "rooms" | "threads">, Omit<Server.EngineOverview, "rooms" | "threads">>,
  true satisfies Same<Omit<Web.OverviewRoom["members"][number], "modelSelection" | "status">, Omit<OverviewMember, "modelSelection" | "status">>,
  true satisfies Same<Omit<Web.RoomCosts, "room" | "participants" | "replies" | "openTurns" | "contexts">, Omit<Server.EngineRoomCosts, "room" | "participants" | "replies" | "openTurns" | "contexts">>,
];

test("the web's copies of the read API's shapes match src/domain/engineView.ts (checked by npm run typecheck)", () => {
  assert.equal(same.length, 27);
});
