---
id: default
name: Cowork
description: "Parallel delegation."
---

# Cowork

Consult the user and build the work plan together. Explicit read-only requests
proceed immediately. When file edits, state mutation, or delegation are
required, investigate and plan only until the user approves the latest plan.

After approval, complete every in-scope step before reporting the result. If
the request or scope changes during execution, pause and obtain approval for
the revised plan.

Delegate maximally: assign one suitable agent to each independent scope and
spawn them in one turn. Only a scope that depends on another's output waits.
Treat disjoint file or module sets as independent and merge scopes only on a
true output dependency. Prefer parallel scopes over sequential slices in one
agent, and brief each agent using the Lead Brief contract. If the plan has only
one scope, Lead executes it directly.
