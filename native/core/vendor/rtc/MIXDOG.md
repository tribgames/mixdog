# rtc 0.21.1, as modified for Mixdog

rtc 0.21.1 as published on crates.io (MIT OR Apache-2.0, `LICENSE-MIT` and `LICENSE-APACHE` kept), vendored for two
changes in `src/peer_connection/mod.rs`, `src/peer_connection/internal.rs` and
`src/peer_connection/transport/ice/mod.rs`. The changes are marked `mixdog` in the
source. `native/core/Cargo.toml` pins the base (`rtc = "=0.21.1"`) and patches it in.

## A local relay candidate keeps the transport of its TURN allocation

`add_local_candidate` takes a candidate line, and `add_ice_local_candidate` rebuilds the candidate from the ICE agent's
copy of that line. The line has no field for how the TURN server is reached (RFC 8839 §5.1), and
`RTCIceCandidate::from(&Candidate)` sets `relay_protocol` to its default, so the `OnIceCandidateEvent` and the
`local-candidate` stats entry of every relay candidate said `Unspecified`.

`RTCPeerConnection::add_local_relay_candidate(init, relay_protocol)` (new) is `add_local_candidate` with that transport
beside the line. `add_ice_local_candidate` sets it on the rebuilt candidate when the candidate is a relay candidate, so
the event and the stats entry carry it. `add_local_candidate` calls the new method with `Unspecified`, as before. The
candidate line, the SDP and `RTCIceCandidate::to_json` are unchanged: nothing of it reaches the remote peer.

## A relay candidate can be taken back

`RTCPeerConnection::remove_local_relay_candidate(now, relay_addr)` (new) hands the loss of a relay candidate's transport
to the ICE agent (`Agent::remove_local_candidate`, `../rtc-ice/MIXDOG.md`). Upstream has no way to say it: the core
only adds candidates, so a pair selected on a relay whose TURN connection was lost stayed selected until its consent
ran out. It tells the agent whether gathering has ended (`ice_gathering_state`), and when the selected pair went with
the candidate it clears the transport stats' `selected_candidate_pair_id` and the handler's cached pair key: the agent
reports a selection, never its loss, so the stats went on naming the pair that was gone (a selection the agent had
queued and not yet reported is dropped by the agent with the candidate, so nothing writes it back afterwards). The candidate's own stats
entry and the local description are left as they are.

The manifest drops the examples, the tests, the dev-dependencies and the `[profile.dev]` table (ignored outside a
workspace root); their files are not copied. `mixdog-remote` covers the change (`src/webrtc/turn_tests.rs`: the relay
protocol of the candidate events and of the pair selected at open, over UDP, TCP and TLS).

## When to remove

When the pinned release lets a gatherer hand the relay protocol to the core with a local candidate and reports it in
the candidate event and stats, and lets it take a local candidate back, switch `vendor/webrtc`'s driver to that API (or
drop it too) and delete this directory, its `[patch.crates-io]` and `exclude` entries and its entry in
`../audit-bases.lock`.
