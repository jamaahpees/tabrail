import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getBridge } from "./ensureBridge.js";
import { bridgePort, loadOrCreateToken } from "./paths.js";
import { registerTools } from "./tools.js";

const INSTRUCTIONS = `This server controls the user's real Chrome browser through a companion extension.

Workflow:
1. Call browser_status when a browser call fails, to see whether the extension is connected.
2. Call browser_snapshot before interacting with a page. Element refs look like "e12" and are only valid for the current page state.
3. After navigating or after a large DOM change, take a new snapshot. A stale_ref error means the element moved or re-rendered.
4. Prefer browser_get_text for reading content and browser_wait_for for slow pages instead of repeated snapshots.
5. Use browser_screenshot only when the accessibility tree is not enough, for example canvas apps or visual checks.

The browser belongs to the user. Do not close tabs you did not open, and never run destructive actions on the page without being asked.`;

async function main(): Promise<void> {
  const port = bridgePort();
  const token = loadOrCreateToken();
  const allowEval = process.env.MCP_BROWSER_ALLOW_EVAL === "1";

  const server = new McpServer(
    { name: "tabrail", version: "0.3.0" },
    { instructions: INSTRUCTIONS },
  );

  registerTools(server, {
    getClient: async () => await getBridge(port, token),
    allowEval,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(`[mcp] ready, bridge port ${port}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[mcp] fatal: ${message}\n`);
  process.exit(1);
});






