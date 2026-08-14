// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";
import {
  ApprovalRequestId,
  DEFAULT_MODEL,
  ProviderDriverKind,
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
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  createCodexRewindTarget,
  hasConfiguredMcpServer,
  isCodexTurnNoLongerActiveError,
  isRecoverableThreadResumeError,
  makeCodexSessionRuntime,
  openCodexThread,
  resolveCodexRewindPlan,
  resolveCodexTurnCompletionSessionUpdate,
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

function makePendingRequestPeerSource(
  method: "item/commandExecution/requestApproval" | "item/tool/requestUserInput",
): string {
  const threadStartResponse = JSON.stringify(wireFixture.responses.threadStart);
  const turnStartResponse = JSON.stringify(wireFixture.responses.turnStart);
  const requestParams =
    method === "item/commandExecution/requestApproval"
      ? `{
        threadId: threadStartResponse.thread.id,
        turnId: turnStartResponse.turn.id,
        itemId: "approval-item",
        startedAtMs: 0,
        command: "echo test"
      }`
      : `{
        threadId: threadStartResponse.thread.id,
        turnId: turnStartResponse.turn.id,
        itemId: "structured-input-item",
        questions: [{ id: "question", header: "Question", question: "Answer?", options: [] }]
      }`;
  return `#!/usr/bin/env node
import * as readline from "node:readline";
const threadStartResponse = ${threadStartResponse};
const turnStartResponse = ${turnStartResponse};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "test", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: threadStartResponse });
    return;
  }
  if (message.method === "turn/start") {
    write({ id: message.id, result: turnStartResponse });
    write({ id: "pending-request", method: ${JSON.stringify(method)}, params: ${requestParams} });
    return;
  }
  if (message.id === "pending-request") {
    write({ method: "warning", params: { message: JSON.stringify(message.result) } });
  }
});
`;
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

describe("Codex structured input responses", () => {
  it.effect("keeps the request pending when answer validation fails", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const threadStartResponse = JSON.stringify(wireFixture.responses.threadStart);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const turnStartResponse = JSON.stringify(wireFixture.responses.turnStart);
      const peerSource = `#!/usr/bin/env node
import * as readline from "node:readline";
const threadStartResponse = ${threadStartResponse};
const turnStartResponse = ${turnStartResponse};
const write = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    write({ id: message.id, result: { userAgent: "test", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" } });
    return;
  }
  if (message.method === "thread/start") {
    write({ id: message.id, result: threadStartResponse });
    return;
  }
  if (message.method === "turn/start") {
    write({ id: message.id, result: turnStartResponse });
    write({
      id: "structured-input-request",
      method: "item/tool/requestUserInput",
      params: {
        threadId: threadStartResponse.thread.id,
        turnId: turnStartResponse.turn.id,
        itemId: "structured-input-item",
        questions: [{ id: "question", header: "Question", question: "Answer?", options: [] }]
      }
    });
  }
});
`;
      const peerDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-code-codex-structured-input-"),
      );
      const peerPath = NodePath.join(peerDirectory, "peer.mjs");
      NodeFS.writeFileSync(peerPath, peerSource, { encoding: "utf8", mode: 0o755 });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(peerDirectory, { recursive: true, force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("t3-thread-structured-input"),
        binaryPath: peerPath,
        cwd: peerDirectory,
        runtimeMode: "full-access",
      });
      yield* Effect.addFinalizer(() => runtime.close);

      const requestEventFiber = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "item/tool/requestUserInput"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "request structured input" });
      const requestEvent = Array.from(yield* Fiber.join(requestEventFiber))[0];
      NodeAssert.ok(requestEvent?.requestId);

      const error = yield* runtime
        .respondToUserInput(requestEvent.requestId, { question: 42 })
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimeInvalidUserInputAnswersError");
      NodeAssert.equal(error.questionId, "question");
      yield* runtime.respondToUserInput(requestEvent.requestId, { question: "valid answer" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("Codex pending request close ownership", () => {
  const verifyInterruptedCloseSettles = (
    method: "item/commandExecution/requestApproval" | "item/tool/requestUserInput",
    expectedResponse: string,
  ) =>
    Effect.gen(function* () {
      const closeClaimed = yield* Deferred.make<void>();
      const allowCloseSettlement = yield* Deferred.make<void>();
      const requestReceived = yield* Deferred.make<void>();
      const responseReceipt = yield* Deferred.make<string>();
      const peerDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-code-codex-close-cancellation-"),
      );
      const peerPath = NodePath.join(peerDirectory, "peer.mjs");
      NodeFS.writeFileSync(peerPath, makePendingRequestPeerSource(method), {
        encoding: "utf8",
        mode: 0o755,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(peerDirectory, { recursive: true, force: true })),
      );

      const runtimeScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make(`t3-thread-close-cancellation-${method}`),
        binaryPath: peerPath,
        cwd: peerDirectory,
        runtimeMode: "full-access",
        _testClosePendingRequestsGate: Deferred.succeed(closeClaimed, undefined).pipe(
          Effect.andThen(Deferred.await(allowCloseSettlement)),
        ),
        _testClosePendingRequestsSettledGate: Deferred.await(responseReceipt),
      }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
      yield* Effect.addFinalizer(() => runtime.close);
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === method) {
            return Deferred.succeed(requestReceived, undefined).pipe(Effect.ignore);
          }
          if (event.method !== "warning") {
            return Effect.void;
          }
          const message = (event.payload as { readonly message?: unknown } | undefined)?.message;
          return typeof message === "string"
            ? Deferred.succeed(responseReceipt, message).pipe(Effect.ignore)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "request pending input" });
      yield* Deferred.await(requestReceived);

      const closeFiber = yield* runtime.close.pipe(Effect.forkScoped);
      yield* Deferred.await(closeClaimed);
      const interruptorId = yield* Effect.fiberId;
      yield* Effect.sync(() => closeFiber.interruptUnsafe(interruptorId));
      yield* Deferred.succeed(allowCloseSettlement, undefined);
      yield* Fiber.await(closeFiber);

      NodeAssert.equal(yield* Deferred.isDone(responseReceipt), true);
      NodeAssert.equal(yield* Deferred.await(responseReceipt), expectedResponse);
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  it.effect("prevents an approval response after close claims the request", () =>
    Effect.gen(function* () {
      const closeClaimed = yield* Deferred.make<void>();
      const allowCloseSettlement = yield* Deferred.make<void>();
      const peerDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-code-codex-close-approval-"),
      );
      const peerPath = NodePath.join(peerDirectory, "peer.mjs");
      NodeFS.writeFileSync(
        peerPath,
        makePendingRequestPeerSource("item/commandExecution/requestApproval"),
        { encoding: "utf8", mode: 0o755 },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(peerDirectory, { recursive: true, force: true })),
      );

      const runtimeScope = yield* Scope.make();
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("t3-thread-close-approval"),
        binaryPath: peerPath,
        cwd: peerDirectory,
        runtimeMode: "full-access",
        _testClosePendingRequestsGate: Deferred.succeed(closeClaimed, undefined).pipe(
          Effect.andThen(Deferred.await(allowCloseSettlement)),
        ),
      }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
      yield* Effect.addFinalizer(() => runtime.close);
      const requestEventReady = yield* Deferred.make<{ readonly requestId: string }>();
      const responseAccepted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === "item/commandExecution/requestApproval" && event.requestId) {
            return Deferred.succeed(requestEventReady, { requestId: event.requestId }).pipe(
              Effect.ignore,
            );
          }
          return event.method === "item/requestApproval/decision"
            ? Deferred.succeed(responseAccepted, undefined).pipe(Effect.ignore)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "request approval" });
      const requestEvent = yield* Deferred.await(requestEventReady);

      const closeFiber = yield* runtime.close.pipe(Effect.forkScoped);

      yield* Deferred.await(closeClaimed);
      const error = yield* runtime
        .respondToRequest(ApprovalRequestId.make(requestEvent.requestId), "accept")
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimePendingApprovalNotFoundError");
      NodeAssert.equal(yield* Deferred.isDone(responseAccepted), false);
      yield* Deferred.succeed(allowCloseSettlement, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prevents a structured-input response after close claims the request", () =>
    Effect.gen(function* () {
      const closeClaimed = yield* Deferred.make<void>();
      const allowCloseSettlement = yield* Deferred.make<void>();
      const peerDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-code-codex-close-user-input-"),
      );
      const peerPath = NodePath.join(peerDirectory, "peer.mjs");
      NodeFS.writeFileSync(peerPath, makePendingRequestPeerSource("item/tool/requestUserInput"), {
        encoding: "utf8",
        mode: 0o755,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(peerDirectory, { recursive: true, force: true })),
      );

      const runtimeScope = yield* Scope.make();
      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("t3-thread-close-user-input"),
        binaryPath: peerPath,
        cwd: peerDirectory,
        runtimeMode: "full-access",
        _testClosePendingRequestsGate: Deferred.succeed(closeClaimed, undefined).pipe(
          Effect.andThen(Deferred.await(allowCloseSettlement)),
        ),
      }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
      yield* Effect.addFinalizer(() => runtime.close);
      const requestEventReady = yield* Deferred.make<{ readonly requestId: string }>();
      const responseAccepted = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (event.method === "item/tool/requestUserInput" && event.requestId) {
            return Deferred.succeed(requestEventReady, { requestId: event.requestId }).pipe(
              Effect.ignore,
            );
          }
          return event.method === "item/tool/requestUserInput/answered"
            ? Deferred.succeed(responseAccepted, undefined).pipe(Effect.ignore)
            : Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* runtime.start();
      yield* runtime.sendTurn({ input: "request structured input" });
      const requestEvent = yield* Deferred.await(requestEventReady);

      const closeFiber = yield* runtime.close.pipe(Effect.forkScoped);

      yield* Deferred.await(closeClaimed);
      const error = yield* runtime
        .respondToUserInput(ApprovalRequestId.make(requestEvent.requestId), {
          question: "late answer",
        })
        .pipe(Effect.flip);
      NodeAssert.equal(error._tag, "CodexSessionRuntimePendingUserInputNotFoundError");
      NodeAssert.equal(yield* Deferred.isDone(responseAccepted), false);
      yield* Deferred.succeed(allowCloseSettlement, undefined);
      yield* Fiber.join(closeFiber);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("settles a drained approval when close is interrupted", () =>
    verifyInterruptedCloseSettles("item/commandExecution/requestApproval", '{"decision":"cancel"}'),
  );

  it.effect("settles drained structured input when close is interrupted", () =>
    verifyInterruptedCloseSettles("item/tool/requestUserInput", '{"answers":{}}'),
  );
});

