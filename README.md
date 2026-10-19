# Agent Annotator (v0.1)

Universal, on-demand UI annotation collector for AI coding agents (**Claude Code**, **Cursor**, **Codex**, **Antigravity**, **Windsurf**).

## Quick Install (Unpacked Extension — 3 Steps)

1. Open `chrome://extensions` (or `arc://extensions` / `edge://extensions`) and enable **Developer mode** in the top-right corner.
2. Click **Load unpacked** and select [`packages/browser-extension`](./packages/browser-extension).
3. On any webpage, press **`Alt+Shift+A`** (or click the extension icon) to annotate elements/regions, then press **`Cmd+Enter`** to copy the structured prompt + cropped screenshots!

---

## Local Hub, Background Service & MCP Server

Start the Local Collector Hub (saves cropped PNGs to `~/.agent-annotator/captures/`, serves the W1 Playground at `http://127.0.0.1:17380/playground`, and writes local file paths to your clipboard):

```bash
npm start
# Or install as a permanent macOS background LaunchAgent (KeepAlive):
npm run install-service
```

One-click MCP setup for **Antigravity**, **Claude Code**, **Cursor**, and **Codex**:

```bash
npm run install-mcp
npm run doctor
```

Package extension zip for GitHub Releases (`dist/agent-annotator-extension-v0.1.0.zip`):

```bash
npm run pack-release
```

Check North Star metric (`weekly_consumed_annotations`) & 6 core anonymous telemetry events:

```bash
npm run stats
```

Run the 20-case UI bug benchmark gate:

```bash
npm run benchmark
```

---

## Chrome Web Store

- Build the store upload: `npm run pack-release` → `dist/agent-annotator-extension-v<version>.zip`
- Listing text, permission justifications and privacy answers: [docs/CHROME_WEB_STORE.md](./docs/CHROME_WEB_STORE.md)
- Privacy policy: [docs/PRIVACY.md](./docs/PRIVACY.md)

## License

[Apache License 2.0](./LICENSE)
