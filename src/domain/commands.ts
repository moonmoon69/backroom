/**
 * The versioned room command contract (PRD 4.4, 4.5).
 * Every input adapter (direct UI, explicit syntax, optional interpreter) builds one of these.
 * Validation of schema happens here; reference/state validation happens in the service.
 */
import { z } from "zod";

export const COMMAND_CONTRACT_VERSION = 1;

const nonEmpty = z.string().trim().min(1);

export const ModelSelectionSchema = z.object({
  instanceId: nonEmpty,
  model: nonEmpty,
  options: z.array(z.object({ id: nonEmpty, value: z.unknown() })).optional(),
});

export const RuntimeModeSchema = z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]);
export const InteractionModeSchema = z.enum(["default", "plan"]);

export const PrerequisiteRefSchema = z.object({
  taskId: nonEmpty,
  revision: z.number().int().min(1),
});

/** Discriminated: now/manual do not accept prerequisites; after_all requires a nonempty list. */
export const ScheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("now") }).strict(),
  z.object({ mode: z.literal("manual") }).strict(),
  z
    .object({
      mode: z.literal("after_all"),
      prerequisites: z.array(PrerequisiteRefSchema).min(1),
    })
    .strict(),
]);

const ThreadBindingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create") }).strict(),
  z.object({ mode: z.literal("attach"), threadId: nonEmpty }).strict(),
]);

export const RoomCreateCommand = z
  .object({
    type: z.literal("room.create"),
    projectId: nonEmpty,
    title: nonEmpty,
  })
  .strict();

export const RoomUpdateCommand = z.object({ type: z.literal("room.update"), roomId: nonEmpty, title: nonEmpty }).strict();

/** Turn the room's shared browser on or off (whether its tasks get one; starting and stopping the process is separate). */
export const RoomBrowserCommand = z.object({ type: z.literal("room.browser"), roomId: nonEmpty, enabled: z.boolean() }).strict();

/** Sidebar order: the full list of room ids, top to bottom. */
export const RoomReorderCommand = z.object({ type: z.literal("room.reorder"), roomIds: z.array(nonEmpty).min(1) }).strict();

/**
 * Delete a room and everything the room stored (messages, tasks, runs, images). Its T3 threads are separate: per
 * participant, keep them (default), settle them, archive them, or delete them in T3. Threads also bound in another
 * room are always kept. Turns running in T3 keep running; the room only stops coordinating them.
 */
export const RoomDeleteCommand = z
  .object({
    type: z.literal("room.delete"),
    roomId: nonEmpty,
    threads: z.record(z.string(), z.enum(["keep", "settle", "archive", "delete"])).default({}),
  })
  .strict();

const ALIAS = nonEmpty
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, "alias must be alphanumeric, dash or underscore")
  .refine((alias) => alias.toLowerCase() !== "all", "@all is reserved: it addresses everyone in the room");

export const ParticipantCreateCommand = z
  .object({
    type: z.literal("participant.create"),
    roomId: nonEmpty,
    alias: ALIAS,
    /** Role assigned in this room (a named rule set). */
    roleId: nonEmpty.nullable().default(null),
    /**
     * Only meaningful when creating a thread; omitted means T3's default model for the project.
     * When attaching, the thread's own model, options, and permission mode are inherited from T3 and these are ignored.
     */
    modelSelection: ModelSelectionSchema.optional(),
    runtimeMode: RuntimeModeSchema.optional(),
    interactionMode: InteractionModeSchema.default("default"),
    thread: ThreadBindingInput,
  })
  .strict();

/**
 * Change the bound thread's model or options through T3 (thread.meta.update). The provider cannot change:
 * a thread's session belongs to one harness. The room re-reads the thread afterwards.
 */
export const ParticipantModelSetCommand = z
  .object({
    type: z.literal("participant.model.set"),
    participantId: nonEmpty,
    modelSelection: ModelSelectionSchema,
  })
  .strict();

/** Change a seated participant's alias and/or role. Model and permission mode have their own commands. */
export const ParticipantUpdateCommand = z
  .object({
    type: z.literal("participant.update"),
    participantId: nonEmpty,
    alias: ALIAS.optional(),
    /** null clears the role; omitted leaves it unchanged. */
    roleId: nonEmpty.nullable().optional(),
  })
  .strict();

