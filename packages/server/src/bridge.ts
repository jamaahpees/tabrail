import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { clearBridgeInfo, loadOrCreateToken, writeBridgeInfo, bridgePort } from "./paths.js";
import type {
  BridgeMessage,
  CallMessage,
  HelloMessage,
  ResultMessage,
  ToolError,
} from "./protocol.js";

const BRIDGE_VERSION = "0.1.0";
const PORT = bridgePort();
const TOKEN = process.env.MCP_BROWSER_TOKEN ?? loadOrCreateToken();
const ALLOW_EVAL = process.env.MCP_BROWSER_ALLOW_EVAL === "1";
const HEARTBEAT_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_PENDING_PER_CLIENT = 32;

interface PendingCall {
  client: WebSocket;
  originalId: string;
  method: string;
  timer: NodeJS.Timeout;
}

let extensionSocket: WebSocket | null = null;
const clients = new Set<WebSocket>();
const pending = new Map<string, PendingCall>();
let sequence = 0;

function log(message: string): void {
  process.stderr.write(`[bridge] ${message}\n`);
}

function debug(message: string): void {
  if (process.env.MCP_BROWSER_DEBUG === "1") log(message);
}

function send(socket: WebSocket, message: BridgeMessage | { kind: "config"; allowEval: boolean }): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, id: string, error: ToolError): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ kind: "result", id, ok: false, error } satisfies ResultMessage));
}

function tokenMatches(candidate: string): boolean {
  const provided = Buffer.from(candidate);
  const expected = Buffer.from(TOKEN);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function broadcastStatus(): void {
  for (const client of clients) {
    send(client, { kind: "status", extensionConnected: extensionSocket !== null });
  }
}

function rejectPendingFor(socket: WebSocket, error: ToolError): void {
  for (const [id, entry] of pending) {
    if (entry.client !== socket) continue;
    clearTimeout(entry.timer);
    pending.delete(id);
    sendError(socket, entry.originalId, error);
  }
}

function callTimeout(method: string, params: Record<string, unknown>): number {
  if (method === "navigate") return 60_000;
  if (method === "screenshot") return 45_000;
  if (method === "wait_for") {
    const requested = Number(params["timeoutMs"] ?? 15_000);
    return Math.min(requested + 10_000, 120_000);
  }
  return 30_000;
}

function handleResult(message: ResultMessage): void {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  clearTimeout(entry.timer);
  send(entry.client, { ...message, id: entry.originalId });
}

function handleExtensionCall(client: WebSocket, message: CallMessage): void {
  debug(`call ${message.method} (extension=${extensionSocket ? "yes" : "no"})`);
  if (!extensionSocket) {
    sendError(client, message.id, {
      code: "extension_offline",
      message: "The Chrome extension is not connected to the bridge.",
      hint: "Open Chrome and click the Remote Browser Bridge icon, then check that the token matches the one in the extension options.",
    });
    return;
  }

  const ownPending = [...pending.values()].filter((entry) => entry.client === client).length;
  if (ownPending >= MAX_PENDING_PER_CLIENT) {
    sendError(client, message.id, {
      code: "too_many_requests",
      message: "This client already has too many browser calls in flight.",
      hint: "Wait for the previous calls to finish before sending more.",
    });
    return;
  }

  const bridgeId = `call-${++sequence}`;
  const timer = setTimeout(() => {
    pending.delete(bridgeId);
    sendError(client, message.id, {
      code: "timeout",
      message: `The extension did not answer "${message.method}" in time.`,
      hint: "The page may still be loading or a JavaScript dialog may be blocking the tab.",
    });
  }, callTimeout(message.method, message.params));

  pending.set(bridgeId, { client, originalId: message.id, method: message.method, timer });
  send(extensionSocket, {
    kind: "call",
    id: bridgeId,
    method: message.method,
    params: message.params,
  });
}

function parse(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        bridgeVersion: BRIDGE_VERSION,
        port: PORT,
        extensionConnected: extensionSocket !== null,
        clients: clients.size,
        pending: pending.size,
        uptimeSeconds: Math.round(process.uptime()),
      }),
    );
    return;
  }
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found\n");
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 * 1024 });

