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

/** A git branch name git accepts, kept simple: letters, digits, . _ / - ; no "..", "//", or a trailing "/", "." or ".lock". */
const BranchName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/, "branch names use letters, digits, . _ / and -")
  .refine((name) => !name.includes("..") && !name.includes("//") && !/[/.]$/.test(name) && !name.endsWith(".lock"), "not a valid branch name");

/**
 * Where a new thread works, as in T3 Code's new-thread toolbar: the project's own folder (T3's "current checkout"),
 * a new worktree made now from a base branch (on `branch`, else a name the room picks), or a worktree that exists.
 */
export const WorkspaceChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }).strict(),
  z.object({ mode: z.literal("worktree"), baseBranch: nonEmpty, branch: BranchName.optional() }).strict(),
  z.object({ mode: z.literal("existing"), worktreePath: nonEmpty }).strict(),
]);

const ThreadBindingInput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("create"), workspace: WorkspaceChoiceSchema.optional() }).strict(),
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

/**
 * Whether the room's agents get browsers, which one is the room's default, and which browsers it may use (starting and
 * stopping the process is separate). browserId omitted keeps the current default, null falls back to "general";
 * allowed omitted keeps the current list, null allows every browser.
 */
export const RoomBrowserCommand = z
  .object({
    type: z.literal("room.browser"),
    roomId: nonEmpty,
    enabled: z.boolean(),
    browserId: nonEmpty.nullable().optional(),
    allowed: z.array(nonEmpty).min(1).nullable().optional(),
  })
  .strict();

const BROWSER_NAME = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "use lowercase letters, digits and dashes (up to 40), starting with a letter or digit");
const BROWSER_DESCRIPTION = z.string().trim().max(500);

/** A shared browser named by purpose; the description tells agents what it is for and which logins it holds. */
export const BrowserCreateCommand = z.object({ type: z.literal("browser.create"), name: BROWSER_NAME, description: BROWSER_DESCRIPTION.default("") }).strict();

export const BrowserUpdateCommand = z
  .object({ type: z.literal("browser.update"), browserId: nonEmpty, name: BROWSER_NAME.optional(), description: BROWSER_DESCRIPTION.optional() })
  .strict();

/** Delete a browser and its profile (logins, history). Refused while a room uses it. */
export const BrowserDeleteCommand = z.object({ type: z.literal("browser.delete"), browserId: nonEmpty }).strict();

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

/**
 * Add a T3 project for a folder on the machine running T3. The title defaults to the folder name. With createIfMissing,
 * T3 creates the folder first; otherwise it must already exist.
 */
export const ProjectCreateCommand = z
  .object({
    type: z.literal("project.create"),
    workspaceRoot: nonEmpty,
    title: nonEmpty.optional(),
    createIfMissing: z.boolean().default(false),
  })
  .strict();

/** An image sent inline with a direct thread message: PNG, JPEG, GIF or WebP as a base64 data URL (T3's upload form). */
export const InlineImageSchema = z
  .object({
    name: z.string().trim().max(255).default("image"),
    dataUrl: z.string().regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/, "must be a base64 PNG, JPEG, GIF or WebP data URL"),
  })
  .strict();

const InlineImages = z.array(InlineImageSchema).max(20).default([]);

/*
 * Direct threads: T3 threads used on their own, outside any room. The text goes to T3 exactly as typed (no room
 * briefing), like typing in T3 Code. A thread seated in a room is refused here: the room coordinates it.
 */

/** Create a thread in a project and send its first message in one step. Omitted model means T3's default for the project. */
export const ThreadStartCommand = z
  .object({
    type: z.literal("thread.start"),
    projectId: nonEmpty,
    /** Chosen by the client when it needs the id up front (a browser key for the first message); else generated. */
    threadId: z.string().uuid().optional(),
    text: z.string().default(""),
    images: InlineImages,
    modelSelection: ModelSelectionSchema.optional(),
    runtimeMode: RuntimeModeSchema.default("full-access"),
    interactionMode: InteractionModeSchema.default("default"),
    workspace: WorkspaceChoiceSchema.optional(),
  })
  .strict()
  .refine((command) => command.text.trim().length > 0 || command.images.length > 0, { message: "message is empty", path: ["text"] });

/** Send a message to a direct thread. While a turn runs, T3 handles it as its own client would (steer or queue). */
export const ThreadSendCommand = z
  .object({ type: z.literal("thread.send"), threadId: nonEmpty, text: z.string().default(""), images: InlineImages })
  .strict()
  .refine((command) => command.text.trim().length > 0 || command.images.length > 0, { message: "message is empty", path: ["text"] });

export const ThreadInterruptCommand = z.object({ type: z.literal("thread.interrupt"), threadId: nonEmpty }).strict();

export const ThreadApprovalRespondCommand = z
  .object({
    type: z.literal("thread.approval.respond"),
    threadId: nonEmpty,
    requestId: nonEmpty,
    decision: z.enum(["accept", "acceptForSession", "acceptAlways", "decline", "cancel"]),
  })
  .strict();

export const ThreadUserInputRespondCommand = z
  .object({ type: z.literal("thread.userInput.respond"), threadId: nonEmpty, requestId: nonEmpty, answers: z.record(z.string(), z.unknown()) })
  .strict();

/** Change a direct thread's model or options (the provider stays: a thread's session belongs to one harness). */
export const ThreadModelSetCommand = z.object({ type: z.literal("thread.model.set"), threadId: nonEmpty, modelSelection: ModelSelectionSchema }).strict();

export const ThreadRuntimeModeSetCommand = z.object({ type: z.literal("thread.runtimeMode.set"), threadId: nonEmpty, runtimeMode: RuntimeModeSchema }).strict();

/** Settle (T3's "settled" list), archive (hidden, reversible) or delete (permanent) a direct thread in T3; or undo a settle or archive. */
export const ThreadLifecycleCommand = z
  .object({ type: z.literal("thread.lifecycle"), threadId: nonEmpty, action: z.enum(["settle", "unsettle", "archive", "unarchive", "delete"]) })
  .strict();

export const RoomCommandSchema = z.discriminatedUnion("type", [
  RoomCreateCommand,
  RoomUpdateCommand,
  RoomBrowserCommand,
  BrowserCreateCommand,
  BrowserUpdateCommand,
  BrowserDeleteCommand,
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
  ProjectCreateCommand,
  ThreadStartCommand,
  ThreadSendCommand,
  ThreadInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadModelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadLifecycleCommand,
]);

export type RoomCommand = z.infer<typeof RoomCommandSchema>;
export type RoomCommandInput = z.input<typeof RoomCommandSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type TaskCreate = z.infer<typeof TaskCreateCommand>;
export type Assignment = z.infer<typeof AssignmentSchema>;
export type InlineImage = z.infer<typeof InlineImageSchema>;
export type WorkspaceChoice = z.infer<typeof WorkspaceChoiceSchema>;

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
