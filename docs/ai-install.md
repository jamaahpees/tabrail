# Install contract for AI agents

This page is written for an agent that is asked to install TabRail. Follow it in order. Do not skip verification.

## What TabRail is

A local MCP server and a Chrome extension. The server speaks stdio MCP and owns a loopback WebSocket bridge on `127.0.0.1:8765`. The extension attaches to the Chrome tabs the user already has open. There is no remote service, no account, and no cookie requirement.

## Preconditions

Check before doing anything:

1. `node --version` returns 20.11 or newer.
2. The user has Chrome 116 or newer installed.
3. You know which MCP client is in use. If not, ask.

## Steps you can do alone

### 1. Inspect the install recipe

```sh
npx -y tabrail setup
```

Read the block for the user's client. Do not paste the whole output into the conversation if it is long; use the block you need.

### 2. Register the MCP server

Add the server to the client configuration. Use the server name `chrome`.

- OpenCode: `mcp.servers.chrome` in `opencode.jsonc`
- Claude Code: `claude mcp add chrome --env MCP_BROWSER_ALLOW_LOCAL_PAIRING=1 -- npx -y tabrail mcp`
- Claude Desktop: `mcpServers.chrome` in `claude_desktop_config.json`
- Codex: `[mcp_servers.chrome]` in `~/.codex/config.toml`

Always keep `MCP_BROWSER_ALLOW_LOCAL_PAIRING=1` unless the user explicitly wants manual token pairing.

### 3. Extract the extension

```sh
npx -y tabrail extension
```

Capture the printed folder path. It is a folder that contains `manifest.json`.

### 4. Ask the user to load it

Chrome does not allow silent extension installation. Tell the user exactly:

> Open `chrome://extensions`, enable Developer mode, click Load unpacked, and select this folder: `<path>`. Then click the TabRail icon.

Wait for confirmation.

### 5. Verify

```sh
npx -y tabrail doctor
```

Success looks like:

```
Token: 32 characters
Extension connected: yes
```

If it is not connected, do not reinstall. Ask the user to open the extension popup once, then run `doctor` again.

### 6. Verify through MCP

Call `browser_status`. It must return `state: connected`. Then call `browser_tabs` with `action: list`.

## Steps that need the user

- Clicking **Load unpacked** in Chrome
- Accepting the permission prompt
- Choosing which tab to pin, if any
- Any action that changes account state on a website

## Hard rules

- Never ask for cookies, session tokens, passwords, or a cookie export in chat.
- Never paste a token into chat. If manual pairing is required, tell the user where the token file is.
- Never install a second extension for cookies. TabRail has its own cookie page, off by default.
- Never close tabs you did not open.
- Never submit payments, delete data, or change account settings without an explicit request from the user.
- Do not run `browser_evaluate` unless the server was started with `MCP_BROWSER_ALLOW_EVAL=1` and the user asked for it.

## Failure map

| Error | Meaning | Action |
| --- | --- | --- |
| `extension_offline` | Extension not loaded, Chrome closed, or service worker asleep | Ask the user to open the popup, then retry `browser_status` |
| `page_not_controllable` | Chrome system page | Ask for a normal http or https tab |
| `origin_not_allowed` | Extension allowlist excludes the site | Ask the user to edit extension options |
| `cdp_unavailable` | DevTools open on that tab, or policy blocks the debugger | Ask the user to close DevTools |
| `stale_ref` | DOM changed after the snapshot | Call `browser_snapshot` again |
| `timeout` | Loading page or pending dialog | Call `browser_status`, then `browser_handle_dialog` if a dialog is pending |
| `bad_token` | Token mismatch | Use auto pairing, or copy the token file exactly |

## What to report when finished

Report:

1. The MCP client entry added
2. The extension folder path
3. The result of `tabrail doctor`
4. The result of `browser_status`
5. The list of tabs, with a recommendation for which to pin