export const ParticipantRebindCommand = z
  .object({
    type: z.literal("participant.rebind"),
    participantId: nonEmpty,
    thread: ThreadBindingInput,
    /** Required explicit handling of outstanding pending tasks (PRD 4.2). */
    outstandingTasks: z.enum(["carry", "block"]),
  })
  .strict();

const ROLE_NAME = nonEmpty.regex(/^[a-z0-9][a-z0-9_-]{0,31}$/i, "name must be alphanumeric, dash or underscore");

/** A named set of rules, assignable to participants in any room. */
export const RoleCreateCommand = z
  .object({ type: z.literal("role.create"), name: ROLE_NAME, rules: z.string() })
  .strict();

export const RoleUpdateCommand = z
  .object({ type: z.literal("role.update"), roleId: nonEmpty, name: ROLE_NAME.optional(), rules: z.string().optional() })
  .strict();

export const RoleDeleteCommand = z.object({ type: z.literal("role.delete"), roleId: nonEmpty }).strict();

export const ParticipantRetireCommand = z
  .object({
    type: z.literal("participant.retire"),
    participantId: nonEmpty,
    /** Required explicit handling of pending work: cancel it, or keep it blocked for reassignment. */
    pendingTasks: z.enum(["cancel", "keep"]),
    /** What happens to its T3 thread: left alone (default), settled, archived, or deleted in T3 Code. */
    thread: z.enum(["keep", "settle", "archive", "delete"]).default("keep"),
  })
  .strict();

export const ParticipantRuntimeModeCommand = z
  .object({
    type: z.literal("participant.runtimeMode.set"),
    participantId: nonEmpty,
    runtimeMode: RuntimeModeSchema,
  })
  .strict();

const AttachmentIds = z.array(nonEmpty).max(20).default([]);

/** One task per recipient with the same instruction (the single-assignment form of message.create). */
export const TaskCreateCommand = z
  .object({
    type: z.literal("task.create"),
    roomId: nonEmpty,
    recipients: z.array(nonEmpty).min(1),
    instruction: nonEmpty,
    sourceText: z.string().nullable().default(null),
    attachmentIds: AttachmentIds,
    schedule: ScheduleSchema,
    delivery: z.enum(["queue", "steer"]).default("queue"),
  })
  .strict();

export const AssignmentSchema = z
  .object({
    recipients: z.array(nonEmpty).min(1),
    /** May be empty only when the message carries attachments. */
    instruction: z.string().trim().default(""),
    /** Timing against work outside the message. */
    schedule: ScheduleSchema.default({ mode: "now" }),
    /** Earlier assignments of the same message (by index) whose tasks this one waits for. */
    after: z.array(z.number().int().min(0)).default([]),
    /** When the recipient is mid-turn: wait for the turn to end ("queue") or send into the running turn ("steer"). */
    delivery: z.enum(["queue", "steer"]).default("queue"),
    /** The instruction is one of the recipient's T3 slash commands ("/compact …"), sent verbatim without a briefing. */
    slashCommand: z.boolean().default(false),
  })
  .strict();

/**
 * A user message split into assignments: one room event, one task per recipient per assignment, and
 * in-message dependencies ("@alice fix it. @bob check alice's work") resolved to the tasks created here.
 */
export const MessageCreateCommand = z
  .object({
    type: z.literal("message.create"),
    roomId: nonEmpty,
    sourceText: z.string().nullable().default(null),
    attachmentIds: AttachmentIds,
    assignments: z.array(AssignmentSchema).min(1).max(20),
  })
  .strict()
  .superRefine((command, ctx) => {
    command.assignments.forEach((assignment, index) => {
      for (const earlier of assignment.after) {
        if (earlier >= index) ctx.addIssue({ code: "custom", path: ["assignments", index, "after"], message: "can only wait for an earlier assignment" });
      }
      if (assignment.slashCommand && !/^\/[a-z0-9]/i.test(assignment.instruction)) {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "instruction"], message: "a slash command must start with /" });
      }
      if (assignment.slashCommand && assignment.delivery === "steer") {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "delivery"], message: "a slash command starts its own turn; it cannot be sent into a running one" });
      }
      if (assignment.delivery === "steer" && assignment.schedule.mode === "manual") {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "delivery"], message: "a held assignment cannot be sent into a running turn" });
      }
      if (assignment.after.length > 0 && assignment.schedule.mode === "manual") {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "schedule"], message: "a held assignment cannot also wait for another assignment" });
      }
      if (assignment.instruction.length === 0 && command.attachmentIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "instruction"], message: "instruction is empty" });
      }
    });
  });

