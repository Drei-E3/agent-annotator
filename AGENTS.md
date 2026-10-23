# Agent instructions

Shared rules for every coding agent working on this repository. Antigravity (IDE and `agy` CLI) and Codex load this file as project rules. Claude Code loads it only while the project has no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. Whoever adds one of those must put `@AGENTS.md` in it. Keep this file the single source: put new shared rules here, not in per-agent files.

## Who works here

| Agent | Works in | Pushes to GitHub |
|---|---|---|
| Antigravity (IDE and `agy` CLI) | the maintainer's machine | no |
| Claude Code, local | the same machine | no |
| annotator4ai threads (Claude Code cloud project) | a fresh clone per thread | yes: branches and PRs |

GitHub `main` is the source of truth and changes only through PRs.

On the maintainer's machine, one shared checkout stays on `main` and runs live code. The hub service and every MCP client's `annotator mcp` process start from it. Do not edit files in it directly: each local agent works in its own worktree inside it (see Sync).

## Layout

- `packages/browser-extension/`: Manifest V3 extension. It is a service worker, an annotator script injected on demand (`activeTab` + `scripting`, no declared content scripts) and a main-world hook. It is loaded unpacked, with no build step, and always talks to the hub at `127.0.0.1:17380`.
- `packages/collector-hub/src/`: the `annotator` CLI. It runs the local hub (`serve`, default port 17380) and the MCP server over stdio (`mcp`). It also has `doctor`, `stats`, `benchmark`, `pack` and the `install-mcp` / `install-service` installers.
- `packages/shared/src/`: annotation schema, prompt formatter, crop geometry.
- `benchmarks/`: 20 recorded UI bug cases and the script that scores them.
- `tests/annotator.test.js`: the `node:test` suite.
- `docs/`: Chrome Web Store notes and the privacy policy.

Node >= 20, built-in modules only. Ask the maintainer before adding an npm dependency.

## Sync

Local agents, at the start of every task:

1. In the shared checkout, run `git status`. If it shows changes, someone is working there. Leave them alone (no stash, reset, checkout or overwrite), skip the pull and tell the user.
2. If it is clean, run `git fetch --prune origin` and `git pull --ff-only` on `main`. If the pull is not a fast-forward, stop and ask. Never merge or rebase to force it.
3. Start the task in your own worktree, branched from `origin/main`. Both worktree folders below are git-ignored, so the shared checkout stays clean.
   - Claude Code: use its worktree feature, which creates `.claude/worktrees/<name>/`.
   - Other agents:

     ```sh
     topic=short-name   # pick your own
     git worktree add -b "$topic" ".worktrees/$topic" origin/main
     ```

After `main` moves, reload what runs from the shared checkout:

- Hub: if it is installed as a LaunchAgent, run `launchctl kickstart -k gui/$(id -u)/com.agent-annotator.hub`. Otherwise restart `npm start`.
- MCP server: every client (Antigravity, `agy`, Claude Code, Codex, Cursor) starts its own `annotator mcp` process. Each keeps the old code until that client or session restarts.
- Extension: reload the unpacked extension in `chrome://extensions`.

`npm run doctor` shows whether the hub is up and which MCP clients are registered. It cannot tell whether a process runs old code. Do not follow its install hints without the user.

annotator4ai threads start from a fresh clone of `main`. There, `.claude/hooks/session-start.sh` checks the Node version.

## Test

Before every commit, in your worktree:

- `npm test` must pass. It uses a temporary data directory and a random port, so it is safe next to a running hub.
- Run `node --check` on every JavaScript file you changed.
- Behavior changes come with a new or updated test in `tests/annotator.test.js`. This includes formatter and schema changes, because the benchmark does not run the formatter.
- When you edit `benchmarks/`, run `npm run benchmark` and read the gate line. It must say `PASSED`. The command exits 0 either way.
- For extension or playground changes, look at the result, for example in a headless Chromium screenshot with the unpacked extension loaded. Say in the PR how you checked. The user's Chrome loads the extension from the shared checkout. Do not point it at a worktree without asking.
- To try hub changes without restarting the user's hub, start a side instance from your worktree. Use a free port, run it in the background, and keep its data in the git-ignored `dist/`. Stop it and delete `dist/hub-data` when done. The extension only talks to port 17380, so a side instance serves API and playground checks only.

  ```sh
  AGENT_ANNOTATOR_HOME="$PWD/dist/hub-data" node packages/collector-hub/src/cli.js serve --port 17390 &
  ```

Run `npm run install-mcp` or `npm run install-service` only when the user asks. They rewrite the user's MCP client configs and LaunchAgents.

## Commit

- One topic per branch and PR. Write the subject in the imperative, at most 65 characters (the squash merge appends ` (#N)`), with no prefix tags (see `git log`). The body says what changed and why, wrapped at 72 columns. Write commits, code, comments and docs in English.
- Author: the identity of the existing commits on `main`. Your git config may hold a personal or work email, and the repository is public. Set the author on every commit, and never change the global git config:

  ```sh
  git commit --author="$(git log -1 --format='%an <%ae>' origin/main)"
  ```

- End the message with one trailer block. Replace each `<...>` as a whole:

  ```
  Session: <full id of the agent session that made the change>
  Platform: <Antigravity | Claude Code | Codex | ...>
  ```

  If your platform adds a co-author line, put it in the same block. Write `session-unknown` when the platform exposes no session id. Keep the platform out of the `Session:` value. Do not add links to private agent sessions. To trace a change back to its session, use `git log --grep='^Session: '`.
- Never commit any of the following. Keep fixtures obviously fake.
  - signing keys and packed builds (`*.pem`, `*.crx`), `dist/`, `*.zip`, `.env*`
  - the user's captures or other personal data
  - absolute local paths, account names, tokens
  - agent working files: plans, transcripts, `.agents/teamwork/`

## Hand-off to GitHub

Local agents cannot push. Do not try `git push` on the maintainer's machine. To get a change onto GitHub:

1. Commit in your worktree, on a branch based on the current `origin/main`.
2. Export the patches into the git-ignored `dist/patches/`. Check that each `From:` line shows the author from `main`:

   ```sh
   rm -rf dist/patches && git format-patch origin/main..HEAD -o dist/patches
   grep -h '^From: ' dist/patches/*.patch
   ```

3. Give the `.patch` files to the user with a note for an annotator4ai thread. The note gives the base commit (`git rev-parse --short origin/main`), what the change does and which checks ran.

An annotator4ai thread that receives patches:

1. Starts from a fresh `main` and applies the patch files with `git am --3way`, which keeps the author and the trailers. If `git am` fails, it runs `git am --abort` and reports back.
2. Runs the checks under Test. If one fails, it reports back instead of quietly reworking the patch.
3. Pushes a branch and opens a PR to `main`. The description covers Before / After / How and lists the checks that ran.
4. Gets the diff reviewed by an agent that did not write the change. Review findings are fixed on the PR branch and reviewed again.
5. Squash-merges once review and checks pass and the branch is up to date with `main`. A draft PR, or one labeled `draft` or `experimental`, needs the maintainer's explicit OK.

After the PR is merged (check on GitHub or ask the user), the local agent:

1. In the shared checkout, runs `git status`. If it is clean, it runs `git pull --ff-only` and reloads (see Sync).
2. Removes its worktree, for example `git worktree remove ".worktrees/$topic"`.
3. Deletes the branch with `git branch -D "$topic"`. A squash merge changes the commit id, so `-d` would refuse.
