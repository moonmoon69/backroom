/** Errors raised by the service for reference, state, and precondition failures. */

export class RoomError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "RoomError";
    this.code = code;
    this.status = status;
  }
}

export const notFound = (what: string, id: string): RoomError =>
  new RoomError("not_found", `${what} ${id} does not exist`, 404);

export const stale = (what: string, expected: number, actual: number): RoomError =>
  new RoomError("stale_revision", `${what} revision ${expected} is stale; current revision is ${actual}`, 409);

export const invalidTransition = (task: string, from: string, action: string): RoomError =>
  new RoomError("invalid_transition", `${task} is ${from}; cannot ${action}`, 409);
