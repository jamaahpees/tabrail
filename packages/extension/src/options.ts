import { saveSettings, getSettings } from "./settings.js";

const statusLabels: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting",
  disconnected: "Waiting",
  error: "Needs attention",
  disabled: "Paused",
};

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const pill = byId<HTMLSpanElement>("status-pill");
const statusText = byId<HTMLSpanElement>("status-text");
const portInput = byId<HTMLInputElement>("port");
const tokenInput = byId<HTMLInputElement>("token");
const revealButton = byId<HTMLButtonElement>("reveal");
const enabledInput = byId<HTMLInputElement>("enabled");
const allowlistInput = byId<HTMLTextAreaElement>("allowlist");
const saveButton = byId<HTMLButtonElement>("save");
const testButton = byId<HTMLButtonElement>("test");
const feedback = byId<HTMLSpanElement>("feedback");
const snippet = byId<HTMLPreElement>("snippet");

function setFeedback(message: string, bad = false): void {
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.color = bad ? "var(--bad)" : "var(--muted)";
}

function setStatus(state: string, text: string): void {
  if (pill) pill.dataset["state"] = state;
  if (statusText) statusText.textContent = text;
}

function renderSnippet(): void {
  if (!snippet) return;
  snippet.textContent = [
    "{",
    '  "mcp": {',
    '    "servers": {',
    '      "chrome": {',
    '        "type": "local",',
    '        "command": ["node", "<path-to-repo>/packages/server/dist/index.js"]',
    "      }",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

async function refreshStatus(): Promise<void> {
  try {
    const payload = (await chrome.runtime.sendMessage({ type: "popup:status" })) as
      | { status: { state: string } }
      | undefined;
    const state = payload?.status.state ?? "disconnected";
    setStatus(state, statusLabels[state] ?? state);
  } catch {
    setStatus("error", "Unavailable");
  }
}

async function load(): Promise<void> {
  const settings = await getSettings();
  if (portInput) portInput.value = String(settings.port);
  if (tokenInput) tokenInput.value = settings.token;
  if (enabledInput) enabledInput.checked = settings.enabled;
  if (allowlistInput) allowlistInput.value = settings.allowlist.join("\n");
  renderSnippet();
  await refreshStatus();
}

saveButton?.addEventListener("click", () => {
  const port = Number(portInput?.value ?? "");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    setFeedback("Port must be a whole number between 1 and 65535.", true);
    portInput?.focus();
    return;
  }

  const token = tokenInput?.value.trim() ?? "";
  if (!token) {
    setFeedback("The token cannot be empty.", true);
    tokenInput?.focus();
    return;
  }

  const allowlist = (allowlistInput?.value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  setFeedback("Saving...");
  void saveSettings({ port, token, enabled: enabledInput?.checked !== false, allowlist })
    .then(async () => {
      setStatus("connecting", "Reconnecting");
      setFeedback("Saved. Reconnecting to the bridge.");
      await chrome.runtime.sendMessage({ type: "popup:reconnect" });
    })
    .catch(() => setFeedback("Could not save the settings.", true));
});

revealButton?.addEventListener("click", () => {
  if (!tokenInput) return;
  const hidden = tokenInput.type === "password";
  tokenInput.type = hidden ? "text" : "password";
  revealButton.textContent = hidden ? "Hide" : "Show";
});

testButton?.addEventListener("click", () => {
  setFeedback("Testing the bridge...");
  if (testButton) testButton.disabled = true;

  void (async () => {
    try {
      await chrome.runtime.sendMessage({ type: "popup:reconnect" });
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const payload = (await chrome.runtime.sendMessage({ type: "popup:status" })) as
          | { status: { state: string; detail?: string } }
          | undefined;
        const state = payload?.status.state ?? "disconnected";
        if (state === "connected") {
          setStatus(state, statusLabels[state] ?? state);
          setFeedback("Bridge connected. The agent can reach this browser.");
          return;
        }
        setStatus(state, statusLabels[state] ?? state);
        if (payload?.status.detail) setFeedback(payload.status.detail, state === "error");
      }
      setFeedback("The bridge did not answer. Start the MCP server, then test again.", true);
    } finally {
      if (testButton) testButton.disabled = false;
    }
  })();
});

void load();
setInterval(() => void refreshStatus(), 3000);
