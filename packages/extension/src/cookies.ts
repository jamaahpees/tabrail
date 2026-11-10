import { getSettings, saveSettings } from "./settings.js";

interface CookieEntry {
  domain: string;
  hostOnly: boolean;
  httpOnly: boolean;
  name: string;
  path: string;
  sameSite: string;
  secure: boolean;
  session: boolean;
  storeId: string | null;
  value: string;
  expirationDate?: number;
}

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

const enabledInput = byId<HTMLInputElement>("enabled");
const pill = byId<HTMLSpanElement>("status-pill");
const statusText = byId<HTMLSpanElement>("status-text");
const domainInput = byId<HTMLInputElement>("domain");
const useTabButton = byId<HTMLButtonElement>("use-tab");
const readButton = byId<HTMLButtonElement>("read");
const copyButton = byId<HTMLButtonElement>("copy");
const downloadButton = byId<HTMLButtonElement>("download");
const showValuesInput = byId<HTMLInputElement>("show-values");
const summary = byId<HTMLParagraphElement>("summary");
const list = byId<HTMLTableSectionElement>("cookie-list");
const importInput = byId<HTMLTextAreaElement>("import-json");
const importButton = byId<HTMLButtonElement>("import");
const clearButton = byId<HTMLButtonElement>("clear");
const feedback = byId<HTMLParagraphElement>("feedback");

let enabled = false;
let showValues = false;
let cookies: chrome.cookies.Cookie[] = [];
let deleteArmed = false;
let deleteTimer: ReturnType<typeof setTimeout> | undefined;

function setFeedback(message: string, bad = false): void {
  if (!feedback) return;
  feedback.textContent = message;
  feedback.style.color = bad ? "var(--bad)" : "var(--muted)";
}

function setStatus(): void {
  if (pill) pill.dataset["state"] = enabled ? "connected" : "disabled";
  if (statusText) statusText.textContent = enabled ? "Cookie tools on" : "Cookie tools off";
}

function controls(): HTMLButtonElement[] {
  return [useTabButton, readButton, copyButton, downloadButton, importButton, clearButton].filter(
    (button): button is HTMLButtonElement => button !== null,
  );
}

function applyEnabled(): void {
  setStatus();
  for (const button of controls()) button.disabled = !enabled;
  if (domainInput) domainInput.disabled = !enabled;
  if (importInput) importInput.disabled = !enabled;
  if (showValuesInput) showValuesInput.disabled = !enabled;
  if (!enabled) {
    cookies = [];
    render();
    if (summary) summary.textContent = "Cookie tools are off.";
  }
}

function normalizeDomain(raw: string): string {
  let value = raw.trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith(".")) value = value.slice(1);
  if (!value.includes("://")) value = `https://${value}`;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function buildUrl(domain: string, path: string, secure: boolean): string {
  const host = domain.replace(/^\./, "");
  const suffix = path && path.startsWith("/") ? path : "/";
  return `${secure ? "https" : "http"}://${host}${suffix}`;
}

function toEntry(cookie: chrome.cookies.Cookie): CookieEntry {
  return {
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    httpOnly: cookie.httpOnly,
    name: cookie.name,
    path: cookie.path,
    sameSite: cookie.sameSite,
    secure: cookie.secure,
    session: cookie.session,
    storeId: cookie.storeId ?? null,
    value: cookie.value,
    ...(typeof cookie.expirationDate === "number" ? { expirationDate: cookie.expirationDate } : {}),
  };
}

function flagsOf(cookie: chrome.cookies.Cookie): string {
  const flags: string[] = [];
  if (cookie.secure) flags.push("secure");
  if (cookie.httpOnly) flags.push("httpOnly");
  if (cookie.hostOnly) flags.push("hostOnly");
  if (cookie.session) flags.push("session");
  flags.push(cookie.sameSite);
  return flags.join(", ");
}

