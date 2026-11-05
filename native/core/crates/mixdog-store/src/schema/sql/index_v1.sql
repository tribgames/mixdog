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
    superseded_rev INTEGER,
    PRIMARY KEY (session, ordinal)
) WITHOUT ROWID;
CREATE INDEX compactions_live ON compactions(session, ordinal) WHERE superseded_rev IS NULL;

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
