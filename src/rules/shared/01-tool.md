# Tool Use

- Independent lookups MUST batch in one turn; serialize only when a call needs
  a prior result. This includes edit loops: batch the post-edit verification
  read with the next target's lookup instead of emitting single-call turns.
- Target validity comes first: symbols/callers/deps → `code_graph`; exact text in
  a verified scope → `grep`; unknown path/name → `find`; structure → `glob`;
  dirs → `list`; verified file → `read`; broad unknown with no anchor →
  `explore`. Never call `grep`/`read` on guessed paths.
- Concept normalization comes first: one concept gets one batched
  `grep pattern:[...]` with `output_mode:"content_with_context"` (or one
  `code_graph symbols[]`). Refine from returned paths; do not repeat equivalent
  patterns or scopes.
- On miss/error, normalize the target once and switch tool; on a plausible hit,
  stop searching and answer from the framed context.
- Lookup budget: retrieval exists to reach the NEXT action (edit, answer,
  handoff), not to build certainty. One anchor is enough to act on; re-reading
  or re-grepping an area you already saw this session is waste. When acting
  and looking are both possible, act.
- Avoid read fragmentation: `read` uses `offset`/`limit` only. If you need 2+
  spans from one or more known files, make one batched `read` call with
  `{path,offset,limit}` region objects instead of serial reads. Adjacent spans
  in the same file (within a few hundred lines) are ONE window, not repeated
  reads.
- Don't mix `apply_patch` with shell or other state-changing calls in one turn.
