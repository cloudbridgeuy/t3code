import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";
import {
  DEFAULT_MODEL,
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  type CodexThreadRewinder,
  hasConfiguredMcpServer,
  isCodexTerminalThreadStatus,
  isCodexTurnNoLongerActiveError,
  isRecoverableThreadResumeError,
  makeCodexThreadRewinder,
  makeCodexApprovalDecisionEvent,
  makeCodexPendingRequestStore,
  makeCodexLiveChildTurnStore,
  makeCodexUserInputAnsweredEvent,
  openCodexThread,
  resolveActiveCodexTurnId,
  resolveCodexRewindPlan,
  resolveCodexRewindWaitPlan,
  resolveRetiredCodexChildThreadId,
  resolveCodexTurnCompletionSessionUpdate,
  registerCodexLiveChildTurn,
  toCodexUserInputAnswers,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

function makeThreadReadResponse(input: {
  readonly status: "idle" | "active";
  readonly turns: ReadonlyArray<{
    readonly id: string;
    readonly status: "completed" | "inProgress";
  }>;
}): CodexRpc.ClientRequestResponsesByMethod["thread/read"] {
  const opened = makeThreadOpenResponse("source-thread");
  return {
    thread: {
      ...opened.thread,
      status: input.status === "idle" ? { type: "idle" } : { type: "active", activeFlags: [] },
      turns: input.turns.map((turn) => ({ ...turn, items: [] })),
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/read"];
}

function makeThreadForkResponse(
  threadId: string,
  turns: ReadonlyArray<{ readonly id: string; readonly status: "completed" }> = [],
): CodexRpc.ClientRequestResponsesByMethod["thread/fork"] {
  const opened = makeThreadOpenResponse(threadId);
  return {
    ...opened,
    thread: {
      ...opened.thread,
      id: threadId,
      turns: turns.map((turn) => ({ ...turn, items: [] })),
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/fork"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.issueCount ?? 0) > 0);
    NodeAssert.ok(error.issueKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  it("prefers the product-native preview tools in both collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("resolveCodexRewindPlan", () => {
  const turns = [
    { id: "completed-turn", status: "completed" },
    { id: "active-turn", status: "inProgress" },
  ] as const;

  it("starts a fresh thread when no turn is retained", () => {
    NodeAssert.deepStrictEqual(resolveCodexRewindPlan(turns, undefined), { _tag: "start" });
  });

  it("forks through the requested completed turn", () => {
    NodeAssert.deepStrictEqual(resolveCodexRewindPlan(turns, TurnId.make("completed-turn")), {
      _tag: "fork",
      lastTurnId: "completed-turn",
    });
  });

  it("rejects a retained turn that is missing or still active", () => {
    NodeAssert.deepStrictEqual(resolveCodexRewindPlan(turns, TurnId.make("missing-turn")), {
      _tag: "invalid",
      turnId: "missing-turn",
      reason: "not-found",
    });
    NodeAssert.deepStrictEqual(resolveCodexRewindPlan(turns, TurnId.make("active-turn")), {
      _tag: "invalid",
      turnId: "active-turn",
      reason: "not-completed",
    });
  });
});

describe("resolveActiveCodexTurnId", () => {
  const turns = [
    { id: "completed-turn", status: "completed" },
    { id: "active-turn", status: "inProgress" },
  ] as const;

  it("ignores a stale runtime turn that is absent from the active snapshot", () => {
    NodeAssert.equal(
      resolveActiveCodexTurnId(turns, TurnId.make("runtime-active-turn")),
      "active-turn",
    );
  });

  it("falls back to the last in-progress snapshot turn", () => {
    NodeAssert.equal(resolveActiveCodexTurnId(turns, undefined), "active-turn");
    NodeAssert.equal(resolveActiveCodexTurnId(turns.slice(0, 1), undefined), undefined);
  });

  it("uses the runtime active turn when several snapshot turns are in progress", () => {
    NodeAssert.equal(
      resolveActiveCodexTurnId(
        [
          { id: "actual-active-turn", status: "inProgress" },
          { id: "queued-follow-up", status: "inProgress" },
        ],
        TurnId.make("actual-active-turn"),
      ),
      "actual-active-turn",
    );
  });
});

describe("isCodexTurnNoLongerActiveError", () => {
  it("accepts completed and inactive turn request failures", () => {
    for (const errorMessage of [
      "turn is not active",
      "turn already completed",
      "cannot interrupt completed turn",
      "no active turn",
    ]) {
      NodeAssert.equal(
        isCodexTurnNoLongerActiveError(
          new CodexErrors.CodexAppServerRequestError({ code: -32602, errorMessage }),
        ),
        true,
      );
    }
  });

  it("rejects unrelated request and transport failures", () => {
    NodeAssert.equal(
      isCodexTurnNoLongerActiveError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "permission denied",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isCodexTurnNoLongerActiveError(new CodexErrors.CodexAppServerInputStreamEndedError()),
      false,
    );
  });
});

describe("resolveCodexTurnCompletionSessionUpdate", () => {
  it("preserves a newer active turn when an older queued turn completes", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexTurnCompletionSessionUpdate({
        currentActiveTurnId: TurnId.make("root-b"),
        completedTurnId: "root-a",
        failed: false,
        lastError: undefined,
      }),
      {},
    );
  });

  it("settles the session when the current active turn completes", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexTurnCompletionSessionUpdate({
        currentActiveTurnId: TurnId.make("root-b"),
        completedTurnId: "root-b",
        failed: false,
        lastError: undefined,
      }),
      { status: "ready", activeTurnId: undefined },
    );
  });
});

describe("resolveRetiredCodexChildThreadId", () => {
  const retiredThreadIds = new Set(["retired-source"]);

  it("keeps an already retired child retired", () => {
    NodeAssert.equal(
      resolveRetiredCodexChildThreadId({
        childThreadId: "retired-source",
        parentThreadId: undefined,
        spawnParentThreadId: undefined,
        retiredThreadIds,
      }),
      "retired-source",
    );
  });

  it("retires a child whose direct parent is retired", () => {
    NodeAssert.equal(
      resolveRetiredCodexChildThreadId({
        childThreadId: "late-child",
        parentThreadId: "retired-source",
        spawnParentThreadId: undefined,
        retiredThreadIds,
      }),
      "late-child",
    );
  });

  it("retires a child whose spawn parent is retired", () => {
    NodeAssert.equal(
      resolveRetiredCodexChildThreadId({
        childThreadId: "late-child",
        parentThreadId: undefined,
        spawnParentThreadId: "retired-source",
        retiredThreadIds,
      }),
      "late-child",
    );
  });

  it("preserves a child from the current lineage", () => {
    NodeAssert.equal(
      resolveRetiredCodexChildThreadId({
        childThreadId: "current-child",
        parentThreadId: "current-source",
        spawnParentThreadId: "current-source",
        retiredThreadIds,
      }),
      undefined,
    );
  });
});

describe("resolveCodexRewindWaitPlan", () => {
  const turns = [
    { id: "completed-turn", status: "completed" },
    { id: "active-turn", status: "inProgress" },
  ] as const;

  it("waits for the authoritative active turn and a non-idle source thread", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexRewindWaitPlan({
        turns,
        sourceStatus: "active",
        sessionActiveTurnId: TurnId.make("runtime-active-turn"),
      }),
      {
        _tag: "ready",
        rootTurnId: "active-turn",
        waitForRootCompletion: true,
        waitForSourceIdle: true,
      },
    );
  });

  it("skips waiters when the source is idle and no active turn remains", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexRewindWaitPlan({
        turns: turns.slice(0, 1),
        sourceStatus: "idle",
        sessionActiveTurnId: undefined,
      }),
      {
        _tag: "ready",
        rootTurnId: undefined,
        waitForRootCompletion: false,
        waitForSourceIdle: false,
      },
    );
  });

  it.each(["systemError", "notLoaded"])(
    "does not wait for terminal source status %s",
    (sourceStatus) => {
      NodeAssert.deepStrictEqual(
        resolveCodexRewindWaitPlan({
          turns: turns.slice(0, 1),
          sourceStatus,
          sessionActiveTurnId: undefined,
        }),
        {
          _tag: "ready",
          rootTurnId: undefined,
          waitForRootCompletion: false,
          waitForSourceIdle: false,
        },
      );
    },
  );

  it("rejects an active source without an active root turn", () => {
    NodeAssert.deepStrictEqual(
      resolveCodexRewindWaitPlan({
        turns: turns.slice(0, 1),
        sourceStatus: "active",
        sessionActiveTurnId: undefined,
      }),
      {
        _tag: "invalid",
        rootTurnId: undefined,
        waitForRootCompletion: false,
        waitForSourceIdle: false,
      },
    );
  });
});

