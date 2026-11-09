import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MCP_ENTRY, stopBridgeByPort } from "./helpers.mjs";

const PORT = 8797;

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
  assert.match(status.content[0].text, /extension_offline/);

  const snapshotSchema = tools.tools.find((tool) => tool.name === "browser_snapshot");
  assert.ok(snapshotSchema.inputSchema);
  assert.ok(snapshotSchema.inputSchema.properties.mode);
});
