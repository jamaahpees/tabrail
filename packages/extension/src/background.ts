import type {
  BridgeToExtension,
  CallEnvelope,
  ContentResponse,
  ExtensionToBridge,
  ToolErrorPayload,
} from "./protocol.js";
import { DEFAULT_SETTINGS, getSettings, originAllowed, saveSettings, type Settings } from "./settings.js";

const EXTENSION_VERSION = "0.2.0";
const RECONNECT_CAP_MS = 30_000;
const CDP_IDLE_DETACH_MS = 30_000;
const BLOCKED_SCHEME = /^(chrome|chrome-extension|edge|about|devtools|view-source|file|data|blob):/i;

class ActionError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
    this.hint = hint;
  }
}

interface ExtensionStatus {
  state: "disabled" | "disconnected" | "connecting" | "connected" | "error";
  detail?: string;
  updatedAt: string;
}

interface Activity {
  at: string;
  method: string;
  ok: boolean;
  summary: string;
}

interface ConsoleEntry {
  level: string;
  text: string;
  at: string;
}

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status: number | null;
  type: string;
  at: string;
  failed: string | null;
}

interface PendingDialog {
  type: string;
  message: string;
  defaultPrompt: string;
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

let settings: Settings = { ...DEFAULT_SETTINGS };
let socket: WebSocket | null = null;
let status: ExtensionStatus = { state: "disconnected", updatedAt: new Date().toISOString() };
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connectQueue: Promise<void> = Promise.resolve();
let allowEval = false;
let activity: Activity[] = [];
let rejectedDetail: string | null = null;

const consoleBuffers = new Map<number, ConsoleEntry[]>();
const networkBuffers = new Map<number, NetworkEntry[]>();
const attachedTabs = new Map<number, { idle?: ReturnType<typeof setTimeout> }>();
const pendingDialogs = new Map<number, PendingDialog>();

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(state: ExtensionStatus["state"], detail?: string): void {
  status = { state, detail, updatedAt: new Date().toISOString() };
  updateBadge();
}

function updateBadge(): void {
  const text =
    status.state === "connected" ? "ON" : status.state === "error" ? "!" : status.state === "disabled" ? "" : "…";
  const color = status.state === "connected" ? "#1c6f4a" : status.state === "error" ? "#a33a2b" : "#8a5a12";
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

function record(method: string, ok: boolean, ms: number, code?: string): void {
  activity.unshift({
    at: new Date().toISOString(),
    method,
    ok,
    summary: code ? `${code} after ${ms}ms` : `${ms}ms`,
  });
  activity = activity.slice(0, 10);
}

function payloadOf(error: unknown): ToolErrorPayload {
  if (error instanceof ActionError) {
    return { code: error.code, message: error.message, hint: error.hint };
  }
  return { code: "action_failed", message: error instanceof Error ? error.message : String(error) };
}

function send(message: ExtensionToBridge): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function connect(reason: string): Promise<void> {
  connectQueue = connectQueue
    .then(() => doConnect(reason))
    .catch((error: unknown) => {
      setStatus("error", error instanceof Error ? error.message : String(error));
    });
  return connectQueue;
}

async function pairWithBridge(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { token?: unknown };
    return typeof data.token === "string" && data.token.length > 0 ? data.token : null;
  } catch {
    return null;
  }
}

async function doConnect(reason: string): Promise<void> {
  const current = await getSettings();
  settings = current;

  if (!current.enabled) {
    const previous = socket;
    socket = null;
    if (previous) previous.close(1000, "disabled");
    setStatus("disabled", "Extension control is turned off.");
    return;
  }

  if (!current.token) {
    const paired = await pairWithBridge(current.port);
    if (paired) {
      current.token = paired;
      settings = await saveSettings({ token: paired });
      setStatus("connecting", "Paired with the local bridge.");
    } else {
      setStatus(
        "error",
        "No token set. Paste the bridge token in the popup, or start the bridge with local pairing enabled.",
      );
      scheduleReconnect();
      return;
    }
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setStatus("connecting", `Trying 127.0.0.1:${current.port} (${reason}).`);
  const ws = new WebSocket(`ws://127.0.0.1:${current.port}`);
  socket = ws;

  ws.addEventListener("open", () => {
    if (socket !== ws) return;
    ws.send(
      JSON.stringify({
        kind: "hello",
        role: "extension",
        token: current.token,
        version: EXTENSION_VERSION,
        browser: navigator.userAgent,
      }),
    );
    reconnectAttempts = 0;
    rejectedDetail = null;
    setStatus("connected");
  });

  ws.addEventListener("message", (event) => {
    void onBridgeMessage(event.data);
  });

  ws.addEventListener("close", () => {
    if (socket !== ws) return;
    socket = null;
    if (rejectedDetail) {
      setStatus("error", rejectedDetail);
    } else {
      setStatus("disconnected", "The local bridge is not reachable yet. Start an MCP client or check the port.");
    }
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // The close event follows and schedules the retry.
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = Math.min(RECONNECT_CAP_MS, 1000 * 2 ** Math.min(reconnectAttempts, 5));
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connect("retry");
  }, delay);
}

let forceReconnectTimer: ReturnType<typeof setTimeout> | undefined;

function requestReconnect(reason: string): void {
  if (forceReconnectTimer) clearTimeout(forceReconnectTimer);
  forceReconnectTimer = setTimeout(() => {
    forceReconnectTimer = undefined;
    void reconnectNow(reason);
  }, 150);
}

async function reconnectNow(reason: string): Promise<void> {
  const previous = socket;
  socket = null;
  reconnectAttempts = 0;
  rejectedDetail = null;
  if (previous) previous.close(1000, "reconnecting");
  await connect(reason);
}

async function onBridgeMessage(raw: unknown): Promise<void> {
  let message: BridgeToExtension;
  try {
    message = JSON.parse(String(raw)) as BridgeToExtension;
  } catch {
    return;
  }

  if (message.kind === "ping") {
    send({ kind: "pong" });
    return;
  }
  if (message.kind === "config") {
    allowEval = message.allowEval;
    return;
  }
  if (message.kind === "reject") {
    rejectedDetail = message.error.hint
      ? `${message.error.message} ${message.error.hint}`
      : message.error.message;
    setStatus("error", rejectedDetail);
    socket?.close(4001, "rejected");
    return;
  }
  if (message.kind === "call") {
    await handleCall(message);
  }
}

async function handleCall(call: CallEnvelope): Promise<void> {
  const started = Date.now();
  try {
    const result = await dispatch(call.method, call.params ?? {});
    send({ kind: "result", id: call.id, ok: true, result });
    record(call.method, true, Date.now() - started);
  } catch (error) {
    const payload = payloadOf(error);
    send({ kind: "result", id: call.id, ok: false, error: payload });
    record(call.method, false, Date.now() - started, payload.code);
  }
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "status":
      return await extensionStatus();
    case "tabs":
      return await tabsCommand(params);
    case "navigate":
      return await navigate(params);
    case "go_back":
      return await goBack(params);
    case "snapshot":
      return await withContent(params, "snapshot");
    case "get_text":
      return await withContent(params, "get_text");
    case "click":
      return await click(params);
    case "type":
      return await withContent(params, "type");
    case "press_key":
      return await withContent(params, "press_key");
    case "hover":
      return await withContent(params, "hover");
    case "select_option":
      return await withContent(params, "select_option");
    case "scroll":
      return await withContent(params, "scroll");
    case "wait_for":
      return await withContent(params, "wait_for");
    case "screenshot":
      return await screenshot(params);
    case "console":
      return await consoleMessages(params);
    case "network":
      return await networkRequests(params);
    case "handle_dialog":
      return await handleDialog(params);
    case "evaluate":
      return await evaluate(params);
    default:
      throw new ActionError("unknown_method", `Unknown method "${method}".`);
  }
}

async function requireTab(params: Record<string, unknown>): Promise<chrome.tabs.Tab> {
  const tabId = typeof params["tabId"] === "number" ? params["tabId"] : undefined;
  if (tabId !== undefined) {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new ActionError("tab_not_found", `Tab ${tabId} no longer exists.`);
    }
  }

