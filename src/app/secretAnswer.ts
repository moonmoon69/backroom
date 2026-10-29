/**
 * Answering a secret a T3 thread asks the user for, for a room's member (native.secret.respond) and a thread outside any
 * room (thread.secret.respond). The secret goes to the adapter and nowhere else: what this throws is said in its own
 * words, by the kind of failure, and never carries an error's message, cause or stack, which could repeat it.
 */
import type { SecretAnswer, T3Adapter } from "../adapter/types.ts";
import { SECRET_REFUSALS, T3CommandRejected, T3OutcomeUnknown, T3ScopeMissing, T3SecretRefused, T3Unavailable } from "../adapter/types.ts";
import { RoomError } from "../domain/errors.ts";

/** T3 says nothing waits for this answer any more: the request is gone, was answered elsewhere, or its agent stopped. */
export class SecretRequestStale extends RoomError {
  constructor(message: string) {
    super("secret_stale", message, 409);
    this.name = "SecretRequestStale";
  }
}

function secretError(error: unknown): RoomError {
  if (error instanceof T3SecretRefused) {
    const message = SECRET_REFUSALS[error.reason];
    // record_failed: T3 stored the secret and could not mark the request answered. Not a success, and not a refusal.
    return error.stale ? new SecretRequestStale(message) : new RoomError(`secret_${error.reason}`, message, 502);
  }
  if (error instanceof T3ScopeMissing) return new RoomError("t3_scope_missing", error.message, 403);
  if (error instanceof T3OutcomeUnknown) return new RoomError("t3_outcome_unknown", "T3 did not confirm the secret; it may have been saved. Look at the request before you answer it again.", 504);
  if (error instanceof T3Unavailable) return new RoomError("t3_unavailable", "T3 is not answering; the secret was not sent.", 503);
  if (error instanceof T3CommandRejected) return new RoomError("t3_rejected", "T3 refused the secret; nothing was saved.", 502);
  return new RoomError("secret_failed", "Backroom could not send the secret to T3; it may not have been saved.", 500);
}

/** Send the answer to T3; a failure is thrown as a RoomError that says what happened, a stale request as SecretRequestStale. */
export async function answerSecret(adapter: T3Adapter, threadId: string, requestId: string, answer: SecretAnswer): Promise<void> {
  try {
    await adapter.respondSecret({ threadId, turnItemId: requestId, answer });
  } catch (error) {
    throw secretError(error);
  }
}