describe("isCodexTerminalThreadStatus", () => {
  it("recognizes idle, system-error, and unloaded states as terminal", () => {
    NodeAssert.equal(isCodexTerminalThreadStatus("idle"), true);
    NodeAssert.equal(isCodexTerminalThreadStatus("systemError"), true);
    NodeAssert.equal(isCodexTerminalThreadStatus("notLoaded"), true);
    NodeAssert.equal(isCodexTerminalThreadStatus("active"), false);
  });
});

describe("Codex pending request resolution events", () => {
  const threadId = ThreadId.make("t3-thread");
  const requestId = ApprovalRequestId.make("request-1");
  const turnId = TurnId.make("turn-1");
  const itemId = ProviderItemId.make("item-1");

  it("builds the canonical approval cancellation event", () => {
    NodeAssert.deepStrictEqual(
      makeCodexApprovalDecisionEvent({
        threadId,
        pending: { requestId, requestKind: "command", turnId, itemId },
        decision: "cancel",
      }),
      {
        kind: "notification",
        threadId,
        method: "item/requestApproval/decision",
        requestId,
        requestKind: "command",
        turnId,
        itemId,
        payload: { requestId, requestKind: "command", decision: "cancel" },
      },
    );
  });

  it("builds the canonical empty structured-input answer event", () => {
    NodeAssert.deepStrictEqual(
      makeCodexUserInputAnsweredEvent({
        threadId,
        pending: { requestId, turnId, itemId },
        answers: {},
      }),
      {
        kind: "notification",
        threadId,
        method: "item/tool/requestUserInput/answered",
        requestId,
        turnId,
        itemId,
        payload: { answers: {} },
      },
    );
  });
});

