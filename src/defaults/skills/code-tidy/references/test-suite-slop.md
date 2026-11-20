# Test-suite slop

Read this when tests are in scope. Pruning rules and the test workflow belong
to the `test-suite` skill (Prune); this file only adds the cleanup gate.

First tell redundant coverage from removing a supported behavior. Keep
distinct observable success, rejection, error, and compatibility cases. Before
removing a behavior and its tests, require independent evidence from current
requirements, real callers, or a specification; a test existing only for that
branch is neither proof of necessity nor permission to delete it. A closed
loop (a fallback justified by its test, a test justified by the fallback) is
no evidence either; unresolved intent blocks deletion.

Delete a test only when it is dominated (same branch and result as a stronger
test), tautological (cannot fail), a permutation crossing no new branch, or
verification theater (verifier and producer share one failure domain), or it
asserts a removal, a restated constant or copied production logic, and name
the test that still owns the contract. Deleting a contract test needs the
user's approval. Merging into an owner, rewriting source-text assertions, and
everything else follows `test-suite`.
