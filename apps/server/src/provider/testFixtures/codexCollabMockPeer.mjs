// Minimal codex app-server stand-in for runtime-level collab tests.
// Speaks just enough of the protocol for CodexSessionRuntime to start a
// session, using REAL captured responses (codexMultiAgentWire.json), then
// replays a scripted multi-agent notification sequence read from the
// T3_CODEX_COLLAB_SCRIPT env var (a JSON file path) when the first turn
// starts. Runs as a plain Node process — stdlib only.
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "codexMultiAgentWire.json"), "utf8"),
);
const script = JSON.parse(NodeFS.readFileSync(process.env.T3_CODEX_COLLAB_SCRIPT, "utf8"));

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const lifecyclePath = script.processCloseControl?.sidecarPath;
function appendLifecycle(entry) {
  if (!lifecyclePath) {
    return;
  }
  NodeFS.appendFileSync(lifecyclePath, `${JSON.stringify(entry)}\n`);
}
let turnStartCount = 0;
let threadStartCount = 0;
let currentTurns = [];
let currentStatus = { type: "idle" };
const liveTurns = new Map();
const pendingRequestResponses = new Map();

function lifecycleState() {
  return {
    liveTurns: Array.from(liveTurns, ([threadId, turnId]) => ({ threadId, turnId })),
    pendingRequestResponses: Object.fromEntries(pendingRequestResponses),
  };
}

function recordProcessClose(kind, detail) {
  appendLifecycle({
    type: "process-close",
    kind,
    detail,
    ...lifecycleState(),
  });
}

function exitForSignal(signal) {
  appendLifecycle({ type: "close-signal-received", signal });
  recordProcessClose("signal", signal);
  process.exit(0);
}

if (script.processCloseControl) {
  process.once("SIGTERM", () => {
    exitForSignal("SIGTERM");
  });
  process.once("SIGHUP", () => {
    exitForSignal("SIGHUP");
  });
  process.once("exit", (code) => {
    appendLifecycle({
      type: "process-exit",
      code,
      ...lifecycleState(),
    });
  });
}

function sendPendingRequests(rootThreadId, turnId) {
  const controls = script.pendingRequestControl;
  if (!controls) {
    return;
  }
  if (controls.approvalRequestId) {
    pendingRequestResponses.set(controls.approvalRequestId, "pending");
    write({
      id: controls.approvalRequestId,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: rootThreadId,
        turnId,
        itemId: "shutdown-approval-item",
        startedAtMs: 0,
        command: "echo shutdown-proof",
      },
    });
    appendLifecycle({ type: "request-sent", request: "approval" });
  }
  if (controls.structuredInputRequestId) {
    pendingRequestResponses.set(controls.structuredInputRequestId, "pending");
    write({
      id: controls.structuredInputRequestId,
      method: "item/tool/requestUserInput",
      params: {
        threadId: rootThreadId,
        turnId,
        itemId: "shutdown-structured-input-item",
        questions: [
          {
            id: "shutdown-question",
            header: "Shutdown",
            question: "Keep the old source open?",
            options: [],
          },
        ],
      },
    });
    appendLifecycle({ type: "request-sent", request: "structured-input" });
  }
}

function pendingRequestKind(id) {
  const controls = script.pendingRequestControl;
  if (controls?.approvalRequestId !== undefined && id === controls.approvalRequestId) {
    return "approval";
  }
  if (
    controls?.structuredInputRequestId !== undefined &&
    id === controls.structuredInputRequestId
  ) {
    return "structured-input";
  }
  return undefined;
}

