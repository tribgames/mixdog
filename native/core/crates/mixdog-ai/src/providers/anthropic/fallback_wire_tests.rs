//! Anthropic's server-side fallback against Node's recordings (`fixtures/provider-wire/anthropic-fallback`, recorded by
//! `benchmarks/rust-core/recorders/record-provider-wire.mjs`): the subscription adapter sends the turn, the recorded stream
//! (a `fallback` block before any output, after some, or naming a snapshot of the requested model) comes back. The
//! provider is built by the production builder from the recorded sign-in: every request is compared whole with Node's,
//! the whole result (the model that answered and the fallback record included), the stream callbacks in order, and the
//! ledger row the accounting writes.
