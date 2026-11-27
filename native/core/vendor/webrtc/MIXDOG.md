# webrtc 0.21.1, as modified for Mixdog

webrtc 0.21.1 as published on crates.io (MIT OR Apache-2.0, `LICENSE-MIT` and `LICENSE-APACHE` kept), vendored so that
TURN relay candidates are gathered over TCP and TLS as well as UDP. Upstream's relayer skips every url that is not
`turn:…?transport=udp`. The changes are marked `mixdog` in the source. `native/core/Cargo.toml` pins the base
(`webrtc = "=0.21.1"`) and patches it in, with the three crates below it that the change needs (`../rtc/MIXDOG.md`,
`../rtc-ice/MIXDOG.md`, `../rtc-turn/MIXDOG.md`).

## Changes

- `src/peer_connection/transport/turn_stream.rs` (new): one outbound connection per offered TCP or TLS endpoint, as one
  task on the runtime. It resolves, connects through the system's route and, for `turns:`, runs a rustls handshake
  against the url's host name (an IP literal is an IP identity: it verifies against a certificate that carries that
  address as an iPAddress name, and against no DNS name); a `turns:` endpoint without a TLS configuration, or whose
  handshake fails, ends there and is never tried in the clear. Reads go through
  `rtc_shared::turn_framing::TurnStreamDecoder` (RFC 8656 §12.5: STUN is 20 + length, ChannelData 4 + length rounded up
  to four) and reach the driver on a bounded queue of the driver's connections alone (`STREAM_EVENTS`), which is their
  read back-pressure and keeps them off the queue the application writes to. Writes come from three places of the
  connection: a queue of requests (`REQUEST_FRAMES`, written first), a queue of relayed data (`DATA_FRAMES`, a full one
  drops the frame) and one place for the release that ends the connection, which no other frame can take and which
  the writer looks at first, so only a write already under way precedes a release. Every write
  has a deadline (`WRITE_TIMEOUT`, 5 s): a socket that takes no more ends the connection, and a connection whose owner
  is gone writes its release, or nothing, and ends within two deadlines. The driver never awaits a connection. Setup
  is bounded by Ti (39.5 s, RFC 8489 §6.2.2), so a connection that never comes up is still a gatherer that ends.
