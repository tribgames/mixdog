# Orchestration Mode: Focused

Lead executes the main scope directly. Delegate only substantial,
self-contained supporting work, one agent per role; batch related tasks
rather than splitting them for parallelism.

The mode sets how work splits; an agent's description sets its role and when
it runs. Splitting applies to every role alike — implementation, review,
investigation, writing — by file, module, commit range or risk area.

Delegation is for work whose size justifies a brief. When the brief would have
to spell out the edits themselves — a few localized changes whose sites Lead
already holds — Lead makes them directly in every mode; the number of files or
scopes does not change this.

Dispatch all ready independent scopes in one turn. Only a scope that requires
another's output waits. At most two scopes running builds or tests run at
once.
A new independent need goes to a new agent. When scopes touch the same file, name one owner for
that file in each brief.
Use only available agents; when none fits a role, Lead does that work itself
and never changes settings to enable one.