describe("createCodexRewindTarget", () => {
  const makeSession = (): ProviderSession => ({
    provider: ProviderDriverKind.make("codex"),
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make("t3-thread"),
    resumeCursor: { threadId: "source-thread" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  it.effect("creates a target without changing the source session or cursor", () =>
    Effect.gen(function* () {
      const sourceThreadId = "source-thread";
      const replacementThreadId = "replacement-thread";
      const capturedThreadStarted = wireFixture.notifications.find(
        (notification) => notification.method === "thread/started",
      );
      NodeAssert.ok(capturedThreadStarted);
      const capturedParams =
        capturedThreadStarted.params as CodexRpc.ServerNotificationParamsByMethod["thread/started"];
      const script = {
        rootThreadId: sourceThreadId,
        replacementThreadId,
        turnIds: ["source-setup-turn", "source-flush-turn"],
        notifications: [],
        notificationsByTurnStart: [
          [],
          [
            {
              method: "thread/started",
              params: {
                ...capturedParams,
                thread: {
                  ...capturedParams.thread,
                  id: replacementThreadId,
                },
              },
            },
            {
              method: "warning",
              params: { message: "target thread/started delivered" },
            },
          ],
        ],
      };
      const scriptDirectory = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-code-codex-rewind-target-"),
      );
      const scriptPath = NodePath.join(scriptDirectory, "script.json");
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptDirectory, { recursive: true, force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("t3-thread"),
        binaryPath: NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh"),
        cwd: scriptDirectory,
        runtimeMode: "full-access",
        resumeCursor: { threadId: sourceThreadId },
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      yield* Effect.addFinalizer(() => runtime.close);

      yield* runtime.start();
      const firstSourceTurnCompleted = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "turn/completed"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* runtime.sendTurn({ input: "establish the complete source session" });
      yield* Fiber.join(firstSourceTurnCompleted);
      const sourceSession = yield* runtime.getSession;

      const targetThreadStartedDelivered = yield* runtime.events.pipe(
        Stream.filter((event) => event.method === "warning"),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );
      const target = yield* runtime.createRewindTarget();
      const sessionAfterTargetRpc = yield* runtime.getSession;

      NodeAssert.equal(target.threadId, replacementThreadId);
      NodeAssert.deepStrictEqual(sessionAfterTargetRpc, sourceSession);

      // The mock peer flushes this async replacement thread/started after the
      // target RPC resolves. Target creation must keep the source cursor.
      yield* runtime.sendTurn({ input: "flush target thread/started" });
      yield* Fiber.join(targetThreadStartedDelivered);
      const sessionAfterTargetNotification = yield* runtime.getSession;

      NodeAssert.deepStrictEqual(sessionAfterTargetNotification.resumeCursor, {
        threadId: sourceThreadId,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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

      const snapshot = yield* createCodexRewindTarget(
        {
          client,
          getSession: Effect.succeed(makeSession()),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          model: undefined,
          serviceTier: undefined,
        },
        undefined,
      );

      NodeAssert.equal(snapshot.threadId, "fresh-thread");
      NodeAssert.deepStrictEqual(calls, ["thread/read", "thread/start"]);
    }),
  );

  it.effect("creates a fork target through the requested completed turn", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const source = makeThreadReadResponse({
        status: "active",
        turns: [
          { id: "retained-turn", status: "completed" },
          { id: "active-turn", status: "inProgress" },
        ],
      });
      const replacement = makeThreadForkResponse("fork-thread", [
        { id: "retained-turn", status: "completed" },
      ]);
      const client = {
        request: <M extends "thread/read" | "turn/interrupt" | "thread/fork" | "thread/start">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          return Effect.succeed(
            (method === "thread/read"
              ? source
              : replacement) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const snapshot = yield* createCodexRewindTarget(
        {
          client,
          getSession: Effect.succeed(makeSession()),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          model: undefined,
          serviceTier: undefined,
        },
        TurnId.make("retained-turn"),
      );

      NodeAssert.equal(snapshot.threadId, "fork-thread");
      NodeAssert.deepStrictEqual(
        snapshot.turns.map((turn) => turn.id),
        ["retained-turn"],
      );
      NodeAssert.deepStrictEqual(calls, [
        {
          method: "thread/read",
          payload: { threadId: "source-thread", includeTurns: true },
        },
        {
          method: "thread/fork",
          payload: { threadId: "source-thread", lastTurnId: "retained-turn" },
        },
      ]);
    }),
  );

  it.effect("rejects an invalid retained turn before target creation", () =>
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

      const error = yield* createCodexRewindTarget(
        {
          client,
          getSession: Effect.succeed(makeSession()),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          model: undefined,
          serviceTier: undefined,
        },
        TurnId.make("missing-turn"),
      ).pipe(Effect.flip);

      NodeAssert.equal(error._tag, "CodexSessionRuntimeInvalidRetainedTurnError");
      NodeAssert.deepStrictEqual(calls, ["thread/read"]);
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