function render(): void {
  if (!list) return;
  list.replaceChildren();

  if (cookies.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "empty";
    cell.textContent = enabled ? "No cookies loaded. Read a domain first." : "Enable the tools, then read cookies.";
    row.append(cell);
    list.append(row);
    return;
  }

  for (const cookie of cookies) {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "cookie-name";
    name.textContent = cookie.name;

    const domain = document.createElement("td");
    domain.className = "cookie-mono";
    domain.textContent = cookie.domain;

    const path = document.createElement("td");
    path.className = "cookie-mono";
    path.textContent = cookie.path;

    const flags = document.createElement("td");
    flags.className = "cookie-mono";
    flags.textContent = flagsOf(cookie);

    const value = document.createElement("td");
    value.className = "cookie-value";
    value.textContent = showValues ? cookie.value : "••••••";

    row.append(name, domain, path, flags, value);
    list.append(row);
  }
}

async function loadSettings(): Promise<void> {
  const settings = await getSettings();
  enabled = settings.cookiesEnabled;
  if (enabledInput) enabledInput.checked = enabled;
  applyEnabled();
}

async function useActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) {
    setFeedback("No active tab with a web address.", true);
    return;
  }
  try {
    const host = new URL(tab.url).hostname;
    if (!host) throw new Error("no host");
    if (domainInput) domainInput.value = host;
    setFeedback(`Domain filled from the active tab: ${host}`);
  } catch {
    setFeedback("The active tab is not a normal web page.", true);
  }
}