export const RoomNoteCreateCommand = z
  .object({
    type: z.literal("room.note.create"),
    roomId: nonEmpty,
    text: nonEmpty,
  })
  .strict();

export const TaskUpdateCommand = z
  .object({
    type: z.literal("task.update"),
    taskId: nonEmpty,
    revision: z.number().int().min(1),
    instruction: nonEmpty.optional(),
    participantId: nonEmpty.optional(),
    schedule: ScheduleSchema.optional(),
    /** When true, dependents that reference the old revision are re-pointed to the new one. */
    carryDependents: z.boolean().default(false),
  })
  .strict();

export const TaskReleaseCommand = z
  .object({ type: z.literal("task.release"), taskId: nonEmpty, revision: z.number().int().min(1) })
  .strict();

export const TaskCancelCommand = z
  .object({ type: z.literal("task.cancel"), taskId: nonEmpty, revision: z.number().int().min(1) })
  .strict();

export const TaskInterruptCommand = z
  .object({ type: z.literal("task.interrupt"), taskId: nonEmpty, runId: nonEmpty })
  .strict();

export const TaskRetryCommand = z
  .object({
    type: z.literal("task.retry"),
    taskId: nonEmpty,
    revision: z.number().int().min(1),
    /** Explicit dependent handling (PRD 4.4): follow the new attempt or stay blocked. */
    reattachDependents: z.boolean(),
  })
  .strict();

export const TaskMarkBlockedCommand = z
  .object({
    type: z.literal("task.markBlocked"),
    taskId: nonEmpty,
    revision: z.number().int().min(1),
    reason: nonEmpty,
  })
  .strict();

export const TaskUnblockCommand = z
  .object({ type: z.literal("task.unblock"), taskId: nonEmpty, revision: z.number().int().min(1) })
  .strict();

export const NativeApprovalRespondCommand = z
  .object({
    type: z.literal("native.approval.respond"),
    participantId: nonEmpty,
    requestId: nonEmpty,
    decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
  })
  .strict();

export const NativeUserInputRespondCommand = z
  .object({
    type: z.literal("native.userInput.respond"),
    participantId: nonEmpty,
    requestId: nonEmpty,
    answers: z.record(z.string(), z.unknown()),
  })
  .strict();

export const RoomCommandSchema = z.discriminatedUnion("type", [
  RoomCreateCommand,
  RoomUpdateCommand,
  RoomBrowserCommand,
  RoomReorderCommand,
  RoomDeleteCommand,
  ParticipantCreateCommand,
  ParticipantUpdateCommand,
  ParticipantRebindCommand,
  ParticipantRetireCommand,
  ParticipantRuntimeModeCommand,
  ParticipantModelSetCommand,
  RoleCreateCommand,
  RoleUpdateCommand,
  RoleDeleteCommand,
  TaskCreateCommand,
  MessageCreateCommand,
  RoomNoteCreateCommand,
  TaskUpdateCommand,
  TaskReleaseCommand,
  TaskCancelCommand,
  TaskInterruptCommand,
  TaskRetryCommand,
  TaskMarkBlockedCommand,
  TaskUnblockCommand,
  NativeApprovalRespondCommand,
  NativeUserInputRespondCommand,
]);

export type RoomCommand = z.infer<typeof RoomCommandSchema>;
export type RoomCommandInput = z.input<typeof RoomCommandSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type TaskCreate = z.infer<typeof TaskCreateCommand>;
export type Assignment = z.infer<typeof AssignmentSchema>;

export class CommandValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(issues: Array<{ path: string; message: string }>) {
    super(issues.map((issue) => `${issue.path || "$"}: ${issue.message}`).join("; "));
    this.name = "CommandValidationError";
    this.issues = issues;
  }
}

/** Parse and validate an untrusted command payload. Unknown types/fields fail here. */
export function parseCommand(input: unknown): RoomCommand {
  const result = RoomCommandSchema.safeParse(input);
  if (!result.success) {
    throw new CommandValidationError(
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}
