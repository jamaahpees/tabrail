#!/usr/bin/env node
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = packageJson.version;

function configDir() {
  if (process.env.MCP_BROWSER_HOME) return process.env.MCP_BROWSER_HOME;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "tabrail");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tabrail");
}

function tokenFile() {
  return join(configDir(), "token");
}

function port() {
  const raw = process.env.MCP_BROWSER_PORT;
  return raw ? Number(raw) : 51337;
}

function extensionSource() {
  return join(root, "packages", "extension", "dist");
}

function extensionTarget() {
  return join(configDir(), "extension");
}

function printExtension() {
  const source = extensionSource();
  if (!existsSync(join(source, "manifest.json"))) {
    console.error("The bundled extension folder is missing. Reinstall the package.");
    process.exit(1);
  }

  const target = extensionTarget();
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });

  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  console.log(`TabRail extension ${manifest.version}`);
  console.log("");
  console.log("Extension folder:");
  console.log(`  ${target}`);
  console.log("");
  console.log("Load it in Chrome:");
  console.log("  1. Open chrome://extensions");
  console.log("  2. Turn on Developer mode");
  console.log("  3. Click Load unpacked and select the folder above");
  console.log("  4. Click the TabRail icon. It pairs with the local bridge automatically.");
  console.log("");
  console.log(`Bridge token file: ${tokenFile()}`);
  console.log(`Bridge port: ${port()}`);
}

function printSetup() {
  const target = extensionTarget();
  console.log(`TabRail ${version}`);
  console.log("");
  console.log("1. Register the MCP server");
  console.log("");
  console.log("OpenCode, opencode.jsonc:");
  console.log(`  {
    "mcp": {
      "servers": {
        "chrome": {
          "type": "local",
          "command": ["npx", "-y", "tabrail", "mcp"],
          "environment": { "MCP_BROWSER_ALLOW_LOCAL_PAIRING": "1" }
        }
      }
    }
  }`);
  console.log("");
  console.log("Claude Code:");
  console.log("  claude mcp add chrome -- npx -y tabrail mcp");
  console.log("");
  console.log("Claude Desktop, claude_desktop_config.json:");
  console.log(`  {
    "mcpServers": {
      "chrome": {
        "command": "npx",
        "args": ["-y", "tabrail", "mcp"],
        "env": { "MCP_BROWSER_ALLOW_LOCAL_PAIRING": "1" }
      }
    }
  }`);
  console.log("");
  console.log("Codex, ~/.codex/config.toml:");
  console.log(`  [mcp_servers.chrome]
  command = "npx"
  args = ["-y", "tabrail", "mcp"]
  env = { MCP_BROWSER_ALLOW_LOCAL_PAIRING = "1" }`);
  console.log("");
  console.log("2. Load the extension");
  console.log("");
  console.log("  Run: npx -y tabrail extension");
  console.log(`  Then load unpacked from: ${target}`);
  console.log("");
  console.log("3. Use it");
  console.log("");
  console.log('  Ask the agent: "Use chrome, list my tabs, and snapshot the active one."');
}

async function doctor() {
  const token = existsSync(tokenFile()) ? readFileSync(tokenFile(), "utf8").trim() : "";
  const target = extensionTarget();

  console.log(`TabRail ${version}`);
  console.log(`Node: ${process.version}`);
  console.log(`Config folder: ${configDir()}`);
  console.log(`Token: ${token ? `${token.length} characters` : "missing"}`);
  console.log(`Extension folder: ${existsSync(join(target, "manifest.json")) ? target : "not extracted yet"}`);

  try {
    const response = await fetch(`http://127.0.0.1:${port()}/health`);
    const health = await response.json();
    console.log(`Bridge: running on ${port()}`);
    console.log(`Extension connected: ${health.extensionConnected ? "yes" : "no"}`);
    console.log(`MCP clients: ${health.clients}`);
    if (Array.isArray(health.helloAttempts) && health.helloAttempts.length > 0) {
      const last = health.helloAttempts[health.helloAttempts.length - 1];
      console.log(`Last extension hello: ${last.at}, token ${last.tokenLength} chars, ok=${last.ok}`);
    }
  } catch {
    console.log(`Bridge: not running on ${port()}`);
    console.log("Start it by calling a browser tool from your MCP client.");
  }
}

function help() {
  console.log(`TabRail ${version}

Usage:
  tabrail [mcp]        Run the MCP server over stdio (default)
  tabrail extension    Extract the Chrome extension and print its folder
  tabrail setup        Print MCP client configuration and install steps
  tabrail doctor       Check the token, bridge, and extension state
  tabrail version      Print the version
  tabrail help         Show this help

Environment:
  MCP_BROWSER_PORT                 Bridge port, default 51337
  MCP_BROWSER_HOME                 Config folder override
  MCP_BROWSER_ALLOW_LOCAL_PAIRING  Set 1 to let the extension pair itself
  MCP_BROWSER_ALLOW_EVAL           Set 1 to expose browser_evaluate
  MCP_BROWSER_DEBUG                Set 1 for bridge protocol logs`);
}

const command = process.argv[2] ?? "mcp";

if (command === "mcp") {
  await import("../packages/server/dist/index.js");
} else if (command === "extension" || command === "extension-path") {
  printExtension();
} else if (command === "setup") {
  printSetup();
} else if (command === "doctor") {
  await doctor();
} else if (command === "version" || command === "--version" || command === "-v") {
  console.log(version);
} else if (command === "help" || command === "--help" || command === "-h") {
  help();
} else {
  console.error(`Unknown command: ${command}`);
  help();
  process.exit(1);
}