- `src/peer_connection/transport/turn_relayer.rs`: TURN clients are keyed by `ClientKey` (a UDP four-tuple, or the id of
  the connection a stream client owns) instead of a four-tuple. `gather` opens every distinct TCP/TLS endpoint before it
  resolves the UDP urls; the client of a connection is made when the connection reports its own local and peer
  addresses, with `rtc-turn`'s reliable transactions, and still asks for `REQUESTED-TRANSPORT=17`. A stream client's
  messages go to its connection (`poll_write`) and nothing is kept for one without room: relayed data is dropped, and a
  connection that takes no request is given up, as is one whose request ran out its wait (a request is sent once over
  a reliable transport, so its frame must not go out late). Gathering completes when every UDP client and every
  connection is terminal; an ICE server entry that does not parse is skipped instead of ending `gather` early, which
  left the gathering unfinished. A relay candidate carries the
  transport of its allocation (`RTCTurnRelayEventOut::LocalIceCandidate`) and an explicit priority whose local
  preference orders UDP, then TLS, then TCP, under the relay type preference (`relay_priority`; the UDP value is the one
  upstream computed). A client leaves in one way, `retire`, whatever makes it leave (its connection or UDP socket is
  lost, a request ran out, the configuration changed, the peer connection closes or is dropped), and it always does the
  same: what the client had queued is dropped (its own pending messages, which `Client::close` leaves, and those
  already in the driver's queue); where the transport is alive the allocation's `Refresh(0)` goes out ahead of anything
  else (first out of the UDP socket, or in its connection's place for it, after which the connection closes); its
  routes, pending permissions and buffered packets go; nothing reconnects; and its relayed address is queued for ICE
  (`poll_gone`, `RTCTurnRelayEventOut::LocalIceCandidateGone`) in a queue a configuration reset does not clear, while
  an announcement of the same candidate that has not been read yet is withdrawn (a relayer that gathers again after
  completing re-announces its candidates, and one read after the removal would put the candidate back). Upstream
  dropped a client without telling ICE in every one of these cases. A stream client whose Allocate fails or times out is retired. Credential rotation keeps its
  meaning and also waits for connections still coming up.
- `src/peer_connection/driver.rs`: the event loop takes the connections' reports from their own queue, one per pass,
  and hands them to the relayer; every relayer the driver builds gets that queue and the TLS configuration; relay
  candidates are added with `RTCPeerConnection::add_local_relay_candidate` and taken back with
  `remove_local_relay_candidate`; a rebind closes the relayer it replaces and hands ICE its removals whenever that
  relayer has a client, not only while a UDP socket is left; a UDP socket that fails for good retires the relays
  allocated from it and leaves the addresses later gatherings allocate from (`RTCTurnRelayEventIn::SocketLost`: a later
  write to the missing socket is dropped, not failed, so nothing else would), and when it was the last transport ICE
  still gets the removals before the driver returns; a connection to a TURN server counts as a transport, so losing the last
  UDP socket does not end a driver that still has one; the loop also wakes on `close_wake`.
- `src/peer_connection/mod.rs`: `PeerConnectionBuilder::with_turn_tls_config(Arc<rustls::ClientConfig>)`: the caller's
  roots, verifier and crypto provider, used as given. A connection that is dropped stops its driver as `close()` does
  (`PeerConnectionRef::signal_close`): upstream stopped only a driver on the reactor pool, and a driver left on the
  general runtime went on refreshing its TURN allocations, which then never expired on the server. The stop is the
  `closing` flag with a wake on a queue of its own (`close_wake`); `close()` no longer awaits room on the application's
  queue, which could not come when it was called from a callback, on the driver's own task.
- `src/peer_connection/transport/stun_gatherer.rs`: the Binding request carries a random transaction id
  (`TransactionId::new()`), as RFC 8489 §5 requires. Upstream's `TransactionId::default()` is all zeros; the path to
  Mixdog's STUN/TURN server never answers a Binding that carries it and then drops the flow it came on, so no
  server-reflexive candidate was gathered, and no UDP TURN allocation either, its client sharing that socket and server.
- `src/peer_connection/transport/mod.rs`: the new module.
- `Cargo.toml`: `rustls` (the version `rtc` asks for) is a dependency; the examples, tests and dev-dependencies are
  dropped (their files are not copied).

Not proven: that the remote peer follows when this side moves to another pair after a candidate was taken back. The
controlling agent nominates the new pair, but a controlled agent of the pinned `rtc-ice` answers the nomination with a
Binding Success and keeps the pair it had selected (`agent_selector.rs`, `handle_binding_request`: it selects only when
it has no selected pair), so against such a peer only this side's sending moves. What a phone's browser does was not
tested.

Not changed: on the `runtime-smol` runtime, `write_with` retries a partial `write_all` with the whole buffer. A review
raised it for the stream writer; Mixdog builds this crate on Tokio only (`runtime-tokio`), whose `write_all` is
Tokio's, so the copy stays as upstream there.

The crate's tests are not built here. `mixdog-remote` covers the change against a stand-in TURN server with UDP, TCP and
TLS listeners (`src/webrtc/turn_tests.rs`), each case a data-channel exchange through relay candidates, and the
Binding request against a stand-in STUN server that answers only a random transaction id (`src/webrtc/tests.rs`).

## When to remove

When the pinned release gathers `turn:…?transport=tcp` and `turns:` itself, with caller-supplied TLS verification, the
relay protocol on the candidate, a release on the owning connection, a candidate taken back when its connection is
lost, a dropped connection that releases its allocations and a Binding request with a random transaction id (check:
`turn_tests` and `a_stun_server_that_answers_only_random_transaction_ids_yields_a_server_reflexive_candidate` pass
against the unpatched crate, with `with_turn_tls_config` replaced by its API), delete this directory, its
`[patch.crates-io]` and `exclude` entries
and its entry in `../audit-bases.lock`, then `../rtc`, `../rtc-ice` and `../rtc-turn` under their own conditions.