  const pinned = settings.pinnedTabId;
  if (typeof pinned === "number") {
    try {
      return await chrome.tabs.get(pinned);
    } catch {
      settings = await saveSettings({ pinnedTabId: null });
    }
  }

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) {
    throw new ActionError("no_active_tab", "No active tab found.", "Focus a Chrome window with a normal web page open.");
  }
  return tab;
}

async function currentTargetTab(): Promise<chrome.tabs.Tab | null> {
  const pinned = settings.pinnedTabId;
  if (typeof pinned === "number") {
    try {
      return await chrome.tabs.get(pinned);
    } catch {
      settings = await saveSettings({ pinnedTabId: null });
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

function assertControllable(tab: chrome.tabs.Tab): void {
  const url = tab.url;
  if (!url) return;
  if (BLOCKED_SCHEME.test(url)) {
    throw new ActionError(
      "page_not_controllable",
      `Chrome blocks extensions from controlling ${url.split(":")[0]}: pages.`,
      "Switch the tab to a normal http or https page.",
    );
  }
  if (!originAllowed(url, settings.allowlist)) {
    throw new ActionError(
      "origin_not_allowed",
      `${url} is not covered by the extension allowlist.`,
      "Add the origin in the extension options, or clear the allowlist to allow every site.",
    );
  }
}

async function trySend(tabId: number, message: unknown): Promise<ContentResponse | null> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as ContentResponse | undefined;
    return response ?? null;
  } catch {
    return null;
  }
}

async function ensureContent(tab: chrome.tabs.Tab): Promise<number> {
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");
  assertControllable(tab);

  const ping = await trySend(tabId, { type: "content:ping" });
  if (ping?.ok) return tabId;

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActionError(
      "injection_blocked",
      `Could not inject the automation script: ${message}`,
      "Chrome blocks extensions on chrome:// pages, the Chrome Web Store, and other extensions.",
    );
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const pong = await trySend(tabId, { type: "content:ping" });
    if (pong?.ok) return tabId;
    await sleep(50);
  }

  throw new ActionError(
    "injection_failed",
    "The automation script was injected but never answered.",
    "Reload the page and try again.",
  );
}

