/**
 * The versioned room command contract.
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
    /** Seat the Consigliere chosen in Settings (when there is one) and designate him. */
    consigliere: z.boolean().default(true),
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

/** The same choices for a thread outside rooms (its one agent), with the same rules. The thread need not exist yet. */
export const ThreadBrowserCommand = z
  .object({
    type: z.literal("thread.browser"),
    threadId: z.string().uuid(),
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
 * Sidebar order of T3's projects, top to bottom. Kept by Backroom (T3 Code keeps its own order in each browser), so
 * every device shows the same; projects not listed follow in T3's order.
 */
export const ProjectReorderCommand = z.object({ type: z.literal("project.reorder"), projectIds: z.array(nonEmpty).min(1) }).strict();

/**
 * Delete a room and everything the room stored (its members, messages and images). Its T3 threads are separate: per
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

/** Change a seated participant's alias. Model and permission mode have their own commands. */
export const ParticipantUpdateCommand = z
  .object({
    type: z.literal("participant.update"),
    participantId: nonEmpty,
    alias: ALIAS.optional(),
  })
  .strict();

/**
 * A participant's settings under a name. The name follows the alias rules: it is the alias the preset takes in a room.
 */
/** A pixel look as named parts (domain/look.ts). Names are not checked here: a part or option this version does not know falls back to its default when drawn. */
export const LookSchema = z.record(z.string().min(1).max(32), z.string().min(1).max(32)).refine((look) => Object.keys(look).length <= 32, "a look has at most 32 parts");

/** The longest crew member description: one sentence. The page's field has the same cap (web/src/types.ts). */
export const PRESET_DESCRIPTION_MAX = 300;

/** A crew member's one-sentence description, folded to one line: line breaks and runs of whitespace become one space. */
export const PresetDescriptionSchema = z.string().max(PRESET_DESCRIPTION_MAX).transform((text) => text.replace(/\s+/g, " ").trim());

export const PresetCreateCommand = z
  .object({
    type: z.literal("preset.create"),
    name: ALIAS,
    modelSelection: ModelSelectionSchema,
    runtimeMode: RuntimeModeSchema.default("full-access"),
    workspaceMode: z.enum(["local", "worktree"]).default("local"),
    look: LookSchema.optional(),
    description: PresetDescriptionSchema.default(""),
  })
  .strict();

export const PresetUpdateCommand = z
  .object({
    type: z.literal("preset.update"),
    presetId: nonEmpty,
    name: ALIAS.optional(),
    modelSelection: ModelSelectionSchema.optional(),
    runtimeMode: RuntimeModeSchema.optional(),
    workspaceMode: z.enum(["local", "worktree"]).optional(),
    look: LookSchema.optional(),
    description: PresetDescriptionSchema.optional(),
  })
  .strict();

export const PresetDeleteCommand = z.object({ type: z.literal("preset.delete"), presetId: nonEmpty }).strict();

/**
 * Seat a preset in a room on a new thread. Without an alias it takes the preset's name, with a number added when the
 * room already has that alias ("sol", then "sol2").
 */
export const ParticipantFromPresetCommand = z
  .object({ type: z.literal("participant.fromPreset"), roomId: nonEmpty, presetId: nonEmpty, alias: ALIAS.optional() })
  .strict();

/**
 * Make a seated member the room's Consigliere, move the mark to another member, or clear it (participantId null).
 * A room has at most one.
 */
export const RoomConsigliereSetCommand = z.object({ type: z.literal("room.consigliere.set"), roomId: nonEmpty, participantId: nonEmpty.nullable() }).strict();

/** The saved crew member who is the Consigliere of new rooms, or none (presetId null). Backroom names no model. */
export const ConsiglierePresetSetCommand = z.object({ type: z.literal("consigliere.preset.set"), presetId: nonEmpty.nullable() }).strict();

/**
 * The Consigliere's rules in the user's own words: the text every briefing Backroom writes for a Consigliere carries.
 * null goes back to Backroom's wording.
 */
export const ConsigliereRulesSetCommand = z.object({ type: z.literal("consigliere.rules.set"), rules: z.string().trim().min(1).max(20000).nullable() }).strict();

/**
 * What happens to a member's T3 thread when the Consigliere retires it (rooms-board retire) or a reseat retires the old
 * seat: the choices of the page's removal dialog. App-wide; keep until the user picks another.
 */
export const ConsigliereRetireThreadSetCommand = z
  .object({ type: z.literal("consigliere.retireThread.set"), thread: z.enum(["keep", "settle", "archive", "delete"]) })
  .strict();

/**
 * Start a conversation with the Consigliere in a project: a room titled with the start of the message, that saved crew
 * member seated and designated, and the message delivered to him. requestId names the attempt: sending the command
 * again with the same id carries on where it stopped and never makes a second room.
 */
export const ConsigliereStartCommand = z
  .object({ type: z.literal("consigliere.start"), projectId: nonEmpty, text: nonEmpty, requestId: z.string().uuid() })
  .strict();

export const ParticipantRetireCommand = z
  .object({
    type: z.literal("participant.retire"),
    participantId: nonEmpty,
    /** What happens to its T3 thread: left alone (default), settled, archived, or deleted in T3 Code. */
    thread: z.enum(["keep", "settle", "archive", "delete"]).default("keep"),
  })
  .strict();

/**
 * Reseat a member from a clean context (rooms-board reseat): it is asked for a checkpoint post, and when that lands a
 * fresh seat of the same saved crew member takes over with it, and with the Consigliere's mark when it was his; the old
 * seat leaves the room. by is the member who asked; plan is what the fresh seat carries on with.
 */
export const ParticipantReseatCommand = z
  .object({
    type: z.literal("participant.reseat"),
    participantId: nonEmpty,
    by: nonEmpty,
    plan: z.string().trim().max(4000).nullable().default(null),
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

export const AssignmentSchema = z
  .object({
    recipients: z.array(nonEmpty).min(1),
    /** May be empty only when the message carries attachments. */
    instruction: z.string().trim().default(""),
    /**
     * Ignored: every message goes into a working recipient's running turn (M1). A page loaded before M1 still sends it,
     * and the schema is strict, so it is accepted and dropped rather than refused.
     */
    delivery: z.enum(["queue", "steer"]).optional(),
    /** The instruction is one of the recipient's T3 slash commands ("/compact …"), sent verbatim without a briefing. */
    slashCommand: z.boolean().default(false),
  })
  .strict();

/**
 * A user message split into assignments: one request per recipient per assignment on the room's journal
 * (src/app/engineMessages.ts). Nothing waits on other work (decision D2): the parser refuses /after, /hold and the
 * waits a message implies before anything is sent.
 */
export const MessageCreateCommand = z
  .object({
    type: z.literal("message.create"),
    roomId: nonEmpty,
    sourceText: z.string().nullable().default(null),
    /**
     * Text before the first address (the parser's draft.preamble): context every recipient's request carries; when
     * absent it is read from sourceText. The client's ID for the message: sending it again with the same ID records
     * nothing twice and sends no T3 command twice.
     */
    preamble: z.string().trim().optional(),
    clientMessageId: z.string().uuid().optional(),
    attachmentIds: AttachmentIds,
    assignments: z.array(AssignmentSchema).min(1).max(20),
  })
  .strict()
  .superRefine((command, ctx) => {
    command.assignments.forEach((assignment, index) => {
      if (assignment.slashCommand && !/^\/[a-z0-9]/i.test(assignment.instruction)) {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "instruction"], message: "a slash command must start with /" });
      }
      if (assignment.instruction.length === 0 && command.attachmentIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["assignments", index, "instruction"], message: "instruction is empty" });
      }
    });
  });

