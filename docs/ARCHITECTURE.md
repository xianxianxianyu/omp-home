# omp-home architecture

One human talks to one long-lived omp session (the **main chat**). The main chat routes work to **worker** omp sessions, each running in a git worktree of a registered **workspace**, with a per-worktree test environment. Every worker turn ends in a report that reaches the main chat first; the main chat decides reversible matters and escalates the rest by opening that worker's session view beside the chat.

```mermaid
flowchart LR
  Human -->|composer| Main[main omp, RPC mode]
  Main -- task agent=dispatcher --> Dispatcher
  Dispatcher -- home_dispatch --> Hub
  Hub -- outbox prompt --> Worker[worker omp in worktree, RPC mode]
  Worker -- run end + home_report --> Hub
  Hub -- coalesced notice --> Main
  Main -- home_send / home_escalate --> Hub
  Hub -- focus --> UI[UI: task view with the worker session]
  Human -->|composer| Worker
```

## Processes

- **Desktop shell** (`desktop/`, Tauri 2): the macOS app. It runs the hub as a sidecar on the bundled official Node runtime, loads the hub-served UI in its window, stays in the tray, sends native notifications and installs signed updates from GitHub Releases. The same hub and UI also run without the app (`pnpm start`, browser).
- **Hub** (`server/`, Node 26): sole SQLite writer, owner of every omp child process, HTTP + WebSocket server, provisioner, notifier. Binds 127.0.0.1. One hub per config directory (`hub.lock`); a second launch attaches to the running one.
- **omp processes**: spawned by the hub as `omp --mode rpc-ui` with JSONL over stdio (`server/rpc.ts`). The hub normalizes RPC frames into `shared/transcript.ts` events (`server/transcript.ts`), keeps a bounded live view per session and streams it to the UI. The UI never sees RPC frames. Each process also loads the omp-home extension package for its role with `-e`:
  - `omp-plugin/main/` adds skills `home-route`, `home-notices` and agent `dispatcher`.
  - `omp-plugin/worker/` adds skills `home-worker`, `pstack-omp`.
  - Both packages point at the same bridge module (`omp-plugin/bridge.ts`, bundled to `omp-plugin/dist/bridge.js` for the app), which connects back to the hub over WebSocket with a per-process token for home_* tools, notice and prompt delivery, chat capture and worker policy.
- **omp binary**: the hub spawns a managed copy under `<configDir>/omp/<version>/omp`. A newer omp on PATH is adopted only after a model-free compatibility self-check (the bridge loads, says hello and registers its tools); hub-spawned omp never self-updates.
- **pstack** is loaded into every session through a generated package (`<home>/.omp-home/run/pstack/`) whose `skills/` links to the configured pstack root and whose `agents/` holds omp-native copies of pstack's agents.
- **Web UI** (`web/`, React): renders each session as a message stream (thinking collapsed, tool cards, home_* cards, inline approval and ask cards, IRC and omp-home notices, subagent drawer with nested transcripts, composer with slash commands) plus the Inbox / Tasks / Sessions / Workspaces / Decisions / Resources / Settings panels.

A hub restart ends every omp process. Sessions resume from their JSONL with `--resume <file>`; runs cut mid-turn are flagged `interrupted` and never replayed automatically.

## State ownership

| State | Owner module | Storage |
|---|---|---|
| Workspaces (identity, path, base, worker model) | `server/workspaces.ts` | `workspace` table |
| Env recipe | the user, via UI or agent | `<home>/repos/<workspace>.env.yaml` (git-versioned) |
| Worktrees | `server/git.ts` | `worktree` table + git |
| Worktree environments, services, leases | `server/env.ts` | `worktree_env`, `service`, `lease` |
| Sessions and live processes | `server/pool.ts` | `session` table + in-memory process map |
| Tasks, timeline, decisions, escalations, notices, outbox | `server/ledger.ts` | `task`, `task_event`, `task_link`, `decision`, `escalation`, `notice`, `outbox` |
| Chat escrow and search index | `server/indexer.ts` | `chat_record`, `doc`, `doc_fts` |
| Settings | `server/settings.ts` | `meta` + `~/.config/omp-home/config.json` (home path only) |

Task status changes are decided only by the pure fold in `server/core/task.ts`. Notice delivery is decided only by `server/core/notices.ts`. Process admission is decided only by `server/core/pool.ts`. These modules do no I/O and carry the unit tests.

## Task lifecycle

`pending → working → awaiting(wait) → done | cancelled`. A worker turn ending applies the report filed during that turn; a turn without `home_report` becomes `awaiting(no_report)` with the turn's final text. A human message to a worker (sent from its session view through the hub) reopens a finished task and resolves its open escalation. Process loss during a run becomes `awaiting(interrupted)`.

## Notices and the wake budget

Every task transition that matters creates one notice. The notifier batches pending notices (2 s debounce, 10 s max), and delivers one batch at a time to the main chat only while it is idle. A batch with non-info notices **wakes** the main chat (`followUp` + `triggerTurn`) only while fewer than 3 hub wakes were delivered since the last human input (a prompt the hub relayed from the UI composer to the main chat); otherwise it is added as context without starting a turn, and the UI shows "main paused". Worker text inside a batch is wrapped in `<worker-report>` and treated as data. The budget covers hub-originated notices only; omp's own async-subagent completion wakes are outside it.

## Policy (guardrails, not a sandbox)

- Workers have `ask` removed; questions end the turn via `home_report({status:"question"})`.
- The bridge's `tool_call` handler blocks recognized `git push`, merge into protected branches, branch deletion, `gh pr merge` and similar in both `bash` and `eval` inputs.
- Worker processes run with `core.hooksPath` pointed (through `GIT_CONFIG_*` env, so the user's repo is untouched) at `git-guard/`, whose `pre-push` always refuses and whose other hooks chain to the repository's own hooks.
- Arbitrary code can still bypass these. Irreversible administrative actions in the hub (cleanup, service stop, workspace removal) are human-only UI actions.

## Synthesis record

Two independent designs were compared (Opus, Astra). Base: Opus (single hub process, outbox as the only path into a session, derived wake budget, role-scoped tool audiences, hub-rendered task envelope, recipe YAML in the home repo, restart reconciliation). Grafted from Astra: lossless chat escrow captured from bridge events (`input`, `message_end`) instead of relying on omp JSONL alone; explicit statement that guards are guardrails. Rejected from Astra: a separate runtime-host process (keeps PTYs across hub restarts at the cost of a second process and a durable spool; omp's `--resume` covers the need), a generic operations table with compensation records (per-entity idempotency keys suffice locally). Rejected from Opus: `@xterm/headless` screen mirror (raw scrollback replay plus a forced repaint is enough) and `bash.patterns` overlays (one `tool_call` policy covers bash and eval).

v2 (native app) decisions: omp moved from interactive TUIs in PTYs to `--mode rpc-ui`, because a structured event stream is the only way to fold thinking, split subagents and IRC into panels and render home_* tools as cards (TSP, Tern's surface protocol, was rejected as a dependency on a closed-beta protocol that yields UI nodes rather than data). The UI stayed omp-home's own React app instead of forking apoc/omp-desktop: its renderers are reusable but its process lifecycle, replay and approvals live in a Tauri-IPC layer with no injectable transport, estimated at 1–2 weeks just to re-point at the hub. Tauri was chosen over Electron because its updater verifies its own minisign signatures and works on an ad-hoc signed app, while Electron's macOS auto-update requires Apple code signing.
