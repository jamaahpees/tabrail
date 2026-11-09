interface ActivityEntry {
  at: string;
  method: string;
  ok: boolean;
  summary: string;
}

interface StatusPayload {
  status: { state: string; detail?: string; updatedAt: string };
  activity: ActivityEntry[];
  allowEval: boolean;
  settings: { port: number; enabled: boolean; allowlist: string[]; hasToken: boolean };
  activeTab: { tabId?: number; title?: string; url?: string } | null;
  version: string;
}

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
const statusDetail = byId<HTMLParagraphElement>("status-detail");
const tokenInput = byId<HTMLInputElement>("token");
const enabledInput = byId<HTMLInputElement>("enabled");
const saveButton = byId<HTMLButtonElement>("save");
const reconnectButton = byId<HTMLButtonElement>("reconnect");
const feedback = byId<HTMLParagraphElement>("save-feedback");
const tabName = byId<HTMLParagraphElement>("tab-name");
const tabUrl = byId<HTMLParagraphElement>("tab-url");
const activityList = byId<HTMLUListElement>("activity");
const versionLabel = byId<HTMLSpanElement>("version");
const optionsLink = byId<HTMLAnchorElement>("options-link");

let editingToken = false;

function setFeedback(message: string): void {
  if (feedback) feedback.textContent = message;
}

function renderActivity(entries: ActivityEntry[]): void {
  if (!activityList) return;
  activityList.replaceChildren();

  if (entries.length === 0) {
    const item = document.createElement("li");
    item.className = "empty";
    item.textContent = "No calls yet.";
    activityList.append(item);
    return;
  }

  for (const entry of entries.slice(0, 6)) {
    const item = document.createElement("li");
    item.className = entry.ok ? "ok" : "failed";

    const time = document.createElement("time");
    time.dateTime = entry.at;
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour12: false });

    const method = document.createElement("span");
    method.className = "method";
    method.textContent = entry.method;

    const outcome = document.createElement("span");
    outcome.className = "outcome";
    outcome.textContent = entry.ok ? entry.summary : `failed, ${entry.summary}`;

    item.append(time, method, outcome);
    activityList.append(item);
  }
}

function render(payload: StatusPayload): void {
  const state = payload.status.state;
  if (pill) pill.dataset["state"] = state;
  if (statusText) statusText.textContent = statusLabels[state] ?? state;
  if (statusDetail) {
    statusDetail.textContent =
      payload.status.detail ??
      (state === "connected"
        ? `Bridge port ${payload.settings.port}. The agent can control the active tab.`
        : "Start an MCP client, it launches the bridge automatically.");
  }

  if (enabledInput && document.activeElement !== enabledInput) {
    enabledInput.checked = payload.settings.enabled;
  }

  if (tokenInput && !editingToken) {
    tokenInput.placeholder = payload.settings.hasToken ? "Token saved. Paste a new one to replace it." : "Paste the token from the server";
  }

  if (tabName) tabName.textContent = payload.activeTab?.title ?? "No active tab";
  if (tabUrl) tabUrl.textContent = payload.activeTab?.url ?? "Focus a normal web page to let the agent read it.";
  if (versionLabel) versionLabel.textContent = `v${payload.version}`;

  renderActivity(payload.activity);
}

async function refresh(): Promise<void> {
  try {
    const payload = (await chrome.runtime.sendMessage({ type: "popup:status" })) as StatusPayload | undefined;
    if (payload) render(payload);
  } catch {
    if (statusText) statusText.textContent = "Unavailable";
    if (pill) pill.dataset["state"] = "error";
    if (statusDetail) statusDetail.textContent = "The background worker did not answer. Reload the extension.";
  }
}

saveButton?.addEventListener("click", () => {
  const value = tokenInput?.value.trim() ?? "";
  if (!value) {
    setFeedback("Paste a token first.");
    tokenInput?.focus();
    return;
  }
  setFeedback("Saving...");
  void chrome.runtime
    .sendMessage({ type: "popup:save", patch: { token: value } })
    .then(() => {
      setFeedback("Token saved. Reconnecting.");
      editingToken = false;
      if (tokenInput) {
        tokenInput.value = "";
        tokenInput.blur();
      }
      return refresh();
    })
    .catch(() => setFeedback("Could not save the token."));
});

tokenInput?.addEventListener("input", () => {
  editingToken = tokenInput.value.length > 0;
});

reconnectButton?.addEventListener("click", () => {
  setFeedback("Reconnecting...");
  if (reconnectButton) reconnectButton.disabled = true;
  void chrome.runtime
    .sendMessage({ type: "popup:reconnect" })
    .then(() => {
      setFeedback("Reconnect requested.");
      return refresh();
    })
    .catch(() => setFeedback("Reconnect failed."))
    .finally(() => {
      if (reconnectButton) reconnectButton.disabled = false;
    });
});

enabledInput?.addEventListener("change", () => {
  const enabled = enabledInput.checked;
  setFeedback(enabled ? "Control enabled." : "Control paused.");
  void chrome.runtime.sendMessage({ type: "popup:save", patch: { enabled } }).then(() => refresh());
});

optionsLink?.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.runtime.openOptionsPage();
});

void refresh();
setInterval(() => void refresh(), 2000);
