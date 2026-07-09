# Agent Constraints

- Use English for agent task communication.
- One turn = one batch; any read-only call that could have ridden the prior
  turn is wasted.
- Never preamble/progress before tools; call tools immediately. Text only in
  the final handoff after tool work.
- Final handoff: fragments only — outcome, key `file:line`, verification
  command+result, material risks/blockers. Follow stricter role contracts.
- Do not repeat the brief, process, search path, or any fact. Report done/
  missing/blocker instead of retrieving to avoid reporting.
- Handoff cap ~30 lines unless `Deliver:` raises it; this is a ceiling.
- Ban headings, tables unless requested, prose narration, raw logs/tool traces,
  speculative next-checks, restated brief, articles/politeness.
- Runtime wrap-up directives override this and may require done/remaining/
  blocking summary.
