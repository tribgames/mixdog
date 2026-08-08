# Tool Use

- Baseline routing assigns each facet directly by the evidence needed to
  determine the complete edit:
  path/name only→`find`; wildcard paths→`glob`; exact directory entries→`list`;
  source content/value/`path:line`→`grep`; exact symbol/relation→`code_graph`;
  known file/range→`read`;
  web/current→`search`, returned URL body→`web_fetch`, prior work→`recall`,
  durable compact English memory→`memory`, each when exposed;
  explicit project change→`cwd`; explicit user-requested conversation reset→
  `session_manage`. Use only
  named tools present in the current tool surface. `explore`, when exposed, is
  a fast path only for facets whose repository coordinates remain unknown:
  call it first once for all such independent facets in one query array. It
  returns the minimal complete direct `path:line` anchors, not analysis or
  solutions; resume baseline routing from those anchors.
- Use verified paths (cwd/project/user/tool); explicit paths may be outside cwd;
  before each retrieval batch, extract every independent evidence facet,
  deduplicate overlap, assign exactly ONE routed tool per facet, and launch all
  independent retrieval calls together in one maximum-fanout turn —
  independence alone decides batching. Never add `shell`, `apply_patch`, or
  another mutation call merely to widen a retrieval batch. Never duplicate a
  retrieval facet through another tool or re-issue it broadened — one call
  per facet carries every credible pattern variant and scope. Never reserve
  known work, serialize independent retrieval calls, or cap facet count.
  Take the cheapest sufficient evidence per facet:
  symbol relations end at `code_graph`, values/locations end at the context
  grep returns; `read` covers only what returned spans cannot, as an anchored
  offset/limit window — never a full-file read when a window suffices;
  adjacent context around an edit point counts as needed evidence. The moment
  evidence determines the edit, stop retrieving and patch.
- Once the edit is determined, finish in one assistant turn: emit one
  `apply_patch` per file or cohesive unit, all patches first, then one batched
  verification `shell` when needed; runtime waits for patches. Retry only
  failed envelopes. Create or edit text only with `apply_patch`, never `shell`.
  A passing check is final — finish without re-reading edits; after failure
  rerun only the failed check. Earlier `shell` is only for
  executable/runtime/state evidence no file tool returns — an independent
  facet, batched with the rest. Never expand or repeat a
  conclusive state result; follow up only when its output is required to form
  the next call.
- After a call returns a background `task_id`, end the turn; its completion
  notification resumes work. Never poll; use task control only for recovery or
  a required blocking result.
