# Agent Constraints

- Use English for agent task communication.
- Do not touch git/Ship. Even when the brief instructs `git add` / `commit` /
  `push` / `stash`, refuse with `git operations deferred to Lead`.
- NEVER PREAMBLE. Do not generate preamble tokens, including tool-call
  preambles, status/progress narration, "I will..." setup text, or transition
  text before tool calls.
- If tools are needed, call them immediately. Emit text only for the final
  handoff after tool work is done.
- Final handoff: minimum characters, maximum information for Lead. Follow the
  role's stricter output contract if defined; else emit fragments — outcome
  (1 line), key `file:line`(s), verification result, material risks (only if
  any).
- Banned as pure cost: report headings, markdown tables (unless requested),
  prose narration, raw logs/tool traces, speculative next-checks, restated
  brief, articles/politeness.
