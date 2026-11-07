//! Node's trace-store SQL, generated from the recorded golden by benchmarks/rust-core/recorders/
//! gen-trace-store-sql.mjs (do not edit by hand): the text is what `trace-store.mjs` sends, byte for byte.

/// Per-connection path of the trace schema (`adapter.mjs` `_initClient`).
pub(super) const SET_SEARCH_PATH: &str = r#"SET search_path = trace, public"#;
/// Session-scoped bootstrap lock, non-blocking first.
pub(super) const TRY_LOCK: &str = r#"SELECT pg_try_advisory_lock(hashtext('mixdog.trace_bootstrap')) AS locked"#;
/// Releases the bootstrap lock.
pub(super) const UNLOCK: &str = r#"SELECT pg_advisory_unlock(hashtext('mixdog.trace_bootstrap'))"#;
/// `isBootstrapComplete`.
pub(super) const IS_BOOTSTRAP_COMPLETE: &str = r#"
      SELECT 1 WHERE
        -- (a) partitioned root exists
        EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_partitioned_table pt ON pt.partrelid = c.oid
          WHERE n.nspname = 'trace' AND c.relname = 'trace_events'
        )
        -- (b) schema-version columns present
        AND EXISTS (
          SELECT 1 FROM pg_attribute a
          JOIN pg_class c ON c.oid = a.attrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'trace' AND c.relname = 'trace_events'
            AND a.attname IN ('parent_span_id', 'entry_id')
            AND a.attnum > 0 AND NOT a.attisdropped
          HAVING count(*) = 2
        )
        -- (c) BRIN index exists
        AND EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'trace' AND indexname = 'idx_trace_ts_brin'
        )
        -- (d) at least one partition (named-month or default catch-all) exists
        AND EXISTS (
          SELECT 1 FROM pg_inherits i
          JOIN pg_class cp ON cp.oid = i.inhparent
          JOIN pg_namespace n ON n.oid = cp.relnamespace
          WHERE n.nspname = 'trace' AND cp.relname = 'trace_events'
        )
    "#;
/// `maybeDropLegacyTable`: the lookup.
pub(super) const LEGACY_TABLE_LOOKUP: &str = r#"
    SELECT c.relname
    FROM   pg_class c
    JOIN   pg_namespace n ON n.oid = c.relnamespace
    WHERE  n.nspname = 'trace'
      AND  c.relname = 'trace_events'
      AND  c.relkind = 'r'           -- ordinary (non-partitioned) table only
      AND  c.oid NOT IN (
             SELECT partrelid FROM pg_partitioned_table
           )
  "#;
