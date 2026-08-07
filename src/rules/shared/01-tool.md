# Tool Use

- Unknown coordinates → one `explore` call with every unknown facet, sent
  alone. Then batch every anchored retrieval needed to determine the complete
  edit: partial path/name→`find`; exact directory entries→`list`; wildcard→
  `glob`; text/regex-anchored source blocks→`grep`; anchorless known file/range→
  `read`; symbol/relation→`code_graph`; web/current→`search`; returned URL body→
  `web_fetch`; prior work→`recall`; durable compact English memory→`memory`;
  explicit project change→`cwd`; explicit user-requested conversation reset→
  `session_manage`; process/env, git, build/run/test→`shell`. Call `shell` only
  when the task actually requires one of those operations; do not treat it as
  a routine investigation or completion step. Never use shell equivalents for
  file discovery or content retrieval.
- Use verified paths (cwd/project/user/tool); explicit paths may be outside cwd;
  guessed fragments use `find`. Maximize fan-out across routed retrieval tools
  and fetch all information needed in one batch; never re-fetch an unchanged
  span.
- Once the edit is determined, finish in one assistant turn with one
  `apply_patch` for all edits. If final verification actually requires `shell`,
  use one verification chain after the edit; otherwise finish without it.
- After a call returns a background `task_id`, end the turn; its completion
  notification resumes work. Never poll; use task control only for recovery or
  a required blocking result.
