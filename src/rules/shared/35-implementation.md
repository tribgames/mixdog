# Implementation

- Stop at the smallest implementation satisfying the full contract. Change
  code only for an unmet requirement or demonstrated defect, never optional
  cleanup. Reuse functions; avoid heuristics, generalization and duplicate logic.
- Normalize by source formats and required schema before comparing/selecting;
  equivalent representations are not conflicts. Invent no extra conversions.
- Fix causes, not symptom-specific exceptions. Remove obsolete branches and
  dependencies when replacing an implementation.
