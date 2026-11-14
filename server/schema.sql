-- omp-home schema v3. Each table has one writer module (see docs/ARCHITECTURE.md). Older databases reach it through server/migrations.ts.

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- schema_version · settings (JSON) · human_input_at (ms) · counters next:<kind>

CREATE TABLE workspace (                                    -- writer: workspaces.ts
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,                           -- realpath of the main checkout
  default_base TEXT NOT NULL,
  worker_model TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
) STRICT;

CREATE TABLE worktree (                                     -- writer: worktrees.ts (the only module that mutates repositories)
  id TEXT PRIMARY KEY,                                      -- WT-n
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  branch TEXT NOT NULL,
  path TEXT NOT NULL,                                       -- where it is (or will be) checked out
  fork_ref TEXT NOT NULL,                                   -- informational; the integration target is workspace.default_base
  fork_sha TEXT,                                            -- branch tip at claim; NULL only for rows migrated from v2
  state TEXT NOT NULL CHECK (state IN ('live','retiring','retired')),
  retire_reason TEXT CHECK (retire_reason IN ('merged','unused','gone','discarded')),
  retired_sha TEXT,                                         -- CAS value for the branch delete (NULL: the hub deletes no branch)
  retire_error TEXT,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  CHECK ((state = 'live') = (retire_reason IS NULL)),
  CHECK ((state = 'retired') = (retired_at IS NOT NULL)),
  UNIQUE (id, workspace_id)
) STRICT;
CREATE UNIQUE INDEX worktree_branch_live ON worktree(workspace_id, branch) WHERE state <> 'retired';
CREATE UNIQUE INDEX worktree_path_live ON worktree(path) WHERE state <> 'retired';

