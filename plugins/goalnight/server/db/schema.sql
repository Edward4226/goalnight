-- goalnight SQLite schema v0.1
-- Location: ~/.goalnight/goalnight.db
-- Notes: We use INTEGER (unix ms) for timestamps to avoid TZ issues.
--        Foreign keys are ON; cascade on session delete.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================================
-- sessions: one row per `gn plan-night` invocation
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,         -- uuid
  thread_id            TEXT,                     -- codex thread_id (joined from state_5.sqlite)
  objective            TEXT NOT NULL,
  hours                INTEGER NOT NULL,         -- requested sleep/runtime hours
  target_quota_pct     REAL DEFAULT 0.8,
  quiet_hours          TEXT,                     -- e.g. "22:00-07:00" local time; null = no quiet hours
  token_budget         INTEGER,                  -- computed budget passed to codex /goal
  tokens_used          INTEGER DEFAULT 0,        -- accumulated via PostToolUse hook
  state                TEXT DEFAULT 'planned',   -- planned|active|usage_limited|blocked|paused|complete
  next_quota_reset_at  INTEGER,                  -- unix ms; set when usage_limited
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
CREATE INDEX IF NOT EXISTS idx_sessions_thread ON sessions(thread_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- ============================================================================
-- milestones: planned subtasks for a session
-- ============================================================================
CREATE TABLE IF NOT EXISTS milestones (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  estimated_tokens      INTEGER,
  ordinal               INTEGER NOT NULL,           -- display order
  state                 TEXT DEFAULT 'pending',     -- pending|in_progress|done|skipped
  -- Optional shell command run by the audit gate before morning_brief renders.
  -- Must start with one of: gh / git / test / npm. Shell metachars rejected.
  verification_command  TEXT,
  -- Result of the most recent audit pass for this milestone. Tri-state:
  --   pending (never audited) | verified | failed | unknown (timeout/spawn err)
  verification_status   TEXT DEFAULT 'pending',
  verification_output   TEXT,                       -- captured stdout+stderr (truncated)
  verified_at           INTEGER,
  started_at            INTEGER,
  completed_at          INTEGER,
  created_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_milestones_session ON milestones(session_id);
CREATE INDEX IF NOT EXISTS idx_milestones_state ON milestones(state);
CREATE INDEX IF NOT EXISTS idx_milestones_ordinal ON milestones(session_id, ordinal);

-- ============================================================================
-- findings: model-logged observations during the run
-- ============================================================================
CREATE TABLE IF NOT EXISTS findings (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type           TEXT NOT NULL,                 -- insight|warning|bug|note
  severity       TEXT DEFAULT 'low',            -- low|medium|high
  content        TEXT NOT NULL,
  context_files  TEXT,                          -- JSON array of file paths
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);

-- ============================================================================
-- decisions: items awaiting user judgement (the killer feature)
-- ============================================================================
CREATE TABLE IF NOT EXISTS decisions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  question        TEXT NOT NULL,
  options         TEXT,                         -- JSON array of choices
  recommendation  TEXT,                         -- model's recommended choice
  reasoning       TEXT,                         -- model's reasoning
  blocking        INTEGER DEFAULT 0,            -- 0/1: does this block progress?
  uncertain       INTEGER DEFAULT 0,            -- 0 = confident, 1 = agent flagged this call as a guess
  resolved        INTEGER DEFAULT 0,            -- 0/1
  resolution      TEXT,                         -- user's final choice (v0.2 interactive)
  resolved_at     INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_decisions_resolved ON decisions(resolved);

-- ============================================================================
-- turn_log: one row per codex turn (written by PostToolUse / Stop hooks)
-- ============================================================================
CREATE TABLE IF NOT EXISTS turn_log (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id          TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number         INTEGER,
  tokens_delta        INTEGER,                  -- new tokens this turn
  tools_called        TEXT,                     -- JSON array of tool names
  goal_state_before   TEXT,
  goal_state_after    TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_turn_log_session ON turn_log(session_id);
CREATE INDEX IF NOT EXISTS idx_turn_log_created ON turn_log(created_at DESC);