async function withContent(params: Record<string, unknown>, method: string): Promise<unknown> {
  const tab = await requireTab(params);
  return await contentRpc(tab, method, params);
}

async function contentRpc(tab: chrome.tabs.Tab, method: string, params: Record<string, unknown>): Promise<unknown> {
  const tabId = await ensureContent(tab);
  try {
    const response = (await chrome.tabs.sendMessage(tabId, {
      type: "content:req",
      method,
      params,
    })) as ContentResponse | undefined;

    if (!response) {
      return { note: "The page did not answer, it may have started navigating." };
    }
    if (!response.ok) {
      const error = response.error;
      throw new ActionError(error?.code ?? "action_failed", error?.message ?? "The page action failed.", error?.hint);
    }
    return response.result;
  } catch (error) {
    if (error instanceof ActionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/message port closed|Receiving end does not exist|context invalidated/i.test(message)) {
      return { note: "The page started navigating before it answered. Take a new snapshot." };
    }
    const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "content_rpc_failed";
    const hint = typeof (error as { hint?: unknown })?.hint === "string" ? (error as { hint: string }).hint : undefined;
    throw new ActionError(code, message, hint);
  }
}

async function navigate(params: Record<string, unknown>): Promise<unknown> {
  const raw = typeof params["url"] === "string" ? params["url"].trim() : "";
  if (!raw) throw new ActionError("missing_url", "Pass an absolute http or https URL.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ActionError("invalid_url", `"${raw}" is not an absolute URL.`, "Include the scheme, for example https://example.com.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ActionError("unsupported_scheme", `Only http and https URLs can be opened, got ${url.protocol}`);
  }

  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  const loaded = waitForTabComplete(tabId, 45_000);
  await chrome.tabs.update(tabId, { url: url.href });
  await loaded;

  const fresh = await chrome.tabs.get(tabId);
  await ensureContent(fresh);
  return { tabId, url: fresh.url, title: fresh.title, status: fresh.status };
}

