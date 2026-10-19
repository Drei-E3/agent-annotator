# Agent Annotator Privacy Policy

_Last updated: 2026-10-19_

Agent Annotator is a browser extension that lets you annotate elements on a webpage and turn those annotations into a prompt for AI coding agents.

## What the extension accesses

- **The current tab, only when you activate it.** The extension uses the `activeTab` permission. It runs on a page only after you click its toolbar icon or press `Alt+Shift+A`, and only on that tab.
- **A screenshot of the visible part of that tab**, taken once when you finish a batch of annotations, so the annotated regions can be cropped.
- **The elements you select and the comments you type.**

## Where the data goes

- Annotations and cropped screenshots are sent **only to your own computer**: to the optional Agent Annotator hub running at `http://127.0.0.1:17380`, and/or to your clipboard.
- The extension does **not** send any data to the developer or to any third-party server.
- The local hub keeps usage counters (for example, how many annotations were created) in a file on your computer. They are not sent anywhere unless you explicitly configure your own endpoint with the `AGENT_ANNOTATOR_TELEMETRY_URL` environment variable.

## What we do not do

- We do not sell or transfer user data to third parties.
- We do not use or transfer user data for purposes unrelated to the extension's single purpose.
- We do not use or transfer user data to determine creditworthiness or for lending purposes.

## Contact

Questions: open an issue at https://github.com/Drei-E3/agent-annotator/issues
