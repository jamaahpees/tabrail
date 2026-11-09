import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import puppeteer from "puppeteer-core";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const EXTENSION_PATH = join(ROOT, "packages", "extension", "dist");
export const BRIDGE_ENTRY = join(ROOT, "packages", "server", "dist", "bridge.js");
export const MCP_ENTRY = join(ROOT, "packages", "server", "dist", "index.js");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function chromePath() {
  const playwrightRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : null;
  const playwrightChromium = playwrightRoot && existsSync(playwrightRoot)
    ? readdirSync(playwrightRoot)
        .filter((entry) => entry.startsWith("chromium-"))
        .sort((left, right) => Number(right.split("-")[1] ?? 0) - Number(left.split("-")[1] ?? 0))
        .map((entry) => join(playwrightRoot, entry, "chrome-win64", "chrome.exe"))
        .find((candidate) => existsSync(candidate))
    : null;

  const candidates = [
    process.env.CHROME_PATH,
    playwrightChromium,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : null,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("No Chromium binary found for the browser tests. Set CHROME_PATH.");
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

export async function startFixtureServer() {
  const root = join(ROOT, "fixtures");
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const target = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    if (!target.startsWith(root)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, { "content-type": MIME[extname(target)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end("not found");
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function startBridge({ port, token }) {
  const home = await mkdtemp(join(tmpdir(), "mcp-bridge-home-"));
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    env: {
      ...process.env,
      MCP_BROWSER_PORT: String(port),
      MCP_BROWSER_TOKEN: token,
      MCP_BROWSER_HOME: home,
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      if (health.ok) {
        return {
          child,
          home,
          stop: () => {
            child.kill();
          },
        };
      }
    } catch {
      // Not listening yet.
    }
    await sleep(100);
  }

  child.kill();
  throw new Error(`The bridge did not start.\n${stderr}`);
}

export async function stopBridgeByPort(port) {
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    const payload = await health.json();
    if (payload.pid) process.kill(payload.pid);
  } catch {
    // Nothing to stop.
  }
}

export async function connectClient(port, token, timeoutMs = 5000) {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const pending = new Map();
    let sequence = 0;
    let ready = null;
    let settled = false;

    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out connecting the test client"));
    }, timeoutMs);

    const api = {
      get ready() {
        return ready;
      },
      call(method, params = {}, callTimeout = 30_000) {
        return new Promise((resolveCall, rejectCall) => {
          const id = `test-${++sequence}`;
          const callTimer = setTimeout(() => {
            pending.delete(id);
            rejectCall(new Error(`Test call ${method} timed out`));
          }, callTimeout);
          pending.set(id, {
            resolve: (value) => {
              clearTimeout(callTimer);
              resolveCall(value);
            },
            reject: (error) => {
              clearTimeout(callTimer);
              rejectCall(error);
            },
          });
          socket.send(JSON.stringify({ kind: "call", id, method, params }));
        });
      },
      close() {
        socket.close();
      },
    };

    socket.on("open", () => {
      socket.send(JSON.stringify({ kind: "hello", role: "internal", token, version: "test" }));
    });

    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.kind === "ready") {
        ready = message;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(api);
        }
        return;
      }
      if (message.kind === "status") {
        ready = { ...ready, extensionConnected: message.extensionConnected };
        return;
      }
      if (message.kind === "result") {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else {
          const error = new Error(message.error?.message ?? "Browser call failed");
          error.code = message.error?.code;
          error.hint = message.error?.hint;
          entry.reject(error);
        }
      }
    });

    socket.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

export async function waitUntil(check, timeoutMs = 15_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export async function launchChrome() {
  const profile = await mkdtemp(join(tmpdir(), "mcp-chrome-profile-"));
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    userDataDir: profile,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate,MediaRouter",
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const target = await browser.waitForTarget(
    (candidate) => candidate.type() === "service_worker" && candidate.url().startsWith("chrome-extension://"),
    { timeout: 25_000 },
  );
  const extensionId = new URL(target.url()).host;
  return { browser, extensionId, profile };
}

export async function configureExtension(browser, extensionId, { port, token }) {
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#token");
  await page.evaluate(
    ({ port, token }) => {
      document.querySelector("#port").value = String(port);
      document.querySelector("#token").value = token;
      document.querySelector("#enabled").checked = true;
    },
    { port, token },
  );
  await page.click("#save");
  await page.waitForFunction(
    () => {
      const feedback = document.querySelector("#feedback");
      return Boolean(feedback && /Saved|Reconnecting/.test(feedback.textContent ?? ""));
    },
    { timeout: 8000 },
  );
  return page;
}
