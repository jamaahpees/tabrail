import { WebSocket } from "ws";
import type { BridgeMessage, ReadyMessage, ResultMessage, ToolError } from "./protocol.js";

export class BridgeError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(error: ToolError) {
    super(error.message);
    this.name = "BridgeError";
    this.code = error.code;
    this.hint = error.hint;
  }
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function parse(raw: unknown): BridgeMessage | null {
  try {
    return JSON.parse(String(raw)) as BridgeMessage;
  } catch {
    return null;
  }
}

export class BridgeClient {
  readonly #socket: WebSocket;
  readonly #pending = new Map<string, PendingRequest>();
  #ready: ReadyMessage;
  #sequence = 0;

  private constructor(socket: WebSocket, ready: ReadyMessage) {
    this.#socket = socket;
    this.#ready = ready;
    socket.on("message", (raw) => this.#onMessage(raw));
    socket.on("close", () => this.#onClose());
  }

  static async connect(port: number, token: string, timeoutMs = 1500): Promise<BridgeClient> {
    return await new Promise<BridgeClient>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`);
      let settled = false;

      const timer = setTimeout(() => {
        finish(new Error(`Timed out connecting to the bridge on 127.0.0.1:${port}`));
      }, timeoutMs);

      const finish = (error: Error | null, client?: BridgeClient): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          socket.terminate();
          reject(error);
        } else if (client) {
          resolve(client);
        }
      };

      const onMessage = (raw: unknown): void => {
        const message = parse(raw);
        if (!message) return;
        if (message.kind === "ready") {
          socket.off("message", onMessage);
          finish(null, new BridgeClient(socket, message));
        } else if (message.kind === "reject") {
          finish(new BridgeError(message.error));
        }
      };

      socket.on("message", onMessage);
      socket.on("open", () => {
        socket.send(JSON.stringify({ kind: "hello", role: "internal", token, version: "0.2.0" }));
      });
      socket.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))));
      socket.on("close", () => finish(new Error("The bridge closed the connection before it was ready")));
    });
  }

  get ready(): ReadyMessage {
    return this.#ready;
  }

  get connected(): boolean {
    return this.#socket.readyState === WebSocket.OPEN;
  }

  get extensionConnected(): boolean {
    return this.#ready.extensionConnected;
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.connected) throw new Error("The browser bridge is not connected");
    const id = `req-${++this.#sequence}`;

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new BridgeError({
            code: "timeout",
            message: `The browser did not answer "${method}" within ${Math.round(timeoutMs / 1000)} seconds.`,
            hint: "Check that the target tab is still open and that no JavaScript dialog is blocking it.",
          }),
        );
      }, timeoutMs);

      this.#pending.set(id, { resolve, reject, timer });
      this.#socket.send(JSON.stringify({ kind: "call", id, method, params }));
    });
  }

  close(): void {
    this.#onClose();
    this.#socket.close(1000, "client closing");
  }

  #onMessage(raw: unknown): void {
    const message = parse(raw);
    if (!message) return;

    if (message.kind === "ping") {
      if (this.connected) this.#socket.send(JSON.stringify({ kind: "pong" }));
      return;
    }

    if (message.kind === "status") {
      this.#ready = { ...this.#ready, extensionConnected: message.extensionConnected };
      return;
    }

    if (message.kind === "result") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      this.#settle(pending, message);
    }
  }

  #settle(pending: PendingRequest, message: ResultMessage): void {
    if (message.ok) {
      pending.resolve(message.result);
    } else if (message.error) {
      pending.reject(new BridgeError(message.error));
    } else {
      pending.reject(new Error("The extension returned an empty error"));
    }
  }

  #onClose(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(new Error("The bridge client closed before the call finished"));
    }
  }
}

