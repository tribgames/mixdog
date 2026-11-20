//! The generation window and the ledger's first-output time against Node's recordings (`fixtures/provider-wire/
//! generation-timing`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`): each answer is read in
//! two parts, the virtual clock stepped 700 ms before the first (which ends with the first text) and 1300 ms before the
//! rest, as Node's endpoint stepped it. Node measures the window from its stream's first output (generation-window.mjs:
//! Anthropic's first block opening, a Responses stream's first item, a compatible Chat stream's first visible delta) to
//! its end, and the ledger's `ttftMs` as the request's time less that window for the timed providers
//! (usage-accounting.mjs:15-33, :140). The provider is built by the production builder and accounted as production
//! accounts it, over the hub's clock: every request, the whole result (`generationMs` included), the callbacks in order
//! and the ledger rows are compared with Node's.
