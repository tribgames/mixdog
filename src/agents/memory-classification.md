# Memory Classification Shared

Shared category taxonomy referenced by the memory cycle agents (cycle1 chunker/classifier, cycle2 curator).

## Category grades

Higher grade = more permanent weight.

| grade | category | meaning |
|---|---|---|
| 2.0 | `rule` | permanent rules, identity, operating policies |
| 1.9 | `constraint` | hard limits (security / cost / time) |
| 1.8 | `decision` | agreed decisions |
| 1.6 | `fact` | verified facts / observed patterns |
| 1.5 | `goal` | long-term direction |
| 1.4 | `preference` | user taste / style |
| 1.1 | `task` | active work (volatile; rarely core) |
| 1.0 | `issue` | known problems (only if permanently relevant) |

When ambiguous, pick the higher-grade category that fits (rule > constraint > decision > fact > goal > preference > task > issue).

## Edge examples

| contrast | A | B |
|---|---|---|
| rule / constraint | rule: "Commit uses `YYYY-MM-DD HH:MM` prefix" | constraint: "Never push to main without approval" |
| decision / fact | decision: "Use bridge as the single agent entry point" | fact: "bridge dispatches via role mapping in user-workflow.json" |
| fact / preference | fact: "User prefers Korean replies" (verified, hard) | preference: "User prefers warm polite tone" (taste) |
| task / issue | task: "Implement chunk grouping in cycle1" | issue: "vec_memory has 6,000 stale rows" |
| goal / decision | goal: "Cut LLM cost 50% next quarter" | decision: "Drop semantic_cache to simplify" |
