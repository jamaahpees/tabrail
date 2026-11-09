import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BridgeClient, BridgeError } from "./client.js";

interface CachedBridge {
  port: number;
  token: string;
  client: BridgeClient;
}

let cached: CachedBridge | null = null;
let inflight: Promise<BridgeClient> | null = null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function spawnBridge(port: number, token: string): void {
  const entry = fileURLToPath(new URL("./bridge.js", import.meta.url));
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      MCP_BROWSER_PORT: String(port),
      MCP_BROWSER_TOKEN: token,
    },
  });
  child.unref();
}

async function connectOnce(port: number, token: string, timeoutMs: number): Promise<BridgeClient> {
  return await BridgeClient.connect(port, token, timeoutMs);
}

export async function getBridge(port: number, token: string): Promise<BridgeClient> {
  if (cached && cached.port === port && cached.token === token && cached.client.connected) {
    return cached.client;
  }
  if (inflight) return await inflight;

  inflight = openBridge(port, token).finally(() => {
    inflight = null;
  });
  return await inflight;
}

async function openBridge(port: number, token: string): Promise<BridgeClient> {
  try {
    const client = await connectOnce(port, token, 500);
    cached = { port, token, client };
    return client;
  } catch {
    // No bridge answered, start one below.
  }

  spawnBridge(port, token);

  const deadline = Date.now() + 10_000;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const client = await connectOnce(port, token, 1200);
      cached = { port, token, client };
      return client;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await sleep(250);
    }
  }

  throw new Error(
    lastError instanceof BridgeError && lastError.code === "bad_token"
      ? `A bridge is already listening on 127.0.0.1:${port} but it uses a different token. Stop that process, or set MCP_BROWSER_PORT to another port.`
      : `Could not start the browser bridge on 127.0.0.1:${port}. ${lastError?.message ?? ""}`.trim(),
  );
}
