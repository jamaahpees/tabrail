# Contributing

Thanks for helping. TabRail is small on purpose: one MCP server, one bridge, one extension.

## Setup

```sh
git clone https://github.com/jamaahpees/tabrail.git
cd tabrail
npm install
npm run build
npm run typecheck
npm test
```

`npm test` builds both packages, runs the MCP protocol test, and runs an end-to-end test in a real Chromium with the extension loaded. The e2e test uses Playwright's Chromium or the binary at `CHROME_PATH`, because branded Chrome 137 and newer ignores `--load-extension`.

## Project rules

- TypeScript strict mode, no `any` unless there is a written reason
- Keep the tool surface small. A new tool needs a real use case and a test
- Never log tokens, cookie values, or full page content
- Keep the bridge protocol backward compatible within a minor version
- Update `README.md`, `docs/install.md`, and `docs/ai-install.md` when install steps change

## Tests

- `tests/mcp.test.mjs`: server startup, tool listing, pairing origin checks
- `tests/e2e.test.mjs`: navigate, snapshot, click, type, dialogs, stale refs, target tab, cookie tools, popup and options flows

Add a test for every behavior change. If the change touches the UI, also run `npm run screenshots` and check the generated images in `tests/.artifacts`.

## Pull requests

1. Keep the diff focused
2. Include the test output
3. Mention any security-relevant change in the description
4. Do not commit `dist/`, tokens, or screenshots

## Release

1. Update the version in `package.json`, `packages/*/package.json`, and `packages/extension/src/manifest.json`
2. Update hard-coded version constants if any
3. `npm test`
4. `npm publish`
5. Create a GitHub release with a zip of `packages/extension/dist`