const rl = NodeReadline.createInterface({ input: process.stdin });
rl.once("close", () => {
  if (script.processCloseControl) {
    recordProcessClose("transport", "stdin");
  }
});
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method } = message;
  const pendingRequest = pendingRequestKind(id);
  if (pendingRequest) {
    pendingRequestResponses.set(id, message.result);
    appendLifecycle({ type: "response-received", request: pendingRequest, result: message.result });
    return;
  }
  if (method === "initialize") {
    write({
      id,
      result: {
        userAgent: "t3-collab-mock/0.0.0",
        codexHome: "/tmp",
        platformFamily: "unix",
        platformOs: "linux",
      },
    });
    return;
  }
  if (method === "thread/start" || method === "thread/resume") {
    const threadId =
      threadStartCount > 0 && script.replacementThreadId
        ? script.replacementThreadId
        : script.rootThreadId;
    threadStartCount += 1;
    currentTurns = [];
    currentStatus = { type: "idle" };
    write({
      id,
      result: {
        ...fixture.responses.threadStart,
        thread: { ...fixture.responses.threadStart.thread, id: threadId, turns: [] },
      },
    });
    return;
  }
  if (method === "thread/read") {
    write({
      id,
      result: {
        thread: {
          ...fixture.responses.threadStart.thread,
          id: message.params?.threadId,
          turns: currentTurns,
          status: currentStatus,
        },
      },
    });
    return;
  }
  if (method === "turn/start") {
    const turnId = script.turnIds?.[turnStartCount];
    const turn = turnId
      ? { ...fixture.responses.turnStart.turn, id: turnId }
      : fixture.responses.turnStart.turn;
    turnStartCount += 1;
    currentTurns = [...currentTurns, { ...turn, status: "inProgress" }];
    currentStatus = { type: "active", activeFlags: [] };
    const rootThreadId = message.params?.threadId ?? script.rootThreadId;
    liveTurns.set(rootThreadId, turn.id);
    write({ id, result: { ...fixture.responses.turnStart, turn } });
    if (script.onlyFirstTurnStarts !== true || turnStartCount === 1) {
      write({
        jsonrpc: "2.0",
        method: "turn/started",
        params: { threadId: rootThreadId, turn },
      });
    }
    const notifications =
      script.notificationsByTurnStart?.[turnStartCount - 1] ?? script.notifications;
    for (const notification of notifications) {
      if (notification.method === "turn/started") {
        liveTurns.set(notification.params.threadId, notification.params.turn.id);
      }
      if (notification.method === "turn/completed") {
        liveTurns.delete(notification.params.threadId);
      }
      if (notification.method === "thread/closed") {
        liveTurns.delete(notification.params.threadId);
      }
      write({ jsonrpc: "2.0", method: notification.method, params: notification.params });
    }
    sendPendingRequests(rootThreadId, turn.id);
    if (script.holdTurnOpen !== true) {
      currentTurns = currentTurns.map((candidate) =>
        candidate.id === turn.id ? { ...candidate, status: "completed" } : candidate,
      );
      currentStatus = { type: "idle" };
      liveTurns.delete(rootThreadId);
      write({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          threadId: rootThreadId,
          turn: { ...turn, status: "completed" },
        },
      });
    }
    return;
  }
  if (method === "turn/interrupt") {
    // Record which thread/turn was interrupted (append-only sidecar file the
    // test reads) so Stop coverage can assert every live child was reached.
    // failInterruptFor simulates a dead child whose interrupt errors.
    const target = message.params?.threadId;
    NodeFS.appendFileSync(
      `${process.env.T3_CODEX_COLLAB_SCRIPT}.interrupts`,
      `${JSON.stringify({ threadId: target, turnId: message.params?.turnId })}\n`,
    );
    if (
      script.expectedActiveTurnId &&
      message.params?.threadId === script.rootThreadId &&
      message.params?.turnId !== script.expectedActiveTurnId
    ) {
      write({
        id,
        error: {
          code: -32000,
          message: `expected active turn id ${message.params?.turnId} but found ${script.expectedActiveTurnId}`,
        },
      });
      return;
    }
    if (script.failInterruptFor && script.failInterruptFor === target) {
      write({ id, error: { code: -32000, message: "thread already closed" } });
      return;
    }
    if (script.hangInterruptFor && script.hangInterruptFor === target) {
      // Never respond: simulates a wedged child whose RPC neither resolves
      // nor rejects. The runtime's bounded deadline must move on.
      return;
    }
    write({ id, result: {} });
    return;
  }
  if (id !== undefined) {
    write({ id, result: {} });
  }
});