async function readCookies(): Promise<void> {
  const domain = normalizeDomain(domainInput?.value ?? "");
  if (!domain) {
    setFeedback("Enter a domain such as example.com.", true);
    domainInput?.focus();
    return;
  }

  setFeedback("Reading cookies...");
  try {
    cookies = (await chrome.cookies.getAll({ domain })).sort((left, right) =>
      `${left.name}${left.domain}`.localeCompare(`${right.name}${right.domain}`),
    );
    render();
    if (summary) {
      summary.textContent =
        cookies.length === 0
          ? `No cookies for ${domain}. Check that the site is open and the domain matches.`
          : `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${domain}. Values stay in this page.`;
    }
    setFeedback("");
  } catch (error) {
    setFeedback(`Could not read cookies: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function copyJson(): Promise<void> {
  if (cookies.length === 0) {
    setFeedback("Read cookies first.", true);
    return;
  }
  const text = JSON.stringify(cookies.map(toEntry), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setFeedback(`Copied ${cookies.length} cookies as JSON. Do not paste this into chat.`);
  } catch {
    setFeedback("Clipboard access was denied. Use Download JSON instead.", true);
  }
}

function downloadJson(): void {
  if (cookies.length === 0) {
    setFeedback("Read cookies first.", true);
    return;
  }
  const domain = normalizeDomain(domainInput?.value ?? "") || "cookies";
  const blob = new Blob([JSON.stringify(cookies.map(toEntry), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `cookies-${domain.replace(/[^a-z0-9.-]/gi, "_")}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  setFeedback("Downloaded. The file contains live session values.");
}

function sameSiteOf(value: unknown): `${chrome.cookies.SameSiteStatus}` {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized === "strict") return "strict";
  if (normalized === "lax") return "lax";
  if (normalized === "none" || normalized === "no_restriction") return "no_restriction";
  return "unspecified";
}

async function importCookies(): Promise<void> {
  const text = importInput?.value.trim() ?? "";
  if (!text) {
    setFeedback("Paste a cookie array first.", true);
    importInput?.focus();
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    setFeedback("That is not valid JSON.", true);
    return;
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    setFeedback("Expected a non-empty array of cookie objects.", true);
    return;
  }
  if (parsed.length > 500) {
    setFeedback("Too many cookies in one import. Limit is 500.", true);
    return;
  }

  let imported = 0;
  const failures: string[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      failures.push("entry is not an object");
      continue;
    }
    const entry = item as Record<string, unknown>;
    const name = typeof entry["name"] === "string" ? entry["name"] : "";
    const value = typeof entry["value"] === "string" ? entry["value"] : "";
    const rawDomain = typeof entry["domain"] === "string" ? entry["domain"] : (domainInput?.value ?? "");
    const domain = normalizeDomain(rawDomain);

    if (!name || !domain) {
      failures.push(`invalid entry ${String(entry["name"] ?? "?")}`);
      continue;
    }

    const path = typeof entry["path"] === "string" && entry["path"].startsWith("/") ? entry["path"] : "/";
    const secure = entry["secure"] === true;
    const session = entry["session"] === true || typeof entry["expirationDate"] !== "number";
    const hostOnly =
      typeof entry["hostOnly"] === "boolean" ? entry["hostOnly"] : !rawDomain.startsWith(".");

    try {
      await chrome.cookies.set({
        url: buildUrl(domain, path, secure),
        name,
        value,
        path,
        secure,
        httpOnly: entry["httpOnly"] === true,
        sameSite: sameSiteOf(entry["sameSite"]),
        ...(hostOnly ? {} : { domain }),
        ...(session ? {} : { expirationDate: entry["expirationDate"] as number }),
        ...(typeof entry["storeId"] === "string" ? { storeId: entry["storeId"] } : {}),
      });
      imported += 1;
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (imported > 0) {
    if (importInput) importInput.value = "";
    await readCookies();
  }

  if (failures.length > 0) {
    setFeedback(
      `Imported ${imported} cookie${imported === 1 ? "" : "s"}, ${failures.length} failed. First failure: ${failures[0]}`,
      true,
    );
  } else {
    setFeedback(`Imported ${imported} cookie${imported === 1 ? "" : "s"}.`);
  }
}

async function deleteCookies(): Promise<void> {
  if (!deleteArmed) {
    deleteArmed = true;
    if (clearButton) clearButton.textContent = "Click again to delete";
    setFeedback("This removes every cookie for the domain above. Click again to confirm.", true);
    deleteTimer = setTimeout(() => {
      deleteArmed = false;
      if (clearButton) clearButton.textContent = "Delete cookies for this domain";
    }, 6000);
    return;
  }

  if (deleteTimer) clearTimeout(deleteTimer);
  deleteArmed = false;
  if (clearButton) clearButton.textContent = "Delete cookies for this domain";

  const domain = normalizeDomain(domainInput?.value ?? "");
  if (!domain) {
    setFeedback("Enter a domain first.", true);
    return;
  }

  try {
    const listToRemove = await chrome.cookies.getAll({ domain });
    let removed = 0;
    for (const cookie of listToRemove) {
      const url = buildUrl(cookie.domain, cookie.path, cookie.secure);
      const details: chrome.cookies.CookieDetails = { url, name: cookie.name };
      if (cookie.storeId) details.storeId = cookie.storeId;
      await chrome.cookies.remove(details);
      removed += 1;
    }
    cookies = [];
    render();
    if (summary) summary.textContent = `Removed ${removed} cookie${removed === 1 ? "" : "s"} for ${domain}.`;
    setFeedback("Cookies removed. Reload the site to see the effect.");
  } catch (error) {
    setFeedback(`Could not remove cookies: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

enabledInput?.addEventListener("change", () => {
  void (async () => {
    enabled = enabledInput.checked;
    await saveSettings({ cookiesEnabled: enabled });
    applyEnabled();
    setFeedback(enabled ? "Cookie tools enabled." : "Cookie tools disabled and the table cleared.");
  })();
});

showValuesInput?.addEventListener("change", () => {
  showValues = showValuesInput.checked;
  render();
});

useTabButton?.addEventListener("click", () => void useActiveTab());
readButton?.addEventListener("click", () => void readCookies());
copyButton?.addEventListener("click", () => void copyJson());
downloadButton?.addEventListener("click", () => downloadJson());
importButton?.addEventListener("click", () => void importCookies());
clearButton?.addEventListener("click", () => void deleteCookies());

void loadSettings();