describe("makeCodexPendingRequestStore", () => {
  it.effect("atomically drains existing requests and rejects late registration", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexPendingRequestStore<string>();
      const firstId = ApprovalRequestId.make("first");
      const lateId = ApprovalRequestId.make("late");
      NodeAssert.equal(yield* store.register(firstId, "first request"), false);

      NodeAssert.deepStrictEqual(yield* store.drainForRewind, ["first request"]);
      NodeAssert.equal(yield* store.register(lateId, "late request"), true);
      NodeAssert.equal(yield* store.take(lateId), undefined);

      yield* store.finishRewind;
      NodeAssert.equal(yield* store.register(lateId, "after rewind"), false);
      NodeAssert.equal(yield* store.take(lateId), "after rewind");
    }),
  );

  it.effect("keeps a pending request when structured-input validation fails", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexPendingRequestStore<string>();
      const requestId = ApprovalRequestId.make("request-with-invalid-answer");
      yield* store.register(requestId, "pending request");

      const error = yield* toCodexUserInputAnswers({ question: 42 }).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimeInvalidUserInputAnswersError");
      NodeAssert.equal(yield* store.take(requestId), "pending request");
    }),
  );
});

describe("makeCodexLiveChildTurnStore", () => {
  it.effect("waits for a late child interrupt before rebind", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexLiveChildTurnStore();
      const interruptStarted = yield* Deferred.make<void>();
      const allowInterrupt = yield* Deferred.make<void>();
      const rebound = yield* Deferred.make<void>();
      NodeAssert.equal(yield* store.register("child-before", "turn-before"), false);

      NodeAssert.deepStrictEqual(Array.from((yield* store.drainForRewind).entries()), [
        ["child-before", "turn-before"],
      ]);
      const interruptFiber = yield* registerCodexLiveChildTurn({
        store,
        threadId: "child-late",
        turnId: "turn-late",
        client: {
          request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
            method: M,
            payload: CodexRpc.ClientRequestParamsByMethod[M],
          ) => {
            NodeAssert.equal(method, "turn/interrupt");
            NodeAssert.deepStrictEqual(payload, {
              threadId: "child-late",
              turnId: "turn-late",
            });
            return Deferred.succeed(interruptStarted, undefined).pipe(
              Effect.andThen(Deferred.await(allowInterrupt)),
              Effect.as(
                makeThreadOpenResponse("unused") as CodexRpc.ClientRequestResponsesByMethod[M],
              ),
            );
          },
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(interruptStarted);
      const rebindFiber = yield* store
        .settleBeforeRebind(Deferred.succeed(rebound, undefined).pipe(Effect.asVoid))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.equal(yield* Deferred.isDone(rebound), false);

      yield* Deferred.succeed(allowInterrupt, undefined);
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(rebindFiber);
      yield* Deferred.await(rebound);
      NodeAssert.deepStrictEqual(Array.from((yield* store.snapshot).entries()), []);

      NodeAssert.equal(yield* store.register("child-after", "turn-after"), false);
      yield* store.finishRewind;
      NodeAssert.deepStrictEqual(Array.from((yield* store.snapshot).entries()), [
        ["child-after", "turn-after"],
      ]);
    }),
  );

  it.effect("bounds a stuck late interrupt before rebind", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexLiveChildTurnStore();
      const interruptStarted = yield* Deferred.make<void>();
      const rebound = yield* Deferred.make<void>();
      yield* store.drainForRewind;
      const interruptFiber = yield* registerCodexLiveChildTurn({
        store,
        threadId: "child-stuck",
        turnId: "turn-stuck",
        client: {
          request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
            _method: M,
            _payload: CodexRpc.ClientRequestParamsByMethod[M],
          ) =>
            Deferred.succeed(interruptStarted, undefined).pipe(
              Effect.andThen(Effect.never),
            ) as Effect.Effect<CodexRpc.ClientRequestResponsesByMethod[M]>,
        },
      }).pipe(Effect.forkChild);
      yield* Deferred.await(interruptStarted);
      const rebindFiber = yield* store
        .settleBeforeRebind(Deferred.succeed(rebound, undefined).pipe(Effect.asVoid))
        .pipe(Effect.forkChild);

      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(interruptFiber);
      yield* Fiber.join(rebindFiber);
      NodeAssert.equal(yield* Deferred.isDone(rebound), true);
    }),
  );

  it.effect("resets the gate when rebind fails", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexLiveChildTurnStore();
      yield* store.drainForRewind;
      const error = yield* store.settleBeforeRebind(Effect.fail("rebind failed")).pipe(Effect.flip);
      NodeAssert.equal(error, "rebind failed");
      NodeAssert.equal(yield* store.register("child-after-failure", "turn-after-failure"), false);
    }),
  );

  it.effect("rejects an old-source child queued behind rebind", () =>
    Effect.gen(function* () {
      const store = yield* makeCodexLiveChildTurnStore();
      const sourceThreadRef = yield* Ref.make("source-thread");
      const rebindPermitHeld = yield* Deferred.make<void>();
      const finishRebind = yield* Deferred.make<void>();
      const registrationAttempted = yield* Deferred.make<void>();
      const interruptRequested = yield* Deferred.make<void>();
      const syntheticEventEmitted = yield* Ref.make(false);
      yield* store.drainForRewind;
      const rebind = yield* store
        .settleBeforeRebind(
          Effect.gen(function* () {
            yield* Deferred.succeed(rebindPermitHeld, undefined);
            yield* Deferred.await(finishRebind);
            yield* Ref.set(sourceThreadRef, "replacement-thread");
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(rebindPermitHeld);

      const instrumentedStore = {
        ...store,
        registerAndInterrupt: (...args: Parameters<typeof store.registerAndInterrupt>) =>
          Deferred.succeed(registrationAttempted, undefined).pipe(
            Effect.andThen(store.registerAndInterrupt(...args)),
          ),
      };
      const handler = yield* Effect.gen(function* () {
        const sourceThreadIdAtReceipt = yield* Ref.get(sourceThreadRef);
        const currentSource = yield* registerCodexLiveChildTurn({
          store: instrumentedStore,
          threadId: "old-child-thread",
          turnId: "old-child-turn",
          sourceThreadIdAtReceipt,
          getCurrentSourceThreadId: Ref.get(sourceThreadRef),
          client: {
            request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
              method: M,
              payload: CodexRpc.ClientRequestParamsByMethod[M],
            ) => {
              NodeAssert.equal(method, "turn/interrupt");
              NodeAssert.deepStrictEqual(payload, {
                threadId: "old-child-thread",
                turnId: "old-child-turn",
              });
              return Deferred.succeed(interruptRequested, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as(
                  makeThreadOpenResponse("unused") as CodexRpc.ClientRequestResponsesByMethod[M],
                ),
              );
            },
          },
        });
        if (currentSource) {
          yield* Ref.set(syntheticEventEmitted, true);
        }
      }).pipe(Effect.forkChild);

      yield* Deferred.await(registrationAttempted);
      NodeAssert.equal(yield* Deferred.isDone(interruptRequested), false);
      yield* Deferred.succeed(finishRebind, undefined);
      yield* Fiber.join(rebind);
      yield* Deferred.await(interruptRequested);
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(handler);
      NodeAssert.equal(yield* Ref.get(syntheticEventEmitted), false);
      NodeAssert.deepStrictEqual(Array.from((yield* store.snapshot).entries()), []);
    }),
  );
});

