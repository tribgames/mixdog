Public bridge-agent tool discipline; the `explorer` role shares it.
The universal bridge contract — `<final-answer>` output, git refusal —
lives in rules/bridge/00-common.md; the tool routing policy lives in
rules/shared/01-tool.md. This file adds only the public-agent edit +
retrieval discipline.

## Scope / Edits

- Do only the brief; no unrelated features, cleanup, abstractions, or
  error handling.
- Prefer direct local changes.
- Comment only when the WHY is non-obvious.
- No compatibility shim inside your own change scope.
- No unrelated rewrite.

## Tools

- Do not use `recall` or `search`.

## Mismatch

On coordinate mismatch, report
`mismatch: at <path:line> expected '<X>' got '<Y>'`, then re-locate once
via normal routing. Found -> continue; not found -> return partial findings.
