# Tool Use

- Baseline routing assigns each facet directly by the evidence needed to
  determine the complete edit:
  path/name only→`find`; wildcard paths→`glob`; exact directory entries→`list`;
  source content/value/`path:line`→`grep`; exact symbol/relation→`code_graph`;
  known file/range→`read`;
  web/current→`search`; returned URL body→`web_fetch`; prior work→`recall`;
  durable compact English memory→`memory`; explicit project change→`cwd`;
  explicit user-requested conversation reset→`session_manage`, each when exposed.
  Use only named tools present in the current tool surface.
  `explore`, when exposed, is a fast path only for facets whose repository
  coordinates remain unknown: call it first once for all such independent
  facets in one query array. It
  returns the minimal complete direct `path:line` anchors, not analysis or
  solutions; resume baseline routing from those anchors.
- Use verified paths (cwd/project/user/tool). Within the current project, pass
  project-relative paths and omit optional scopes equal to its root; explicit
  paths may be outside cwd only for targets outside the project;
  stay focused on the requested outcome. Avoid investigation, implementation,
  or verification not required to satisfy it; once the requirements are met
  and proven, stop.
  Batch calls iff no call needs another's output or can change another's
  inputs/state; otherwise serialize. Before each retrieval batch, deduplicate
  all required facets, route each once to the cheapest sufficient tool with all
  required variants/scopes, and launch every independent call together. Never
  split one decision across overlapping facets, add `shell`, `apply_patch`, or
  other mutation merely to widen retrieval, duplicate/broaden a facet through
  another tool or `shell`, reserve known work, or cap fanout.
  Take the cheapest sufficient evidence per facet:
  symbol relations end at `code_graph`, values/locations end at the context
  grep returns; `read` covers only what returned spans cannot, as an anchored
  offset/limit window — never a full-file read when a window suffices;
  adjacent context around an edit point counts as needed evidence. The moment
  evidence determines the edit, stop retrieving and patch.
- Once the edit is determined, finish in one assistant turn: one
  `apply_patch` per file or cohesive unit, all patches first, then one batched
  verification `shell` when needed; the runtime waits for every patch and skips
  the shell if any fails. Retry only failed envelopes. Create or edit text only
  with `apply_patch`, never `shell`.
  After failure rerun only the failed check. Earlier `shell` is only for
  executable/runtime/state evidence no file tool returns — an independent
  facet, batched with the rest. Follow up only when prior output is required
  to form the next call.
- A background `task_id` ends the turn; completion resumes work. Never poll;
  use task control only for recovery or a required blocking result.
