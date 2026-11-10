# TabRail

**Your real Chrome tabs, on rails for AI agents.**

TabRail lets any MCP client read and control the Chrome tabs you are already using, with your existing logins, cookies, and 2FA sessions. There is no new browser profile, no headless browser, and no cookie export.

```
MCP client (OpenCode, Claude, Codex, Cursor)
        │  stdio MCP
        ▼
tabrail (local server)  ── WebSocket 127.0.0.1:8765 ──  TabRail Chrome extension  ──►  your tabs
```

The server is a thin MCP layer. A small local bridge owns the WebSocket, and the extension controls the tab you choose.

## Why another browser MCP

Playwright MCP and chrome-devtools-mcp launch their own browser. That is great for tests, and wrong for work that depends on the session you already have: a dashboard, an admin panel, a checkout flow, a SaaS account behind SSO.

TabRail attaches to the browser you are already in. The session never leaves Chrome. The agent sees an accessibility tree with stable refs, not raw HTML, and acts on the tab you pinned.

- Real tabs, real session, no profile copying
- Accessibility snapshot with `ref=e12` instead of selectors
- Snapshot modes: `full`, `interactive`, `diff`
- Chrome DevTools Protocol for console, network, screenshots, dialogs, and trusted clicks
- Built-in cookie tools, off by default, so you do not need a second extension
- Loopback only, token authenticated, origin pinned pairing

## Requirements

- Node.js 20.11 or newer
- Chrome 116 or newer
- An MCP client that supports local stdio servers

## Quick start

```sh
npx -y tabrail setup
```

That prints the MCP configuration for your client and the install steps. Then:

```sh
npx -y tabrail extension
```

Copy the folder path it prints, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select that folder. Click the TabRail icon once. It pairs with the local bridge automatically.

Verify:

```sh
npx -y tabrail doctor
```

## Install for AI agents

Paste this into your agent when you want it to install TabRail for you:

```text
Install TabRail, a local MCP server that controls my real Chrome tabs.

1. Run: npx -y tabrail setup
2. Add the MCP server entry for my client from that output. Keep the
   MCP_BROWSER_ALLOW_LOCAL_PAIRING=1 environment variable.
3. Run: npx -y tabrail extension
4. Tell me the extension folder path and ask me to load it in
   chrome://extensions with Developer mode and Load unpacked.
5. After I confirm, run: npx -y tabrail doctor
6. When the extension shows connected, call browser_status, then list my tabs.
   Ask me which tab to pin before reading a page.

Do not ask me for cookies or session tokens in chat.
```

The agent can do steps 1, 2, 3, 5, and 6 by itself. Step 4 needs a human click because Chrome does not let extensions install silently.

More detail: [docs/install.md](docs/install.md) and [docs/ai-install.md](docs/ai-install.md).

## MCP configuration

### OpenCode

`~/.config/opencode/opencode.jsonc` or a project `opencode.jsonc`:

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

Tools appear as `chrome_browser_navigate`, `chrome_browser_snapshot`, and so on.

### Claude Code

```sh
claude mcp add chrome --env MCP_BROWSER_ALLOW_LOCAL_PAIRING=1 -- npx -y tabrail mcp
```

### Claude Desktop

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

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.chrome]
command = "npx"
args = ["-y", "tabrail", "mcp"]
env = { MCP_BROWSER_ALLOW_LOCAL_PAIRING = "1" }
```

### Without auto pairing

If you do not set `MCP_BROWSER_ALLOW_LOCAL_PAIRING`, copy the token from the config folder into the extension popup:

- Windows: `%APPDATA%\tabrail\token`
- Linux and macOS: `~/.config/tabrail/token`

The token is 32 characters. Paste only that line, never a cookie export.

## Target tab

The popup lists your open tabs. Click one to pin it, or leave **Follow active tab** selected. Resolution order:

1. `tabId` passed by the tool
2. Tab pinned in the popup
3. Active tab

If the pinned tab closes, the extension falls back to follow active tab.

## Tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Bridge, extension, target tab, debugger, pending dialogs |
| `browser_tabs` | `list`, `new`, `close`, `activate` |
| `browser_navigate` | Open a URL and wait for load |
| `browser_go_back` | Back one history entry |
| `browser_snapshot` | Accessibility tree with refs, modes `full`, `interactive`, `diff` |
| `browser_get_text` | Visible text of a ref, selector, or the page |
| `browser_click` | DOM click, or `trusted: true` through CDP |
| `browser_type` | Fill a field, works with React and Vue controlled inputs |
| `browser_press_key` | Enter, Escape, Tab, `Control+A` |
| `browser_hover` | Open hover menus |
| `browser_select_option` | Native select by value or label |
| `browser_scroll` | Page or element |
| `browser_wait_for` | Selector, text, or URL change |
| `browser_screenshot` | Viewport, full page, or element as PNG |
| `browser_console` | Buffered console and exceptions |
| `browser_network` | Buffered requests with status |
| `browser_handle_dialog` | Accept or dismiss alert, confirm, prompt |
| `browser_evaluate` | JavaScript, only with `MCP_BROWSER_ALLOW_EVAL=1` |

### Snapshot example

```
[page] https://shop.example.com/checkout
[title] Checkout
  - heading "Cart" [level=2] ref=e2
  - listitem "Black Tee" ref=e5
    - button "Remove" ref=e6
  - textbox "Promo code" ref=e9
  - button "Apply" [disabled] ref=e10
  - combobox "Carrier" value="JNE Reguler" ref=e12
  - button "Pay now" ref=e15
