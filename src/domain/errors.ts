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

