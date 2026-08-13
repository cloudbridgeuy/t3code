import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderInstanceId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderInteractionMode,
  type ProviderRequestKind,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { normalizeModelSlug } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
const decodeV2TurnStartResponse = Schema.decodeUnknownEffect(EffectCodexSchema.V2TurnStartResponse);

const PROVIDER = ProviderDriverKind.make("codex");

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];
const CODEX_CHILD_INTERRUPT_TIMEOUT = "3 seconds" as const;
const CODEX_CHILD_INTERRUPT_BATCH_TIMEOUT = "10 seconds" as const;
const CODEX_REWIND_SETTLEMENT_TIMEOUT = "30 seconds" as const;

export function hasConfiguredMcpServer(appServerArgs: ReadonlyArray<string> | undefined): boolean {
  return appServerArgs?.some((argument) => argument.includes("mcp_servers.")) === true;
}

export const CodexResumeCursorSchema = Schema.Struct({
  threadId: Schema.String,
});
const CodexUserInputAnswerObject = Schema.Struct({
  answers: Schema.Array(Schema.String),
});
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);
const isCodexUserInputAnswerObject = Schema.is(CodexUserInputAnswerObject);

// TODO: Verify `packages/effect-codex-app-server/scripts/generate.ts` so the generated
// `V2TurnStartParams` schema includes `collaborationMode` directly.
const CodexTurnStartParamsWithCollaborationMode = EffectCodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(EffectCodexSchema.V2TurnStartParams__CollaborationMode),
  }),
);
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);

export type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;

export type CodexResumeCursor = typeof CodexResumeCursorSchema.Type;
type CodexServiceTier = NonNullable<EffectCodexSchema.V2ThreadStartParams["serviceTier"]>;
type CodexThreadItem =
  | EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadRollbackResponse["thread"]["turns"][number]["items"][number]
  | EffectCodexSchema.V2ThreadForkResponse["thread"]["turns"][number]["items"][number];

export interface CodexSessionRuntimeOptions {
  readonly threadId: ThreadId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly resumeCursor?: CodexResumeCursor;
  readonly appServerArgs?: ReadonlyArray<string>;
}

export interface CodexSessionRuntimeSendTurnInput {
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier | undefined;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort | undefined;
  readonly interactionMode?: ProviderInteractionMode;
}

export interface CodexThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<CodexThreadItem>;
}

export interface CodexThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexThreadTurnSnapshot>;
}

export interface CodexSessionRuntimeShape {
  readonly start: () => Effect.Effect<ProviderSession, CodexSessionRuntimeError>;
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly sendTurn: (
    input: CodexSessionRuntimeSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError>;
  readonly interruptTurn: (turnId?: TurnId) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly readThread: Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rewindThread: (
    lastTurnId?: TurnId,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly rollbackThread: (
    numTurns: number,
  ) => Effect.Effect<CodexThreadSnapshot, CodexSessionRuntimeError>;
  readonly respondToRequest: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly respondToUserInput: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, CodexSessionRuntimeError>;
  readonly events: Stream.Stream<ProviderEvent, never>;
  readonly close: Effect.Effect<void>;
}

export type CodexSessionRuntimeError =
  | CodexErrors.CodexAppServerError
  | CodexSessionRuntimePendingApprovalNotFoundError
  | CodexSessionRuntimePendingUserInputNotFoundError
  | CodexSessionRuntimeInvalidUserInputAnswersError
  | CodexSessionRuntimeInvalidRetainedTurnError
  | CodexSessionRuntimeActiveTurnMissingError
  | CodexSessionRuntimeRewindSettlementTimeoutError
  | CodexSessionRuntimeThreadIdMissingError;

export class CodexSessionRuntimePendingApprovalNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingApprovalNotFoundError>()(
  "CodexSessionRuntimePendingApprovalNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex approval request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimePendingUserInputNotFoundError extends Schema.TaggedErrorClass<CodexSessionRuntimePendingUserInputNotFoundError>()(
  "CodexSessionRuntimePendingUserInputNotFoundError",
  {
    requestId: Schema.String,
  },
) {
  override get message(): string {
    return `Unknown pending Codex user input request: ${this.requestId}`;
  }
}

export class CodexSessionRuntimeInvalidUserInputAnswersError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidUserInputAnswersError>()(
  "CodexSessionRuntimeInvalidUserInputAnswersError",
  {
    questionId: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid Codex user input answers for question '${this.questionId}'`;
  }
}

export class CodexSessionRuntimeThreadIdMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeThreadIdMissingError>()(
  "CodexSessionRuntimeThreadIdMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex session is missing a provider thread id for ${this.threadId}`;
  }
}

export class CodexSessionRuntimeInvalidRetainedTurnError extends Schema.TaggedErrorClass<CodexSessionRuntimeInvalidRetainedTurnError>()(
  "CodexSessionRuntimeInvalidRetainedTurnError",
  {
    turnId: Schema.String,
    reason: Schema.Literals(["not-found", "not-completed"]),
  },
) {
  override get message(): string {
    return this.reason === "not-found"
      ? `Codex thread does not contain retained turn '${this.turnId}'`
      : `Codex retained turn '${this.turnId}' is not completed`;
  }
}

export class CodexSessionRuntimeActiveTurnMissingError extends Schema.TaggedErrorClass<CodexSessionRuntimeActiveTurnMissingError>()(
  "CodexSessionRuntimeActiveTurnMissingError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex thread '${this.threadId}' is active but has no active root turn`;
  }
}

export class CodexSessionRuntimeRewindSettlementTimeoutError extends Schema.TaggedErrorClass<CodexSessionRuntimeRewindSettlementTimeoutError>()(
  "CodexSessionRuntimeRewindSettlementTimeoutError",
  {
    threadId: Schema.String,
  },
) {
  override get message(): string {
    return `Codex thread '${this.threadId}' did not settle before rewind timed out`;
  }
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly jsonRpcId: string;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ApprovalCorrelation {
  readonly requestId: ApprovalRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
}

interface PendingUserInput {
  readonly requestId: ApprovalRequestId;
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface CodexPendingRequestStore<A> {
  readonly register: (requestId: ApprovalRequestId, request: A) => Effect.Effect<boolean>;
  readonly take: (requestId: ApprovalRequestId) => Effect.Effect<A | undefined>;
  readonly drainForRewind: Effect.Effect<ReadonlyArray<A>>;
  readonly finishRewind: Effect.Effect<void>;
}

export const makeCodexPendingRequestStore = Effect.fn("makeCodexPendingRequestStore")(<A>() =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make({
      rewinding: false,
      pending: new Map<ApprovalRequestId, A>(),
    });
    return {
      register: (requestId, request) =>
        Ref.modify(stateRef, (state) => {
          if (state.rewinding) {
            return [true, state] as const;
          }
          const pending = new Map(state.pending);
          pending.set(requestId, request);
          return [false, { ...state, pending }] as const;
        }),
      take: (requestId) =>
        Ref.modify(stateRef, (state) => {
          const request = state.pending.get(requestId);
          if (!request) {
            return [undefined, state] as const;
          }
          const pending = new Map(state.pending);
          pending.delete(requestId);
          return [request, { ...state, pending }] as const;
        }),
      drainForRewind: Ref.modify(stateRef, (state) => [
        Array.from(state.pending.values()),
        { rewinding: true, pending: new Map() },
      ]),
      finishRewind: Ref.update(stateRef, (state) => ({ ...state, rewinding: false })),
    } satisfies CodexPendingRequestStore<A>;
  }),
);

export interface CodexLiveChildTurnStore {
  readonly snapshot: Effect.Effect<ReadonlyMap<string, string>>;
  readonly register: (threadId: string, turnId: string) => Effect.Effect<boolean>;
  readonly registerAndInterrupt: (
    threadId: string,
    turnId: string,
    interrupt: Effect.Effect<void>,
    sourceIsCurrent: Effect.Effect<boolean>,
  ) => Effect.Effect<boolean>;
  readonly settleBeforeRebind: <A, E, R>(rebind: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withSettlementPermit: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly remove: (threadId: string) => Effect.Effect<void>;
  readonly drainForRewind: Effect.Effect<ReadonlyMap<string, string>>;
  readonly finishRewind: Effect.Effect<void>;
}

export const makeCodexLiveChildTurnStore = Effect.fn("makeCodexLiveChildTurnStore")(function* () {
  const settlementSemaphore = yield* Semaphore.make(1);
  const stateRef = yield* Ref.make({
    rewinding: false,
    liveTurns: new Map<string, string>(),
  });
  const register = (threadId: string, turnId: string) =>
    Ref.modify(stateRef, (state) => {
      if (state.rewinding) {
        return [true, state] as const;
      }
      const liveTurns = new Map(state.liveTurns);
      liveTurns.set(threadId, turnId);
      return [false, { ...state, liveTurns }] as const;
    });
  const finishRewind = Ref.update(stateRef, (state) =>
    state.rewinding
      ? {
          rewinding: false,
          liveTurns: new Map(),
        }
      : state,
  );
  const withSettlementPermit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    settlementSemaphore.withPermit(effect);
  return {
    snapshot: Ref.get(stateRef).pipe(Effect.map((state) => state.liveTurns)),
    register,
    registerAndInterrupt: (threadId, turnId, interrupt, sourceIsCurrent) =>
      withSettlementPermit(
        Effect.gen(function* () {
          if (!(yield* sourceIsCurrent)) {
            yield* interrupt;
            return false;
          }
          if (yield* register(threadId, turnId)) {
            yield* interrupt;
          }
          return true;
        }),
      ),
    settleBeforeRebind: (rebind) =>
      withSettlementPermit(rebind.pipe(Effect.ensuring(finishRewind))),
    withSettlementPermit,
    remove: (threadId) =>
      Ref.update(stateRef, (state) => {
        const liveTurns = new Map(state.liveTurns);
        liveTurns.delete(threadId);
        return { ...state, liveTurns };
      }),
    drainForRewind: Ref.modify(stateRef, (state) => [
      state.liveTurns,
      { rewinding: true, liveTurns: new Map() },
    ]),
    finishRewind,
  } satisfies CodexLiveChildTurnStore;
});

type CodexProviderEventInput = Omit<ProviderEvent, "id" | "provider" | "createdAt">;

export function makeCodexApprovalDecisionEvent(input: {
  readonly threadId: ThreadId;
  readonly pending: Pick<PendingApproval, "requestId" | "requestKind" | "turnId" | "itemId">;
  readonly decision: ProviderApprovalDecision;
}): CodexProviderEventInput {
  return {
    kind: "notification",
    threadId: input.threadId,
    method: "item/requestApproval/decision",
    requestId: input.pending.requestId,
    requestKind: input.pending.requestKind,
    ...(input.pending.turnId ? { turnId: input.pending.turnId } : {}),
    ...(input.pending.itemId ? { itemId: input.pending.itemId } : {}),
    payload: {
      requestId: input.pending.requestId,
      requestKind: input.pending.requestKind,
      decision: input.decision,
    },
  };
}

export function makeCodexUserInputAnsweredEvent(input: {
  readonly threadId: ThreadId;
  readonly pending: Pick<PendingUserInput, "requestId" | "turnId" | "itemId">;
  readonly answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"];
}): CodexProviderEventInput {
  return {
    kind: "notification",
    threadId: input.threadId,
    method: "item/tool/requestUserInput/answered",
    requestId: input.pending.requestId,
    ...(input.pending.turnId ? { turnId: input.pending.turnId } : {}),
    ...(input.pending.itemId ? { itemId: input.pending.itemId } : {}),
    payload: { answers: input.answers },
  };
}

type CodexServerNotification = {
  readonly [M in CodexRpc.ServerNotificationMethod]: {
    readonly method: M;
    readonly params: CodexRpc.ServerNotificationParamsByMethod[M];
  };
}[CodexRpc.ServerNotificationMethod];

function makeCodexServerNotification<M extends CodexRpc.ServerNotificationMethod>(
  method: M,
  params: CodexRpc.ServerNotificationParamsByMethod[M],
): CodexServerNotification {
  return { method, params } as CodexServerNotification;
}

function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }
  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }
  return normalized;
}

