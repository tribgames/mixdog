-- state/core.sqlite, user_version 1: small non-derived core state (SPEC R30).
-- User data: never rebuilt, never deleted by the core.
-- Connection settings (not stored here): journal_mode=WAL, synchronous=FULL,
-- wal_autocheckpoint=0, busy_timeout=0.

PRAGMA application_id = 1297634132; -- 0x4D585354 'MXST'
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA user_version = 1;

-- Key/value: maintenance job cursors (`job:<id>`).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- Desktop project preferences (DS §4.1). Converted from desktop-projects.json
-- `{version:2, aliases{path:name}, hidden[path]}`: hidden_rank keeps the array order.
CREATE TABLE projects (
    path TEXT PRIMARY KEY,
    alias TEXT,
    hidden INTEGER NOT NULL CHECK (hidden IN (0,1)),
    hidden_rank INTEGER,
    last_used_at INTEGER
) WITHOUT ROWID;

-- Group rooms (DS §9): the stored room document as JSON text.
CREATE TABLE rooms (
    room_id TEXT PRIMARY KEY,
    doc TEXT NOT NULL
);

-- Op records of every non-thread scope (P §9.2). op_id is a UUIDv7, so key order is
-- time order and retention pruning is a key-range delete.
CREATE TABLE ops (
    scope TEXT NOT NULL,
    op_id TEXT NOT NULL,
    method TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('inProgress','applied','rejected','fenced','externalPending','externalUnknown')),
    outcome TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    PRIMARY KEY (scope, op_id)
) WITHOUT ROWID;

-- Per-scope retention watermark (P §9.5): the UUIDv7 below which records may be gone.
CREATE TABLE op_watermarks (
    scope TEXT PRIMARY KEY,
    watermark TEXT NOT NULL
) WITHOUT ROWID;