async function goBack(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");
  const loaded = waitForTabComplete(tabId, 45_000);
  await chrome.tabs.goBack(tabId);
  await loaded.catch(() => undefined);
  const fresh = await chrome.tabs.get(tabId);
  await ensureContent(fresh);
  return { tabId, url: fresh.url, title: fresh.title };
}

function waitForTabComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new ActionError("navigation_timeout", `The tab did not finish loading within ${timeoutMs / 1000}s.`)),
      timeoutMs,
    );
    const onUpdated = (id: number, info: { status?: string; url?: string }): void => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function tabsCommand(params: Record<string, unknown>): Promise<unknown> {
  const action = params["action"];
  if (action === "list") {
    const tabs = await chrome.tabs.query({});
    return {
      tabs: tabs
        .filter((tab) => tab.id !== undefined)
        .slice(0, 80)
        .map((tab) => ({
          tabId: tab.id,
          title: tab.title,
          url: tab.url,
          active: tab.active,
          windowId: tab.windowId,
        })),
    };
  }

  if (action === "new") {
    const url = typeof params["url"] === "string" ? params["url"] : "about:blank";
    const created = await chrome.tabs.create({ url, active: true });
    if (created.id !== undefined && url !== "about:blank") {
      await waitForTabComplete(created.id, 45_000).catch(() => undefined);
    }
    return { tabId: created.id, url: created.url, title: created.title };
  }

  if (action === "close" || action === "activate") {
    if (typeof params["tabId"] !== "number") {
      throw new ActionError("missing_tab_id", `Pass tabId when using "${action}".`, "Call browser_tabs with action=list to find the id.");
    }
    const tab = await requireTab(params);
    const tabId = tab.id;
    if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

    if (action === "close") {
      await chrome.tabs.remove(tabId);
      return { closed: tabId };
    }

    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { activated: tabId };
  }

  throw new ActionError("bad_action", `Unknown tabs action "${String(action)}".`, "Use list, new, close, or activate.");
}

async function click(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const result = (await contentRpc(tab, "click", params)) as {
    trusted?: boolean;
    x?: number;
    y?: number;
    button?: string;
    clickCount?: number;
    element?: string;
  };

  if (!result?.trusted) return result;

  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");
  const x = result.x ?? 0;
  const y = result.y ?? 0;
  const button = result.button ?? "left";
  const clickCount = result.clickCount ?? 1;

  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount });

  return { clicked: result.element, trusted: true, at: { x, y } };
}