function readResumeCursorThreadId(
  resumeCursor: ProviderSession["resumeCursor"],
): string | undefined {
  return isCodexResumeCursorSchema(resumeCursor) ? resumeCursor.threadId : undefined;
}

function runtimeModeToThreadConfig(input: RuntimeMode): {
  readonly approvalPolicy: EffectCodexSchema.V2ThreadStartParams__AskForApproval;
  readonly sandbox: EffectCodexSchema.V2ThreadStartParams__SandboxMode;
  // Always explicit: omitting the field on resume keeps the thread's previous
  // reviewer, which would leave auto_review sticky after switching modes.
  readonly approvalsReviewer: EffectCodexSchema.V2ThreadStartParams__ApprovalsReviewer;
} {
  switch (input) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
        approvalsReviewer: "user",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
  }
}

function buildThreadStartParams(input: {
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): EffectCodexSchema.V2ThreadStartParams {
  const config = runtimeModeToThreadConfig(input.runtimeMode);
  return {
    cwd: input.cwd,
    approvalPolicy: config.approvalPolicy,
    sandbox: config.sandbox,
    approvalsReviewer: config.approvalsReviewer,
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  };
}

function runtimeModeToTurnSandboxPolicy(
  input: RuntimeMode,
): EffectCodexSchema.V2TurnStartParams__SandboxPolicy {
  switch (input) {
    case "approval-required":
      return {
        type: "readOnly",
      };
    case "auto-accept-edits":
    case "auto":
      return {
        type: "workspaceWrite",
      };
    case "full-access":
    default:
      return {
        type: "dangerFullAccess",
      };
  }
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly model?: string;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
}): EffectCodexSchema.V2TurnStartParams__CollaborationMode | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? DEFAULT_MODEL;
  const reasoningEffort = input.effort ?? "medium";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: reasoningEffort,
      developer_instructions: buildCodexDeveloperInstructions(input.interactionMode, {
        model,
        reasoningEffort,
      }),
    },
  };
}

export function buildTurnStartParams(input: {
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly prompt?: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: "image";
    readonly url: string;
  }>;
  readonly model?: string;
  readonly serviceTier?: CodexServiceTier;
  readonly effort?: EffectCodexSchema.V2TurnStartParams__ReasoningEffort;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<
  CodexTurnStartParamsWithCollaborationMode,
  CodexErrors.CodexAppServerProtocolParseError
> {
  const turnInput: Array<EffectCodexSchema.V2TurnStartParams__UserInput> = [];
  if (input.prompt) {
    turnInput.push({
      type: "text",
      text: input.prompt,
    });
  }
  for (const attachment of input.attachments ?? []) {
    turnInput.push(attachment);
  }

  const config = runtimeModeToThreadConfig(input.runtimeMode);
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });

  return decodeCodexTurnStartParamsWithCollaborationMode({
    threadId: input.threadId,
    input: turnInput,
    approvalPolicy: config.approvalPolicy,
    approvalsReviewer: config.approvalsReviewer,
    sandboxPolicy: runtimeModeToTurnSandboxPolicy(input.runtimeMode),
    ...(input.model ? { model: input.model } : {}),
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(collaborationMode ? { collaborationMode } : {}),
  }).pipe(
    Effect.mapError((cause) =>
      CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
        "decode-request-payload",
        cause,
        { method: "turn/start" },
      ),
    ),
  );
}

function classifyCodexStderrLine(rawLine: string): { readonly message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }
    if (BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet))) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread")) {
    return false;
  }
  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

type CodexThreadOpenResponse =
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/resume"];

type CodexThreadOpenMethod = "thread/start" | "thread/resume";

interface CodexThreadOpenClient {
  readonly request: <M extends CodexThreadOpenMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

export const openCodexThread = (input: {
  readonly client: CodexThreadOpenClient;
  readonly threadId: ThreadId;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly requestedModel: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
  readonly resumeThreadId: string | undefined;
}): Effect.Effect<CodexThreadOpenResponse, CodexErrors.CodexAppServerError> => {
  const resumeThreadId = input.resumeThreadId;
  const startParams = buildThreadStartParams({
    cwd: input.cwd,
    runtimeMode: input.runtimeMode,
    model: input.requestedModel,
    serviceTier: input.serviceTier,
  });

  if (resumeThreadId === undefined) {
    return input.client.request("thread/start", startParams);
  }

  return input.client
    .request("thread/resume", {
      threadId: resumeThreadId,
      ...startParams,
    })
    .pipe(
      Effect.catchIf(isRecoverableThreadResumeError, (error) =>
        Effect.logWarning("codex app-server thread resume fell back to fresh start", {
          threadId: input.threadId,
          requestedRuntimeMode: input.runtimeMode,
          resumeThreadId,
          recoverable: true,
          cause: error,
        }).pipe(Effect.andThen(input.client.request("thread/start", startParams))),
      ),
    );
};

export type CodexRewindPlan =
  | { readonly _tag: "start" }
  | { readonly _tag: "fork"; readonly lastTurnId: string }
  | {
      readonly _tag: "invalid";
      readonly turnId: string;
      readonly reason: "not-found" | "not-completed";
    };

export function resolveCodexRewindPlan(
  turns: ReadonlyArray<{ readonly id: string; readonly status: string }>,
  lastTurnId: TurnId | undefined,
): CodexRewindPlan {
  if (lastTurnId === undefined) {
    return { _tag: "start" };
  }
  const retained = turns.find((turn) => turn.id === lastTurnId);
  if (!retained) {
    return { _tag: "invalid", turnId: lastTurnId, reason: "not-found" };
  }
  if (retained.status !== "completed") {
    return { _tag: "invalid", turnId: lastTurnId, reason: "not-completed" };
  }
  return { _tag: "fork", lastTurnId };
}

export function resolveActiveCodexTurnId(
  turns: ReadonlyArray<{ readonly id: string; readonly status: string }>,
  sessionActiveTurnId: TurnId | undefined,
): string | undefined {
  const inProgressTurns = turns.filter((turn) => turn.status === "inProgress");
  if (
    sessionActiveTurnId !== undefined &&
    inProgressTurns.some((turn) => turn.id === sessionActiveTurnId)
  ) {
    return sessionActiveTurnId;
  }
  return inProgressTurns.length === 1 ? inProgressTurns[0]?.id : undefined;
}

export function isCodexTurnNoLongerActiveError(error: CodexErrors.CodexAppServerError): boolean {
  if (error._tag !== "CodexAppServerRequestError") {
    return false;
  }
  const message = error.errorMessage.toLowerCase();
  return (
    message.includes("already completed") ||
    message.includes("already finished") ||
    message.includes("not active") ||
    message.includes("not in progress") ||
    message.includes("no active turn") ||
    (message.includes("cannot interrupt") &&
      (message.includes("completed") || message.includes("finished")))
  );
}

export function resolveCodexTurnCompletionSessionUpdate(input: {
  readonly currentActiveTurnId: TurnId | undefined;
  readonly completedTurnId: string;
  readonly failed: boolean;
  readonly lastError: string | undefined;
}): Partial<ProviderSession> {
  if (input.currentActiveTurnId !== input.completedTurnId) {
    return {};
  }
  return {
    status: input.failed ? "error" : "ready",
    activeTurnId: undefined,
    ...(input.lastError ? { lastError: input.lastError } : {}),
  };
}

export interface CodexRewindWaitPlan {
  readonly _tag: "ready" | "invalid";
  readonly rootTurnId: string | undefined;
  readonly waitForRootCompletion: boolean;
  readonly waitForSourceIdle: boolean;
}

export function resolveCodexRewindWaitPlan(input: {
  readonly turns: ReadonlyArray<{ readonly id: string; readonly status: string }>;
  readonly sourceStatus: string;
  readonly sessionActiveTurnId: TurnId | undefined;
}): CodexRewindWaitPlan {
  if (input.sourceStatus !== "active") {
    return {
      _tag: "ready",
      rootTurnId: undefined,
      waitForRootCompletion: false,
      waitForSourceIdle: false,
    };
  }
  const rootTurnId = resolveActiveCodexTurnId(input.turns, input.sessionActiveTurnId);
  if (rootTurnId === undefined) {
    return {
      _tag: "invalid",
      rootTurnId: undefined,
      waitForRootCompletion: false,
      waitForSourceIdle: false,
    };
  }
  return {
    _tag: "ready",
    rootTurnId,
    waitForRootCompletion: true,
    waitForSourceIdle: true,
  };
}

type CodexThreadRewindMethod = "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start";

interface CodexThreadRewindClient {
  readonly request: <M extends CodexThreadRewindMethod>(
    method: M,
    payload: CodexRpc.ClientRequestParamsByMethod[M],
  ) => Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M], CodexErrors.CodexAppServerError>;
}

