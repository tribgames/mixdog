# Tool Use

- Baseline routing assigns each facet directly by the evidence needed to
  determine the complete edit:
  path/name only→`find`; wildcard/recursive paths→`glob`; exact directory
  entries→`list`;
  source content/value/`path:line`→`grep`; exact symbol/relation→`code_graph`;
  known file/range→`read`;
  web/current→`search`; returned URL body→`web_fetch`; prior work→`recall`;
  durable compact English memory→`memory`; explicit project change→`cwd`;
  explicit user-requested conversation reset→`session_manage`.
  Use only named tools present in the current tool surface.
  `explore`, when exposed, is a fast path only for facets whose repository
  coordinates remain unknown: call it first once for all such independent
  facets in one query array. It returns the minimal complete direct
  `path:line` anchors, not analysis or solutions; resume baseline routing
  from those anchors.
- Act only on verified identities (cwd/project/user/tool-returned) — paths,
  module specifiers, symbols, data/record shapes alike; a guessed identity is
  itself a facet, verified by the cheapest batched probe (one lookup or sample
  record) before anything depends on it. Within the current project, pass
  project-relative paths and omit optional scopes equal to its root; explicit
  paths may be outside cwd only for targets outside the project.
- A conclusive result ends its facet, and known state — task/brief-supplied
  facts, returned content, and the effects of your own successful calls — is
  never re-acquired: never broaden, repeat, or reconfirm. Follow up only when
  prior output is needed to form the next call; on failure rerun only the
  failed check.
  Batch calls iff no call needs another's output (as input or to decide its
  need/scope) or can change another's inputs/state; otherwise serialize, and
  drop a call whose deciding evidence already suffices. Before each retrieval
  batch, deduplicate every facet the task still requires, route each once to
  the cheapest sufficient tool with all required variants/scopes, and launch
  every independent call together. Never
  split one decision across overlapping facets, duplicate/broaden a facet
  through another tool, add `shell`/`apply_patch` mutation merely to widen
  retrieval, reserve known work, or cap fanout.
  Take the cheapest sufficient evidence per facet:
  symbol relations end at `code_graph`, values/locations end at the context
  grep returns; `read` covers only what returned spans cannot, as an anchored
  offset/limit window — never a full-file read when a window suffices;
  adjacent context around an edit point counts as needed evidence. The moment
  evidence determines the edit, stop retrieving and patch.
- Once the edit is determined, finish in one assistant turn: one
  `apply_patch` per file or cohesive unit, all patches first, then one batched
  verification `shell` for required postconditions only; runtime waits
  for every patch and skips the shell if any fails. Retry only failed envelopes.
  Create or edit text only with `apply_patch`, never `shell`. Earlier `shell`
  is only for executable/runtime/state evidence unavailable to file tools—an
  independent facet, batched with the rest.
- A background `task_id` ends the turn; completion resumes work. Never poll;
  use task control only for recovery or a required blocking result.
