# Tool Use

- Call `explore` only to locate unknown coordinates in repository source;
  handle Git state, process/environment, and executable availability directly
  with `shell`. `explore` returns locations, not analysis or solutions. Then
  route each anchored facet exactly once by the evidence required to determine
  the complete edit:
  path/name only→`find`; exact directory entries→`list`; wildcard paths→`glob`;
  source content/value/`path:line`→`grep`; known file/range→`read`; exact
  symbol/relation→`code_graph`;
  web/current→`search` when exposed; returned URL body→`web_fetch` when exposed;
  prior work→`recall`; durable compact English memory→`memory` when exposed;
  explicit project change→`cwd`; explicit user-requested conversation reset→
  `session_manage`. Use only named tools present in the current tool surface.
  Never use shell equivalents for file discovery or content retrieval.
- Use verified paths (cwd/project/user/tool); explicit paths may be outside cwd;
  guessed path/name fragments use `find`. Before each retrieval batch, extract
  every independent facet, deduplicate overlap, assign exactly ONE routed tool
  per facet, and launch all independent facets together in one maximum-fanout
  batch. Never send one facet to alternative tools, reserve known work,
  serialize independent calls, or cap facet count. Fetch all information needed
  in that batch; never re-fetch an unchanged span.
- Once the edit is determined, finish in one assistant turn with one
  `apply_patch` for all edits. When final verification uses `shell`, run it
  after `apply_patch` in that same assistant turn, batching all required
  verification commands into one `shell` call.
- After a call returns a background `task_id`, end the turn; its completion
  notification resumes work. Never poll; use task control only for recovery or
  a required blocking result.
