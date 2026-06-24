// bridge-trace-queries.mjs — SQL helpers for the bridge analytic tables.
// All functions accept a `db` handle from openTraceDatabase() and return
// plain row arrays.  Query parameters are always $N — no interpolation.

// ---------------------------------------------------------------------------
// topSessionsByIteration(db, hours, limit)
// Sessions with the highest max_iteration seen in the last N hours.
// ---------------------------------------------------------------------------
export async function topSessionsByIteration(db, hours = 24, limit = 20) {
  const { rows } = await db.query(`
    SELECT s.session_id,
           s.role,
           s.model,
           s.max_iteration,
           s.tool_calls,
           s.llm_calls,
           s.total_input_tokens,
           s.total_output_tokens,
           s.started_at,
           s.last_seen_at
    FROM   bridge_sessions s
    WHERE  s.last_seen_at >= now() - ($1 || ' hours')::interval
    ORDER BY s.max_iteration DESC, s.tool_calls DESC
    LIMIT $2
  `, [String(hours), limit])
  return rows
}

// ---------------------------------------------------------------------------
// repeatToolCalls(db, sessionId)
// Tool calls whose (tool_name, md5(tool_args::text)) combo appears ≥3 times
// in a single session — strong signal for a tool-loop.
// ---------------------------------------------------------------------------
export async function repeatToolCalls(db, sessionId) {
  const { rows } = await db.query(`
    SELECT tool_name,
           md5(tool_args::text)    AS args_hash,
           COUNT(*)                AS call_count,
           MIN(ts)                 AS first_at,
           MAX(ts)                 AS last_at,
           (array_agg(tool_args ORDER BY ts))[1] AS sample_args
    FROM   bridge_calls
    WHERE  session_id = $1
      AND  tool_name  IS NOT NULL
    GROUP BY tool_name, md5(tool_args::text)
    HAVING COUNT(*) >= 3
    ORDER BY call_count DESC, tool_name
  `, [sessionId])
  return rows
}

// ---------------------------------------------------------------------------
// mixedToolPattern(db, sessionId)
// Sliding 3-tool window where grep and read alternate AND share a path token.
// Returns the centre-row of each such window.
// ---------------------------------------------------------------------------
export async function mixedToolPattern(db, sessionId) {
  const { rows } = await db.query(`
    WITH ordered AS (
      SELECT id, ts, tool_name,
             tool_args->>'path'                                      AS path,
             -- basename: last segment after splitting on '/'
             regexp_replace(tool_args->>'path', '^.*/', '')          AS basename,
             LAG (tool_name,          1) OVER (ORDER BY ts, id)     AS prev1,
             LAG (tool_name,          2) OVER (ORDER BY ts, id)     AS prev2,
             LEAD(tool_name,          1) OVER (ORDER BY ts, id)     AS next1,
             LAG (tool_args->>'path', 1) OVER (ORDER BY ts, id)     AS prev_path,
             LEAD(tool_args->>'path', 1) OVER (ORDER BY ts, id)     AS next_path,
             -- basenames of neighbours
             regexp_replace(LAG (tool_args->>'path', 1) OVER (ORDER BY ts, id), '^.*/', '') AS prev_base,
             regexp_replace(LEAD(tool_args->>'path', 1) OVER (ORDER BY ts, id), '^.*/', '') AS next_base
      FROM   bridge_calls
      WHERE  session_id = $1
        AND  tool_name IN ('grep','read')
    )
    SELECT id, ts, tool_name, path
    FROM   ordered
    WHERE  -- true 3-tool alternation: centre plus BOTH flanking neighbours (window size = 3)
           (
             (tool_name = 'read'  AND prev1 = 'grep' AND next1 = 'grep')
          OR (tool_name = 'grep'  AND prev1 = 'read' AND next1 = 'read')
           )
      -- path-token sharing: basename or exact path matches across all 3 slots
      AND basename IS NOT NULL
      AND (
            -- exact path shared with both neighbours
            (path = prev_path AND path = next_path)
            -- or basename shared with both neighbours
         OR (basename = prev_base AND basename = next_base)
            -- or mixed: exact on one side, basename on other
         OR (path = prev_path AND basename = next_base)
         OR (path = next_path AND basename = prev_base)
          )
    ORDER BY ts, id
  `, [sessionId])
  return rows
}

// ---------------------------------------------------------------------------
// tokenUsageByRole(db, hours)
// Sum of input/output tokens grouped by role over the last N hours.
// ---------------------------------------------------------------------------
export async function tokenUsageByRole(db, hours = 24) {
  const { rows } = await db.query(`
    SELECT s.role,
           COUNT(DISTINCT l.session_id)           AS sessions,
           SUM(l.input_tokens)                    AS total_input,
           SUM(l.output_tokens)                   AS total_output,
           SUM(l.cached_tokens)                   AS total_cached,
           SUM(l.cache_write_tokens)              AS total_cache_write,
           AVG(l.input_tokens)::int               AS avg_input_per_call,
           AVG(l.output_tokens)::int              AS avg_output_per_call
    FROM   bridge_llm l
    JOIN   bridge_sessions s USING (session_id)
    WHERE  l.ts >= now() - ($1 || ' hours')::interval
    GROUP BY s.role
    ORDER BY total_input DESC NULLS LAST
  `, [String(hours)])
  return rows
}