interface CodexThreadRewindState {
  readonly getSession: Effect.Effect<ProviderSession>;
  readonly drainLiveChildTurnsForRewind: Effect.Effect<ReadonlyMap<string, string>>;
  readonly finishLiveChildTurnSettlement: Effect.Effect<void>;
  readonly settlePendingRequests: Effect.Effect<void, CodexErrors.CodexAppServerError>;
  readonly finishPendingRequestSettlement: Effect.Effect<void>;
  readonly threadMutationSemaphore: Semaphore.Semaphore;
  readonly rebindProviderThread: (input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly model: string;
  }) => Effect.Effect<void>;
}

interface CodexRewindSettlement {
  readonly sourceThreadId: string;
  rootTurnId: string | undefined;
  readonly changes: Queue.Queue<void>;
  readonly sourceTerminal: Ref.Ref<boolean>;
}

function makeCodexRewindSettlement(
  sourceThreadId: string,
  waitPlan: CodexRewindWaitPlan,
): Effect.Effect<CodexRewindSettlement> {
  return Effect.gen(function* () {
    return {
      sourceThreadId,
      rootTurnId: waitPlan.rootTurnId,
      changes: yield* Queue.unbounded<void>(),
      sourceTerminal: yield* Ref.make(false),
    } satisfies CodexRewindSettlement;
  });
}

export function isCodexTerminalThreadStatus(status: string): boolean {
  return status === "idle" || status === "systemError" || status === "notLoaded";
}

function reconcileCodexRewindSettlement(
  settlement: CodexRewindSettlement,
  thread: CodexRpc.ClientRequestResponsesByMethod["thread/read"]["thread"],
  sessionActiveTurnId: TurnId | undefined,
): Effect.Effect<string | undefined> {
  const terminal = isCodexTerminalThreadStatus(thread.status.type);
  const activeRootTurnId = terminal
    ? undefined
    : resolveActiveCodexTurnId(thread.turns, sessionActiveTurnId);
  settlement.rootTurnId = activeRootTurnId;
  return terminal
    ? Ref.set(settlement.sourceTerminal, true).pipe(Effect.as(undefined))
    : Effect.succeed(activeRootTurnId);
}

function interruptCodexLiveTurns(
  client: CodexThreadRewindClient,
  liveTurns: ReadonlyMap<string, string>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(liveTurns.entries()),
    ([childThreadId, childTurnId]) =>
      client
        .request("turn/interrupt", {
          threadId: childThreadId,
          turnId: childTurnId,
        })
        .pipe(Effect.timeoutOption(CODEX_CHILD_INTERRUPT_TIMEOUT), Effect.ignore),
    { concurrency: 8, discard: true },
  ).pipe(Effect.timeoutOption(CODEX_CHILD_INTERRUPT_BATCH_TIMEOUT), Effect.ignore);
}

function interruptCodexLiveTurn(
  client: CodexThreadRewindClient,
  childThreadId: string,
  childTurnId: string,
): Effect.Effect<void> {
  return client
    .request("turn/interrupt", {
      threadId: childThreadId,
      turnId: childTurnId,
    })
    .pipe(Effect.timeoutOption(CODEX_CHILD_INTERRUPT_TIMEOUT), Effect.ignore);
}

export function registerCodexLiveChildTurn(input: {
  readonly store: CodexLiveChildTurnStore;
  readonly client: CodexThreadRewindClient;
  readonly threadId: string;
  readonly turnId: string;
  readonly sourceThreadIdAtReceipt?: string | undefined;
  readonly getCurrentSourceThreadId?: Effect.Effect<string | undefined> | undefined;
}): Effect.Effect<boolean> {
  const interrupt = interruptCodexLiveTurn(input.client, input.threadId, input.turnId);
  if (input.sourceThreadIdAtReceipt === undefined || input.getCurrentSourceThreadId === undefined) {
    return input.store.registerAndInterrupt(
      input.threadId,
      input.turnId,
      interrupt,
      Effect.succeed(true),
    );
  }
  return input.store.registerAndInterrupt(
    input.threadId,
    input.turnId,
    interrupt,
    input.getCurrentSourceThreadId.pipe(
      Effect.map(
        (currentSourceThreadId) => currentSourceThreadId === input.sourceThreadIdAtReceipt,
      ),
    ),
  );
}

function startCodexReplacementThread(input: {
  readonly client: CodexThreadRewindClient;
  readonly sourceThreadId: string;
  readonly plan: Exclude<CodexRewindPlan, { readonly _tag: "invalid" }>;
  readonly cwd: string;
  readonly runtimeMode: RuntimeMode;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}): Effect.Effect<
  | CodexRpc.ClientRequestResponsesByMethod["thread/fork"]
  | CodexRpc.ClientRequestResponsesByMethod["thread/start"],
  CodexErrors.CodexAppServerError
> {
  if (input.plan._tag === "fork") {
    return input.client.request("thread/fork", {
      threadId: input.sourceThreadId,
      lastTurnId: input.plan.lastTurnId,
    });
  }

  return input.client.request(
    "thread/start",
    buildThreadStartParams({
      cwd: input.cwd,
      runtimeMode: input.runtimeMode,
      model: input.model,
      serviceTier: input.serviceTier,
    }),
  );
}

export interface CodexThreadRewinder {
  readonly rewindThread: (
    lastTurnId?: TurnId,
  ) => Effect.Effect<
    CodexThreadSnapshot,
    | CodexErrors.CodexAppServerError
    | CodexSessionRuntimeInvalidRetainedTurnError
    | CodexSessionRuntimeActiveTurnMissingError
    | CodexSessionRuntimeRewindSettlementTimeoutError
    | CodexSessionRuntimeThreadIdMissingError
  >;
  readonly observeTurnStarted: (input: {
    readonly threadId: string;
    readonly turnId: string;
  }) => Effect.Effect<void>;
  readonly observeTurnCompleted: (input: {
    readonly threadId: string;
    readonly turnId: string;
  }) => Effect.Effect<void>;
  readonly observeThreadStatusChanged: (input: {
    readonly threadId: string;
    readonly status: { readonly type: string };
  }) => Effect.Effect<void>;
}

export const makeCodexThreadRewinder = Effect.fn("makeCodexThreadRewinder")(function* (input: {
  readonly client: CodexThreadRewindClient;
  readonly state: CodexThreadRewindState;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly model: string | undefined;
  readonly serviceTier: CodexServiceTier | undefined;
}) {
  const settlementRef = yield* Ref.make<CodexRewindSettlement | undefined>(undefined);

  const observeTurnStarted: CodexThreadRewinder["observeTurnStarted"] = (notification) =>
    Ref.get(settlementRef).pipe(
      Effect.flatMap((settlement) => {
        if (settlement === undefined || settlement.sourceThreadId !== notification.threadId) {
          return Effect.void;
        }
        settlement.rootTurnId = notification.turnId;
        return Queue.offer(settlement.changes, undefined).pipe(Effect.asVoid);
      }),
    );

  const observeTurnCompleted: CodexThreadRewinder["observeTurnCompleted"] = (notification) =>
    Ref.get(settlementRef).pipe(
      Effect.flatMap((settlement) =>
        settlement !== undefined &&
        settlement.sourceThreadId === notification.threadId &&
        settlement.rootTurnId === notification.turnId
          ? Queue.offer(settlement.changes, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ),
    );

  const observeThreadStatusChanged: CodexThreadRewinder["observeThreadStatusChanged"] = (
    notification,
  ) =>
    Ref.get(settlementRef).pipe(
      Effect.flatMap((settlement) =>
        settlement !== undefined &&
        settlement.sourceThreadId === notification.threadId &&
        isCodexTerminalThreadStatus(notification.status.type)
          ? Effect.all(
              [
                Ref.set(settlement.sourceTerminal, true),
                Queue.offer(settlement.changes, undefined),
              ],
              { discard: true },
            )
          : Effect.void,
      ),
    );

  const rewindThread: CodexThreadRewinder["rewindThread"] = Effect.fn(
    "CodexSessionRuntime.rewindThread",
  )(function* (lastTurnId) {
    const session = yield* input.state.getSession;
    const sourceThreadId = currentProviderThreadId(session);
    if (sourceThreadId === undefined) {
      return yield* new CodexSessionRuntimeThreadIdMissingError({ threadId: session.threadId });
    }
    const source = yield* input.client.request("thread/read", {
      threadId: sourceThreadId,
      includeTurns: true,
    });
    const plan = resolveCodexRewindPlan(source.thread.turns, lastTurnId);
    if (plan._tag === "invalid") {
      return yield* new CodexSessionRuntimeInvalidRetainedTurnError({
        turnId: plan.turnId,
        reason: plan.reason,
      });
    }

    const waitPlan = resolveCodexRewindWaitPlan({
      turns: source.thread.turns,
      sourceStatus: source.thread.status.type,
      sessionActiveTurnId: session.activeTurnId,
    });
    if (waitPlan._tag === "invalid") {
      return yield* new CodexSessionRuntimeActiveTurnMissingError({ threadId: sourceThreadId });
    }
    const settlement = yield* makeCodexRewindSettlement(sourceThreadId, waitPlan);
    yield* Ref.set(settlementRef, settlement);

    return yield* Effect.gen(function* () {
      yield* input.state.settlePendingRequests;
      yield* input.state.drainLiveChildTurnsForRewind.pipe(
        Effect.flatMap((liveChildTurns) => interruptCodexLiveTurns(input.client, liveChildTurns)),
      );

      if (waitPlan.waitForRootCompletion || waitPlan.waitForSourceIdle) {
        yield* Effect.gen(function* () {
          while (!(yield* Ref.get(settlement.sourceTerminal))) {
            const reconciled = yield* input.client.request("thread/read", {
              threadId: sourceThreadId,
              includeTurns: true,
            });
            const currentSession = yield* input.state.getSession;
            const rootTurnIdToInterrupt = yield* reconcileCodexRewindSettlement(
              settlement,
              reconciled.thread,
              currentSession.activeTurnId,
            );
            if (yield* Ref.get(settlement.sourceTerminal)) {
              break;
            }
            if (rootTurnIdToInterrupt === undefined) {
              yield* Queue.take(settlement.changes);
              continue;
            }
            const interrupted = yield* input.client
              .request("turn/interrupt", {
                threadId: sourceThreadId,
                turnId: rootTurnIdToInterrupt,
              })
              .pipe(
                Effect.as(true),
                Effect.catchIf(isCodexTurnNoLongerActiveError, () => Effect.succeed(false)),
              );
            if (interrupted) {
              yield* Queue.take(settlement.changes);
            }
          }
        }).pipe(
          Effect.timeoutOrElse({
            duration: CODEX_REWIND_SETTLEMENT_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new CodexSessionRuntimeRewindSettlementTimeoutError({
                  threadId: sourceThreadId,
                }),
              ),
          }),
        );
      }

      const replacement = yield* startCodexReplacementThread({
        client: input.client,
        sourceThreadId,
        plan,
        cwd: input.cwd,
        runtimeMode: input.runtimeMode,
        model: input.model,
        serviceTier: input.serviceTier,
      });

      yield* input.state.rebindProviderThread({
        threadId: replacement.thread.id,
        cwd: replacement.cwd,
        model: replacement.model,
      });
      return parseThreadSnapshot(replacement);
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            Ref.set(settlementRef, undefined),
            input.state.finishPendingRequestSettlement,
            input.state.finishLiveChildTurnSettlement,
          ],
          { discard: true },
        ),
      ),
    );
  }, input.state.threadMutationSemaphore.withPermit);

  return {
    rewindThread,
    observeTurnStarted,
    observeTurnCompleted,
    observeThreadStatusChanged,
  } satisfies CodexThreadRewinder;
});

