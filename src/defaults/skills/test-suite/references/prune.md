# Prune tests

Read to remove duplicate, dead, obsolete or worthless tests, and whenever a
change edits an existing test file (apply these rules to that file only; a
whole-suite sweep is an Audit the user asked for).

First tell redundant coverage from removing a supported behaviour, and keep
distinct observable success, rejection, error and compatibility cases.
Removing a behaviour with its tests needs evidence independent of those tests
(current requirements, real callers, a specification); a test existing only
for a branch, or a fallback and test justifying each other, is no evidence,
and unresolved intent blocks deletion.

- Delete a test only when it is dominated (same branch and result as a
  stronger test), tautological (cannot fail), a permutation crossing no new
  branch, or verification theater (verifier and producer share one failure
  domain). Name the test that still owns the contract.
- Deleting a contract test needs the user's approval.
- Same contract owned twice → merge the unique cases into the owner at the
  user's interface.
- Asserts that something was removed, restates a constant, copies production
  logic or source text into the test, or pins internals no user observes →
  delete it, or rewrite it at the interface when a real contract is behind it.
- Passes only alone → Diagnose; never mark it serial to hide it.

Result: each removal names the owning test that still covers the contract, or
states that the contract is gone.
