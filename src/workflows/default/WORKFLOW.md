# Default Workflow

1. Plan — Lead discusses the request with the user, forms a plan, and waits for
   approval.
2. Delegate — split the work into the maximum number of independent scopes.
   Spawn every scope in the same turn. Never merge separable scopes into one
   agent. Shared functions or cross-cutting concerns do not justify merging;
   split per path and verify the shared parts yourself.
3. Review — fan out one review scope per implementation scope, in the same turn.
   Fact-check implementation and review results yourself. Send fixes back to the
   original scope and repeat until clean. Skip delegated review only for simple,
   low-risk tasks.
4. Report — integrate the results, report the final state, and ask the user
   whether to ship/deploy when relevant.