function readNotificationThreadId(notification: CodexServerNotification): string | undefined {
  switch (notification.method) {
    case "thread/started":
      return notification.params.thread.id;
    case "error":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "serverRequest/resolved":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "thread/compacted":
    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function readRouteFields(notification: CodexServerNotification): {
  readonly turnId: TurnId | undefined;
  readonly itemId: ProviderItemId | undefined;
} {
  switch (notification.method) {
    case "thread/started":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "turn/started":
    case "turn/completed":
      return {
        turnId: TurnId.make(notification.params.turn.id),
        itemId: undefined,
      };
    case "error":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "turn/diff/updated":
    case "turn/plan/updated":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: undefined,
      };
    case "serverRequest/resolved":
      return {
        turnId: undefined,
        itemId: undefined,
      };
    case "item/started":
    case "item/completed":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.item.id),
      };
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
      return {
        turnId: TurnId.make(notification.params.turnId),
        itemId: ProviderItemId.make(notification.params.itemId),
      };
    default:
      return {
        turnId: undefined,
        itemId: undefined,
      };
  }
}

/**
 * Native collab child-agent tracking (multi-agent v2). Under v2 subagents are
 * full app-server threads: identity arrives on `thread/started` with
 * source.subAgent.thread_spawn, lifecycle on `subAgentActivity` items and the
 * child thread's own turn/status/tokenUsage notifications. The runtime
 * registers children from those explicit signals, intercepts their
 * notifications before parent-timeline mapping, and re-emits them as
 * synthetic `collabAgent/*` provider events the adapter turns into task.*
 * runtime events (timelineBypass keeps them out of the parent chat).
 *
 * WIP, probe-gated: registration is deliberately explicit-signals-only. The
 * spec's "provisionally treat unknown foreign thread ids as v2 children" rule
 * needs a live wire capture of the packaged binary before it lands — blind
 * capture risks eating unrelated traffic. Until then a child whose first
 * notification precedes registration passes through as today (no regression
 * vs main, which passes everything through).
 */
interface CollabChildAgentState {
  readonly agentThreadId: string;
  readonly nickname: string | undefined;
  readonly role: string | undefined;
  readonly agentPath: string | undefined;
  readonly depth: number | undefined;
  readonly parentThreadId: string | undefined;
  /**
   * Parent canonical turn active when the child registered. Stamped on every
   * synthetic collabAgent/* event so clients can batch a fleet by its spawn
   * turn — without it, separate fleets in one thread collapsed into a single
   * "direct:no-turn" CTA (review finding).
   */
  readonly spawnTurnId: TurnId | undefined;
}

function readThreadSpawnSource(thread: { readonly source: unknown }):
  | {
      nickname: string | undefined;
      role: string | undefined;
      agentPath: string | undefined;
      depth: number | undefined;
      parentThreadId: string | undefined;
    }
  | undefined {
  const source = thread.source;
  if (typeof source !== "object" || source === null || !("subAgent" in source)) {
    return undefined;
  }
  const subAgent = (source as { subAgent: unknown }).subAgent;
  if (typeof subAgent !== "object" || subAgent === null || !("thread_spawn" in subAgent)) {
    return undefined;
  }
  const spawn = (subAgent as { thread_spawn: unknown }).thread_spawn;
  if (typeof spawn !== "object" || spawn === null) {
    return undefined;
  }
  const record = spawn as Record<string, unknown>;
  return {
    nickname: typeof record.agent_nickname === "string" ? record.agent_nickname : undefined,
    role: typeof record.agent_role === "string" ? record.agent_role : undefined,
    agentPath: typeof record.agent_path === "string" ? record.agent_path : undefined,
    depth: typeof record.depth === "number" ? record.depth : undefined,
    parentThreadId:
      typeof record.parent_thread_id === "string" ? record.parent_thread_id : undefined,
  };
}

export function resolveRetiredCodexChildThreadId(input: {
  readonly childThreadId: string;
  readonly parentThreadId: string | undefined;
  readonly spawnParentThreadId: string | undefined;
  readonly retiredThreadIds: ReadonlySet<string>;
}): string | undefined {
  return input.retiredThreadIds.has(input.childThreadId) ||
    (input.parentThreadId !== undefined && input.retiredThreadIds.has(input.parentThreadId)) ||
    (input.spawnParentThreadId !== undefined &&
      input.retiredThreadIds.has(input.spawnParentThreadId))
    ? input.childThreadId
    : undefined;
}

export function settleCodexNotificationFromRetiredSource(input: {
  readonly notification:
    | {
        readonly _tag: "thread-started";
        readonly childThreadId: string;
        readonly parentThreadId: string | undefined;
        readonly spawnParentThreadId: string | undefined;
      }
    | {
        readonly _tag: "turn-started";
        readonly threadId: string;
        readonly turnId: string;
      };
  readonly sourceThreadIdAtReceipt: string | undefined;
  readonly getCurrentSourceThreadId: Effect.Effect<string | undefined>;
  readonly retiredThreadIdsRef: Ref.Ref<Set<string>>;
  readonly client: CodexThreadRewindClient;
}): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const currentSourceThreadId = yield* input.getCurrentSourceThreadId;
    const retiredThreadIds = yield* Ref.get(input.retiredThreadIdsRef);
    const sourceChanged =
      input.sourceThreadIdAtReceipt !== undefined &&
      currentSourceThreadId !== input.sourceThreadIdAtReceipt;
    if (input.notification._tag === "thread-started") {
      const retiredChildThreadId = resolveRetiredCodexChildThreadId({
        childThreadId: input.notification.childThreadId,
        parentThreadId: input.notification.parentThreadId,
        spawnParentThreadId: input.notification.spawnParentThreadId,
        retiredThreadIds,
      });
      if (retiredChildThreadId === undefined) {
        return false;
      }
      yield* Ref.update(input.retiredThreadIdsRef, (current) => {
        const next = new Set(current);
        next.add(retiredChildThreadId);
        return next;
      });
      return true;
    }
    if (!sourceChanged && !retiredThreadIds.has(input.notification.threadId)) {
      return false;
    }
    yield* interruptCodexLiveTurn(
      input.client,
      input.notification.threadId,
      input.notification.turnId,
    );
    return true;
  });
}

function rememberCollabReceiverTurns(
  collabReceiverTurns: Map<string, TurnId>,
  notification: CodexServerNotification,
  parentTurnId: TurnId | undefined,
): void {
  if (!parentTurnId) {
    return;
  }

  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return;
  }

  if (notification.params.item.type !== "collabAgentToolCall") {
    return;
  }

  for (const receiverThreadId of notification.params.item.receiverThreadIds) {
    collabReceiverTurns.set(receiverThreadId, parentTurnId);
  }
}

function shouldSuppressChildConversationNotification(
  method: CodexRpc.ServerNotificationMethod,
): boolean {
  return (
    method === "thread/started" ||
    method === "thread/status/changed" ||
    method === "thread/archived" ||
    method === "thread/unarchived" ||
    method === "thread/closed" ||
    method === "thread/compacted" ||
    method === "thread/name/updated" ||
    method === "thread/tokenUsage/updated" ||
    method === "turn/started" ||
    method === "turn/completed" ||
    method === "turn/plan/updated" ||
    method === "item/plan/delta"
  );
}

/**
 * How a notification addressed to a REGISTERED child thread is handled.
 *
 * Exported and pure so the routing table can be asserted against captured
 * wire traces (see codexMultiAgentWire.json) rather than only read.
 *
 * - "agent-event": map to a synthetic collabAgent/* event (Agents surface).
 * - "parent": pass through to the parent path — it carries state the parent
 *   still owns (approval correlation cleanup).
 * - "drop": genuine child chatter with no parent meaning (deltas, name and
 *   plan updates).
 *
 * Default is "drop" ONLY for the enumerated chatter; anything unrecognized
 * routes to "parent" so new wire methods surface instead of vanishing
 * (two shipped bugs came from a catch-all that swallowed everything).
 */
export type CodexChildNotificationRoute = "agent-event" | "parent" | "drop";

