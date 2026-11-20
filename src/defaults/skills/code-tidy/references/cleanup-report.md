# Report

Findings and tiers come from `agent-cleanup.md`. Keep the list in the
conversation, not a file. Record only findings with a path+symbol, a cost, and
an action; threshold hits are signals, not findings.

Order entries by severity: structural findings first (responsibility mixing,
ad-hoc conditionals, contract-level optionality or casts, oversized mixed
modules), then slop and dead code, then cosmetic items. Each structural entry
adds a one-line reader benefit.

Each entry carries: path · symbol, action or blocker, risk tier, evidence
(what changed, why kept, or what blocks it). Findings sharing a root cause
group together. Unresolved intent stays unfinished; approval to apply does not
authorize guessing.

## Final report

Include only sections that have content:

```text
Scope: <paths | whole project> · Mode: report|apply · Overall: complete|partial
Deterministic: engines used/missing (why tidy does not install each missing one, and the options) · files changed · diagnostics remaining
Unchecked: files per language with the reason, copied from the last `unprocessed`, never from memory
Coverage: units reviewed in depth, units covered by engines only, the cross-partition pass done or not
Completed / Kept / Unfinished: entries as above
Noticed, not applied (RISKY or out of scope): entries · test coverage
Defects found (not fixed here): <issues>
Verification: checks run and results · failures and established attribution · blocked or unverified checks with reason
Needs your decision: <RISKY findings, defects, unresolved intent, unfinished items>
```

Complete means every partition was reviewed and the required checks passed or
are reported blocked; otherwise report partial with the remaining paths.