describe("makeCodexThreadRewinder", () => {
  it.effect("fails with a typed error when an interrupted source never settles", () =>
    Effect.gen(function* () {
      const rootInterruptSent = yield* Deferred.make<void>();
      const active = makeThreadReadResponse({
        status: "active",
        turns: [{ id: "active-turn", status: "inProgress" }],
      });
      const replacement = makeThreadOpenResponse("unused");
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) =>
          method === "turn/interrupt"
            ? Deferred.succeed(rootInterruptSent, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as(replacement as CodexRpc.ClientRequestResponsesByMethod[M]),
              )
            : Effect.succeed(active as CodexRpc.ClientRequestResponsesByMethod[M]),
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Effect.succeed({
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            threadId: ThreadId.make("t3-thread"),
            activeTurnId: TurnId.make("active-turn"),
            resumeCursor: { threadId: "source-thread" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const fiber = yield* rewinder.rewindThread().pipe(Effect.forkChild);
      yield* Deferred.await(rootInterruptSent);
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimeRewindSettlementTimeoutError");
      NodeAssert.equal(error.threadId, "source-thread");
    }),
  );

  it.effect("skips root interruption when reconciliation finds it completed", () =>
    Effect.gen(function* () {
      let reads = 0;
      let interrupts = 0;
      const active = makeThreadReadResponse({
        status: "active",
        turns: [{ id: "active-turn", status: "inProgress" }],
      });
      const settled = makeThreadReadResponse({
        status: "idle",
        turns: [{ id: "active-turn", status: "completed" }],
      });
      const replacement = makeThreadOpenResponse("replacement-thread");
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/read") {
            reads += 1;
            return Effect.succeed(
              (reads === 1 ? active : settled) as CodexRpc.ClientRequestResponsesByMethod[M],
            );
          }
          if (method === "turn/interrupt") {
            interrupts += 1;
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32602,
                errorMessage: "cannot interrupt completed turn",
              }),
            );
          }
          return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Effect.succeed({
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            threadId: ThreadId.make("t3-thread"),
            activeTurnId: TurnId.make("active-turn"),
            resumeCursor: { threadId: "source-thread" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const snapshot = yield* rewinder.rewindThread();
      NodeAssert.equal(reads, 2);
      NodeAssert.equal(interrupts, 0);
      NodeAssert.equal(snapshot.threadId, "replacement-thread");
    }),
  );

  it.effect("interrupts the queued root that becomes active during reconciliation", () =>
    Effect.gen(function* () {
      let reads = 0;
      const interrupted = yield* Deferred.make<void>();
      const initial = makeThreadReadResponse({
        status: "active",
        turns: [{ id: "root-a", status: "inProgress" }],
      });
      const reconciled = makeThreadReadResponse({
        status: "active",
        turns: [
          { id: "root-a", status: "completed" },
          { id: "root-b", status: "inProgress" },
        ],
      });
      const replacement = makeThreadOpenResponse("replacement-thread");
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/read") {
            reads += 1;
            return Effect.succeed(
              (reads === 1 ? initial : reconciled) as CodexRpc.ClientRequestResponsesByMethod[M],
            );
          }
          if (method === "turn/interrupt") {
            NodeAssert.deepStrictEqual(payload, {
              threadId: "source-thread",
              turnId: "root-b",
            });
            return Deferred.succeed(interrupted, undefined).pipe(
              Effect.as(replacement as CodexRpc.ClientRequestResponsesByMethod[M]),
            );
          }
          return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Effect.succeed({
            provider: ProviderDriverKind.make("codex"),
            status: "running",
            runtimeMode: "full-access",
            threadId: ThreadId.make("t3-thread"),
            activeTurnId: TurnId.make("root-a"),
            resumeCursor: { threadId: "source-thread" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const fiber = yield* rewinder.rewindThread().pipe(Effect.forkChild);
      yield* Deferred.await(interrupted);
      yield* rewinder.observeTurnCompleted({ threadId: "source-thread", turnId: "root-b" });
      yield* rewinder.observeThreadStatusChanged({
        threadId: "source-thread",
        status: { type: "idle" },
      });
      const snapshot = yield* Fiber.join(fiber);
      NodeAssert.equal(reads, 2);
      NodeAssert.equal(snapshot.threadId, "replacement-thread");
    }),
  );

  it.effect("reconciles again when the selected root completes before interruption", () =>
    Effect.gen(function* () {
      let reads = 0;
      let sourceSettled = false;
      const interruptedTurns: Array<string> = [];
      const initial = makeThreadReadResponse({
        status: "active",
        turns: [{ id: "root-a", status: "inProgress" }],
      });
      const rootBActive = makeThreadReadResponse({
        status: "active",
        turns: [
          { id: "root-a", status: "completed" },
          { id: "root-b", status: "inProgress" },
        ],
      });
      const rootCActive = makeThreadReadResponse({
        status: "active",
        turns: [
          { id: "root-a", status: "completed" },
          { id: "root-b", status: "completed" },
          { id: "root-c", status: "inProgress" },
        ],
      });
      const idle = makeThreadReadResponse({
        status: "idle",
        turns: [
          { id: "root-a", status: "completed" },
          { id: "root-b", status: "completed" },
          { id: "root-c", status: "completed" },
        ],
      });
      const replacement = makeThreadOpenResponse("replacement-thread");
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        threadId: ThreadId.make("t3-thread"),
        activeTurnId: TurnId.make("root-a"),
        resumeCursor: { threadId: "source-thread" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      let rewinder!: CodexThreadRewinder;
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/read") {
            reads += 1;
            const response =
              reads === 1
                ? initial
                : sourceSettled
                  ? idle
                  : reads === 2
                    ? rootBActive
                    : rootCActive;
            return Effect.succeed(response as CodexRpc.ClientRequestResponsesByMethod[M]);
          }
          if (method === "turn/interrupt") {
            const turnId = (payload as CodexRpc.ClientRequestParamsByMethod["turn/interrupt"])
              .turnId;
            interruptedTurns.push(turnId);
            if (turnId === "root-b") {
              return Ref.update(sessionRef, (session) => ({
                ...session,
                activeTurnId: TurnId.make("root-c"),
              })).pipe(
                Effect.andThen(
                  Effect.fail(
                    new CodexErrors.CodexAppServerRequestError({
                      code: -32602,
                      errorMessage: "turn is not active",
                    }),
                  ),
                ),
              );
            }
            return Effect.gen(function* () {
              sourceSettled = true;
              yield* rewinder.observeTurnCompleted({
                threadId: "source-thread",
                turnId: "root-c",
              });
              yield* rewinder.observeThreadStatusChanged({
                threadId: "source-thread",
                status: { type: "idle" },
              });
              return replacement as CodexRpc.ClientRequestResponsesByMethod[M];
            });
          }
          return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Ref.get(sessionRef),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const snapshot = yield* rewinder.rewindThread();
      NodeAssert.deepStrictEqual(interruptedTurns, ["root-b", "root-c"]);
      NodeAssert.equal(snapshot.threadId, "replacement-thread");
    }),
  );

  it.effect(
    "settles requests, interrupts child and root, waits for root and idle, then forks",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const rootInterruptSent = yield* Deferred.make<void>();
        const source = makeThreadReadResponse({
          status: "active",
          turns: [
            { id: "retained-turn", status: "completed" },
            { id: "active-turn", status: "inProgress" },
          ],
        });
        const replacement = makeThreadForkResponse("replacement-thread", [
          { id: "retained-turn", status: "completed" },
        ]);
        const rebound: Array<{ threadId: string; cwd: string; model: string }> = [];
        const client = {
          request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
            method: M,
            payload: CodexRpc.ClientRequestParamsByMethod[M],
          ) => {
            if (method === "thread/read") {
              calls.push("read");
              return Effect.succeed(source as CodexRpc.ClientRequestResponsesByMethod[M]);
            }
            if (method === "turn/interrupt") {
              const interrupt = payload as CodexRpc.ClientRequestParamsByMethod["turn/interrupt"];
              calls.push(`interrupt:${interrupt.threadId}:${interrupt.turnId}`);
              if (interrupt.threadId === "source-thread") {
                return Deferred.succeed(rootInterruptSent, undefined).pipe(
                  Effect.as(replacement as CodexRpc.ClientRequestResponsesByMethod[M]),
                );
              }
              return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
            }
            calls.push(method === "thread/fork" ? "fork" : "start");
            return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
          },
        };
        const session: ProviderSession = {
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "full-access",
          threadId: ThreadId.make("t3-thread"),
          activeTurnId: TurnId.make("active-turn"),
          resumeCursor: { threadId: "source-thread" },
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        };
        const rewinder = yield* makeCodexThreadRewinder({
          client,
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          model: "gpt-5.3-codex",
          serviceTier: undefined,
          state: {
            threadMutationSemaphore: yield* Semaphore.make(1),
            getSession: Effect.succeed(session),
            drainLiveChildTurnsForRewind: Effect.succeed(new Map([["child-thread", "child-turn"]])),
            finishLiveChildTurnSettlement: Effect.void,
            settlePendingRequests: Effect.sync(() => calls.push("settle-pending")),
            finishPendingRequestSettlement: Effect.void,
            rebindProviderThread: (input) =>
              Effect.sync(() => {
                calls.push("rebind");
                rebound.push(input);
              }),
          },
        });

        const rewindFiber = yield* rewinder
          .rewindThread(TurnId.make("retained-turn"))
          .pipe(Effect.forkChild);
        yield* Deferred.await(rootInterruptSent);
        NodeAssert.deepStrictEqual(calls, [
          "read",
          "settle-pending",
          "interrupt:child-thread:child-turn",
          "read",
          "interrupt:source-thread:active-turn",
        ]);

        yield* rewinder.observeTurnCompleted({
          threadId: "foreign-thread",
          turnId: "active-turn",
        });
        yield* Effect.yieldNow;
        NodeAssert.equal(rewindFiber.pollUnsafe(), undefined);
        yield* rewinder.observeThreadStatusChanged({
          threadId: "source-thread",
          status: { type: "idle" },
        });
        const snapshot = yield* Fiber.join(rewindFiber);

        NodeAssert.deepStrictEqual(calls, [
          "read",
          "settle-pending",
          "interrupt:child-thread:child-turn",
          "read",
          "interrupt:source-thread:active-turn",
          "fork",
          "rebind",
        ]);
        NodeAssert.equal(snapshot.threadId, "replacement-thread");
        NodeAssert.deepStrictEqual(
          snapshot.turns.map((turn) => turn.id),
          ["retained-turn"],
        );
        NodeAssert.deepStrictEqual(rebound, [
          {
            threadId: "replacement-thread",
            cwd: "/tmp/project",
            model: "gpt-5.3-codex",
          },
        ]);
      }),
  );

  it.effect("starts a fresh replacement before the first retained turn", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const source = makeThreadReadResponse({ status: "idle", turns: [] });
      const replacement = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push(method);
          return Effect.succeed(
            (method === "thread/read"
              ? source
              : replacement) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Effect.succeed({
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("t3-thread"),
            resumeCursor: { threadId: "source-thread" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const snapshot = yield* rewinder.rewindThread();
      NodeAssert.equal(snapshot.threadId, "fresh-thread");
      NodeAssert.deepStrictEqual(calls, ["thread/read", "thread/start"]);
    }),
  );

  it.effect("rejects an invalid retained turn before settlement or interruption", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const source = makeThreadReadResponse({ status: "idle", turns: [] });
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push(method);
          return Effect.succeed(source as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: yield* Semaphore.make(1),
          getSession: Effect.succeed({
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("t3-thread"),
            resumeCursor: { threadId: "source-thread" },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.sync(() => calls.push("settle-pending")),
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const error = yield* rewinder.rewindThread(TurnId.make("missing-turn")).pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimeInvalidRetainedTurnError");
      NodeAssert.deepStrictEqual(calls, ["thread/read"]);
    }),
  );

  it.effect("serializes concurrent rewinds and other thread mutations", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const firstReplacementAllowed = yield* Deferred.make<void>();
      const firstReplacementRequested = yield* Deferred.make<void>();
      const semaphore = yield* Semaphore.make(1);
      let startCount = 0;
      const source = makeThreadReadResponse({ status: "idle", turns: [] });
      const replacement = makeThreadOpenResponse("replacement-thread");
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push(method);
          if (method === "thread/read") {
            return Effect.succeed(source as CodexRpc.ClientRequestResponsesByMethod[M]);
          }
          if (method === "thread/start") {
            startCount += 1;
            if (startCount === 1) {
              return Deferred.succeed(firstReplacementRequested, undefined).pipe(
                Effect.andThen(Deferred.await(firstReplacementAllowed)),
                Effect.as(replacement as CodexRpc.ClientRequestResponsesByMethod[M]),
              );
            }
          }
          return Effect.succeed(replacement as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };
      const session: ProviderSession = {
        provider: ProviderDriverKind.make("codex"),
        status: "ready",
        runtimeMode: "full-access",
        threadId: ThreadId.make("t3-thread"),
        resumeCursor: { threadId: "source-thread" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const rewinder = yield* makeCodexThreadRewinder({
        client,
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        model: undefined,
        serviceTier: undefined,
        state: {
          threadMutationSemaphore: semaphore,
          getSession: Effect.succeed(session),
          drainLiveChildTurnsForRewind: Effect.succeed(new Map()),
          finishLiveChildTurnSettlement: Effect.void,
          settlePendingRequests: Effect.void,
          finishPendingRequestSettlement: Effect.void,
          rebindProviderThread: () => Effect.void,
        },
      });

      const firstRewind = yield* rewinder.rewindThread().pipe(Effect.forkChild);
      yield* Deferred.await(firstReplacementRequested);
      const secondRewind = yield* rewinder.rewindThread().pipe(Effect.forkChild);
      const send = yield* semaphore
        .withPermit(Effect.sync(() => calls.push("send")))
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      NodeAssert.deepStrictEqual(calls, ["thread/read", "thread/start"]);
      NodeAssert.equal(secondRewind.pollUnsafe(), undefined);
      NodeAssert.equal(send.pollUnsafe(), undefined);

      yield* Deferred.succeed(firstReplacementAllowed, undefined);
      yield* Fiber.join(firstRewind);
      yield* Fiber.join(secondRewind);
      yield* Fiber.join(send);
      NodeAssert.deepStrictEqual(calls, [
        "thread/read",
        "thread/start",
        "thread/read",
        "thread/start",
        "send",
      ]);
    }),
  );
});

describe("openCodexThread", () => {
  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
