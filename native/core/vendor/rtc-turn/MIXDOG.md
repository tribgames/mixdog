# rtc-turn 0.21.1, as modified for Mixdog

rtc-turn 0.21.1 as published on crates.io (MIT OR Apache-2.0; the crate ships no licence file, `LICENSE-MIT` and
`LICENSE-APACHE` here are those of `rtc` 0.21.1, the same repository), vendored for one change in `src/client/mod.rs` and
`src/client/proto.rs`. The changes are marked `mixdog` in the source. `native/core/Cargo.toml` pins the base
(`rtc = "=0.21.1"`, which requires this version) and patches it in.

## One Allocate, one completion id

`Client::allocate` sends an anonymous request (wire id A) and returns the id it reserves for the authenticated request
(B = A + 1). Upstream reported the first transaction's outcomes with A: a server that never answered the first request
timed out A, which no caller holds, and a 401 without a nonce or realm failed A. A gatherer that compares
`TransactionTimeout` with the id it was given never finished, so a peer connection whose UDP answers are lost never
reached the end of candidates.

The client now keeps, per outstanding Allocate wire transaction, the Allocate it belongs to (`allocate_flows`), and
reports every outcome of the Allocate with the id `allocate` returned:

- `AllocateResponse` and `AllocateError`, from whichever wire transaction ends it;
- `TransactionTimeout`, translated where the transaction map's events are drained (`complete_allocate_timeout`);
- a success the client cannot read (no relayed address, no lifetime) is an `AllocateError` instead of an error returned
  from `handle_read` that completed nothing.

A 438 (Stale Nonce) answer to the authenticated request is retried once under the nonce it carries (RFC 8489 §9.2.5),
as a third wire transaction of the same Allocate; a second 438 fails it.

The manifest drops the example, the bench and the dev-dependencies (their files are not copied). The crate's tests are
not built here; `mixdog-remote` covers the change (`src/webrtc/turn_tests.rs`, module `allocate`: silence before and
after the challenge over UDP and a reliable transport, the 438 retry, a refusal).

## When to remove

When the pinned `rtc`/`webrtc` release moves to an rtc-turn whose `allocate` reports its timeout, error and success under
the id it returns (check: the `allocate` tests above pass against the unpatched crate), delete this directory, its
`[patch.crates-io]` and `exclude` entries and its entry in `../audit-bases.lock`.