/*
 * The user's controls on the room's journal (plan item L4a). Requests and runs are named by their
 * journal IDs: withdraw a request, amend one still open, retry a failed run with its original content, or stop what
 * a member is running in T3.
 */
export const RequestCancelCommand = z.object({ type: z.literal("request.cancel"), roomId: nonEmpty, requestId: nonEmpty }).strict();

export const RequestCorrectCommand = z.object({ type: z.literal("request.correct"), roomId: nonEmpty, requestId: nonEmpty, text: nonEmpty }).strict();

export const RunRetryCommand = z.object({ type: z.literal("run.retry"), roomId: nonEmpty, runId: nonEmpty, text: z.string().trim().default("") }).strict();

export const RunStopCommand = z.object({ type: z.literal("run.stop"), roomId: nonEmpty, participantId: nonEmpty }).strict();

/** Drop a question the user will not answer (T3 dismisses it; the agent goes on, or its turn ends, without the answer). */
export const NativeUserInputDismissCommand = z.object({ type: z.literal("native.userInput.dismiss"), participantId: nonEmpty, requestId: nonEmpty }).strict();

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

/** Settings → Agents file: whether a room created in a project without one writes the default agents file (on by default). */
export const AgentsFileEnabledCommand = z.object({ type: z.literal("agentsFile.enabled.set"), enabled: z.boolean() }).strict();

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
  ThreadBrowserCommand,
  BrowserCreateCommand,
  BrowserUpdateCommand,
  BrowserDeleteCommand,
  RoomReorderCommand,
  ProjectReorderCommand,
  RoomDeleteCommand,
  ParticipantCreateCommand,
  ParticipantUpdateCommand,
  ParticipantRetireCommand,
  ParticipantReseatCommand,
  ParticipantRuntimeModeCommand,
  ParticipantModelSetCommand,
  PresetCreateCommand,
  PresetUpdateCommand,
  PresetDeleteCommand,
  ParticipantFromPresetCommand,
  RoomConsigliereSetCommand,
  ConsiglierePresetSetCommand,
  ConsigliereRulesSetCommand,
  ConsigliereRetireThreadSetCommand,
  ConsigliereStartCommand,
  MessageCreateCommand,
  RequestCancelCommand,
  RequestCorrectCommand,
  RunRetryCommand,
  RunStopCommand,
  NativeUserInputDismissCommand,
  NativeApprovalRespondCommand,
  NativeUserInputRespondCommand,
  ProjectCreateCommand,
  AgentsFileEnabledCommand,
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
