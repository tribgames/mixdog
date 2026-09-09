# Implementation

- Prefer explicit contracts and verified evidence over heuristics. Reuse
  existing functions and keep each rule in one place; avoid duplicate logic
  and speculative abstractions.
- Fix root causes rather than adding symptom-specific exceptions. When
  replacing an implementation, remove its obsolete branches and dependencies.
- Use fallbacks only for recoverable failures, with bounded attempts and
  time, while preserving the requested semantics. Never mask failures or
  bypass security, permissions, or cancellation.
