/**
 * An approval answers with one of the choices its request offers, when it names them (an MCP server's form request
 * offers Cancel, Decline and Approve, and a session or permanent approval only when the server allows it). T3 passes
 * any decision on to the provider, so Backroom refuses one the request did not offer.
 */
import type { ApprovalDecision, T3ApprovalOption } from "../adapter/types.ts";
import { RoomError } from "../domain/errors.ts";

export function requireOffered(options: unknown, decision: ApprovalDecision): void {
  if (!Array.isArray(options) || options.length === 0) return;
  if (!(options as T3ApprovalOption[]).some((option) => option?.decision === decision)) {
    throw new RoomError("not_offered", `This request does not offer "${decision}": answer with one of its own choices (${(options as T3ApprovalOption[]).map((o) => o.label).join(", ")}).`, 400);
  }
}
