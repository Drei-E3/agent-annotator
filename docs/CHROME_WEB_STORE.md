# Chrome Web Store submission notes

Upload `dist/agent-annotator-extension-v<version>.zip` (built with `npm run pack-release`).

## Store listing

- **Name:** Agent Annotator
- **Category:** Developer Tools
- **Language:** English
- **Short description (from manifest):** Annotate any webpage and hand AI coding agents (Claude Code, Cursor, Codex) a structured prompt with cropped screenshots.
- **Detailed description:**

  Point at what's wrong, and let your AI coding agent fix it.

  Agent Annotator lets you click elements or drag regions on any webpage, add a comment to each, and copy one structured prompt with cropped screenshots that Claude Code, Cursor, Codex, Antigravity or Windsurf can act on.

  • Activate with the toolbar icon or Alt+Shift+A. Nothing runs until you do.
  • Annotate several elements or regions in one pass, then press Cmd/Ctrl+Enter.
  • Detects React, Vue and Svelte components so the prompt names the component, not just the DOM node.
  • Captures the screen once and crops each annotation from it.
  • Optional local hub saves screenshots to disk and exposes them to agents through MCP.
  • All data stays on your computer. Nothing is sent to us or any third party.

- **Assets you still need:** at least one screenshot (1280×800 or 640×400), small promo tile 440×280 (optional but recommended). Store icon: `packages/browser-extension/icon-128.png`.

## Privacy tab

- **Single purpose:** Let developers annotate UI elements on a webpage and copy a structured prompt with cropped screenshots for AI coding agents.
- **Permission justifications:**
  - `activeTab`: Access the current tab only after the user clicks the icon or presses the shortcut, to show the annotation overlay and capture a screenshot of the visible area.
  - `scripting`: Inject the annotation overlay and the component-detection script into the active tab on user request.
  - `clipboardWrite`: Copy the generated prompt and cropped screenshots to the clipboard.
- **Remote code:** No. All JavaScript is packaged in the extension.
- **Data usage:** Declare only "Website content" (selected elements, screenshots), used solely for the extension's function and kept on the user's device. Tick all three certifications.
- **Privacy policy URL:** link to `docs/PRIVACY.md` (the repository must be public for this URL to work, or host the file elsewhere, e.g. GitHub Pages or a Gist).
