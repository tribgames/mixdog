// Batched unnest INSERTs for one agent trace batch; each runs inside the
// caller's transaction and is a no-op for an empty input.

export async function insertToolRows(client, toolRows) {
  if (toolRows.length === 0) return;
  await client.query(
    `INSERT INTO agent_calls (session_id,iteration,ts,tool_name,tool_kind,tool_ms,tool_args,result_kind,result_error_category,result_error_first_line)
       SELECT u.session_id, u.iteration::int, u.ts::timestamptz,
              u.tool_name, u.tool_kind, u.tool_ms::int, u.tool_args::jsonb,
              u.result_kind, u.result_error_category, u.result_error_first_line
       FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::text[],$6::int[],$7::text[],$8::text[],$9::text[],$10::text[])
            AS u(session_id,iteration,ts,tool_name,tool_kind,tool_ms,tool_args,result_kind,result_error_category,result_error_first_line)`,
    [
      toolRows.map((r) => r.session_id),
      toolRows.map((r) => r.iteration),
      toolRows.map((r) => r.ts),
      toolRows.map((r) => r.tool_name),
      toolRows.map((r) => r.tool_kind),
      toolRows.map((r) => r.tool_ms),
      toolRows.map((r) => (r.tool_args != null ? JSON.stringify(r.tool_args) : null)),
      toolRows.map((r) => r.result_kind),
      toolRows.map((r) => r.result_error_category),
      toolRows.map((r) => r.result_error_first_line),
    ]
  );
}

export async function insertLlmRows(client, llmRows) {
  if (llmRows.length === 0) return;
  await client.query(
    `INSERT INTO agent_llm (session_id,iteration,ts,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,prompt_tokens,response_id)
       SELECT u.session_id, u.iteration::int, u.ts::timestamptz,
              u.model, u.input_tokens::int, u.output_tokens::int,
              u.cached_tokens::int, u.cache_write_tokens::int,
              u.prompt_tokens::int, u.response_id
       FROM unnest($1::text[],$2::int[],$3::text[],$4::text[],$5::int[],$6::int[],$7::int[],$8::int[],$9::int[],$10::text[])
            AS u(session_id,iteration,ts,model,input_tokens,output_tokens,cached_tokens,cache_write_tokens,prompt_tokens,response_id)`,
    [
      llmRows.map((r) => r.session_id),
      llmRows.map((r) => r.iteration),
      llmRows.map((r) => r.ts),
      llmRows.map((r) => r.model),
      llmRows.map((r) => r.input_tokens),
      llmRows.map((r) => r.output_tokens),
      llmRows.map((r) => r.cached_tokens),
      llmRows.map((r) => r.cache_write_tokens),
      llmRows.map((r) => r.prompt_tokens),
      llmRows.map((r) => r.response_id),
    ]
  );
}

// Coalesced agent_sessions upsert: every session of the batch in one unnest.
export async function upsertAgentSessions(client, sessions) {
  if (sessions.size === 0) return;
  const rows = [...sessions.values()];
  await client.query(
    `
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
    `,
    [
      [...sessions.keys()],
      rows.map((s) => s.agent),
      rows.map((s) => s.model),
      rows.map((s) => s.ts0),
      rows.map((s) => s.ts1),
      rows.map((s) => s.tool_calls),
      rows.map((s) => s.llm_calls),
      rows.map((s) => s.max_iteration),
      rows.map((s) => String(s.total_input)),
      rows.map((s) => String(s.total_output)),
    ]
  );
}
