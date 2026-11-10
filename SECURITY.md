# Security policy

TabRail gives an AI agent control of the browser tabs you already use. That is a large capability, so the design assumes a hostile network and a cautious local model.

## Supported versions

Only the latest published version receives fixes.

## Threat model

In scope:

- A web page that tries to reach the bridge or impersonate the extension
- A local process that tries to connect without the token
- A different browser extension that tries to pair
- Accidental leakage of tokens or cookies through chat or logs
- A malicious page that the agent is tricked into acting on

Out of scope:

- Malware running as the same OS user. It can read the token file and the browser profile.
- A compromised Chrome build or OS.
- A user who deliberately pastes secrets into chat.

## Controls

- The bridge binds to `127.0.0.1` only. It never listens on a LAN interface.
- Clients must send a shared token, compared with a constant-time comparison.
- Local pairing answers only `chrome-extension://` origins. Web pages receive `403`, including preflight requests.
- Pairing can be pinned further with `MCP_BROWSER_PAIR_ORIGINS`.
- The extension allowlist in options restricts which sites can be controlled. Empty means every http and https site.
- `chrome://` pages, the Chrome Web Store, and other extensions are always blocked.
- `debugger` attaches only when a CDP tool is used, and detaches after 30 seconds idle.
- `browser_evaluate` is not registered unless `MCP_BROWSER_ALLOW_EVAL=1`.
- Cookie tools are off by default. Values are masked in the UI and never sent to the MCP server.
- The MCP server logs to stderr only. Tokens and cookie values are not logged.
- Extension storage is restricted to trusted extension contexts.

## Known risks

- Token file. Anyone who can read `%APPDATA%\tabrail\token` can control the browser through the bridge.
- Local pairing. With `MCP_BROWSER_ALLOW_LOCAL_PAIRING=1`, any extension in the same Chrome profile can fetch the token. Use `MCP_BROWSER_PAIR_ORIGINS` to pin one extension, or leave pairing off and copy the token manually.
- Page content. Snapshots, text, screenshots, console, and network output are sent to your model provider. Do not point the agent at pages you would not paste into that provider.
- Cookie export. `HttpOnly` does not protect a cookie from an extension with the `cookies` permission. Treat any export as a live credential.
- Agent mistakes. The agent can click real buttons. Use a dedicated Chrome profile or an origin allowlist for sensitive accounts.

## Recommendations

- Keep `MCP_BROWSER_ALLOW_LOCAL_PAIRING` off on shared machines.
- Set an origin allowlist for work accounts.
- Do not use the same Chrome profile for TabRail and banking.
- Close the extension when you are not using it.
- Rotate a session if a cookie export or token is ever pasted somewhere unsafe.

## Reporting a vulnerability

Open a private security advisory on GitHub, or email the maintainer listed in `package.json`. Include reproduction steps and the version. Do not include live cookies, tokens, or personal data in the report.
