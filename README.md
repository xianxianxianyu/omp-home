# omp-home

One chat for all your repos, as a native macOS app. You talk to a single long-lived [omp](https://omp.sh) session, the **main chat**. It looks up related earlier work, picks the workspace and a pstack playbook, and hands the job to a **worker** omp session running in its own git worktree with its own test environment. Workers report back to the main chat, not to you. The main chat settles what it safely can and logs every decision it makes for you; when it needs you, it opens that worker's session beside the chat and you answer there.

```
┌ omp-home ─ Main idle · wakes 0/3 ─ Live 2/4 ─ ⌕ search ─ Inbox 1 ──────────────────┐
│ Main chat                      [Subagents 2] │ Inbox Tasks Sessions … │ W-3 · deckhand │
│  你  登录超时又出现了，顺便加个重试提示        │                                        │
│  ▸ 思考 · 120 字                              │  worker session (same renderer)        │
│  ● home_search  查相关任务            完成 ›  │  ● bash  Running e2e tests    运行中 › │
│  ● home_dispatch  deckhand · bug-fix  完成 ›  │  [ Approve ] [ Deny ]  Allow tool: …   │
│  已交给 dispatcher：deckhand 新 worktree       │                                        │
│ [ 给 omp 一个目标，或输入 / 查看命令…   Send ] │ [ reply to the worker…           Send ] │
└──────────────────────────────────────────────┴────────────────────────────────────────┘
```

omp runs headless in RPC mode; the app renders its event stream: thinking folded, tool calls as cards, home_* tools as task cards, approvals and ask dialogs inline, IRC messages from other agents as notices, and a subagent drawer with each subagent's own transcript.

## Requirements

- Apple Silicon Mac, macOS 13.5+, git, `omp` installed and logged in (`omp login`).
- pstack (optional but recommended): the Claude Code tree of [cursor/plugins](https://github.com/cursor/plugins) at `harness/pstack/claude-code`.
- To build from source: Node 26+, pnpm, Rust (`~/.cargo/bin`), Xcode command-line tools.

## Install the app

```sh
pnpm install
pnpm build:app      # → desktop/src-tauri/target/release/bundle/{macos/omp-home.app, dmg/*.dmg}
```

Drag `omp-home.app` into Applications and open it. It is ad-hoc signed, not notarized; for a build you trust, run `xattr -dr com.apple.quarantine /Applications/omp-home.app` once. The app runs the hub itself (bundled Node runtime), lives in the menu bar when the window is closed, sends native notifications when a worker needs you, and installs signed updates from GitHub Releases (checked at launch, every 6 h, and from the menu bar). Building, signing keys and publishing releases: [desktop/README.md](desktop/README.md).

Without the app, the same hub and UI run in a browser:

```sh
pnpm start          # builds the UI, starts the hub on http://127.0.0.1:4777 and opens the browser with your token
```

Only one hub runs per config directory; launching the app while a browser hub is running attaches to it.

Config (home path, install token, port) lives in `~/.config/omp-home/config.json`, the hub-managed omp copy in `~/.config/omp-home/omp/<version>/`. Everything else lives in the home repo under `<home>/.omp-home/` (gitignored): `home.db`, main-chat and worker transcripts, environment logs, generated run overlays and the pstack package. App logs: `~/Library/Logs/omp-home/desktop.log`.

The first run asks for the **home repo** (default `/Volumes/NVMe2T/project/home`), shows exactly which files it will add or replace there (old versions are backed up under `<home>/.omp-home/backup/`), and starts the main chat.

## How it works

- **Main chat**: an omp session with cwd = home repo, transcripts in `<home>/.omp-home/chat/`. Every message is also captured losslessly into SQLite and searchable (Chinese included) through `home_search` / `home_chat`. Its working context uses omp's notes-backed context windows (`context_notes` / `new_context`), so it never fills up and nothing is deleted. A hub restart resumes it from its transcript.
- **omp version**: the hub runs its own managed copy of omp. A newer omp on your PATH is adopted only after a model-free compatibility check with the bridge; if the check fails the app keeps the last good copy and tells you.
- **Routing**: for work, the main chat spawns an asynchronous `dispatcher` subagent that writes the brief and calls `home_dispatch`. The main chat is never blocked.
- **Workspaces**: registered git repos. Each task gets a worktree at `<repo>.worktrees/<branch>` and a worker session from the pool (live processes are capped; idle ones are stopped and resumed later from their transcript).
- **Test environments**: per workspace recipe `<home>/repos/<workspace>.env.yaml`: shared services started once, per-worktree ports, a per-worktree database cloned from a template, setup commands, and a leased test-account pool.
- **Notices**: worker outcomes are batched into the main chat. It wakes at most 3 times in a row on its own; then it waits for you ("paused").
- **Guardrails**: workers cannot `ask`; pushes, merges into protected branches and branch deletions are blocked at the tool layer and by a git pre-push hook. These are guardrails against mistakes, not a sandbox.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the pipeline diagrams in [docs/PIPELINES.md](docs/PIPELINES.md).

## Development

```sh
pnpm dev                     # hub with --watch (no browser)
pnpm exec vite web           # UI dev server with hot reload, proxies /api to the hub on :4777
VITE_MOCK=1 pnpm exec vite web   # UI against a scripted transcript stream, no hub needed
pnpm test                    # unit + hub end-to-end tests with a fake omp (no model calls)
pnpm typecheck               # server, shared, tests and web
pnpm build:hub               # bundled hub + resources in dist/hub (what the app ships)
node desktop/verify.mjs      # builds two app versions and proves launch, tray, crash restart, shutdown and signed update (no model calls)
node test/bridge.live.mjs    # manual: real omp + model, verifies the bridge extension (costs tokens)
```


Layout: `server/` hub (pure decision logic in `server/core/`, RPC client in `server/rpc.ts`, RPC → transcript normalizer in `server/transcript.ts`), `shared/` contracts between hub, bridge and UI (`shared/transcript.ts` is the session view model), `omp-plugin/` the omp extension packages (bridge, skills, `dispatcher` agent), `git-guard/` worker git hooks, `templates/home/` the home-repo migration applied at first run, `web/` the UI, `desktop/` the Tauri app.
