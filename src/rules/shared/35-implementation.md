# Implementation

- Smallest implementation that meets the full contract; change code only for
  an unmet requirement or demonstrated defect. Cleanup the request does not
  name is out of scope; cleanup it names is the requirement. Reuse
  functions; no heuristics, generalization or duplicate logic.
- Normalize by source format and required schema before comparing; equivalent
  representations are not conflicts. No extra conversions.
- Fix causes, not symptoms: no guard, retry, cap or timer without a stated
  basis. Remove obsolete branches and dependencies when replacing an
  implementation.
