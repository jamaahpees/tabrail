export interface Settings {
  port: number;
  token: string;
  enabled: boolean;
  allowlist: string[];
  pinnedTabId: number | null;
  cookiesEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  port: 8765,
  token: "",
  enabled: true,
  allowlist: [],
  pinnedTabId: null,
  cookiesEnabled: false,
};

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
  return {
    port: typeof stored.port === "number" ? stored.port : DEFAULT_SETTINGS.port,
    token: typeof stored.token === "string" ? stored.token : DEFAULT_SETTINGS.token,
    enabled: stored.enabled !== false,
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist.filter((item) => typeof item === "string") : [],
    pinnedTabId: typeof stored.pinnedTabId === "number" ? stored.pinnedTabId : null,
    cookiesEnabled: stored.cookiesEnabled === true,
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set(next);
  return next;
}

export function originAllowed(url: string | undefined, allowlist: string[]): boolean {
  if (!url) return false;
  if (allowlist.length === 0) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return allowlist.some((raw) => {
    const entry = raw.trim().replace(/\/$/, "");
    if (!entry) return false;

    if (entry.includes("://")) {
      try {
        return new URL(entry).origin === parsed.origin;
      } catch {
        return false;
      }
    }

    return parsed.hostname === entry || parsed.hostname.endsWith(`.${entry}`);
  });
}
