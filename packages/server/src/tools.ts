import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError, type BridgeClient } from "./client.js";

export interface ToolContext {
  getClient(): Promise<BridgeClient>;
  allowEval: boolean;
}

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

function textResult(value: unknown): ToolResult {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown): ToolResult {
  if (error instanceof BridgeError) {
    const hint = error.hint ? `\nHint: ${error.hint}` : "";
    return { content: [{ type: "text", text: `${error.code}: ${error.message}${hint}` }], isError: true };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `unexpected_error: ${message}` }], isError: true };
}

const tabId = z.number().int().positive().optional().describe("Target tab id. Defaults to the active tab.");

function targetFields(extra: Record<string, z.ZodType> = {}) {
  return {
    ref: z
      .string()
      .optional()
      .describe("Element reference from the latest browser_snapshot, for example e12. Prefer this over selector."),
    selector: z.string().optional().describe("CSS selector used only when no ref is available."),
    tabId,
    ...extra,
  };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const call = async (method: string, params: Record<string, unknown>): Promise<ToolResult> => {
    try {
      const client = await ctx.getClient();
      return textResult(await client.request(method, params, 45_000));
    } catch (error) {
      return errorResult(error);
    }
  };

  server.registerTool(
    "browser_status",
    {
      title: "Browser status",
      description:
        "Check the bridge and extension state, the active tab, and whether the Chrome debugger is attached. Call this first when a browser tool fails.",
      inputSchema: {},
    },
    async () => await call("status", {}),
  );

  server.registerTool(
    "browser_tabs",
    {
      title: "Manage tabs",
      description:
        "List open tabs, open a tab, close a tab, or activate a tab. Navigation targets the active tab unless browser_navigate receives a tabId.",
      inputSchema: {
        action: z.enum(["list", "new", "close", "activate"]).describe("Operation to perform."),
        url: z.string().optional().describe("URL for the new action."),
        tabId: z.number().int().positive().optional().describe("Tab id for close or activate."),
      },
    },
    async ({ action, url, tabId: id }) => await call("tabs", { action, url, tabId: id }),
  );

  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate",
      description:
        "Open a URL in the target tab and wait for the page load event. After navigating, call browser_snapshot before interacting with the page.",
      inputSchema: {
        url: z.string().describe("Absolute http or https URL."),
        tabId,
      },
    },
    async ({ url, tabId: id }) => await call("navigate", { url, tabId: id }),
  );

  server.registerTool(
    "browser_go_back",
    {
      title: "Go back",
      description: "Go back one entry in the target tab history.",
      inputSchema: { tabId },
    },
    async ({ tabId: id }) => await call("go_back", { tabId: id }),
  );

  server.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot page",
      description:
        "Read the page as an accessibility tree with stable element references (ref=e12). Use mode=interactive to keep only actionable elements, and mode=diff to return only what changed since the previous snapshot in the same tab. Always call this before clicking or typing.",
      inputSchema: {
        mode: z
          .enum(["full", "interactive", "diff"])
          .optional()
          .describe("full returns the semantic tree, interactive filters to actionable elements, diff returns only changes."),
        maxNodes: z.number().int().min(10).max(2000).optional().describe("Node budget, default 800."),
        tabId,
      },
    },
    async ({ mode, maxNodes, tabId: id }) => await call("snapshot", { mode, maxNodes, tabId: id }),
  );

  server.registerTool(
    "browser_get_text",
    {
      title: "Read text",
      description:
        "Return the visible text of a ref or selector, or of the whole page when neither is given. Cheaper than a full snapshot for reading content.",
      inputSchema: {
        ref: z.string().optional().describe("Element reference from browser_snapshot."),
        selector: z.string().optional().describe("CSS selector."),
        tabId,
      },
    },
    async ({ ref, selector, tabId: id }) => await call("get_text", { ref, selector, tabId: id }),
  );

  server.registerTool(
    "browser_click",
    {
      title: "Click",
      description:
        "Click an element by ref or selector. Uses a DOM click by default. Set trusted=true to send a real mouse event through the Chrome debugger, which some sites require.",
      inputSchema: targetFields({
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button, default left."),
        clickCount: z.number().int().min(1).max(3).optional().describe("Click count, default 1."),
        trusted: z.boolean().optional().describe("Send a trusted input event through the Chrome debugger."),
      }),
    },
    async (args) => await call("click", args),
  );

  server.registerTool(
    "browser_type",
    {
      title: "Type text",
      description:
        "Focus a field and replace its value with text, then optionally press Enter or submit the form. Works with React and Vue controlled inputs.",
      inputSchema: targetFields({
        text: z.string().describe("Text to enter."),
        submit: z.boolean().optional().describe("Submit after typing, default false."),
        clear: z.boolean().optional().describe("Clear the field first, default true."),
      }),
    },
    async (args) => await call("type", args),
  );

  server.registerTool(
    "browser_press_key",
    {
      title: "Press key",
      description:
        "Press a keyboard key on the focused element or on the element given by ref. Examples: Enter, Escape, Tab, ArrowDown, PageDown, Control+A.",
      inputSchema: {
        key: z.string().describe("Key name or shortcut such as Enter or Control+A."),
        ref: z.string().optional().describe("Element to focus before pressing."),
        selector: z.string().optional().describe("CSS selector to focus before pressing."),
        tabId,
      },
    },
    async (args) => await call("press_key", args),
  );

  server.registerTool(
    "browser_hover",
    {
      title: "Hover",
      description: "Move the pointer over an element so hover menus and tooltips open.",
      inputSchema: targetFields(),
    },
    async (args) => await call("hover", args),
  );

  server.registerTool(
    "browser_select_option",
    {
      title: "Select option",
      description: "Choose one or more options in a native select element by value or visible label.",
      inputSchema: targetFields({
        values: z.array(z.string()).min(1).describe("Option values or labels to select."),
      }),
    },
    async (args) => await call("select_option", args),
  );

  server.registerTool(
    "browser_scroll",
    {
      title: "Scroll",
      description:
        "Scroll the page or a scrollable element. Direction is up, down, left, or right. Amount is in CSS pixels and defaults to one viewport.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction."),
        amount: z.number().int().positive().optional().describe("Pixels to scroll, default about one viewport."),
        ref: z.string().optional().describe("Element to scroll instead of the page."),
        selector: z.string().optional().describe("CSS selector of the element to scroll."),
        tabId,
      },
    },
    async (args) => await call("scroll", args),
  );

  server.registerTool(
    "browser_wait_for",
    {
      title: "Wait for",
      description:
        "Wait until a selector exists, visible text appears, or the URL contains a value. Use this instead of guessing with screenshots.",
      inputSchema: {
        selector: z.string().optional().describe("CSS selector to wait for."),
        text: z.string().optional().describe("Visible text to wait for."),
        urlIncludes: z.string().optional().describe("Substring the page URL must contain."),
        timeoutMs: z.number().int().min(100).max(60_000).optional().describe("Timeout, default 15000."),
        tabId,
      },
    },
    async (args) => await call("wait_for", args),
  );

  server.registerTool(
    "browser_screenshot",
    {
      title: "Screenshot",
      description:
        "Capture the viewport, the full page, or a single element as a PNG. Use this for canvas apps, visual layout checks, or when the accessibility tree is not enough.",
      inputSchema: {
        fullPage: z.boolean().optional().describe("Capture the whole scrollable page."),
        ref: z.string().optional().describe("Element reference to capture."),
        selector: z.string().optional().describe("CSS selector of the element to capture."),
        tabId,
      },
    },
    async ({ fullPage, ref, selector, tabId: id }) => {
      try {
        const client = await ctx.getClient();
        const result = (await client.request(
          "screenshot",
          { fullPage, ref, selector, tabId: id },
          45_000,
        )) as { data?: string; mimeType?: string; width?: number; height?: number; note?: string };
        if (!result?.data) throw new Error("The extension returned no image data");
        const mimeType = result.mimeType ?? "image/png";
        const meta = [result.width && result.height ? `${result.width}x${result.height}` : null, result.note]
          .filter(Boolean)
          .join(", ");
        return {
          content: [
            { type: "image" as const, data: result.data, mimeType },
            { type: "text" as const, text: meta ? `Screenshot ${meta}` : "Screenshot captured" },
          ],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "browser_console",
    {
      title: "Console messages",
      description:
        "Return buffered console and runtime messages from the target tab, newest last. Keep the limit small unless you need history.",
      inputSchema: {
        level: z.enum(["all", "error", "warning", "info", "log"]).optional().describe("Filter by level, default all."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum entries, default 30."),
        tabId,
      },
    },
    async ({ level, limit, tabId: id }) => await call("console", { level, limit, tabId: id }),
  );

  server.registerTool(
    "browser_network",
    {
      title: "Network requests",
      description:
        "Return buffered network requests from the target tab with status and timing. Useful for debugging failed fetches and API calls.",
      inputSchema: {
        urlContains: z.string().optional().describe("Only requests whose URL contains this value."),
        method: z.string().optional().describe("Filter by HTTP method such as GET or POST."),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum entries, default 30."),
        tabId,
      },
    },
    async (args) => await call("network", args),
  );

  server.registerTool(
    "browser_handle_dialog",
    {
      title: "Handle dialog",
      description:
        "Accept or dismiss a pending JavaScript alert, confirm, or prompt. A pending dialog blocks every other call on that tab, so handle it before anything else.",
      inputSchema: {
        accept: z.boolean().describe("true accepts the dialog, false dismisses it."),
        promptText: z.string().optional().describe("Text for a prompt dialog."),
        tabId,
      },
    },
    async (args) => await call("handle_dialog", args),
  );

  if (ctx.allowEval) {
    server.registerTool(
      "browser_evaluate",
      {
        title: "Evaluate JavaScript",
        description:
          "Run JavaScript in the page and return the JSON result. Disabled by default; enable it with MCP_BROWSER_ALLOW_EVAL=1 before starting the MCP server.",
        inputSchema: {
          expression: z.string().describe("JavaScript expression or statements. Async functions are awaited."),
          tabId,
        },
      },
      async ({ expression, tabId: id }) => await call("evaluate", { expression, tabId: id }),
    );
  }
}
