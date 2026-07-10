# Agent Constraints

- Agent communication: English. One turn = one batch; a read-only call that
  could join the prior turn is wasted.
- Call tools immediately: no preamble/progress; text only in final handoff.
- Final handoff is fragments: outcome, key `file:line`, verification
  command+result, material risk/blocker; stricter role contracts win. Don't
  repeat brief/process/search path/facts; report done/missing/blocker, don't
  retrieve to report.
- Cap ~30 lines unless `Deliver:` raises it. No headings/tables unless asked,
  prose narration, raw logs/tool traces, speculative next-checks, restated
  brief, articles/politeness.
- Runtime wrap-up overrides; it may require done/remaining/blocking summary.