const CHILD_AGENT_EVENT_METHODS: ReadonlySet<string> = new Set([
  "turn/started",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "item/started",
  "item/completed",
  "thread/closed",
  "error",
]);

const CHILD_CHATTER_METHODS: ReadonlySet<string> = new Set([
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/plan/delta",
  "turn/plan/updated",
  "turn/diff/updated",
  "thread/name/updated",
  "thread/settings/updated",
  "rawResponseItem/completed",
  // Child-owned thread lifecycle: the parent adapter maps these onto the
  // PARENT thread (archived/compacted state), so a child compacting would
  // rewrite the parent. Mirrors the v1 suppressor list — dropping them is
  // the pre-existing behavior for collab children (review finding).
  "thread/archived",
  "thread/unarchived",
  "thread/compacted",
  // Registration path 1 handles a child's first thread/started; a repeat
  // must not reach the parent (it would restart the parent's thread state).
  "thread/started",
]);

export function routeCodexChildNotification(method: string): CodexChildNotificationRoute {
  if (CHILD_AGENT_EVENT_METHODS.has(method)) {
    return "agent-event";
  }
  if (CHILD_CHATTER_METHODS.has(method)) {
    return "drop";
  }
  // Unknown or parent-owned (serverRequest/resolved, approvals, …).
  return "parent";
}

function toCodexUserInputAnswer(
  questionId: string,
  value: ProviderUserInputAnswers[string],
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse__ToolRequestUserInputAnswer,
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  if (typeof value === "string") {
    return Effect.succeed({ answers: [value] });
  }
  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return Effect.succeed({ answers });
  }
  if (isCodexUserInputAnswerObject(value)) {
    return Effect.succeed({ answers: value.answers });
  }
  return Effect.fail(new CodexSessionRuntimeInvalidUserInputAnswersError({ questionId }));
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Effect.Effect<
  EffectCodexSchema.ToolRequestUserInputResponse["answers"],
  CodexSessionRuntimeInvalidUserInputAnswersError
> {
  return Effect.forEach(
    Object.entries(answers),
    ([questionId, value]) =>
      toCodexUserInputAnswer(questionId, value).pipe(
        Effect.map((answer) => [questionId, answer] as const),
      ),
    { concurrency: 1 },
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));
}

function currentProviderThreadId(session: ProviderSession): string | undefined {
  return readResumeCursorThreadId(session.resumeCursor);
}

function updateSession(
  sessionRef: Ref.Ref<ProviderSession>,
  updates: Partial<ProviderSession> | ((session: ProviderSession) => Partial<ProviderSession>),
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Ref.update(sessionRef, (session) => ({
      ...session,
      ...(typeof updates === "function" ? updates(session) : updates),
      updatedAt,
    }));
  });
}

function parseThreadSnapshot(
  response:
    | EffectCodexSchema.V2ThreadReadResponse
    | EffectCodexSchema.V2ThreadRollbackResponse
    | EffectCodexSchema.V2ThreadForkResponse
    | EffectCodexSchema.V2ThreadStartResponse,
): CodexThreadSnapshot {
  return {
    threadId: response.thread.id,
    turns: response.thread.turns.map((turn) => ({
      id: TurnId.make(turn.id),
      items: turn.items,
    })),
  };
}

