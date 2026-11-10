import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  const override = process.env.MCP_BROWSER_HOME;
  if (override) return override;
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "tabrail");
  }
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "tabrail");
}

export function ensureConfigDir(): string {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tokenFile(): string {
  return join(configDir(), "token");
}

export function loadToken(): string | null {
  const file = tokenFile();
  if (!existsSync(file)) return null;
  const value = readFileSync(file, "utf8").trim();
  return value.length >= 32 ? value : null;
}

export function loadOrCreateToken(): string {
  const existing = loadToken();
  if (existing) return existing;

  const dir = ensureConfigDir();
  const token = randomBytes(24).toString("base64url");
  const file = join(dir, "token");
  writeFileSync(file, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      chmodSync(file, 0o600);
    } catch {
      // The file already has the most restrictive mode the platform accepts.
    }
  }
  return token;
}

export function bridgePort(): number {
  const raw = process.env.MCP_BROWSER_PORT;
  if (!raw) return 51337;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`MCP_BROWSER_PORT must be a port number, got "${raw}"`);
  }
  return port;
}

export interface BridgeInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function infoFile(): string {
  return join(configDir(), "bridge.json");
}

export function writeBridgeInfo(info: BridgeInfo): void {
  ensureConfigDir();
  writeFileSync(infoFile(), `${JSON.stringify(info, null, 2)}\n`, "utf8");
}

export function readBridgeInfo(): BridgeInfo | null {
  const file = infoFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BridgeInfo;
  } catch {
    return null;
  }
}

export function clearBridgeInfo(): void {
  rmSync(infoFile(), { force: true });
}


