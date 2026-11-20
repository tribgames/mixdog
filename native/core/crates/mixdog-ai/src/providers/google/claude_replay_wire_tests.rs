//! Claude through Antigravity replays its history as Node does, against Node's recordings
//! (`fixtures/provider-wire/antigravity-claude`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`
//! from the cases of `antigravity-request.test.mjs:402-795` sent through `AntigravityOAuthProvider`): empty parts,
//! rejoined and unsigned or foreign thinking, and the closing of an unthought tool loop. The provider is built by the
//! production builder from the recorded sign-in and sends each history over the recorder's hub: the request is compared
//! whole with Node's (the per-send `requestId` only for presence), the answer whole with Node's result (the replay
//! envelope the next turn sends back included), and the stream callbacks in order.



