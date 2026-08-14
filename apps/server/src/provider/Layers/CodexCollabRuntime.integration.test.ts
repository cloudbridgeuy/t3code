/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const extras = [
    {
      method: "item/completed",
      params: {
        threadId: ROOT,
        item: {
          type: "collabAgentToolCall",
          id: "call_fixture_wait",
          tool: "wait",
          status: "completed",
          senderThreadId: ROOT,
          receiverThreadIds: [CHILD_A, CHILD_B],
        },
      },
    },
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    {
      method: "turn/completed",
      params: {
        threadId: CHILD_A,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      },
    },
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [...captured.filter((entry) => entry.method !== "turn/completed"), ...extras],
  };
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");

describe("CodexSessionRuntime collab integration", () => {
  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(scriptPath, { force: true })),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [turnStartedA, registrationA, registrationB, turnStartedB],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stopping the source runtime terminates old work and pending requests", () =>
    Effect.gen(function* () {
      const captured = wireFixture.notifications;
      const childRegistration = captured.find((entry) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === CHILD_A;
      });
      const childTurnStarted = captured.find(
        (entry) =>
          entry.method === "turn/started" &&
          (entry.params as { threadId?: string }).threadId === CHILD_A,
      );
      assert.isDefined(childRegistration);
      assert.isDefined(childTurnStarted);
      const runShutdownCase = (request: "approval" | "structured-input") =>
        Effect.gen(function* () {
          const lifecyclePath = `${scriptPath}.shutdown-lifecycle.${request}`;
          const requestId = `shutdown-${request}-request`;
          const requestMethod =
            request === "approval"
              ? "item/commandExecution/requestApproval"
              : "item/tool/requestUserInput";
          const expectedResult = request === "approval" ? { decision: "cancel" } : { answers: {} };
          const script = {
            rootThreadId: ROOT,
            holdTurnOpen: true,
            notifications: [childRegistration, childTurnStarted],
            pendingRequestControl:
              request === "approval"
                ? { approvalRequestId: requestId }
                : { structuredInputRequestId: requestId },
            processCloseControl: { sidecarPath: lifecyclePath },
          };
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
          NodeFS.rmSync(lifecyclePath, { force: true });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(scriptPath, { force: true });
              NodeFS.rmSync(lifecyclePath, { force: true });
            }),
          );

          const runtimeScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(runtimeScope, Exit.void));
          const runtime = yield* makeCodexSessionRuntime({
            threadId: ThreadId.make(`thread-codex-source-shutdown-${request}`),
            binaryPath: peerPath,
            cwd: "/tmp",
            runtimeMode: "full-access",
            environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
          }).pipe(Effect.provideService(Scope.Scope, runtimeScope));
          yield* Effect.addFinalizer(() => runtime.close);

          const requestReady = yield* Deferred.make<void>();
          const childTurnReady = yield* Deferred.make<void>();
          const eventsFiber = yield* runtime.events.pipe(
            Stream.tap((event) => {
              if (event.method === requestMethod) {
                return Deferred.succeed(requestReady, undefined).pipe(Effect.ignore);
              }
              if (
                event.method === "collabAgent/turnStarted" &&
                (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A
              ) {
                return Deferred.succeed(childTurnReady, undefined).pipe(Effect.ignore);
              }
              return Effect.void;
            }),
            Stream.runDrain,
            Effect.forkScoped,
          );

          yield* runtime.start();
          const rootTurn = yield* runtime.sendTurn({ input: "keep the old source working" });
          yield* Effect.all([Deferred.await(requestReady), Deferred.await(childTurnReady)]);

          const closeStartedAt = yield* Clock.currentTimeMillis;
          yield* runtime.close;
          const closeElapsedMs = (yield* Clock.currentTimeMillis) - closeStartedAt;

          const eventsExit = yield* Fiber.await(eventsFiber);
          assert.isTrue(
            Exit.hasInterrupts(eventsExit),
            "closing the runtime must terminate its old event transport",
          );

          const lifecycle = NodeFS.readFileSync(lifecyclePath, "utf8")
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  type?: string;
                  request?: string;
                  result?: unknown;
                  kind?: string;
                  detail?: string;
                  code?: number;
                  pendingRequestResponses?: Readonly<Record<string, unknown>>;
                  liveTurns?: ReadonlyArray<{
                    readonly threadId?: string;
                    readonly turnId?: string;
                  }>;
                },
            );
          assert.deepInclude(lifecycle, { type: "request-sent", request });

          const processClose = lifecycle.find(
            (entry) =>
              entry.type === "process-close" &&
              entry.kind === "signal" &&
              entry.detail === "SIGTERM",
          );
          assert.isDefined(processClose, "the old app-server process must record termination");
          assert.deepInclude(
            processClose,
            { type: "process-close", kind: "signal", detail: "SIGTERM" },
            "the old app-server process must observe process termination",
          );
          const processExit = lifecycle.find((entry) => entry.type === "process-exit");
          assert.deepInclude(
            processExit,
            { type: "process-exit", code: 0 },
            "the old app-server process must exit before close completes",
          );

          const responseReceipt = lifecycle.find(
            (entry) => entry.type === "response-received" && entry.request === request,
          );
          if (responseReceipt) {
            assert.deepEqual(responseReceipt.result, expectedResult);
          } else {
            assert.equal(
              processExit?.pendingRequestResponses?.[requestId],
              "pending",
              "transport close must terminate a request whose response was not flushed",
            );
          }
          assert.deepInclude(
            processExit?.liveTurns ?? [],
            { threadId: ROOT, turnId: rootTurn.turnId },
            "process exit must terminate the old live root turn",
          );
          assert.deepInclude(
            processExit?.liveTurns ?? [],
            {
              threadId: CHILD_A,
              turnId: (childTurnStarted.params as { turn: { id: string } }).turn.id,
            },
            "process exit must terminate the old live child turn",
          );
          assert.strictEqual(
            lifecycle.at(-1),
            processExit,
            "the append-only lifecycle must end at process exit with no old work afterward",
          );
          return {
            closeElapsedMs,
            pendingTermination: responseReceipt ? "response" : "transport-close",
          } as const;
        }).pipe(Effect.scoped);

      const approvalCloseMs = yield* runShutdownCase("approval");
      const structuredInputCloseMs = yield* runShutdownCase("structured-input");
      yield* Effect.sync(() =>
        process.stdout.write(
          `Codex source-close lifecycle: approval=${approvalCloseMs.closeElapsedMs} ms/${approvalCloseMs.pendingTermination}, structured-input=${structuredInputCloseMs.closeElapsedMs} ms/${structuredInputCloseMs.pendingTermination}\n`,
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
