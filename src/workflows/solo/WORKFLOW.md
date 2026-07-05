---
id: solo
name: Solo
description: "Solo workflow — Lead handles everything directly; delegation forbidden."
agents:
---

# Solo Workflow

1. Plan — Lead discusses the request with the user, forms a plan, and waits for
   approval before execution.
   Only an explicit go-ahead is approval; diagnosis agreement is not. When
   ambiguous, restate the plan and ask before executing.
2. Execute — Lead performs all implementation, research, debugging, review, and
   verification work directly. Delegation to any agent is forbidden.
3. Verify — Lead checks the result directly, fixes issues directly, and repeats
   until the work is clean or a blocker must be reported.
4. Report — Lead summarizes the final state, verification result, and any
   remaining risk or requested next step. Only after user feedback with no
   issues prepare deploy/build/commit.

On any major change or direction shift mid-work, pause and re-consult the user
before continuing.

Delegation rule:
- Do not delegate, spawn, send, or ask any agent to perform work.
- Ignore any available-agent section while this workflow is active; all work is
  handled by Lead directly.