async function screenshot(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  const hasTarget = typeof params["ref"] === "string" || typeof params["selector"] === "string";
  let clip: Clip | undefined;
  let note: string | undefined;

  if (hasTarget) {
    const rect = (await contentRpc(tab, "element_rect", params)) as {
      x: number;
      y: number;
      width: number;
      height: number;
      scrollX: number;
      scrollY: number;
    };
    if (!rect || rect.width < 1 || rect.height < 1) {
      throw new ActionError("element_not_visible", "The element has no visible box to capture.");
    }
    clip = {
      x: Math.round(rect.x + rect.scrollX),
      y: Math.round(rect.y + rect.scrollY),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
      scale: 1,
    };
  } else if (params["fullPage"] === true) {
    const metrics = (await cdp(tabId, "Page.getLayoutMetrics")) as {
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize ?? metrics.contentSize;
    if (!size) throw new ActionError("layout_metrics_failed", "Chrome did not return the page size.");
    const maxHeight = 12_000;
    const height = Math.min(size.height, maxHeight);
    const scale = size.height > maxHeight ? maxHeight / size.height : 1;
    if (scale < 1) note = "Page is taller than 12000px, the capture was scaled down.";
    clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(height), scale };
  }

  const capture = (await cdp(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {}),
  })) as { data?: string };

  if (!capture?.data) throw new ActionError("screenshot_failed", "Chrome returned no image data.");

  return {
    data: capture.data,
    mimeType: "image/png",
    width: clip?.width,
    height: clip?.height,
    note,
  };
}

async function consoleMessages(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  if (!attachedTabs.has(tabId)) {
    await attach(tabId);
    return {
      entries: [],
      note: "Console capture started now. Reload or interact with the page, then call again.",
    };
  }

  const level = typeof params["level"] === "string" ? params["level"] : "all";
  const limit = typeof params["limit"] === "number" ? params["limit"] : 30;
  let entries = consoleBuffers.get(tabId) ?? [];
  if (level !== "all") entries = entries.filter((entry) => normalizeLevel(entry.level) === level);

  return { entries: entries.slice(-limit), total: entries.length };
}

async function networkRequests(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  if (!attachedTabs.has(tabId)) {
    await attach(tabId);
    return {
      entries: [],
      note: "Network capture started now. Reload the page, then call again to see requests.",
    };
  }

  const limit = typeof params["limit"] === "number" ? params["limit"] : 30;
  const urlContains = typeof params["urlContains"] === "string" ? params["urlContains"] : undefined;
  const method = typeof params["method"] === "string" ? params["method"].toUpperCase() : undefined;

  let entries = networkBuffers.get(tabId) ?? [];
  if (urlContains) entries = entries.filter((entry) => entry.url.includes(urlContains));
  if (method) entries = entries.filter((entry) => entry.method.toUpperCase() === method);

  return { entries: entries.slice(-limit), total: entries.length };
}

async function handleDialog(params: Record<string, unknown>): Promise<unknown> {
  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  const pending = pendingDialogs.get(tabId);
  await cdp(tabId, "Page.handleJavaScriptDialog", {
    accept: params["accept"] === true,
    ...(typeof params["promptText"] === "string" ? { promptText: params["promptText"] } : {}),
  });
  pendingDialogs.delete(tabId);

  return { handled: true, type: pending?.type ?? "unknown", message: pending?.message };
}

async function evaluate(params: Record<string, unknown>): Promise<unknown> {
  if (!allowEval) {
    throw new ActionError(
      "eval_disabled",
      "JavaScript evaluation is disabled.",
      "Start the MCP server with MCP_BROWSER_ALLOW_EVAL=1 to enable it.",
    );
  }
  const expression = typeof params["expression"] === "string" ? params["expression"] : "";
  if (!expression) throw new ActionError("missing_expression", "Pass a JavaScript expression.");

  const tab = await requireTab(params);
  const tabId = tab.id;
  if (tabId === undefined) throw new ActionError("tab_not_found", "The tab has no id.");

  const result = (await cdp(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    includeCommandLineAPI: true,
  })) as {
    result?: { value?: unknown; type?: string; description?: string };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };

  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed";
    throw new ActionError("eval_failed", detail);
  }

  return { value: result.result?.value ?? null, type: result.result?.type ?? "undefined" };
}

