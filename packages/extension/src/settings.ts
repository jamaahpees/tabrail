export interface Settings {
  port: number;
  token: string;
  enabled: boolean;
  allowlist: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  port: 8765,
  token: "",
  enabled: true,
  allowlist: [],
};

export async function getSettings(): Promise<Settings> {
  const stored = (await chrome.storage.local.get(DEFAULT_SETTINGS)) as Partial<Settings>;
  return {
    port: typeof stored.port === "number" ? stored.port : DEFAULT_SETTINGS.port,
    token: typeof stored.token === "string" ? stored.token : DEFAULT_SETTINGS.token,
    enabled: stored.enabled !== false,
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist.filter((item) => typeof item === "string") : [],
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
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return allowlist.some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    return origin === trimmed || origin.startsWith(`${trimmed.replace(/\/$/, "")}`) || origin.endsWith(trimmed);
  });
}
