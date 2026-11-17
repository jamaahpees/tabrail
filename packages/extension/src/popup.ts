interface ActivityEntry {
  at: string;
  method: string;
  ok: boolean;
  summary: string;
}

interface TabOption {
  tabId?: number;
  title: string;
  url: string;
  active: boolean;
}

interface StatusPayload {
  status: { state: string; detail?: string; updatedAt: string };
  activity: ActivityEntry[];
  allowEval: boolean;
  settings: { port: number; enabled: boolean; allowlist: string[]; hasToken: boolean; pinnedTabId: number | null };
  instance: { id: string; label: string };
  role: { active: boolean; activeLabel: string | null };
  bridgeUrl: string;
  tokenLength: number;
  tabs: TabOption[];
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
const bridgeMeta = byId<HTMLParagraphElement>("bridge-meta");
const tokenInput = byId<HTMLInputElement>("token");
const enabledInput = byId<HTMLInputElement>("enabled");
const saveButton = byId<HTMLButtonElement>("save");
const reconnectButton = byId<HTMLButtonElement>("reconnect");
const feedback = byId<HTMLParagraphElement>("save-feedback");
const tabName = byId<HTMLParagraphElement>("tab-name");
const tabUrl = byId<HTMLParagraphElement>("tab-url");
const targetTabs = byId<HTMLUListElement>("target-tabs");
const refreshTabsButton = byId<HTMLButtonElement>("refresh-tabs");
const browserRolePill = byId<HTMLSpanElement>("browser-role");
const browserRoleText = byId<HTMLSpanElement>("browser-role-text");
const browserDetail = byId<HTMLParagraphElement>("browser-detail");
const takeoverButton = byId<HTMLButtonElement>("takeover");
const activityList = byId<HTMLUListElement>("activity");
const versionLabel = byId<HTMLSpanElement>("version");
const optionsLink = byId<HTMLAnchorElement>("options-link");
const cookiesLink = byId<HTMLAnchorElement>("cookies-link");

const pickAreaButton = byId<HTMLButtonElement>("pick-area");
const pickCaptureInput = byId<HTMLInputElement>("pick-capture");
const pickResult = byId<HTMLDivElement>("pick-result");
const pickCoords = byId<HTMLParagraphElement>("pick-coords");
const pickMeta = byId<HTMLParagraphElement>("pick-meta");
const pickPreviewWrap = byId<HTMLDivElement>("pick-preview-wrap");
const pickPreview = byId<HTMLImageElement>("pick-preview");
const copyJsonButton = byId<HTMLButtonElement>("copy-json");
const copyCoordsButton = byId<HTMLButtonElement>("copy-coords");
const clearPickButton = byId<HTMLButtonElement>("clear-pick");
const pickFeedback = byId<HTMLParagraphElement>("pick-feedback");

interface StoredPickedRegion {
  cancelled?: boolean;
  viewport?: { x: number; y: number; width: number; height: number };
  page?: { x: number; y: number; width: number; height: number };
  scroll?: { x: number; y: number };
  viewportSize?: { width: number; height: number };
  devicePixelRatio?: number;
  element?: string | null;
  at?: string;
  screenshot?: { data?: string; mimeType?: string; width?: number; height?: number };
}

let currentPickedRegion: StoredPickedRegion | null = null;
let editingToken = false;
let targetSignature = "";
let latestPayload: StatusPayload | null = null;

function tokenProblem(value: string): string | null {
  const token = value.trim();
  if (!token) return "Paste the bridge token first.";
  if (token.length > 200 || /\s/.test(token) || /[{}\[\]"]/.test(token)) {
    return "That looks like a cookie export or JSON. Use the short bridge token from the server, not a site session.";
  }
  if (token.length < 8) return "That token is too short. Copy the whole token file.";
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function buildTargetRow(tabId: number | null, title: string, host: string, selected: boolean): HTMLLIElement {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tab-row";
  button.dataset["tabId"] = tabId === null ? "auto" : String(tabId);
  button.setAttribute("aria-pressed", selected ? "true" : "false");

  const label = document.createElement("span");
  label.className = "tab-label";
  const strong = document.createElement("span");
  strong.className = "tab-title";
  strong.textContent = title;
  const small = document.createElement("span");
  small.className = "tab-host";
  small.textContent = host;
  label.append(strong, small);

  const mark = document.createElement("span");
  mark.className = "tab-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = selected ? "Selected" : "";

  button.append(label, mark);
  item.append(button);
  return item;
}

function renderTargetTabs(payload: StatusPayload): void {
  if (!targetTabs) return;
  const pinned = payload.settings.pinnedTabId;
  const signature = `${pinned ?? "auto"}|${(payload.tabs ?? [])
    .map((tab) => `${tab.tabId}:${tab.title}`)
    .join("|")}`;
  if (signature === targetSignature) return;
  targetSignature = signature;

  targetTabs.replaceChildren();
  targetTabs.append(
    buildTargetRow(null, "Follow active tab", "Uses the tab you are focused on", pinned === null),
  );

  for (const tab of payload.tabs ?? []) {
    if (typeof tab.tabId !== "number") continue;
    targetTabs.append(buildTargetRow(tab.tabId, tab.title, hostOf(tab.url), pinned === tab.tabId));
  }
}

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

function renderRole(payload: StatusPayload): void {
  const role = payload.role ?? { active: false, activeLabel: null };
  const standby = !role.active && Boolean(role.activeLabel);

  if (browserRolePill) {
    browserRolePill.dataset["state"] = role.active ? "connected" : standby ? "connecting" : "disconnected";
  }
  if (browserRoleText) {
    browserRoleText.textContent = role.active ? "In use" : standby ? "Standby" : "Waiting";
  }
  if (browserDetail) {
    browserDetail.textContent = role.active
      ? "MCP routes browser calls to this Chrome."
      : standby
        ? `Another Chrome is in use: ${role.activeLabel}.`
        : "No active Chrome yet. Keep this popup open while the bridge starts.";
  }
  if (takeoverButton) {
    takeoverButton.hidden = !standby;
  }
}

function render(payload: StatusPayload): void {
  latestPayload = payload;
  const state = payload.status.state;
  if (pill) pill.dataset["state"] = state;
  if (statusText) statusText.textContent = statusLabels[state] ?? state;
  if (statusDetail) {
    statusDetail.textContent =
      payload.status.detail ??
      (state === "connected"
        ? `Bridge port ${payload.settings.port}. The agent can control the selected tab.`
        : "Start an MCP client, it launches the bridge automatically.");
  }

  if (bridgeMeta) {
    const tokenInfo = payload.tokenLength > 0 ? `token ${payload.tokenLength} chars` : "no token saved";
    bridgeMeta.textContent = `${payload.bridgeUrl} · ${tokenInfo}`;
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

  renderTargetTabs(payload);
  renderRole(payload);
  renderActivity(payload.activity);
  void refreshPickedRegion();
}

async function refreshPickedRegion(): Promise<void> {
  try {
    const stored = (await chrome.storage.local.get("lastPickedRegion")) as { lastPickedRegion?: StoredPickedRegion };
    const region = stored.lastPickedRegion;
    currentPickedRegion = region ?? null;

    if (!pickResult) return;
    if (!region || region.cancelled || !region.viewport) {
      pickResult.hidden = true;
      return;
    }

    pickResult.hidden = false;
    if (pickCoords) {
      pickCoords.textContent = `${region.viewport.x}, ${region.viewport.y} (${region.viewport.width}×${region.viewport.height})`;
    }
    if (pickMeta) {
      const parts = [
        `page: ${region.page?.x ?? region.viewport.x},${region.page?.y ?? region.viewport.y}`,
        `scroll: ${region.scroll?.x ?? 0},${region.scroll?.y ?? 0}`,
        region.devicePixelRatio ? `DPR ${region.devicePixelRatio}` : null,
        region.element ? region.element : null,
      ].filter(Boolean);
      pickMeta.textContent = parts.join(" · ");
    }

    if (pickPreviewWrap && pickPreview) {
      if (region.screenshot?.data) {
        pickPreview.src = `data:${region.screenshot.mimeType ?? "image/png"};base64,${region.screenshot.data}`;
        pickPreviewWrap.style.display = "block";
      } else {
        pickPreviewWrap.style.display = "none";
      }
    }
  } catch {
    // Ignore storage lookup error in popup
  }
}

function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  const el = document.createElement("textarea");
  el.value = text;
  document.body.append(el);
  el.select();
  const ok = document.execCommand("copy");
  el.remove();
  return Promise.resolve(ok);
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
  const problem = tokenProblem(value);
  if (problem) {
    setFeedback(problem);
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

cookiesLink?.addEventListener("click", (event) => {
  event.preventDefault();
  const raw = latestPayload?.activeTab?.url ?? "";
  let query = "";
  try {
    const host = new URL(raw).hostname;
    if (host) query = `?domain=${encodeURIComponent(host)}&autoread=1`;
  } catch {
    // No normal site in focus, open the page without a preset domain.
  }
  void chrome.tabs.create({ url: chrome.runtime.getURL(`cookies.html${query}`) });
});

targetTabs?.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-tab-id]");
  if (!button) return;
  const raw = button.dataset["tabId"] ?? "auto";
  const pinnedTabId = raw === "auto" ? null : Number(raw);
  if (pinnedTabId !== null && !Number.isSafeInteger(pinnedTabId)) return;
  targetSignature = "";
  setFeedback(pinnedTabId === null ? "Following the active tab." : "Target tab pinned.");
  void chrome.runtime
    .sendMessage({ type: "popup:save", patch: { pinnedTabId } })
    .then(() => refresh())
    .catch(() => setFeedback("Could not change the target tab."));
});

refreshTabsButton?.addEventListener("click", () => {
  targetSignature = "";
  void refresh();
});

takeoverButton?.addEventListener("click", () => {
  setFeedback("Switching MCP to this browser...");
  void chrome.runtime
    .sendMessage({ type: "popup:takeover" })
    .then(() => refresh())
    .catch(() => setFeedback("Could not switch browser."));
});

pickAreaButton?.addEventListener("click", () => {
  const capture = pickCaptureInput?.checked === true;
  if (pickFeedback) pickFeedback.textContent = "Activating crosshair on tab...";
  void chrome.runtime.sendMessage({ type: "popup:pick_area", capture });
  setTimeout(() => window.close(), 180);
});

copyJsonButton?.addEventListener("click", () => {
  if (!currentPickedRegion) return;
  void copyText(JSON.stringify(currentPickedRegion, null, 2)).then((ok) => {
    if (pickFeedback) pickFeedback.textContent = ok ? "JSON copied to clipboard." : "Failed to copy.";
    setTimeout(() => {
      if (pickFeedback) pickFeedback.textContent = "";
    }, 2000);
  });
});

copyCoordsButton?.addEventListener("click", () => {
  if (!currentPickedRegion?.viewport) return;
  const vp = currentPickedRegion.viewport;
  const text = `${vp.x},${vp.y} ${vp.width}x${vp.height}`;
  void copyText(text).then((ok) => {
    if (pickFeedback) pickFeedback.textContent = ok ? `Copied "${text}"` : "Failed to copy.";
    setTimeout(() => {
      if (pickFeedback) pickFeedback.textContent = "";
    }, 2000);
  });
});

clearPickButton?.addEventListener("click", () => {
  void chrome.runtime.sendMessage({ type: "popup:clear_picked" }).then(() => {
    currentPickedRegion = null;
    if (pickResult) pickResult.hidden = true;
    if (pickFeedback) pickFeedback.textContent = "Cleared.";
    setTimeout(() => {
      if (pickFeedback) pickFeedback.textContent = "";
    }, 1500);
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["lastPickedRegion"]) {
    void refreshPickedRegion();
  }
});

void refresh();
setInterval(() => void refresh(), 2000);