async function extensionStatus(): Promise<unknown> {
  const target = await currentTargetTab();
  return {
    extensionVersion: EXTENSION_VERSION,
    bridge: { state: status.state, detail: status.detail, updatedAt: status.updatedAt },
    activeTab: target
      ? { tabId: target.id, title: target.title, url: target.url, windowId: target.windowId }
      : null,
    pinnedTabId: settings.pinnedTabId,
    debuggerAttachedTabs: [...attachedTabs.keys()],
    pendingDialogs: [...pendingDialogs.entries()].map(([tabId, dialog]) => ({ tabId, ...dialog })),
    allowEval,
    settings: { port: settings.port, enabled: settings.enabled, allowlist: settings.allowlist },
  };
}

function normalizeLevel(level: string): string {
  const lower = level.toLowerCase();
  if (lower === "warn") return "warning";
  if (level === "verbose") return "debug";
  return lower;
}

function pushConsole(tabId: number, entry: ConsoleEntry): void {
  const buffer = consoleBuffers.get(tabId) ?? [];
  buffer.push(entry);
  if (buffer.length > 300) buffer.splice(0, buffer.length - 300);
  consoleBuffers.set(tabId, buffer);
}

function pushNetwork(tabId: number, entry: NetworkEntry): void {
  const buffer = networkBuffers.get(tabId) ?? [];
  buffer.push(entry);
  if (buffer.length > 300) buffer.splice(0, buffer.length - 300);
  networkBuffers.set(tabId, buffer);
}

async function attach(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) {
    touch(tabId);
    return;
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActionError(
      "cdp_unavailable",
      `Could not attach the Chrome debugger: ${message}`,
      "Close DevTools for that tab and try again. Enterprise policy can also block the debugger.",
    );
  }

  for (const method of ["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]) {
    try {
      await chrome.debugger.sendCommand({ tabId }, method);
    } catch {
      // Some domains are unavailable on restricted pages, the rest still work.
    }
  }

  attachedTabs.set(tabId, {});
  touch(tabId);
}

function touch(tabId: number): void {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  if (entry.idle) clearTimeout(entry.idle);
  entry.idle = setTimeout(() => {
    void detach(tabId);
  }, CDP_IDLE_DETACH_MS);
}

async function detach(tabId: number): Promise<void> {
  const entry = attachedTabs.get(tabId);
  if (entry?.idle) clearTimeout(entry.idle);
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already detached or the tab is gone.
  }
}

