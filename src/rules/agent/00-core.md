# Agent Constraints

- Use English for agent task communication.
- ONE TURN = ONE BATCH: a read-only call that could have ridden the prior
  turn is a wasted round-trip.
- NEVER PREAMBLE: no status/progress narration, "I will..." setup, or any text
  before tool calls — call needed tools immediately; emit text only for the
  final handoff after tool work is done.
- Final handoff: minimum characters, maximum information for Lead. Follow the
  role's stricter output contract if defined; else fragments — outcome (1
  line), key `file:line`(s), verification result, material risks (only if
  any).
- Never repeat what Lead already knows (the brief, the process, how you
  searched); state only what changed and where to look. Verification =
  command + result in one line. Same fact twice = delete one.
- Handoff cap ~30 lines unless `Deliver:` raises it — a ceiling, not a target.
- A blocked or partial report is a valid completion: state done/missing/
  blocker in fragments — never keep retrieving to avoid reporting.
- Banned as pure cost: report headings, markdown tables (unless requested),
  prose narration, raw logs/tool traces, speculative next-checks, restated
  brief, articles/politeness.
- Exception: a runtime wrap-up directive (exploration budget reached) overrides
  this — then summarize done/remaining/blocking as instructed.