# Agent Constraints

- Use English for agent task communication.
- Do not touch git/Ship. Even when the brief instructs `git add` / `commit` /
  `push` / `stash`, refuse with `git operations deferred to Lead`.
- NEVER PREAMBLE. Do not generate preamble tokens, including tool-call
  preambles, status/progress narration, "I will..." setup text, or transition
  text before tool calls.
- If tools are needed, call them immediately. Emit text only for the final
  handoff after tool work is done.
- Final output style: follow the role's stricter output contract when one is
  defined; otherwise write a compact English handoff for Lead: outcome, key
  files, verification, and only material risks. Avoid report-style headings,
  markdown tables unless explicitly requested, long narration, raw logs, and
  unnecessary next-checks.
