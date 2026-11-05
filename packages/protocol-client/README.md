# @mixdog/protocol-client

Mixdog protocol 2 client: handshake, typed calls, reconnect ladder, op reconciliation, blobs, the feed store and the `DesktopSessionState` fold.

## Folding in budgeted turns

A large `app/snapshot` or `thread/snapshot` does not fold in one turn of the thread the client runs on. The fold gives the thread back (`ConnectOptions.turn`: `budgetMs` 8 by default, `now`, `yieldTurn`) whenever the turn's budget is spent:

- **App snapshot:** staged section by section; the previous app state stays whole in the store until the staging is swapped in at once; the `section` changes are announced in budgeted chunks, `appSnapshot` last.
- **Thread snapshot:** folded by `ThreadReducer.initialSteps` (a generator that yields where its work divides; `sessionReducer` yields every 16 items); the previous fold stays until the swap, then one `thread` change.
- **Both:** later notifications of the feed wait behind the fold; a connection that ends mid-fold discards the staging.
- **Blob stubs** are resolved in the same budget, a check every 64 nodes.

**Not budgeted:** `JSON.parse` of the frame. A frame is parsed in one piece before any fold starts, so its cost (about 8 to 10 ms for 1 MB) is a turn of its own that only a streaming transport could split. The per-item cost of a reducer step, and a store listener's own work per change, are also outside the budget: a turn can exceed it by one step.

The unit tests prove the structure with a fake clock (`test/fake-turn.ts`, `ConnectOptions.turn.now`): the fold yields whenever the budget is spent and no turn exceeds the budget plus one step. Wall-clock latency is checked by the gate runs on a quiet machine, not by unit tests.
