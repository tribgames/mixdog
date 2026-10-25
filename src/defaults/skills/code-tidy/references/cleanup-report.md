# Candidate list and report

Findings and risk tiers come from `agent-cleanup.md`; this file owns how they
are recorded and reported. Keep the list in the conversation, not a file.

## Candidates

One line per candidate, with a stable ID (`C-01`):

```text
[ID] path · symbol → problem → cost → action | tier: SAFE/CAREFUL/RISKY | confidence: high/medium/low | status: completed/kept/unfinished
```

- Register only a lens finding with a path+symbol location, a cost, and an
  action. A finding that cannot name its cost is a nit: drop it. Threshold
  hits (long files or functions, deep nesting) are signals, not candidates.
- Findings sharing a root cause group under one ID, each member keeping its
  path and symbol. Code moved by an extraction keeps its origin ID.
- Confidence is `low` when callers, contracts, and tests do not explain why
  the code exists; medium/low candidates stay unfinished until that question
  is resolved. Approval to apply does not authorize guessing.
- `completed` carries evidence of what changed; `kept` carries a concrete
  reason (keep rule or external contract); `unfinished` carries the blocker
  (pending, blocked, deferred, unverified).

Overall cleanup is complete only when every partition is done, the final
check has passed, and every candidate is completed or kept with evidence.
Otherwise report "overall partial" with the remaining paths and IDs.

## Final report

```text
Scope: <paths | whole project> · Mode: report|apply · Overall: complete|partial
Deterministic: engines used/missing · files changed · diagnostics remaining · structural applied/skipped
Completed:  [ID] path · symbol — [Lens/TIER] what changed
Kept:       [ID] path · symbol — reason
Unfinished: [ID] path · symbol — remaining work · status · next
Noticed, not applied (RISKY or out of scope): [ID] path · symbol — why · test coverage
Bugs found (not fixed here): <issues>
Verification: tests <result> · typecheck <result> · tidy check <remaining diagnostics> · pre-existing failures <list|none>
Blocked or unverified: <check> — <reason> → <paths>   (write "none" if none)
Needs your decision: <RISKY findings, bugs, unresolved intent, unfinished candidates>
```