```

Refs are stable while the page state is stable. After a re-render they fail with `stale_ref`, not a wrong click.

## Cookie tools

TabRail has its own cookie page, off by default. Open it from the popup footer. The page fills the domain from the tab you are targeting, enables the tools, and reads that site with one click on **Allow and read cookies**.

- Read cookies for one domain
- Copy or download JSON in Cookie-Editor format
- Paste and import JSON
- Delete cookies for a domain with two-click confirmation
- Values hidden until you enable **Show values**

Cookie values never go to the MCP server, never appear in logs, and never leave the browser unless you copy or download them. `HttpOnly` does not protect a cookie from an extension with the `cookies` permission, so treat any export as a live session credential.

## Security

- Bridge listens on `127.0.0.1` only
- Every client sends a token, compared in constant time
- Local pairing accepts `chrome-extension://` origins only and rejects web pages with 403
- Extension allowlist in options, empty means all http and https sites
- `debugger` attaches lazily and detaches after 30 seconds idle
- `browser_evaluate` and cookie tools are off by default
- No telemetry, no analytics, no remote calls except the pages you visit

Threat model and limits: [SECURITY.md](SECURITY.md).

## Limits

- `chrome://` pages, the Chrome Web Store, and other extensions cannot be controlled
- Cross-origin iframe contents are not read; the snapshot shows the `iframe` node
- Canvas and WebGL apps need screenshots and coordinates
- Closed shadow DOM is not read
- A JavaScript dialog blocks the tab until `browser_handle_dialog`
- The extension must be loaded, Chrome must be open

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `extension_offline` | Chrome closed, extension removed, or the bridge restarted. Open the popup and run `npx -y tabrail doctor`. |
| Status **Waiting** | The bridge is not running. Call any browser tool, or start your MCP client. |
| Status **Needs attention** | Token mismatch. Use auto pairing, or copy the token file exactly. |
| Token shows thousands of characters | You pasted a cookie export. Remove and reload the extension, then use the 32-character token. |
| `page_not_controllable` | The tab is a Chrome system page. Switch to http or https. |
| `origin_not_allowed` | Add the origin in extension options or clear the allowlist. |
| `cdp_unavailable` | DevTools is open on that tab, or an enterprise policy blocks the debugger. |
| `stale_ref` | Take a new snapshot. |
| Port conflict | Another bridge owns the port. Stop it or set `MCP_BROWSER_PORT`. |

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_BROWSER_PORT` | `8765` | Bridge port, set it in the extension too |
| `MCP_BROWSER_HOME` | OS config folder | Token and bridge files |
| `MCP_BROWSER_ALLOW_LOCAL_PAIRING` | off | Let the extension fetch the token itself |
| `MCP_BROWSER_PAIR_ORIGINS` | empty | Comma-separated extension origins allowed to pair |
| `MCP_BROWSER_ALLOW_EVAL` | off | Expose `browser_evaluate` |
| `MCP_BROWSER_DEBUG` | off | Bridge protocol logs on stderr |

## Development

```sh
git clone https://github.com/jamaahpees/tabrail.git
cd tabrail
npm install
npm run build
npm run typecheck
npm test
```

`npm test` builds both packages and runs the MCP protocol test plus an end-to-end test in a real Chromium with the extension loaded. The e2e test uses Playwright's Chromium or `CHROME_PATH`, because branded Chrome 137 and newer ignores `--load-extension`.

### Repository layout

```
bin/tabrail.js              CLI: mcp, extension, setup, doctor
packages/server/src/
  index.ts                  MCP stdio entry
  tools.ts                  tool definitions
  bridge.ts                 local WebSocket daemon
  client.ts                 protocol client
  ensureBridge.ts           spawns the daemon
packages/extension/src/
  background.ts             service worker, CDP, tabs
  content.ts                DOM actions
  snapshot.ts               accessibility snapshot and refs
  cookies.ts                cookie read, export, import
  popup.*, options.*, cookies.*
fixtures/                   test pages
tests/                      MCP and e2e tests
```

### How it is built

- Server and bridge: TypeScript, bundled with esbuild to `packages/server/dist`
- Extension: TypeScript, bundled with esbuild to `packages/extension/dist`
- `npm run prepack` rebuilds both before publishing

## Publishing

```sh
npm login
npm pack --dry-run   # inspect the tarball
npm publish
```

The published package contains the CLI, the server build, and the prebuilt extension folder. `npx -y tabrail extension` copies the extension out of the package into the user config folder so Chrome can load it.

Release notes and a zip of the extension are published on GitHub Releases.

## License

MIT