wss.on("connection", (socket: WebSocket) => {
  let role: "extension" | "internal" | null = null;
  let authAttempts = 0;
  let awaitingPong = false;

  const helloTimer = setTimeout(() => {
    if (role === null) socket.close(4408, "hello timeout");
  }, HELLO_TIMEOUT_MS);

  socket.on("pong", () => {
    awaitingPong = false;
  });

  socket.on("message", (raw: RawData) => {
    const data = parse(raw);
    if (!data || typeof data !== "object") return;
    const kind = (data as { kind?: unknown }).kind;
    debug(`recv ${String(kind)} role=${role ?? "none"}`);

    if (kind === "hello") {
      const hello = data as HelloMessage;
      if (typeof hello.token !== "string") return;
      authAttempts += 1;
      if (!tokenMatches(hello.token)) {
        if (authAttempts >= 3) socket.close(4403, "invalid token");
        send(socket, {
          kind: "reject",
          error: {
            code: "bad_token",
            message: "The bridge rejected the token.",
            hint: "Copy the token from the extension options and paste the same value into both places.",
          },
        });
        return;
      }
      if (role !== null) return;
      role = hello.role === "extension" ? "extension" : "internal";
      clearTimeout(helloTimer);

      if (role === "extension") {
        if (extensionSocket) {
          socket.close(4409, "extension already connected");
          return;
        }
        extensionSocket = socket;
        log(`extension connected (${hello.browser ?? "unknown browser"})`);
        send(socket, { kind: "config", allowEval: ALLOW_EVAL });
        broadcastStatus();
      } else {
        clients.add(socket);
        send(socket, {
          kind: "ready",
          allowEval: ALLOW_EVAL,
          extensionConnected: extensionSocket !== null,
          bridgeVersion: BRIDGE_VERSION,
        });
        log("mcp client connected");
      }
      return;
    }

    if (kind === "ping") {
      send(socket, { kind: "pong" });
      return;
    }

    if (kind === "result") {
      handleResult(data as ResultMessage);
      return;
    }

    if (kind === "call") {
      if (role !== "internal") return;
      handleExtensionCall(socket, data as CallMessage);
    }
  });

  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (role === "extension" && extensionSocket === socket) {
      extensionSocket = null;
      log("extension disconnected");
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(id);
        sendError(entry.client, entry.originalId, {
          code: "extension_disconnected",
          message: "The Chrome extension disconnected while the browser call was running.",
          hint: "Keep Chrome open and make sure the extension service worker is alive, then retry.",
        });
      }
      broadcastStatus();
    }
    if (role === "internal") {
      clients.delete(socket);
      rejectPendingFor(socket, {
        code: "client_closed",
        message: "The MCP client closed before the browser call finished.",
      });
      log("mcp client disconnected");
    }
  });

  socket.on("error", () => {
    // A transport error is followed by close, which performs the cleanup.
  });

  const heartbeat = setInterval(() => {
    if (awaitingPong) {
      debug("heartbeat missed, closing socket");
      socket.terminate();
      return;
    }
    awaitingPong = true;
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.ping();
    if (role === "extension") {
      // Application level ping keeps the MV3 service worker alive and gives
      // the extension a message event to react to.
      socket.send(JSON.stringify({ kind: "ping" }));
    }
  }, HEARTBEAT_MS);

  socket.on("close", () => clearInterval(heartbeat));
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    log(`port ${PORT} is already in use, assuming another bridge is running`);
    process.exit(0);
  }
  log(`server error: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  writeBridgeInfo({ pid: process.pid, port: PORT, startedAt: new Date().toISOString() });
  log(`listening on ws://127.0.0.1:${PORT} (evaluate=${ALLOW_EVAL ? "on" : "off"})`);
});

function shutdown(): void {
  clearBridgeInfo();
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  for (const client of clients) client.close(1001, "bridge shutting down");
  extensionSocket?.close(1001, "bridge shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => clearBridgeInfo());
