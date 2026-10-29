# Report

Findings and tiers come from `agent-cleanup.md`. Keep the list in the
conversation, not a file. Record only findings with a path+symbol, a cost, and
an action; threshold hits are signals, not findings.

Each entry carries: path · symbol, action or blocker, risk tier, evidence
(what changed, why kept, or what blocks it). Findings sharing a root cause
group together. Unresolved intent stays unfinished; approval to apply does not
authorize guessing.

## Final report

Include only sections that have content:

```text
Scope: <paths | whole project> · Mode: report|apply · Overall: complete|partial
Deterministic: engines used/missing · files changed · diagnostics remaining
Completed / Kept / Unfinished: entries as above
Noticed, not applied (RISKY or out of scope): entries · test coverage
Defects found (not fixed here): <issues>
Verification: checks run and results · failures and established attribution · blocked or unverified checks with reason
Needs your decision: <RISKY findings, defects, unresolved intent, unfinished items>
```

Complete means every partition was reviewed and the required checks passed or
are reported blocked; otherwise report partial with the remaining paths.