/// `maybeDropLegacyTable`: the drop.
pub(super) const DROP_LEGACY_TABLE: &str = r#"DROP TABLE trace.trace_events CASCADE"#;
/// `init`: partitioned root, default partition, previous month.
pub(super) const INIT_TABLES: [&str; 3] = [
    r#"
    CREATE TABLE IF NOT EXISTS trace_events (
      id                 BIGSERIAL,
      ts                 BIGINT NOT NULL,
      session_id         TEXT,
      iteration          INTEGER,
      kind               TEXT NOT NULL,
      agent              TEXT,
      model              TEXT,
      tool_name          TEXT,
      tool_ms            INTEGER,
      result_kind        TEXT,
      result_error_category TEXT,
      result_error_first_line TEXT,
      input_tokens       INTEGER,
      output_tokens      INTEGER,
      cached_tokens      INTEGER,
      cache_write_tokens INTEGER,
      duration_ms        INTEGER,
      error_message      TEXT,
      payload            JSONB NOT NULL,
      parent_span_id     BIGINT,
      entry_id           BIGINT,
      PRIMARY KEY (id, ts)
    ) PARTITION BY RANGE (ts)
  "#,
    r#"
    CREATE TABLE IF NOT EXISTS trace_events_default
      PARTITION OF trace_events DEFAULT
  "#,
    r#"
    DO $$
    DECLARE
      prev_start  BIGINT := extract(epoch from date_trunc('month', now() - interval '1 month'))::BIGINT * 1000;
      prev_end    BIGINT := extract(epoch from date_trunc('month', now()))::BIGINT * 1000;
      prev_name   TEXT   := 'trace_events_' || to_char(now() - interval '1 month', 'YYYY_MM');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = prev_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          prev_name, prev_start, prev_end
        );
      END IF;
    END $$
  "#,
];
/// `migrateSchemaDrift`, BEGIN to COMMIT.
pub(super) const DRIFT: [&str; 11] = [
    r#"BEGIN"#,
    r#"SET LOCAL lock_timeout = '5s'"#,
    r#"ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS agent TEXT"#,
    r#"ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_kind TEXT"#,
    r#"ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_error_category TEXT"#,
    r#"ALTER TABLE IF EXISTS trace_events ADD COLUMN IF NOT EXISTS result_error_first_line TEXT"#,
    r#"ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_kind TEXT"#,
    r#"ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_error_category TEXT"#,
    r#"ALTER TABLE IF EXISTS agent_calls ADD COLUMN IF NOT EXISTS result_error_first_line TEXT"#,
    r#"ALTER TABLE IF EXISTS agent_sessions ADD COLUMN IF NOT EXISTS agent TEXT"#,
    r#"COMMIT"#,
];
/// `init`: the trace_events indexes.
pub(super) const INIT_INDEXES: [&str; 8] = [
    r#"CREATE INDEX IF NOT EXISTS idx_trace_ts_brin      ON trace_events USING BRIN (ts) WITH (pages_per_range = 32)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_kind_ts     ON trace_events(kind, ts DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS "idx_trace_session" ON "trace"."trace_events"
        USING hash (session_id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_agent_ts    ON trace_events(agent, ts DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_model_ts    ON trace_events(model, ts DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_tool        ON trace_events(tool_name) WHERE kind = 'tool'"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_parent      ON trace_events(parent_span_id) WHERE parent_span_id IS NOT NULL"#,
    r#"CREATE INDEX IF NOT EXISTS idx_trace_entry       ON trace_events(entry_id)       WHERE entry_id IS NOT NULL"#,
];
/// `ensureCurrentAndNextMonthPartitions`.
pub(super) const ENSURE_PARTITIONS: &str = r#"
    DO $$
    DECLARE
      cur_start  BIGINT := extract(epoch from date_trunc('month', now()))::BIGINT * 1000;
      cur_end    BIGINT := extract(epoch from date_trunc('month', now() + interval '1 month'))::BIGINT * 1000;
      next_start BIGINT := extract(epoch from date_trunc('month', now() + interval '1 month'))::BIGINT * 1000;
      next_end   BIGINT := extract(epoch from date_trunc('month', now() + interval '2 months'))::BIGINT * 1000;
      cur_name   TEXT   := 'trace_events_' || to_char(now(), 'YYYY_MM');
      next_name  TEXT   := 'trace_events_' || to_char(now() + interval '1 month', 'YYYY_MM');
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = cur_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          cur_name, cur_start, cur_end
        );
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'trace' AND c.relname = next_name
      ) THEN
        EXECUTE format(
          'CREATE TABLE %I PARTITION OF trace_events FOR VALUES FROM (%s) TO (%s)',
          next_name, next_start, next_end
        );
      END IF;
    END $$
  "#;
/// `initAgentTables` between its two drift repairs.
pub(super) const AGENT_TABLES: [&str; 13] = [
    r#"
    CREATE TABLE IF NOT EXISTS agent_calls (
      id           BIGSERIAL PRIMARY KEY,
      session_id   TEXT        NOT NULL,
      iteration    INT,
      ts           TIMESTAMPTZ NOT NULL,
      tool_name    TEXT,
      tool_kind    TEXT,
      tool_ms      INT,
      tool_args    JSONB,
      result_kind  TEXT,
      result_error_category TEXT,
      result_error_first_line TEXT
    )
  "#,
    r#"CREATE INDEX IF NOT EXISTS "idx_ac_session" ON "trace"."agent_calls"
        USING hash (session_id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_ac_ts        ON agent_calls USING BRIN (ts)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_ac_tool_name ON agent_calls (tool_name)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_ac_errors_ts ON agent_calls (ts DESC) WHERE result_kind = 'error'"#,
    r#"CREATE INDEX IF NOT EXISTS idx_ac_args_md5  ON agent_calls (session_id, tool_name, md5(tool_args::text))"#,
    r#"CREATE INDEX IF NOT EXISTS idx_ac_args_path ON agent_calls (session_id, tool_name, (tool_args->>'path'), ts, id)"#,
    r#"DROP INDEX IF EXISTS idx_ac_args"#,
    r#"
    CREATE TABLE IF NOT EXISTS agent_llm (
      id                 BIGSERIAL PRIMARY KEY,
      session_id         TEXT        NOT NULL,
      iteration          INT,
      ts                 TIMESTAMPTZ NOT NULL,
      model              TEXT,
      input_tokens       INT,
      output_tokens      INT,
      cached_tokens      INT,
      cache_write_tokens INT,
      prompt_tokens      INT,
      response_id        TEXT
    )
  "#,
    r#"CREATE INDEX IF NOT EXISTS "idx_al_session" ON "trace"."agent_llm"
        USING hash (session_id)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_al_ts      ON agent_llm USING BRIN (ts)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_al_model   ON agent_llm (model)"#,
    r#"
    CREATE TABLE IF NOT EXISTS agent_sessions (
      session_id          TEXT        PRIMARY KEY,
      agent               TEXT,
      model               TEXT,
      started_at          TIMESTAMPTZ,
      last_seen_at        TIMESTAMPTZ,
      tool_calls          INT         NOT NULL DEFAULT 0,
      llm_calls           INT         NOT NULL DEFAULT 0,
      max_iteration       INT         NOT NULL DEFAULT 0,
      total_input_tokens  BIGINT      NOT NULL DEFAULT 0,
      total_output_tokens BIGINT      NOT NULL DEFAULT 0
    )
  "#,
];
/// `dropAgedTracePartitions` ({days} is the retention days).
pub(super) const DROP_AGED_PARTITIONS: &str = r#"
    DO $$
    DECLARE
      cutoff   TEXT := to_char(now() - interval '{days} days', 'YYYY_MM');
      part     RECORD;
    BEGIN
      FOR part IN
        SELECT c.relname
        FROM   pg_class c
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  n.nspname = 'trace'
          AND  c.relname ~ '^trace_events_[0-9]{4}_[0-9]{2}$'
          AND  substring(c.relname from 'trace_events_(.*)') < cutoff
      LOOP
        EXECUTE format('DROP TABLE IF EXISTS trace.%I', part.relname);
      END LOOP;
    END $$
  "#;
/// `pruneAgedTraceRows`: trace_events.
pub(super) const PRUNE_TRACE_EVENTS: &str = r#"WITH doomed AS (
              SELECT tableoid, ctid FROM trace_events
               WHERE ts < $1 LIMIT $2
            )
            DELETE FROM trace_events target USING doomed
             WHERE target.tableoid = doomed.tableoid AND target.ctid = doomed.ctid"#;
/// `pruneAgedTraceRows`: the other tables; `{table}` is replaced.
pub(super) const PRUNE_TABLE_TEMPLATE: &str = r#"DELETE FROM {table}
             WHERE id = ANY(ARRAY(
               SELECT id FROM {table}
                WHERE ts < to_timestamp($1 / 1000.0) LIMIT $2
             ))"#;
/// `insertToolRows`.
pub(super) const INSERT_TOOL_ROWS: &str = r#"INSERT INTO agent_calls (session_id,iteration,ts,tool_name,tool_kind,tool_ms,tool_args,result_kind,result_error_category,result_error_first_line)
       SELECT u.session_id, u.iteration::int, u.ts::timestamptz,
              u.tool_name, u.tool_kind, u.tool_ms::int, u.tool_args::jsonb,
              u.result_kind, u.result_error_category, u.result_error_first_line
       FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],$8::text[],$9::text[],$10::text[])
            AS u(session_id,iteration,ts,tool_name,tool_kind,tool_ms,tool_args,result_kind,result_error_category,result_error_first_line)"#;
