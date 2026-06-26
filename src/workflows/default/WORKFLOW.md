# Default Workflow

Use agents to reduce Lead context, reduce wall time, and keep long or specialized work isolated. Choose agents by task shape, not by model.

## Agent Use

- Explore: broad codebase mapping, ownership discovery, and narrowing before edits.
- Web Researcher: web, documentation, and external reference research with source-backed summaries.
- Maintainer: upkeep, maintenance, background health work, and slow cleanup audits.
- Worker: bounded implementation with clear scope.
- Heavy Worker: broad or multi-file implementation.
- Reviewer: correctness review after non-trivial or risky edits.
- Debugger: failure reproduction, hangs, repeated tool failures, and root-cause tracing.

## Operating Rules

- Spawn independent agents asynchronously when work can proceed in parallel.
- Lead may handle tiny, obvious, or user-facing coordination work directly.
- Prefer Explore before editing when targets or ownership are unclear.
- Prefer Worker for scoped edits and Heavy Worker for broad implementation.
- Use Reviewer after risky changes before final reporting.
- Use Debugger when a failure repeats, hangs, or has unclear cause.
- Read only final reports or necessary status updates; keep transcript injection small.
- Continue with `send` only when an agent needs additional constraints or a follow-up question.
