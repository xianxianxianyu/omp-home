# omp-home

One chat for all your repos. You talk to a single long-lived [omp](https://omp.sh) session, the **main chat**. It looks up related earlier work, picks the workspace and a pstack playbook, and hands the job to a **worker** omp session running in its own git worktree with its own test environment. Workers report back to the main chat, not to you. The main chat settles what it safely can and logs every decision it makes for you; when it needs you, it opens that worker's live terminal beside the chat and you answer there.

```
┌ omp-home ─ main idle · wakes 0/3 ─ live 2/4 ─ ⌕ search ─ Inbox 1 ┐
│ main chat (real omp TUI)      │ Inbox Tasks Sessions … │ W-3 · deckhand │
│                               │                                          │
│ > 登录超时又出现了，顺便加个重试提示 │  worker terminal (real omp TUI)        │
│ 已交给 dispatcher：deckhand 新   │                                          │
│ worktree · bug-fix · 参考 T-31   │                                          │
└───────────────────────────────┴──────────────────────────────────────────┘
```

## Requirements

- macOS, Node 26+, pnpm, git, `omp` on `PATH` and logged in.
- pstack (optional but recommended): the Claude Code tree of [cursor/plugins](https://github.com/cursor/plugins) at `harness/pstack/claude-code`.

## Start

```sh
pnpm install
pnpm start        # builds the UI, starts the hub on http://127.0.0.1:4777 and opens the browser with your token
# or from anywhere: /Volumes/NVMe2T/project/omp-home/bin/omp-home   (flags: --port N, --no-open)
```

Config (home path, install token, port) lives in `~/.config/omp-home/config.json`. Everything else lives in the home repo under `<home>/.omp-home/` (gitignored): `home.db`, main-chat and worker transcripts, environment logs, generated run overlays and the pstack package.

The first run asks for the **home repo** (default `/Volumes/NVMe2T/project/home`), shows exactly which files it will add or replace there (old versions are backed up under `<home>/.omp-home/backup/`), and starts the main chat.

## How it works

- **Main chat**: an omp session with cwd = home repo, transcripts in `<home>/.omp-home/chat/`. Every message is also captured losslessly into SQLite and searchable (Chinese included) through `home_search` / `home_chat`. Its working context uses omp's notes-backed context windows (`context_notes` / `new_context`), so it never fills up and nothing is deleted. A hub restart resumes it from its transcript.
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
VITE_MOCK=1 pnpm exec vite web   # UI against built-in mock data, no hub needed
pnpm test                    # unit + hub end-to-end tests with a fake omp (no model calls)
pnpm typecheck               # server, shared, tests and web
node test/bridge.live.mjs    # manual: real omp + model, verifies the bridge extension (costs tokens)
```

Layout: `server/` hub (pure decision logic in `server/core/`), `shared/` contracts between hub, bridge and UI, `omp-plugin/` the omp extension packages (bridge, skills, `dispatcher` agent), `git-guard/` worker git hooks, `templates/home/` the home-repo migration applied at first run, `web/` the UI.