/// `insertLlmRows`.
pub(super) const INSERT_LLM_ROWS: &str = r#"INSERT INTO agent_llm (session_id,iteration,ts,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,prompt_tokens,response_id)
       SELECT u.session_id, u.iteration::int, u.ts::timestamptz,
              u.model, u.input_tokens::int, u.output_tokens::int,
              u.cached_tokens::int, u.cache_write_tokens::int,
              u.prompt_tokens::int, u.response_id
       FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::int[],$8::int[],$9::int[],$10::text[])
            AS u(session_id,iteration,ts,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,prompt_tokens,response_id)"#;
/// `upsertAgentSessions`.
pub(super) const UPSERT_SESSIONS: &str = r#"
      INSERT INTO agent_sessions (session_id, agent, model, started_at, last_seen_at, tool_calls, llm_calls, max_iteration, total_input_tokens, total_output_tokens)
      SELECT u.session_id, u.agent, u.model,
             u.started_at::timestamptz, u.last_seen_at::timestamptz,
             u.tool_calls::int, u.llm_calls::int, u.max_iteration::int,
             u.total_input_tokens::bigint, u.total_output_tokens::bigint
      FROM unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::int[],$7::int[],$8::int[],$9::text[],$10::text[])
           AS u(session_id,agent,model,started_at,last_seen_at,tool_calls,llm_calls,max_iteration,total_input_tokens,total_output_tokens)
      ON CONFLICT (session_id) DO UPDATE SET
        agent               = COALESCE(EXCLUDED.agent, agent_sessions.agent),
        model               = COALESCE(EXCLUDED.model, agent_sessions.model),
        started_at          = LEAST(agent_sessions.started_at, EXCLUDED.started_at),
        last_seen_at        = GREATEST(agent_sessions.last_seen_at, EXCLUDED.last_seen_at),
        tool_calls          = agent_sessions.tool_calls + EXCLUDED.tool_calls,
        llm_calls           = agent_sessions.llm_calls  + EXCLUDED.llm_calls,
        max_iteration       = GREATEST(agent_sessions.max_iteration, EXCLUDED.max_iteration),
        total_input_tokens  = agent_sessions.total_input_tokens  + EXCLUDED.total_input_tokens,
        total_output_tokens = agent_sessions.total_output_tokens + EXCLUDED.total_output_tokens
    "#;
/// `cleanupTraceWhenDisabled`: is there a trace schema.
pub(super) const TRACE_NAMESPACE_PRESENT: &str = r#"
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = 'trace'
      ) AS present
    "#;
/// `cleanupTraceWhenDisabled`: drop it.
pub(super) const DROP_TRACE_SCHEMA: &str = r#"DROP SCHEMA trace CASCADE"#;
