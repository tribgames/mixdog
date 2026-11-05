-- index/store.sqlite, user_version 1: catalog + history projection + blob refs.
-- Derived and rebuildable from sessions/*/log.* (FORMAT.md §8). Holds no user data.
-- Connection settings (not stored here): journal_mode=WAL, synchronous=FULL,
-- wal_autocheckpoint=0, busy_timeout=0, foreign_keys=OFF.

PRAGMA application_id = 1297631576; -- 0x4D584958 'MXIX'
PRAGMA auto_vacuum = INCREMENTAL;
PRAGMA user_version = 1;

-- Key/value: GC state (`gc:*`), maintenance job cursors (`job:<id>`).
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

-- One row per session: projection state (Codex thread_history_projection_state folded
-- in), the dirty mark of RL §9.2, list/sort/filter columns and the list row itself.
-- `sid` is the stable integer key of the title search index; rows are written with
-- INSERT … ON CONFLICT(id) DO UPDATE, never OR REPLACE (which would skip the
-- search triggers).
CREATE TABLE sessions (
    sid INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    dirty INTEGER NOT NULL CHECK (dirty IN (0,1)),
    status TEXT NOT NULL CHECK (status IN ('ok','damaged','indeterminate')),
    damage TEXT,
    deleted INTEGER NOT NULL CHECK (deleted IN (0,1)),
    base_session TEXT,
    log_id TEXT NOT NULL,
    newest_file_no INTEGER NOT NULL,
    projected_file_no INTEGER NOT NULL,
    projected_offset INTEGER NOT NULL,
    projected_ordinal INTEGER NOT NULL,
    history_rev INTEGER NOT NULL,
    row_count INTEGER NOT NULL,
    visible_count INTEGER NOT NULL,
    activity REAL NOT NULL,
    created_at REAL,
    updated_at REAL,
    closed INTEGER NOT NULL CHECK (closed IN (0,1)),
    archived_at REAL,
    cwd TEXT,
    visibility TEXT,
    owner_session_id TEXT,
    parent_session_id TEXT,
    agent TEXT,
    source_type TEXT,
    -- Session search (FORMAT.md §8.2, the desktop session-search.ts contract):
    -- 'task' | 'project' | other; only task/project rows are searched.
    classification TEXT,
    archived INTEGER NOT NULL CHECK (archived IN (0,1)),
    -- The `[Image]`/`[Video]`/`[File]` placeholder kind when the display title is a
    -- localized label; refolded when the UI language changes.
    title_kind TEXT CHECK (title_kind IN ('image','video','file')),
    -- localeCompare order of `id` as bytes (FORMAT.md §8.2).
    id_key BLOB NOT NULL,
    -- fold(x) = Unicode default lowercase of x (no normalization); NULL for absent fields.
    title_fold TEXT NOT NULL,
    preview_fold TEXT,
    cwd_fold TEXT,
    project_fold TEXT,
    id_fold TEXT NOT NULL,
    model_fold TEXT,
    source_fold TEXT,
    summary TEXT NOT NULL
);
CREATE INDEX sessions_recent ON sessions(deleted, activity DESC, id);
CREATE INDEX sessions_created ON sessions(deleted, created_at DESC, id);
CREATE INDEX sessions_visibility_recent ON sessions(visibility, activity DESC, id);
CREATE INDEX sessions_cwd_recent ON sessions(cwd, activity DESC, id);
CREATE INDEX sessions_owner ON sessions(owner_session_id) WHERE owner_session_id IS NOT NULL;
CREATE INDEX sessions_parent ON sessions(parent_session_id) WHERE parent_session_id IS NOT NULL;
CREATE INDEX sessions_dirty ON sessions(id) WHERE dirty = 1;
-- The search result order (archived last, newest activity, localeCompare id), over the
-- searchable rows only: serves the empty query and short needles.
CREATE INDEX sessions_search_order ON sessions(deleted, archived, activity DESC, id_key)
    WHERE classification IN ('task','project');
CREATE INDEX sessions_title_kind ON sessions(title_kind) WHERE title_kind IS NOT NULL;

-- Session search: a needle is a substring of one of the seven folded fields. A trigram
-- index over them (the writer folds, so the tokenizer stays case-sensitive and a phrase
-- match is exactly a substring test within one field). Maintained by triggers inside
-- the catalog writer's transactions.
CREATE VIRTUAL TABLE session_search USING fts5(
    title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold,
    content='sessions', content_rowid='sid', tokenize='trigram case_sensitive 1'
);
CREATE TRIGGER session_search_insert AFTER INSERT ON sessions BEGIN
    INSERT INTO session_search(rowid, title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold)
        VALUES (NEW.sid, NEW.title_fold, NEW.preview_fold, NEW.cwd_fold, NEW.project_fold, NEW.id_fold,
                NEW.model_fold, NEW.source_fold);
END;
CREATE TRIGGER session_search_delete AFTER DELETE ON sessions BEGIN
    INSERT INTO session_search(session_search, rowid, title_fold, preview_fold, cwd_fold, project_fold, id_fold,
            model_fold, source_fold)
        VALUES ('delete', OLD.sid, OLD.title_fold, OLD.preview_fold, OLD.cwd_fold, OLD.project_fold, OLD.id_fold,
                OLD.model_fold, OLD.source_fold);
END;
CREATE TRIGGER session_search_update
    AFTER UPDATE OF title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold ON sessions
BEGIN
    INSERT INTO session_search(session_search, rowid, title_fold, preview_fold, cwd_fold, project_fold, id_fold,
            model_fold, source_fold)
        VALUES ('delete', OLD.sid, OLD.title_fold, OLD.preview_fold, OLD.cwd_fold, OLD.project_fold, OLD.id_fold,
                OLD.model_fold, OLD.source_fold);
    INSERT INTO session_search(rowid, title_fold, preview_fold, cwd_fold, project_fold, id_fold, model_fold, source_fold)
        VALUES (NEW.sid, NEW.title_fold, NEW.preview_fold, NEW.cwd_fold, NEW.project_fold, NEW.id_fold,
                NEW.model_fold, NEW.source_fold);
END;

-- One row per `item` frame. (file_no, frame_offset, frame_len) locate the item frame;
-- amend_ordinal names the live `amend` whose body replaces it.
CREATE TABLE history (
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    iid TEXT NOT NULL,
    turn TEXT,
    form INTEGER NOT NULL CHECK (form IN (0,1)),
    model INTEGER NOT NULL CHECK (model IN (0,1)),
    visible INTEGER NOT NULL CHECK (visible IN (0,1)),
    file_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    frame_len INTEGER NOT NULL,
    amend_ordinal INTEGER,
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal)
) WITHOUT ROWID;
CREATE INDEX history_iid ON history(session, iid);
CREATE INDEX history_page ON history(session, ordinal) WHERE visible = 1 AND superseded_rev IS NULL;
CREATE INDEX history_model ON history(session, ordinal) WHERE model = 1 AND superseded_rev IS NULL;

-- One row per `amend` frame.
CREATE TABLE amends (
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    target_ordinal INTEGER NOT NULL,
    file_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    frame_len INTEGER NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal)
) WITHOUT ROWID;
CREATE INDEX amends_target ON amends(session, target_ordinal, ordinal);

-- One row per `compacted` frame. The checkpoint holds only the newest live one; a rewind
-- past it finds the next model-context start here.
CREATE TABLE compactions (
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    cid TEXT NOT NULL,
    file_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    frame_len INTEGER NOT NULL,
    -- Where the display divider sits: the ordinal of the oldest live model message row
    -- the replacement kept, else the compaction's own ordinal. The divider precedes the
    -- first displayed row at or above it.
    boundary INTEGER NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal)
) WITHOUT ROWID;
CREATE INDEX compactions_live ON compactions(session, ordinal) WHERE superseded_rev IS NULL;

-- The catalog's message state (FORMAT.md §8.2). Rows are immutable versions keyed by log
-- position: a message of the model context (a model `message` item, or one entry of a
-- `compacted` replacement, which takes the compaction's ordinal and `idx` = its position)
-- has a first version at `ver` = the frame's ordinal, and one more version per `amend`
-- (`ver` = the amend's ordinal). `live` marks the current version of a live row;
-- `superseded_rev` is the ordinal of the rewind that removed the version, so a rewind past
-- an amend brings the earlier version back. `place` is the row's 1-based place among the
-- counted rows of its epoch, fixed when it was written.
CREATE TABLE message_rows (
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    idx INTEGER NOT NULL,
    ver INTEGER NOT NULL,
    iid TEXT NOT NULL,
    counted INTEGER NOT NULL,
    real INTEGER NOT NULL,
    incoming INTEGER NOT NULL,
    place INTEGER NOT NULL,
    preview TEXT NOT NULL,
    line TEXT NOT NULL,
    routine TEXT NOT NULL,
    live INTEGER NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal, idx, ver)
) WITHOUT ROWID;
CREATE INDEX message_rows_iid ON message_rows(session, iid, ordinal);
CREATE INDEX message_rows_ver ON message_rows(session, ver) WHERE superseded_rev IS NULL;
CREATE INDEX message_rows_preview ON message_rows(session, ordinal, idx) WHERE live = 1 AND preview <> '';
CREATE INDEX message_rows_line ON message_rows(session, ordinal, idx) WHERE live = 1 AND line <> '';
CREATE INDEX message_rows_incoming ON message_rows(session, ordinal, idx) WHERE live = 1 AND incoming = 1;

-- Aggregates of one context epoch: the root (`start` 0) or a live `compacted` frame
-- (`start` = its ordinal). Adjusted by deltas on append, amend and rewind; the live epoch
-- is the newest not superseded. Counts include this session's own rows only.
CREATE TABLE message_epochs (
    session TEXT NOT NULL,
    start INTEGER NOT NULL,
    count INTEGER NOT NULL,
    real INTEGER NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, start)
) WITHOUT ROWID;

-- What a fork inherits: its base's state as of `position` (the fork point, or lower after
-- a rewind of the child into the base range), snapshotted once. Immutable once `ready`;
-- a later rewind or amend of the base never reaches it. Versioned by log position like
-- rows: `valid_from` is the frame that set it, a rewind past it supersedes it. A view
-- whose base was not exactly at `position` is `pending` while the maintenance steps scan
-- the base rows as of `position` from the cursor (`cur_*`); the accumulators carry the
-- partial state and `place_base` the base's own inherited count for absolute places.
CREATE TABLE message_views (
    session TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    base TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('ready','pending')),
    count INTEGER NOT NULL,
    real INTEGER NOT NULL,
    preview TEXT NOT NULL,
    line TEXT NOT NULL,
    routine TEXT NOT NULL,
    incoming TEXT NOT NULL,
    scan_from INTEGER NOT NULL,
    cur_ordinal INTEGER NOT NULL,
    cur_idx INTEGER NOT NULL,
    place_base INTEGER NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, valid_from)
) WITHOUT ROWID;
CREATE INDEX message_views_pending ON message_views(state) WHERE state = 'pending' AND superseded_rev IS NULL;

-- One row per run (`run` frames).
CREATE TABLE turns (
    session TEXT NOT NULL,
    rid TEXT NOT NULL,
    started_ordinal INTEGER NOT NULL,
    end_ordinal INTEGER,
    phase TEXT NOT NULL CHECK (phase IN ('started','completed','failed','interrupted')),
    superseded_rev INTEGER,
    PRIMARY KEY (session, rid)
) WITHOUT ROWID;
CREATE INDEX turns_order ON turns(session, started_ordinal);

-- Pending approvals of every session (the one cross-session enumerator).
CREATE TABLE approvals (
    session TEXT NOT NULL,
    aid TEXT NOT NULL,
    rid TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    file_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    frame_len INTEGER NOT NULL,
    PRIMARY KEY (session, aid)
) WITHOUT ROWID;

-- Every `refs` digest of every frame (FORMAT.md §4.3), written in the same transaction
-- as the history rows of those frames.
CREATE TABLE blob_refs (
    digest TEXT NOT NULL,
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (digest, session, ordinal)
) WITHOUT ROWID;
CREATE INDEX blob_refs_session ON blob_refs(session, ordinal);

-- Fork lineage: a base with children keeps its files.
CREATE TABLE fork_edges (
    base TEXT NOT NULL,
    child TEXT NOT NULL,
    PRIMARY KEY (base, child)
) WITHOUT ROWID;
CREATE INDEX fork_edges_child ON fork_edges(child);

-- Prompt history (the `promptHistoryList` of 1.4.5): every visible `user` message row's
-- prompt text, keyed by the JS rule `text.trim().replace(/\s+/g, ' ')`.
-- prompt_occurrences holds every occurrence (superseded by rewinds like history rows);
-- prompt_history holds, per key, the newest live occurrence, so the newest 50 distinct
-- prompts are one index range.
CREATE TABLE prompt_occurrences (
    session TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    key TEXT NOT NULL,
    text TEXT NOT NULL,
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal)
) WITHOUT ROWID;
CREATE INDEX prompt_occurrences_key ON prompt_occurrences(session, key, ordinal);
CREATE TABLE prompt_history (
    session TEXT NOT NULL,
    key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (session, key)
) WITHOUT ROWID;
CREATE INDEX prompt_history_recent ON prompt_history(session, ordinal);

-- Thread-scope op lookup (P §9.2); the record at (file_no, frame_offset) carries the op.
CREATE TABLE thread_ops (
    session TEXT NOT NULL,
    op_id TEXT NOT NULL,
    method TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('applied','rejected','fenced','externalPending','externalUnknown')),
    ordinal INTEGER NOT NULL,
    file_no INTEGER NOT NULL,
    frame_offset INTEGER NOT NULL,
    frame_len INTEGER NOT NULL,
    PRIMARY KEY (session, op_id)
) WITHOUT ROWID;