async function cdp(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
  await attach(tabId);
  touch(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ActionError("cdp_failed", `Chrome debugger command ${method} failed: ${message}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source.tabId;
  if (tabId === undefined || tabId < 0) return;
  touch(tabId);

  switch (method) {
    case "Runtime.consoleAPICalled": {
      const event = params as {
        type?: string;
        args?: Array<{ value?: unknown; description?: string }>;
      };
      const text = (event.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? ""))
        .join(" ")
        .slice(0, 2000);
      pushConsole(tabId, { level: normalizeLevel(event.type ?? "log"), text, at: new Date().toISOString() });
      break;
    }
    case "Log.entryAdded": {
      const event = params as { entry?: { level?: string; text?: string } };
      pushConsole(tabId, {
        level: normalizeLevel(event.entry?.level ?? "info"),
        text: (event.entry?.text ?? "").slice(0, 2000),
        at: new Date().toISOString(),
      });
      break;
    }
    case "Runtime.exceptionThrown": {
      const event = params as {
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      pushConsole(tabId, {
        level: "error",
        text: (event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text ?? "Uncaught exception").slice(0, 2000),
        at: new Date().toISOString(),
      });
      break;
    }
    case "Network.requestWillBeSent": {
      const event = params as {
        requestId?: string;
        request?: { url?: string; method?: string };
        type?: string;
      };
      if (!event.requestId) break;
      pushNetwork(tabId, {
        requestId: event.requestId,
        url: (event.request?.url ?? "").slice(0, 1000),
        method: event.request?.method ?? "GET",
        status: null,
        type: event.type ?? "Other",
        at: new Date().toISOString(),
        failed: null,
      });
      break;
    }
    case "Network.responseReceived": {
      const event = params as { requestId?: string; response?: { status?: number } };
      const buffer = networkBuffers.get(tabId) ?? [];
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const entry = buffer[index];
        if (entry && entry.requestId === event.requestId) {
          entry.status = event.response?.status ?? null;
          break;
        }
      }
      break;
    }
    case "Network.loadingFailed": {
      const event = params as { requestId?: string; errorText?: string };
      const buffer = networkBuffers.get(tabId) ?? [];
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        const entry = buffer[index];
        if (entry && entry.requestId === event.requestId) {
          entry.failed = event.errorText ?? "failed";
          break;
        }
      }
      break;
    }
    case "Page.javascriptDialogOpening": {
      const event = params as { type?: string; message?: string; defaultPrompt?: string };
      pendingDialogs.set(tabId, {
        type: event.type ?? "alert",
        message: event.message ?? "",
        defaultPrompt: event.defaultPrompt ?? "",
      });
      break;
    }
    case "Page.javascriptDialogClosed": {
      pendingDialogs.delete(tabId);
      break;
    }
    default:
      break;
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const entry = attachedTabs.get(tabId);
  if (entry?.idle) clearTimeout(entry.idle);
  attachedTabs.delete(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = attachedTabs.get(tabId);
  if (entry?.idle) clearTimeout(entry.idle);
  attachedTabs.delete(tabId);
  consoleBuffers.delete(tabId);
  networkBuffers.delete(tabId);
  pendingDialogs.delete(tabId);
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return undefined;
  const type = (message as { type?: string } | null)?.type;

  if (type === "popup:status") {
    void (async () => {
      const target = await currentTargetTab();
      const allTabs = await chrome.tabs.query({});
      const tabs = allTabs
        .filter((tab) => tab.id !== undefined && /^https?:/i.test(tab.url ?? ""))
        .slice(0, 15)
        .map((tab) => ({
          tabId: tab.id,
          title: tab.title ?? tab.url ?? "Untitled",
          url: tab.url ?? "",
          active: tab.active,
        }));

      sendResponse({
        status,
        activity,
        allowEval,
        settings: {
          port: settings.port,
          enabled: settings.enabled,
          allowlist: settings.allowlist,
          hasToken: Boolean(settings.token),
          pinnedTabId: settings.pinnedTabId,
        },
        bridgeUrl: `ws://127.0.0.1:${settings.port}`,
        tokenLength: settings.token.length,
        tabs,
        activeTab: target ? { tabId: target.id, title: target.title, url: target.url } : null,
        version: EXTENSION_VERSION,
      });
    })();
    return true;
  }

  if (type === "popup:reconnect") {
    requestReconnect("manual");
    sendResponse({ ok: true });
    return true;
  }

  if (type === "popup:save") {
    const patch = (message as { patch?: Partial<Settings> }).patch ?? {};
    void (async () => {
      const before = settings;
      settings = await saveSettings(patch);
      const needsReconnect =
        before.token !== settings.token || before.port !== settings.port || before.enabled !== settings.enabled;
      if (needsReconnect) requestReconnect("settings saved");
      sendResponse({ ok: true, settings: { port: settings.port, enabled: settings.enabled } });
    })();
    return true;
  }

  return undefined;
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== "local") return;
  void (async () => {
    const current = await getSettings();
    const reconnectNeeded = current.token !== settings.token || current.port !== settings.port || current.enabled !== settings.enabled;
    settings = current;
    if (reconnectNeeded) requestReconnect("settings changed");
  })();
});

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });

chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== "keepalive") return;
  if (!socket || socket.readyState === WebSocket.CLOSED) {
    void connect("alarm");
  } else if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ kind: "ping" }));
  }
});

chrome.runtime.onStartup.addListener(() => {
  void connect("browser startup");
});

chrome.runtime.onInstalled.addListener(() => {
  void connect("extension installed");
});

void connect("service worker start");

