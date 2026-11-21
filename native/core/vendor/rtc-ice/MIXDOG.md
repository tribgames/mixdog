# rtc-ice 0.21.1, as modified for Mixdog

rtc-ice 0.21.1 as published on crates.io (MIT OR Apache-2.0; the crate ships no licence file, `LICENSE-MIT` and
`LICENSE-APACHE` here are those of `rtc` 0.21.1, the same repository), vendored for one addition in `src/agent/mod.rs`,
marked `mixdog` in the source. `native/core/Cargo.toml` pins the base (`rtc = "=0.21.1"`, which requires this version)
and patches it in.

## A local candidate can be taken back

The agent could only gain local candidates. When the transport behind one is lost while the others stand (a relayed
address whose TURN allocation went with its TCP or TLS connection), nothing told the agent: a pair selected on it
stayed selected, everything sent on it was lost, and the connection was given up only when consent ran out, 30 s
later.

`Agent::remove_local_candidate(now, candidate_type, addr, gathering)` (new, public) removes the candidate and every pair on it,
and renumbers the pairs that follow (pairs name candidates by index), the selected and nominated pairs included. When
the selected pair was on it, the agent goes back to `Checking` with its failure deadline counted from `now`: a
controlling agent nominates the best pair that still succeeded, as it does before a first selection. With no pair left
that has not failed, it goes to `Failed` at once, unless the caller says it is still `gathering`: another local
candidate may yet arrive, so an empty checklist is not failure and the deadline alone decides. A controlled agent has
no nomination of its own to make and waits for the controlling side's, inside the same deadline; and one that still
has its selected pair keeps it when the other side nominates another, which is why a remote peer following this
side's move is not proven (`../webrtc/MIXDOG.md`). A `SelectedCandidatePairChange` of a pair on the candidate that is
still queued is dropped: read after the removal, it would name a pair that no longer exists. The failure deadline
after a removal runs from the agent's re-entry into `Checking`, not from the end of candidates: a gathering that ends
later with nothing does not fail the agent at that moment. Nothing else of the agent is changed.

The manifest drops the example and the dev-dependencies (their files are not copied). The crate's tests are not built
here; `mixdog-remote` covers the change (`src/webrtc/turn_tests.rs`,
`a_connection_lost_under_the_selected_pair_fails_the_path_at_once`,
`a_connection_lost_while_another_transport_still_gathers_does_not_fail_the_path`, and module `removal` for the
queued selection).

## When to remove

When the pinned `rtc`/`webrtc` release moves to an rtc-ice whose agent can be told that a local candidate is gone
(check: the test above passes against the unpatched crate, with `vendor/rtc` calling its API), delete this directory,
its `[patch.crates-io]` and `exclude` entries and its entry in `../audit-bases.lock`.