CREATE TABLE worktree_env (                                 -- writer: env.ts
  worktree_id TEXT PRIMARY KEY REFERENCES worktree(id),
  state TEXT NOT NULL CHECK (state IN ('preparing','ready','failed','torn_down')),
  recipe_hash TEXT NOT NULL,
  vars TEXT NOT NULL DEFAULT '{}',                          -- JSON Record<string,string> exported to the worker
  error TEXT,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE session (                                      -- writer: pool.ts
  id TEXT PRIMARY KEY,                                      -- M-n | W-n
  kind TEXT NOT NULL CHECK (kind IN ('main','worker')),
  workspace_id TEXT REFERENCES workspace(id),
  worktree_id TEXT REFERENCES worktree(id),                 -- NULL: main chat, or a worker in the main checkout (lane main)
  cwd TEXT NOT NULL,
  session_dir TEXT NOT NULL UNIQUE,
  omp_session_id TEXT,
  omp_session_file TEXT,
  model TEXT NOT NULL,
  thinking TEXT NOT NULL,
  incarnation INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  last_exit TEXT CHECK (last_exit IN ('clean','lost')),
  last_activity INTEGER,
  created_at INTEGER NOT NULL,
  retired_at INTEGER,
  CHECK ((kind = 'main') = (workspace_id IS NULL)),
  CHECK (worktree_id IS NULL OR kind = 'worker')
) STRICT;
CREATE UNIQUE INDEX session_one_per_worktree ON session(worktree_id) WHERE worktree_id IS NOT NULL AND retired_at IS NULL;
CREATE UNIQUE INDEX session_one_main ON session(kind) WHERE kind = 'main' AND retired_at IS NULL;

CREATE TABLE task (                                         -- writer: ledger.ts (projection of task_event through core/task.ts)
  id TEXT PRIMARY KEY,                                      -- T-n
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  checkout TEXT NOT NULL,                                   -- JSON CheckoutSpec (lane branch | main)
  playbook TEXT,
  brief TEXT NOT NULL,
  envelope TEXT,
  worktree_id TEXT REFERENCES worktree(id),                 -- set at dispatch for lane branch
  session_id TEXT REFERENCES session(id),
  status TEXT NOT NULL CHECK (status IN ('pending','working','awaiting','done','cancelled')),
  wait TEXT,                                                -- JSON Wait iff awaiting
  run_open INTEGER NOT NULL DEFAULT 0 CHECK (run_open IN (0,1)),
  run_report TEXT,                                          -- JSON report filed during the open run
  dispatch_key TEXT NOT NULL UNIQUE,                        -- one dispatch per dispatcher spawn
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0,1)), -- accepted, cancelled or merged, and not reopened since
  CHECK ((status = 'awaiting') = (wait IS NOT NULL)),
  CHECK ((status IN ('done','cancelled')) = (ended_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX task_one_open_per_session ON task(session_id) WHERE session_id IS NOT NULL AND status NOT IN ('done','cancelled');
CREATE INDEX task_by_session ON task(session_id, seq);
CREATE INDEX task_by_status ON task(status, updated_at);
CREATE INDEX task_by_workspace ON task(workspace_id, updated_at);
CREATE INDEX task_by_worktree ON task(worktree_id, seq);
-- One unsettled task editing a workspace's main checkout at a time.
CREATE UNIQUE INDEX task_one_main_editor ON task(workspace_id) WHERE settled = 0 AND json_extract(checkout, '$.edit') = 1;

CREATE TABLE task_link (                                    -- related tasks; earlier work on a branch is the tasks on its worktree
  task_id TEXT NOT NULL REFERENCES task(id),
  other_id TEXT NOT NULL REFERENCES task(id),
  PRIMARY KEY (task_id, other_id)
) STRICT;

CREATE TABLE task_event (                                   -- append-only
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('main','dispatcher','worker','human','hub')),
  kind TEXT NOT NULL,
  data TEXT NOT NULL,                                       -- JSON TaskEvent
  dedupe_key TEXT UNIQUE
) STRICT;
CREATE INDEX task_event_by_task ON task_event(task_id, id);

CREATE TABLE decision (
  id TEXT PRIMARY KEY,                                      -- D-n
  task_id TEXT REFERENCES task(id),
  at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  why TEXT NOT NULL,
  revert_plan TEXT NOT NULL,
  reverts TEXT REFERENCES decision(id),
  revert_requested_at INTEGER,
  dedupe_key TEXT UNIQUE
) STRICT;

CREATE TABLE escalation (
  id TEXT PRIMARY KEY,                                      -- E-n
  task_id TEXT NOT NULL REFERENCES task(id),
  session_id TEXT NOT NULL REFERENCES session(id),
  reason TEXT NOT NULL,
  opened_by TEXT NOT NULL CHECK (opened_by IN ('main','hub')),
  opened_at INTEGER NOT NULL,
  seen_at INTEGER,
  resolved_at INTEGER,
  resolution TEXT CHECK (resolution IN ('human_replied','task_moved','dismissed')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
) STRICT;
CREATE UNIQUE INDEX escalation_open ON escalation(task_id) WHERE resolved_at IS NULL;

CREATE TABLE outbox (                                       -- the only path for text into an omp session
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  task_id TEXT REFERENCES task(id),
  kind TEXT NOT NULL CHECK (kind IN ('prompt','notice')),
  deliver TEXT NOT NULL CHECK (deliver IN ('next','now','wake','context')),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  acked_at INTEGER,
  dedupe_key TEXT UNIQUE,
  CHECK ((kind = 'notice') = (deliver IN ('wake','context')))
) STRICT;
CREATE INDEX outbox_unacked ON outbox(session_id, id) WHERE acked_at IS NULL;
CREATE INDEX outbox_wakes ON outbox(session_id, sent_at) WHERE deliver = 'wake';

CREATE TABLE notice (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task(id),
  event_id INTEGER NOT NULL UNIQUE REFERENCES task_event(id),
  kind TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent','normal','info')),
  created_at INTEGER NOT NULL,
  outbox_id INTEGER REFERENCES outbox(id)
) STRICT;
CREATE INDEX notice_pending ON notice(created_at) WHERE outbox_id IS NULL;

CREATE TABLE service (                                      -- writer: env.ts
  id TEXT PRIMARY KEY,                                      -- <workspace>/<name>
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('external','run')),
  pid INTEGER,
  state TEXT NOT NULL CHECK (state IN ('down','starting','up','failed')),
  checked_at INTEGER,
  error TEXT,
  UNIQUE (workspace_id, name)
) STRICT;

CREATE TABLE lease (                                        -- writer: env.ts
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('port','db','account')),
  key TEXT NOT NULL,                                        -- port number | db name | <workspace>/<pool>/<item>
  label TEXT NOT NULL,                                      -- port name | 'database' | pool name
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('worktree','session','service')),
  holder_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER,
  released_at INTEGER
) STRICT;
CREATE UNIQUE INDEX lease_resource_active ON lease(kind, key) WHERE released_at IS NULL;
CREATE UNIQUE INDEX lease_holder_active ON lease(holder_kind, holder_id, kind, label) WHERE released_at IS NULL;

CREATE TABLE recipe_check (                                 -- writer: recipe-check.ts
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  id TEXT NOT NULL UNIQUE,
  recipe_hash TEXT NOT NULL,
  recipe TEXT NOT NULL,
  base TEXT NOT NULL,
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','passed','failed','cancelled')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  steps TEXT NOT NULL,
  processes TEXT NOT NULL DEFAULT '{}',
  cleaned INTEGER NOT NULL DEFAULT 0 CHECK (cleaned IN (0,1))
) STRICT;

CREATE TABLE chat_record (                                  -- writer: indexer.ts; lossless main-chat escrow
  id INTEGER PRIMARY KEY,
  capture_key TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL REFERENCES session(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','notice')),
  text TEXT NOT NULL,
  raw TEXT NOT NULL,                                        -- untruncated JSON of the captured message
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX chat_by_session ON chat_record(session_id, id);

CREATE TABLE doc (                                          -- writer: indexer.ts; derived search corpus
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('chat','brief','report','run_text','decision')),
  ref TEXT NOT NULL,
  task_id TEXT,
  workspace_id TEXT,
  title TEXT,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (kind, ref)
) STRICT;
CREATE VIRTUAL TABLE doc_fts USING fts5(text, content='doc', content_rowid='id', tokenize='trigram');
CREATE TRIGGER doc_ai AFTER INSERT ON doc BEGIN
  INSERT INTO doc_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER doc_ad AFTER DELETE ON doc BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER doc_au AFTER UPDATE ON doc BEGIN
  INSERT INTO doc_fts(doc_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO doc_fts(rowid, text) VALUES (new.id, new.text);
END;
