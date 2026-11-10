# Install TabRail

TabRail has two parts: a local MCP server that your agent launches, and a Chrome extension that controls the tabs you already use. Install takes about three minutes.

## 1. Check Node and Chrome

```sh
node --version    # needs 20.11 or newer
```

Chrome 116 or newer. No other runtime is required.

## 2. Register the MCP server

Run:

```sh
npx -y tabrail setup
```

It prints a block for each supported client. Pick yours.

### OpenCode

Open `~/.config/opencode/opencode.jsonc` (global) or `opencode.jsonc` in the project, and add:

```jsonc
{
  "mcp": {
    "servers": {
      "chrome": {
        "type": "local",
        "command": ["npx", "-y", "tabrail", "mcp"],
        "environment": { "MCP_BROWSER_ALLOW_LOCAL_PAIRING": "1" }
      }
    }
  }
}
```

Confirm with `opencode mcp list`. You should see `✓ chrome connected`. If it says failed, run `npx -y tabrail doctor` and read the last error.

### Claude Code

```sh
claude mcp add chrome --env MCP_BROWSER_ALLOW_LOCAL_PAIRING=1 -- npx -y tabrail mcp
```

### Claude Desktop

Edit `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chrome": {
      "command": "npx",
      "args": ["-y", "tabrail", "mcp"],
      "env": { "MCP_BROWSER_ALLOW_LOCAL_PAIRING": "1" }
    }
  }
}
```

Restart Claude Desktop after saving.

### Codex

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.chrome]
command = "npx"
args = ["-y", "tabrail", "mcp"]
env = { MCP_BROWSER_ALLOW_LOCAL_PAIRING = "1" }
```

## 3. Extract and load the extension

Run:

```sh
npx -y tabrail extension
```

Example output:

```
TabRail extension 0.2.1

Extension folder:
  C:\Users\you\AppData\Roaming\tabrail\extension

Load it in Chrome:
  1. Open chrome://extensions
  2. Turn on Developer mode
  3. Click Load unpacked and select the folder above
  4. Click the TabRail icon. It pairs with the local bridge automatically.
```

Select the folder that contains `manifest.json`, not a subfolder.

Chrome will ask to confirm the permissions: tabs, scripting, storage, alarms, debugger, cookies, and access to all sites. Debugger is used for console, network, screenshots, dialogs, and trusted clicks. Cookies are only used by the cookie page, which is off by default.

## 4. Pair the extension

Open the TabRail icon. With `MCP_BROWSER_ALLOW_LOCAL_PAIRING=1`, the extension fetches the token from the bridge itself. The popup should show **Connected** and the toolbar badge turns `ON`.

If pairing is not enabled, copy the token:

- Windows: `%APPDATA%\tabrail\token`
- Linux and macOS: `~/.config/tabrail/token`

Paste it into the popup and click **Save**. The popup shows `token 32 chars` when the value is correct.

## 5. Verify

```sh
npx -y tabrail doctor
```

Expected:

```
Token: 32 characters
Extension folder: ...\tabrail\extension
Bridge: running on 51337
Extension connected: yes
```

Then, in your agent:

```text
Call browser_status, list my tabs, and snapshot the active tab.
```

If you see `extension_offline`, Chrome is not running, the extension is not loaded, or the service worker was reset. Open the popup once and retry.

## Choose the target tab

Open the TabRail popup. Click a tab to pin it, or leave **Follow active tab**. The agent reads the pinned tab when a tool does not pass `tabId`.

## Update

```sh
npx -y tabrail@latest extension
```

Then click **Reload** on the extension card in `chrome://extensions`. The MCP command always uses the latest package through `npx -y`, unless you pinned a version.

## Uninstall

1. Remove the extension from `chrome://extensions`.
2. Remove the MCP entry from your client configuration.
3. Delete the config folder if you want to remove the token and extracted extension:
   - Windows: `%APPDATA%\tabrail`
   - Linux and macOS: `~/.config/tabrail`

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `npx` cannot find the package | Check the package name: `tabrail`. Node must be on PATH. |
| MCP server fails to start | Run `node --version`. Node below 20.11 is not supported. |
| Extension loads but never connects | Run `npx -y tabrail doctor`. If the bridge is not running, call a browser tool first. |
| Popup says **Needs attention** | Token mismatch. Use auto pairing, or paste the exact token file. |
| `chrome://extensions` shows an error | Select the folder containing `manifest.json`, not `icons` or `extension`. |
| Everything is connected but tools fail | Check the target tab. Chrome system pages cannot be controlled. |

Still stuck? Open an issue with the output of `npx -y tabrail doctor`. Never include cookies or tokens.