export const makeCodexSessionRuntime = (
  options: CodexSessionRuntimeOptions,
): Effect.Effect<
  CodexSessionRuntimeShape,
  CodexErrors.CodexAppServerError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<ProviderEvent>();
    const pendingApprovals = yield* makeCodexPendingRequestStore<PendingApproval>();
    const approvalCorrelationsRef = yield* Ref.make(new Map<string, ApprovalCorrelation>());
    const pendingUserInputs = yield* makeCodexPendingRequestStore<PendingUserInput>();
    const collabReceiverTurnsRef = yield* Ref.make(new Map<string, TurnId>());
    const collabChildAgentsRef = yield* Ref.make(new Map<string, CollabChildAgentState>());
    const currentProviderChildThreadIdsRef = yield* Ref.make(new Set<string>());
    const retiredProviderThreadIdsRef = yield* Ref.make(new Set<string>());
    /** Child provider-thread id → its currently running provider turn id. */
    const collabChildLiveTurns = yield* makeCodexLiveChildTurnStore();
    const closedRef = yield* Ref.make(false);
    const threadMutationSemaphore = yield* Semaphore.make(1);
    const pendingRequestSemaphore = yield* Semaphore.make(1);

    // `~` is not shell-expanded when env vars are set via
    // `child_process.spawn`; `expandHomePath` lets a configured
    // `CODEX_HOME=~/.codex_work` reach codex as an absolute path.
    const resolvedHomePath = options.homePath ? expandHomePath(options.homePath) : undefined;
    const env = {
      ...options.environment,
      ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
    };
    const extendEnv = options.environment === undefined;
    const appServerArgs = codexSessionAppServerArgs(options.appServerArgs, options.launchArgs);
    const spawnCommand = yield* resolveSpawnCommand(options.binaryPath, appServerArgs, {
      env,
      extendEnv,
    });
    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: options.cwd,
          env,
          extendEnv,
          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerSpawnError({
              command: `${options.binaryPath} app-server`,
              cause,
            }),
        ),
      );

    const clientContext = yield* CodexClient.layerChildProcess(child).pipe(
      Layer.build,
      Effect.provideService(Scope.Scope, runtimeScope),
    );
    const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
      Effect.provide(clientContext),
    );
    const serverNotifications = yield* Queue.unbounded<CodexServerNotification>();
    const drainServerNotifications = (): Effect.Effect<void> =>
      Queue.poll(serverNotifications).pipe(
        Effect.flatMap((notification) =>
          notification._tag === "Some" ? drainServerNotifications() : Effect.void,
        ),
      );
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = (purpose: CodexErrors.CodexAppServerIdentifierPurpose) =>
      crypto.randomUUIDv4.pipe(
        Effect.mapError(
          (cause) =>
            new CodexErrors.CodexAppServerIdentifierGenerationError({
              purpose,
              cause,
            }),
        ),
      );

    const sessionCreatedAt = yield* nowIso;
    const initialSession = {
      provider: PROVIDER,
      ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
      status: "connecting",
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      threadId: options.threadId,
      ...(options.resumeCursor !== undefined ? { resumeCursor: options.resumeCursor } : {}),
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt,
    } satisfies ProviderSession;
    const sessionRef = yield* Ref.make<ProviderSession>(initialSession);
    const offerEvent = (event: ProviderEvent) => Queue.offer(events, event).pipe(Effect.asVoid);

    const emitEvent = (event: Omit<ProviderEvent, "id" | "provider" | "createdAt">) =>
      Effect.gen(function* () {
        const id = yield* randomUUIDv4("provider-event");
        return yield* offerEvent({
          id: EventId.make(id),
          provider: PROVIDER,
          ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
          createdAt: yield* nowIso,
          ...event,
        });
      });
    const emitSessionEvent = (method: string, message: string) =>
      emitEvent({
        kind: "session",
        threadId: options.threadId,
        method,
        message,
      });

    const settlePendingApprovals = (decision: ProviderApprovalDecision) =>
      pendingApprovals.drainForRewind.pipe(
        Effect.flatMap((requests) =>
          Effect.forEach(requests, (request) => Deferred.succeed(request.decision, decision), {
            discard: true,
          }),
        ),
        Effect.ensuring(pendingApprovals.finishRewind),
      );

    const settlePendingUserInputs = (answers: ProviderUserInputAnswers) =>
      pendingUserInputs.drainForRewind.pipe(
        Effect.flatMap((requests) =>
          Effect.forEach(requests, (request) => Deferred.succeed(request.answers, answers), {
            discard: true,
          }),
        ),
        Effect.ensuring(pendingUserInputs.finishRewind),
      );

    const takePendingApproval = pendingApprovals.take;
    const takePendingUserInput = pendingUserInputs.take;

    const resolvePendingApproval = (pending: PendingApproval, decision: ProviderApprovalDecision) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(pending.decision, decision);
        yield* emitEvent(
          makeCodexApprovalDecisionEvent({ threadId: options.threadId, pending, decision }),
        );
      });

    const resolvePendingUserInput = (
      pending: PendingUserInput,
      answers: ProviderUserInputAnswers,
      codexAnswers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
    ) =>
      Effect.gen(function* () {
        yield* Deferred.succeed(pending.answers, answers);
        yield* emitEvent(
          makeCodexUserInputAnsweredEvent({
            threadId: options.threadId,
            pending,
            answers: codexAnswers,
          }),
        );
      });

    const settlePendingRequestsForRewind = Effect.all(
      [
        pendingApprovals.drainForRewind.pipe(
          Effect.flatMap((requests) =>
            Effect.forEach(requests, (request) => resolvePendingApproval(request, "cancel"), {
              discard: true,
            }),
          ),
        ),
        pendingUserInputs.drainForRewind.pipe(
          Effect.flatMap((requests) =>
            Effect.forEach(requests, (request) => resolvePendingUserInput(request, {}, {}), {
              discard: true,
            }),
          ),
        ),
      ],
      { discard: true },
    ).pipe(pendingRequestSemaphore.withPermit);

    const threadRewinder = yield* makeCodexThreadRewinder({
      client,
      runtimeMode: options.runtimeMode,
      cwd: options.cwd,
      model: options.model,
      serviceTier: options.serviceTier,
      state: {
        getSession: Ref.get(sessionRef),
        drainLiveChildTurnsForRewind: collabChildLiveTurns.drainForRewind,
        finishLiveChildTurnSettlement: collabChildLiveTurns.settleBeforeRebind(Effect.void),
        settlePendingRequests: settlePendingRequestsForRewind,
        finishPendingRequestSettlement: Effect.all(
          [pendingApprovals.finishRewind, pendingUserInputs.finishRewind],
          { discard: true },
        ),
        threadMutationSemaphore,
        rebindProviderThread: (replacement) =>
          collabChildLiveTurns.settleBeforeRebind(
            Effect.gen(function* () {
              const currentSession = yield* Ref.get(sessionRef);
              const retiredThreadIds = new Set(yield* Ref.get(retiredProviderThreadIdsRef));
              const sourceThreadId = currentProviderThreadId(currentSession);
              if (sourceThreadId !== undefined) {
                retiredThreadIds.add(sourceThreadId);
              }
              for (const childThreadId of yield* Ref.get(currentProviderChildThreadIdsRef)) {
                retiredThreadIds.add(childThreadId);
              }
              for (const childThreadId of (yield* Ref.get(collabChildAgentsRef)).keys()) {
                retiredThreadIds.add(childThreadId);
              }
              for (const childThreadId of (yield* Ref.get(collabReceiverTurnsRef)).keys()) {
                retiredThreadIds.add(childThreadId);
              }
              retiredThreadIds.delete(replacement.threadId);
              yield* Ref.set(retiredProviderThreadIdsRef, retiredThreadIds);
              yield* Ref.set(currentProviderChildThreadIdsRef, new Set());
              yield* Ref.set(approvalCorrelationsRef, new Map());
              yield* Ref.set(collabReceiverTurnsRef, new Map());
              yield* Ref.set(collabChildAgentsRef, new Map());
              yield* drainServerNotifications();
              yield* updateSession(sessionRef, {
                status: "ready",
                activeTurnId: undefined,
                cwd: replacement.cwd,
                model: replacement.model,
                resumeCursor: { threadId: replacement.threadId },
              });
            }),
          ),
      },
    });

    /**
     * Registers v2 collab children and re-emits their notifications as
     * synthetic `collabAgent/*` events for the adapter's task.* synthesis.
     * Returns true when the notification was fully handled (must not reach
     * parent-timeline mapping).
     */
    const interceptCollabChildNotification = (
      notification: CodexServerNotification,
      sourceThreadIdAtReceipt: string | undefined,
    ) =>
      Effect.gen(function* () {
        const currentSourceThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
        if (
          sourceThreadIdAtReceipt !== undefined &&
          currentSourceThreadId !== sourceThreadIdAtReceipt
        ) {
          if (notification.method === "turn/started") {
            yield* interruptCodexLiveTurn(
              client,
              notification.params.threadId,
              notification.params.turn.id,
            );
          }
          return true;
        }
        // Registration path 1: child thread announces itself with a
        // subAgent thread_spawn source.
        if (notification.method === "thread/started") {
          const thread = notification.params.thread;
          const spawn = readThreadSpawnSource(thread);
          if (!spawn) {
            return false;
          }
          // Merge with any subAgentActivity registration that got here
          // first. spawnTurnId is REGISTRATION-time-only on both paths: for
          // an already-known child we keep its value (set or unset) — a
          // later thread/started during an unrelated parent turn must not
          // backfill that turn as the spawn batch, which would stamp an old
          // child onto a new fleet's CTA (review finding). Only a genuinely
          // new registration captures the current turn.
          const existingChild = (yield* Ref.get(collabChildAgentsRef)).get(thread.id);
          const spawnTurnId = existingChild
            ? existingChild.spawnTurnId
            : ((yield* Ref.get(sessionRef)).activeTurnId ?? undefined);
          const state: CollabChildAgentState = {
            agentThreadId: thread.id,
            nickname: spawn.nickname ?? thread.agentNickname ?? existingChild?.nickname,
            role: spawn.role ?? thread.agentRole ?? existingChild?.role,
            agentPath: spawn.agentPath ?? existingChild?.agentPath,
            depth: spawn.depth ?? existingChild?.depth,
            parentThreadId:
              spawn.parentThreadId ?? thread.parentThreadId ?? existingChild?.parentThreadId,
            spawnTurnId,
          };
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const next = new Map(current);
            next.set(thread.id, state);
            return next;
          });
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/started",
            ...(state.spawnTurnId ? { turnId: state.spawnTurnId } : {}),
            payload: {
              agentThreadId: state.agentThreadId,
              ...(state.nickname ? { nickname: state.nickname } : {}),
              ...(state.role ? { role: state.role } : {}),
              ...(state.agentPath ? { agentPath: state.agentPath } : {}),
              ...(state.depth !== undefined ? { depth: state.depth } : {}),
              ...(state.parentThreadId ? { parentThreadId: state.parentThreadId } : {}),
            },
          });
          return true;
        }

        // Registration path 2: parent-side subAgentActivity item names the
        // child thread (may arrive before or after thread/started).
        if (
          (notification.method === "item/started" || notification.method === "item/completed") &&
          notification.params.item.type === "subAgentActivity"
        ) {
          const item = notification.params.item;
          // Never register the session's ROOT thread as its own child. The
          // wire emits subAgentActivity {agentPath: "/root", interacted}
          // about the root during collab runs; registering it intercepted
          // every subsequent root notification — including the final
          // assistant message and turn/completed — so the thread hung
          // "working" after all subagents finished (live-probe finding).
          const rootProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
          if (
            item.agentThreadId === rootProviderThreadId ||
            item.agentPath === "/root" ||
            item.agentPath === "/"
          ) {
            return false;
          }
          const activitySpawnTurnId = (yield* Ref.get(sessionRef)).activeTurnId ?? undefined;
          yield* Ref.update(collabChildAgentsRef, (current) => {
            const existing = current.get(item.agentThreadId);
            const next = new Map(current);
            // Merge-late semantics: when thread/started registered first, a
            // later subAgentActivity still carries the real agentPath (and a
            // derived nickname) — fill missing fields, never clobber known
            // ones. spawnTurnId is registration-time-only: for an already
            // registered child, a later activity during an UNRELATED turn
            // must not backfill that turn as the spawn batch (review
            // finding); an unset spawn turn stays unset.
            next.set(item.agentThreadId, {
              agentThreadId: item.agentThreadId,
              nickname:
                existing?.nickname ??
                item.agentPath.split("/").findLast((segment) => segment.length > 0),
              role: existing?.role,
              agentPath: existing?.agentPath ?? item.agentPath,
              depth: existing?.depth,
              parentThreadId: existing?.parentThreadId,
              spawnTurnId: existing ? existing.spawnTurnId : activitySpawnTurnId,
            });
            return next;
          });
          const registeredChild = (yield* Ref.get(collabChildAgentsRef)).get(item.agentThreadId);
          yield* emitEvent({
            kind: "notification",
            threadId: options.threadId,
            method: "collabAgent/activity",
            ...(registeredChild?.spawnTurnId ? { turnId: registeredChild.spawnTurnId } : {}),
            payload: {
              agentThreadId: item.agentThreadId,
              agentPath: item.agentPath,
              activityKind: item.kind,
            },
          });
          return true;
        }

        // Interception: notifications addressed to a registered child thread
        // become agent-scoped synthetic events instead of parent chatter.
        const providerConversationId = readNotificationThreadId(notification);
        if (!providerConversationId) {
          return false;
        }
        // Belt-and-braces: the root thread's traffic must never be
        // intercepted, whatever the registry says.
        const interceptRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        if (providerConversationId === interceptRootId) {
          return false;
        }
        const children = yield* Ref.get(collabChildAgentsRef);
        const child = children.get(providerConversationId);
        if (!child) {
          return false;
        }
        const childIdentity = {
          agentThreadId: child.agentThreadId,
          ...(child.nickname ? { nickname: child.nickname } : {}),
          ...(child.role ? { role: child.role } : {}),
          ...(child.agentPath ? { agentPath: child.agentPath } : {}),
        };
        switch (notification.method) {
          case "turn/started": {
            const childTurnId =
              typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                ? ((notification.params as { turn: { id: string } }).turn.id as string)
                : undefined;
            if (childTurnId) {
              const currentSource = yield* registerCodexLiveChildTurn({
                store: collabChildLiveTurns,
                client,
                threadId: child.agentThreadId,
                turnId: childTurnId,
                sourceThreadIdAtReceipt,
                getCurrentSourceThreadId: Ref.get(sessionRef).pipe(
                  Effect.map(currentProviderThreadId),
                ),
              });
              if (!currentSource) {
                return true;
              }
            }
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnStarted",
              payload: childIdentity,
            });
            return true;
          }
          case "turn/completed":
            yield* collabChildLiveTurns.remove(child.agentThreadId);
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/turnCompleted",
              payload: {
                ...childIdentity,
                turn: notification.params.turn,
              },
            });
            return true;
          case "thread/status/changed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: notification.params.status,
              },
            });
            return true;
          case "thread/tokenUsage/updated":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/tokenUsage",
              payload: {
                ...childIdentity,
                tokenUsage: notification.params.tokenUsage,
              },
            });
            return true;
          case "item/started":
          case "item/completed":
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/item",
              payload: {
                ...childIdentity,
                item: notification.params.item,
              },
            });
            return true;
          case "thread/closed":
            // The child is gone: drop its live-turn entry so a later Stop
            // doesn't waste a turn/interrupt RPC on a closed thread before
            // reaching the parent (review finding).
            yield* collabChildLiveTurns.remove(child.agentThreadId);
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/closed",
              payload: childIdentity,
            });
            return true;
          case "error": {
            // A child error must surface as a failed agent, not vanish into
            // the default swallow (review finding: the child stayed
            // "running" forever). Retryable errors (willRetry) keep the
            // child RUNNING and interruptible — mirroring the root error
            // handler; settling it would orphan a still-live child from
            // Stop (review finding). Terminal errors clean up the live turn
            // like thread/closed and reuse the statusChanged systemError
            // path.
            const willRetry = (notification.params as { willRetry?: boolean }).willRetry === true;
            if (willRetry) {
              return true;
            }
            yield* collabChildLiveTurns.remove(child.agentThreadId);
            yield* emitEvent({
              kind: "notification",
              threadId: options.threadId,
              ...(child.spawnTurnId ? { turnId: child.spawnTurnId } : {}),
              method: "collabAgent/statusChanged",
              payload: {
                ...childIdentity,
                status: { type: "systemError" },
              },
            });
            return true;
          }
          default:
            // Routing table decides (single source of truth, asserted
            // against captured wire traces): enumerated chatter is dropped,
            // everything else — including methods this build has never seen
            // — falls through to the parent path rather than vanishing.
            return routeCodexChildNotification(notification.method) === "drop";
        }
      });

    const handleRawNotificationWithReceiptSource = (
      notification: CodexServerNotification,
      sourceThreadIdAtReceipt: string | undefined,
    ) =>
      Effect.gen(function* () {
        const providerConversationId = readNotificationThreadId(notification);
        if (notification.method === "thread/started" || notification.method === "turn/started") {
          const handled = yield* settleCodexNotificationFromRetiredSource({
            notification:
              notification.method === "thread/started"
                ? {
                    _tag: "thread-started" as const,
                    childThreadId: notification.params.thread.id,
                    parentThreadId: notification.params.thread.parentThreadId ?? undefined,
                    spawnParentThreadId:
                      readThreadSpawnSource(notification.params.thread)?.parentThreadId ??
                      undefined,
                  }
                : {
                    _tag: "turn-started" as const,
                    threadId: notification.params.threadId,
                    turnId: notification.params.turn.id,
                  },
            sourceThreadIdAtReceipt,
            getCurrentSourceThreadId: Ref.get(sessionRef).pipe(Effect.map(currentProviderThreadId)),
            retiredThreadIdsRef: retiredProviderThreadIdsRef,
            client,
          });
          if (handled) {
            return;
          }
        }
        const retiredThreadIds = yield* Ref.get(retiredProviderThreadIdsRef);
        if (providerConversationId !== undefined && retiredThreadIds.has(providerConversationId)) {
          return;
        }
        if (
          providerConversationId !== undefined &&
          sourceThreadIdAtReceipt !== undefined &&
          providerConversationId !== sourceThreadIdAtReceipt
        ) {
          yield* Ref.update(currentProviderChildThreadIdsRef, (current) => {
            const next = new Set(current);
            next.add(providerConversationId);
            return next;
          });
        }
        const payload = notification.params;
        const route = readRouteFields(notification);
        const collabReceiverTurns = yield* Ref.get(collabReceiverTurnsRef);
        const childParentTurnId = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return providerConversationId
            ? collabReceiverTurns.get(providerConversationId)
            : undefined;
        })();

        rememberCollabReceiverTurns(collabReceiverTurns, notification, route.turnId);
        // Interception FIRST: a registered v2 child is usually also in the
        // receiver-turn map (collabAgentToolCall.receiverThreadIds), and the
        // legacy suppressor below would drop its lifecycle before it could
        // become synthetic collabAgent events (review finding). The
        // suppressor still covers UNREGISTERED children.
        if (yield* interceptCollabChildNotification(notification, sourceThreadIdAtReceipt)) {
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        // Suppression applies to receiver-map children (v1) AND to any
        // conversation that is not the root thread. The live capture
        // (codexMultiAgentWire.json) shows a child's thread/status/changed
        // arriving BEFORE anything registers the child — pre-registration
        // lifecycle must not reach the parent path, where the adapter maps
        // thread/* onto parent session state. Root-id-known guard keeps the
        // root's own early notifications flowing during session open.
        const suppressRootId = currentProviderThreadId(yield* Ref.get(sessionRef));
        const foreignConversation = (() => {
          const providerConversationId = readNotificationThreadId(notification);
          return (
            providerConversationId !== undefined &&
            suppressRootId !== undefined &&
            providerConversationId !== suppressRootId
          );
        })();
        if (
          (childParentTurnId !== undefined || foreignConversation) &&
          shouldSuppressChildConversationNotification(notification.method)
        ) {
          // Stop-everything must not depend on registration timing: a
          // child's turn/started can arrive before the subAgentActivity that
          // registers it (captured ordering), and suppressing it without
          // remembering the live turn would leave that child running after
          // Stop (review finding). Track live turns for ANY foreign
          // conversation; interrupts are best-effort per child, so a
          // false-positive entry costs one ignored RPC at worst.
          const foreignThreadId = readNotificationThreadId(notification);
          if (foreignThreadId !== undefined) {
            if (notification.method === "turn/started") {
              const foreignTurnId =
                typeof (notification.params as { turn?: { id?: unknown } }).turn?.id === "string"
                  ? (notification.params as { turn: { id: string } }).turn.id
                  : undefined;
              if (foreignTurnId) {
                yield* registerCodexLiveChildTurn({
                  store: collabChildLiveTurns,
                  client,
                  threadId: foreignThreadId,
                  turnId: foreignTurnId,
                  sourceThreadIdAtReceipt,
                  getCurrentSourceThreadId: Ref.get(sessionRef).pipe(
                    Effect.map(currentProviderThreadId),
                  ),
                });
              }
            } else if (
              notification.method === "turn/completed" ||
              notification.method === "thread/closed"
            ) {
              yield* collabChildLiveTurns.remove(foreignThreadId);
            }
          }
          yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
          return;
        }

        let requestId: ApprovalRequestId | undefined;
        let requestKind: ProviderRequestKind | undefined;
        let turnId = childParentTurnId ?? route.turnId;
        let itemId = route.itemId;

        if (notification.method === "serverRequest/resolved") {
          const rawRequestId =
            typeof notification.params.requestId === "string"
              ? notification.params.requestId
              : String(notification.params.requestId);
          const correlation = rawRequestId
            ? (yield* Ref.get(approvalCorrelationsRef)).get(rawRequestId)
            : undefined;
          if (correlation) {
            requestId = correlation.requestId;
            requestKind = correlation.requestKind;
            turnId = correlation.turnId ?? turnId;
            itemId = correlation.itemId ?? itemId;
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.delete(rawRequestId);
              return next;
            });
          }
        }

        yield* Ref.set(collabReceiverTurnsRef, collabReceiverTurns);
        yield* emitEvent({
          kind: "notification",
          threadId: options.threadId,
          method: notification.method,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
          ...(requestId ? { requestId } : {}),
          ...(requestKind ? { requestKind } : {}),
          ...(notification.method === "item/agentMessage/delta"
            ? { textDelta: notification.params.delta }
            : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
      });

    const handleRawNotification = (notification: CodexServerNotification) =>
      Effect.gen(function* () {
        const sourceThreadIdAtReceipt = currentProviderThreadId(yield* Ref.get(sessionRef));
        const handle = handleRawNotificationWithReceiptSource(
          notification,
          sourceThreadIdAtReceipt,
        );
        return yield* notification.method === "thread/started"
          ? collabChildLiveTurns.withSettlementPermit(handle)
          : handle;
      });

    const currentSessionProviderThreadId = Effect.map(Ref.get(sessionRef), currentProviderThreadId);

    yield* client.handleServerNotification("thread/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.thread.id !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            resumeCursor: { threadId: payload.thread.id },
          });
        }),
      ),
    );

    yield* client.handleServerNotification("turn/started", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          return updateSession(sessionRef, {
            status: "running",
            activeTurnId: TurnId.make(payload.turn.id),
          }).pipe(
            Effect.andThen(
              threadRewinder.observeTurnStarted({
                threadId: payload.threadId,
                turnId: payload.turn.id,
              }),
            ),
          );
        }),
      ),
    );

    yield* client.handleServerNotification("turn/completed", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          if (providerThreadId && payload.threadId !== providerThreadId) {
            return Effect.void;
          }
          const lastError =
            payload.turn.status === "failed" && "error" in payload.turn && payload.turn.error
              ? payload.turn.error.message
              : undefined;
          return updateSession(sessionRef, (session) =>
            resolveCodexTurnCompletionSessionUpdate({
              currentActiveTurnId: session.activeTurnId,
              completedTurnId: payload.turn.id,
              failed: payload.turn.status === "failed",
              lastError,
            }),
          ).pipe(
            Effect.andThen(
              threadRewinder.observeTurnCompleted({
                threadId: payload.threadId,
                turnId: payload.turn.id,
              }),
            ),
          );
        }),
      ),
    );

    yield* client.handleServerNotification("thread/status/changed", (payload) =>
      threadRewinder.observeThreadStatusChanged(payload),
    );

    yield* client.handleServerNotification("error", (payload) =>
      currentSessionProviderThreadId.pipe(
        Effect.flatMap((providerThreadId) => {
          const payloadThreadId = payload.threadId;
          if (providerThreadId && payloadThreadId && payloadThreadId !== providerThreadId) {
            return Effect.void;
          }
          const errorMessage = payload.error.message;
          const willRetry = payload.willRetry;
          return updateSession(sessionRef, {
            status: willRetry ? "running" : "error",
            ...(errorMessage ? { lastError: errorMessage } : {}),
          });
        }),
      ),
    );

    yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
      Effect.gen(function* () {
        const pending = yield* pendingRequestSemaphore.withPermit(
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(
              yield* randomUUIDv4("command-approval-request"),
            );
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            const pending = {
              requestId,
              jsonRpcId: payload.approvalId ?? payload.itemId,
              requestKind: "command",
              turnId,
              itemId,
              decision,
            } satisfies PendingApproval;
            const settleImmediately = yield* pendingApprovals.register(requestId, pending);
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.set(payload.approvalId ?? payload.itemId, {
                requestId,
                requestKind: "command",
                turnId,
                itemId,
              });
              return next;
            });
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/commandExecution/requestApproval",
              requestId,
              requestKind: "command",
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });
            if (settleImmediately) {
              yield* resolvePendingApproval(pending, "cancel");
            }
            return pending;
          }),
        );
        const resolved = yield* Deferred.await(pending.decision).pipe(
          Effect.ensuring(pendingApprovals.take(pending.requestId)),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.CommandExecutionRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
      Effect.gen(function* () {
        const pending = yield* pendingRequestSemaphore.withPermit(
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(
              yield* randomUUIDv4("file-change-approval-request"),
            );
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            const pending = {
              requestId,
              jsonRpcId: payload.itemId,
              requestKind: "file-change",
              turnId,
              itemId,
              decision,
            } satisfies PendingApproval;
            const settleImmediately = yield* pendingApprovals.register(requestId, pending);
            yield* Ref.update(approvalCorrelationsRef, (current) => {
              const next = new Map(current);
              next.set(payload.itemId, {
                requestId,
                requestKind: "file-change",
                turnId,
                itemId,
              });
              return next;
            });
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/fileChange/requestApproval",
              requestId,
              requestKind: "file-change",
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });
            if (settleImmediately) {
              yield* resolvePendingApproval(pending, "cancel");
            }
            return pending;
          }),
        );
        const resolved = yield* Deferred.await(pending.decision).pipe(
          Effect.ensuring(pendingApprovals.take(pending.requestId)),
        );
        return {
          decision: resolved,
        } satisfies EffectCodexSchema.FileChangeRequestApprovalResponse;
      }),
    );

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.gen(function* () {
        const pending = yield* pendingRequestSemaphore.withPermit(
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.make(yield* randomUUIDv4("user-input-request"));
            const turnId = TurnId.make(payload.turnId);
            const itemId = ProviderItemId.make(payload.itemId);
            const answers = yield* Deferred.make<ProviderUserInputAnswers>();
            const pending = { requestId, turnId, itemId, answers } satisfies PendingUserInput;
            const settleImmediately = yield* pendingUserInputs.register(requestId, pending);
            yield* emitEvent({
              kind: "request",
              threadId: options.threadId,
              method: "item/tool/requestUserInput",
              requestId,
              ...(turnId ? { turnId } : {}),
              ...(itemId ? { itemId } : {}),
              payload,
            });
            if (settleImmediately) {
              yield* resolvePendingUserInput(pending, {}, {});
            }
            return pending;
          }),
        );
        const resolvedAnswers = yield* Deferred.await(pending.answers).pipe(
          Effect.ensuring(pendingUserInputs.take(pending.requestId)),
        );
        return {
          answers: yield* toCodexUserInputAnswers(resolvedAnswers).pipe(
            Effect.mapError((error) =>
              CodexErrors.CodexAppServerRequestError.invalidParams(error.message, {
                questionId: error.questionId,
              }),
            ),
          ),
        } satisfies EffectCodexSchema.ToolRequestUserInputResponse;
      }),
    );

    yield* client.handleUnknownServerRequest((method) =>
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method)),
    );

    const registerServerNotification = <M extends CodexRpc.ServerNotificationMethod>(method: M) =>
      client.handleServerNotification(method, (params) =>
        Queue.offer(serverNotifications, makeCodexServerNotification(method, params)).pipe(
          Effect.asVoid,
        ),
      );

    yield* Effect.forEach(
      Object.values(
        CodexRpc.SERVER_NOTIFICATION_METHODS,
      ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
      registerServerNotification,
      { concurrency: 1, discard: true },
    );

    yield* Stream.fromQueue(serverNotifications).pipe(
      Stream.runForEach(handleRawNotification),
      Effect.forkIn(runtimeScope),
    );

    const stderrRemainderRef = yield* Ref.make("");
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(stderrRemainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines.map((line) => line.replace(/\r$/, "")), remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(
              lines,
              (line) => {
                const classified = classifyCodexStderrLine(line);
                if (!classified) {
                  return Effect.void;
                }
                return emitEvent({
                  kind: "notification",
                  threadId: options.threadId,
                  method: "process/stderr",
                  message: classified.message,
                });
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    yield* child.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Ref.get(closedRef).pipe(
          Effect.flatMap((closed) => {
            if (closed) {
              return Effect.void;
            }
            const nextStatus = exitCode === 0 ? "closed" : "error";
            return updateSession(sessionRef, {
              status: nextStatus,
              activeTurnId: undefined,
            }).pipe(
              Effect.andThen(
                emitSessionEvent(
                  "session/exited",
                  exitCode === 0
                    ? "Codex App Server exited."
                    : `Codex App Server exited with code ${exitCode}.`,
                ),
              ),
            );
          }),
        ),
      ),
      Effect.forkIn(runtimeScope),
    );

    const start = Effect.fn("CodexSessionRuntime.start")(function* () {
      yield* emitSessionEvent("session/connecting", "Starting Codex App Server session.");
      yield* client.request("initialize", buildCodexInitializeParams());
      yield* client.notify("initialized", undefined);

      const requestedModel = normalizeCodexModelSlug(options.model);

      const opened = yield* openCodexThread({
        client,
        threadId: options.threadId,
        runtimeMode: options.runtimeMode,
        cwd: options.cwd,
        requestedModel,
        serviceTier: options.serviceTier,
        resumeThreadId: readResumeCursorThreadId(options.resumeCursor),
      });

      const providerThreadId = opened.thread.id;
      const session = {
        ...(yield* Ref.get(sessionRef)),
        status: "ready",
        cwd: opened.cwd,
        model: opened.model,
        resumeCursor: { threadId: providerThreadId },
        updatedAt: yield* nowIso,
      } satisfies ProviderSession;
      yield* Ref.set(sessionRef, session);
      yield* emitSessionEvent("session/ready", "Codex App Server session ready.");
      return session;
    });

    const readProviderThreadId = Effect.gen(function* () {
      const providerThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
      if (!providerThreadId) {
        return yield* new CodexSessionRuntimeThreadIdMissingError({
          threadId: options.threadId,
        });
      }
      return providerThreadId;
    });

    const close = Effect.gen(function* () {
      const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
      if (alreadyClosed) {
        return;
      }
      yield* settlePendingApprovals("cancel");
      yield* settlePendingUserInputs({});
      yield* updateSession(sessionRef, {
        status: "closed",
        activeTurnId: undefined,
      });
      yield* emitSessionEvent("session/closed", "Session stopped").pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Codex session closed event.", { cause }),
        ),
      );
      yield* Scope.close(runtimeScope, Exit.void);
      yield* Queue.shutdown(serverNotifications);
      yield* Queue.shutdown(events);
    });

    return {
      start,
      getSession: Ref.get(sessionRef),
      sendTurn: (input) =>
        threadMutationSemaphore.withPermit(
          Effect.gen(function* () {
            const providerThreadId = yield* readProviderThreadId;
            if (hasConfiguredMcpServer(options.appServerArgs)) {
              yield* client.request("config/mcpServer/reload", undefined).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to refresh Codex MCP tool catalog before turn.", {
                    cause,
                  }),
                ),
              );
            }
            const normalizedModel = normalizeCodexModelSlug(
              input.model ?? (yield* Ref.get(sessionRef)).model,
            );
            const params = yield* buildTurnStartParams({
              threadId: providerThreadId,
              runtimeMode: options.runtimeMode,
              ...(input.input ? { prompt: input.input } : {}),
              ...(input.attachments ? { attachments: input.attachments } : {}),
              ...(normalizedModel ? { model: normalizedModel } : {}),
              ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
              ...(input.effort ? { effort: input.effort } : {}),
              ...(input.interactionMode ? { interactionMode: input.interactionMode } : {}),
            });
            const rawResponse = yield* client.raw.request("turn/start", params);
            const response = yield* decodeV2TurnStartResponse(rawResponse).pipe(
              Effect.mapError((error) =>
                CodexErrors.CodexAppServerProtocolParseError.fromSchemaError(
                  "decode-response-payload",
                  error,
                  { method: "turn/start" },
                ),
              ),
            );
            const turnId = TurnId.make(response.turn.id);
            yield* updateSession(sessionRef, (session) => ({
              status: "running",
              // Codex accepts follow-ups while the current turn is still
              // running. The response contains the queued turn id, but
              // turn/interrupt only accepts the id that is active now.
              activeTurnId: session.activeTurnId ?? turnId,
              ...(normalizedModel ? { model: normalizedModel } : {}),
            }));
            const resumedProviderThreadId = currentProviderThreadId(yield* Ref.get(sessionRef));
            return {
              threadId: options.threadId,
              turnId,
              ...(resumedProviderThreadId
                ? { resumeCursor: { threadId: resumedProviderThreadId } }
                : {}),
            } satisfies ProviderTurnStartResult;
          }),
        ),
      interruptTurn: (turnId) =>
        threadMutationSemaphore.withPermit(
          Effect.gen(function* () {
            const providerThreadId = yield* readProviderThreadId;
            const session = yield* Ref.get(sessionRef);
            // Stop-everything: children are full threads with their own turns;
            // interrupting only the parent leaves the fleet running. Interrupt
            // each live child turn first, best-effort per child, BOUNDED: the
            // transport awaits an unbounded Deferred per request, so a wedged
            // child would otherwise block the parent interrupt forever —
            // exactly during the runaway fleet where Stop matters most
            // (review finding). Per-child and overall deadlines guarantee the
            // parent interrupt below always runs.
            yield* collabChildLiveTurns.snapshot.pipe(
              Effect.flatMap((liveChildTurns) => interruptCodexLiveTurns(client, liveChildTurns)),
            );
            const effectiveTurnId = turnId ?? session.activeTurnId;
            if (!effectiveTurnId) {
              return;
            }
            yield* client.request("turn/interrupt", {
              threadId: providerThreadId,
              turnId: effectiveTurnId,
            });
          }),
        ),
      readThread: Effect.gen(function* () {
        const providerThreadId = yield* readProviderThreadId;
        const response = yield* client.request("thread/read", {
          threadId: providerThreadId,
          includeTurns: true,
        });
        return parseThreadSnapshot(response);
      }),
      rewindThread: threadRewinder.rewindThread,
      rollbackThread: (numTurns) =>
        threadMutationSemaphore.withPermit(
          Effect.gen(function* () {
            const providerThreadId = yield* readProviderThreadId;
            const response = yield* client.request("thread/rollback", {
              threadId: providerThreadId,
              numTurns,
            });
            yield* updateSession(sessionRef, {
              status: "ready",
              activeTurnId: undefined,
            });
            return parseThreadSnapshot(response);
          }),
        ),
      respondToRequest: (requestId, decision) =>
        Effect.gen(function* () {
          const pending = yield* takePendingApproval(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingApprovalNotFoundError({
              requestId,
            });
          }
          yield* resolvePendingApproval(pending, decision);
        }),
      respondToUserInput: (requestId, answers) =>
        Effect.gen(function* () {
          const codexAnswers = yield* toCodexUserInputAnswers(answers);
          const pending = yield* takePendingUserInput(requestId);
          if (!pending) {
            return yield* new CodexSessionRuntimePendingUserInputNotFoundError({
              requestId,
            });
          }
          yield* resolvePendingUserInput(pending, answers, codexAnswers);
        }),
      events: Stream.fromQueue(events),
      close,
    } satisfies CodexSessionRuntimeShape;
  });
