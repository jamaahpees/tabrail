import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";
import { MCP_ENTRY, connectClient, startBridge, stopBridgeByPort, waitUntil } from "./helpers.mjs";

const PORT = 8797;
const PAIR_PORT = 8796;
const INSTANCE_PORT = 8795;
const PAIR_TOKEN = "pair-token-0123456789abcdef0123456789";

function fakeExtension(port, token, id) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          kind: "hello",
          role: "extension",
          token,
          version: "test",
          instanceId: id,
          label: `Browser ${id}`,
          active: true,
        }),
      );
    });
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "config") {
        resolve({
          id,
          send: (payload) => socket.send(JSON.stringify(payload)),
          close: () => socket.close(),
        });
      }
      if (message.kind === "call") {
        socket.send(
          JSON.stringify({
            kind: "result",
            id: message.id,
            ok: true,
            result: { who: id, method: message.method },
          }),
        );
      }
    });
    socket.on("error", reject);
  });
}

function transport(extraEnv) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return new StdioClientTransport({
    command: process.execPath,
    args: [MCP_ENTRY],
    env: { ...env, MCP_BROWSER_PORT: String(PORT), ...extraEnv },
    stderr: "pipe",
  });
}

test("MCP server lists tools and reports an offline extension", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "mcp-home-"));
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  await client.connect(transport({ MCP_BROWSER_HOME: home }));

  t.after(async () => {
    await client.close().catch(() => undefined);
    await stopBridgeByPort(PORT);
  });

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of [
    "browser_status",
    "browser_tabs",
    "browser_navigate",
    "browser_snapshot",
    "browser_get_text",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_hover",
    "browser_select_option",
    "browser_scroll",
    "browser_wait_for",
    "browser_screenshot",
    "browser_console",
    "browser_network",
    "browser_handle_dialog",
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  assert.ok(!names.includes("browser_evaluate"), "evaluate is off by default");

  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /no_active_browser/);

  const snapshotSchema = tools.tools.find((tool) => tool.name === "browser_snapshot");
  assert.ok(snapshotSchema.inputSchema);
  assert.ok(snapshotSchema.inputSchema.properties.mode);
});

test("local pairing only answers extension origins", async (t) => {
  const bridge = await startBridge({
    port: PAIR_PORT,
    token: PAIR_TOKEN,
    extraEnv: { MCP_BROWSER_ALLOW_LOCAL_PAIRING: "1" },
  });
  t.after(() => bridge.stop());

  const allowed = await fetch(`http://127.0.0.1:${PAIR_PORT}/pair`, {
    method: "POST",
    headers: { origin: "chrome-extension://cgiclackdhpeikhbfdnokhjoejijjkdp" },
  });
  assert.equal(allowed.status, 200);
  const payload = await allowed.json();
  assert.equal(payload.token, PAIR_TOKEN);

  const denied = await fetch(`http://127.0.0.1:${PAIR_PORT}/pair`, { method: "POST" });
  assert.equal(denied.status, 403);

  const webOrigin = await fetch(`http://127.0.0.1:${PAIR_PORT}/pair`, {
    method: "POST",
    headers: { origin: "https://evil.example" },
  });
  assert.equal(webOrigin.status, 403);
});

test("second browser takes over with one confirmation", async (t) => {
  const bridge = await startBridge({
    port: INSTANCE_PORT,
    token: PAIR_TOKEN,
    extraEnv: { MCP_BROWSER_ALLOW_LOCAL_PAIRING: "1" },
  });
  t.after(() => bridge.stop());

  const first = await fakeExtension(INSTANCE_PORT, PAIR_TOKEN, "browser-a");
  const second = await fakeExtension(INSTANCE_PORT, PAIR_TOKEN, "browser-b");
  t.after(() => {
    first.close();
    second.close();
  });

  const client = await connectClient(INSTANCE_PORT, PAIR_TOKEN);
  t.after(() => client.close());

  const initial = await client.call("who");
  assert.equal(initial.who, "browser-a");

  second.send({ kind: "takeover" });
  await waitUntil(
    async () => {
      try {
        return (await client.call("who")).who === "browser-b";
      } catch {
        return false;
      }
    },
    5000,
    "takeover by the second browser",
  );

  second.close();
  await waitUntil(
    async () => {
      try {
        return (await client.call("who")).who === "browser-a";
      } catch {
        return false;
      }
    },
    5000,
    "fallback to the first browser",
  );
});

