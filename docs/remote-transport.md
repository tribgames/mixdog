# Direct transport (phone ↔ PC over WebRTC)

All live phone↔PC traffic travels over an always-on WebRTC data channel when
one works. That covers RPCs, state sync, file transfer and media, and the JPEG
view.

The relay (`apps/relay`) keeps these jobs:
- pairing;
- signaling;
- presence and heartbeat;
- TURN credentials;
- push;
- the role of fallback carrier.

Code contract: `apps/desktop/src/shared/remote-transport.ts`. Handshake and
E2EE domains: `apps/desktop/src/shared/remote-e2ee.ts`.

## 1. Negotiation and handshake binding

### Capability

- The capability is `transportWebrtc: 1`, offered on the E2EE challenge and
  selected on the hello. It is independent of `browserWebrtc`.
- Selecting it requires the offer **and** `binaryFrames` on both sides
  (`relayE2EETransportNegotiated`).
- A transport session is one E2EE session: one challenge and one
  `RelayE2EEChannel`.
  - Its `sessionId` is the challenge, which is also the media lane's `sid`.
  - A new handshake is a new session and resets the stream. A carrier failure does not.

### Transcript

The transcript is SHA-256 over two parts, both as canonical JSON:
- the challenge **exactly as offered**;
- the hello **exactly as sent**, without its proof.

It therefore covers every offered and selected capability, binary framing
included. The client adds its extra hello members through
`createRelayE2EEClientHandshake(…, { transportWebrtc, helloFields })`, so the
transcript covers what is actually sent. Today the shim instead spreads them
over the finished hello (`renderer/remote-shim-socket.ts:390`).

### Selection is proven

A hello that selects transport carries the **transport proof**:
- `HMAC(pairingSecret, legacyProofPayload ‖ "\0transport\0" ‖ transcript)`.
- The server rejects the hello if:
  - it selects transport without an offer;
  - it selects transport without binary frames on both sides;
  - its transcript does not match.
- So stripping, adding or altering the selection, or any hello member, fails
  the handshake.

### The offer is confirmed

A server that **offered** puts `transcript` into its `e2ee-ready`. That message
is the first application message, authenticated by the channel.

A client that opted in (`transportWebrtc: true`) cannot seal anything until
`channel.confirmHandshake(ready)` has accepted it:
- If `ready` has a transcript, it must equal the client's own transcript.
- If `ready` has none, that is the authenticated word of a host that offered
  nothing. It is accepted only if this client saw no offer either.

A relay that strips the offer, or `binaryFrames`, from the challenge therefore
gets a refused session, never a silent legacy one. The phone opts in only when
the challenge **it saw** offered the transport (§6), so after a strip it has not
opted in. The transcript gives the strip away instead: only an offering host
adds one, so a phone that saw no offer and receives a `transcript` in
`e2ee-ready` refuses the session (`renderer/remote-shim-socket.ts`).

**How `e2ee-ready` travels — exactly one way per session.** Both ends know,
from the challenge and the hello, whether the session is a transport session
(the server offered `transportWebrtc` with `binaryFrames`, and the hello
selected it):
- **Transport session:** `e2ee-ready` is the app stream's record **1** — the
  first box the server seals with `encryptBinary` (app domain, sequence 1) —
  pushed through the stream core like any record (retained until acked) and
  sent on the relay as an `MXT` kind-1 transport record. Nothing is sealed in
  the app domain before it. The client takes it from the receiver
  (`next()` → open → `confirmHandshake` → `commit`) and must not accept a
  bare E2EE box (or any other framing) as `e2ee-ready` in such a session.
- **Every other session:** the legacy `e2ee-ready`, exactly as today (a host
  that offered still adds `transcript`; an older browser ignores it).

### Explicit compatibility paths

- **Older browser** (no opt-in): it sends a legacy hello with the legacy proof.
  An offering host serves it a legacy session. Nothing is downgraded, because
  that browser could never select transport.
- **Older or gated host** (no offer): its `e2ee-ready` carries no transcript.
  The browser saw no offer, so it does not opt in and uses a legacy session
  (a `transcript` in that `e2ee-ready` would be refused, above).

### Legacy, byte for byte

When neither side offers, nothing on the wire changes:
- the hello members and their order;
- the proof (`HMAC` over the legacy payload);
- `e2ee-ready` (`handshakeConfirmation()` returns `{}`);
- the channel key;
- the AAD and boxes.

`shared/remote-e2ee-transport.test.mjs` checks this against an independently
derived legacy key.

## 2. Cryptographic domains

The keys come from the same ECDH secret, with the pairing secret as HKDF salt.
They are separated by HKDF info:
`mixdog-relay-e2ee-v1\0transport\0<domain>\0<direction>\0<challenge>\0<serverPublicKey>\0<clientPublicKey>`.
Each key is per direction, and the AAD names the domain, the direction and the
sequence.

| Domain | Use | Replay rule |
|---|---|---|
| `app` | The sequenced application stream (E2EE binary box `MXE\x01`). | The stream core releases boxes strictly in order, so the existing high-water check holds. |
| `control` | Signaling, acks, repairs, ping/pong (`MXC\x01`, `sealControl(value, lane)`/`openControl(raw, lane)`). | One sequence space, the lane bound into the AAD and checked **per authorized lane** (each carrier is a FIFO lane): a box at or below its lane's high-water mark, or on a retired lane, is `stale`. A box for another lane, or unauthentic, throws. Derivation in §10. |

A transport app record carries at most 1 MiB of plaintext, both before deflate
and after inflate (`RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES`). Every check
that can refuse runs **before** the sequence is assigned, so a refusal never
leaves a hole. A sealing failure after assignment marks the stream broken, and
the session ends.

## 3. Wire format (same bytes on both carriers)

Every carrier message is `MXT\x01 | kind | body`. It is one data-channel
message, or the data of one binary relay frame (never marked `droppable`).

| Kind | Body |
|---|---|
| 1 `app` | One whole E2EE box (≤ `MAX_MESSAGE_BYTES` − 5). Its sequence is its own header's. |
| 2 `chunk` | `u64 sequence, u32 index, u32 count, u32 total`, then bytes `[index·CHUNK_BYTES, …)` of a larger box. |
| 3 `control` | One control box (≤ `REMOTE_TRANSPORT_MAX_CONTROL_BOX_BYTES`). |

### Channels on the direct carrier

- **`mixdog-transport`** (reliable, ordered) carries kinds 1 and 2 only.
- **`mixdog-transport-control`** carries kind 3 only: acks, repair, ping and
  pong.
  - It is reliable and **ordered**, and sits on the same peer connection; its
    own order makes it a FIFO control lane.
  - **What the separate stream guarantees, and what it does not.** SCTP
    orders delivery per stream (RFC 9260 §6.6), so a control message is never
    held for in-order delivery behind a lost or late app message. It does
    **not** escape the shared path: every data channel of one peer connection
    rides one SCTP association over one DTLS/UDP flow (RFC 8831 §5), so control
    shares the congestion window, the association's send buffer and the
    browser's stream scheduler with bulk. With no I-DATA in browsers
    (RFC 8260), a control message also waits for any app message already being
    transmitted (≤ `MAX_MESSAGE_BYTES`, 65 466 bytes).
  - So control latency under load is bounded only by what is queued on the
    association ahead of it. The aggregate backpressure keeps that bounded:
    bulk is admitted only while the app channel is at or below
    `BUFFER_LOW_BYTES`, and nothing is written while the two channels'
    `bufferedAmount` plus the IPC hops exceed `BUFFER_HIGH_BYTES`. There is no
    fixed latency guarantee beyond that.
- **Where the carrier runs: two hops.** The coordinator runs in the machine
  daemon with the relay (plain Node, no Electron). The peer connections run in
  the desktop app's hidden peer window (`peer-window.ts`). A carrier message
  crosses daemon → app main over the existing daemon ↔ app lane (a desktop
  event to the window, answered by desktop operations, like the remote-screen
  live view's `browserRemoteWebrtcSignal`), then app main → peer page over
  Electron IPC (`main/remote-transport/peer-link.ts`).
  - The **direct carrier needs the desktop app running.** A daemon with no app
    attached is relay-only: the offer attempt is refused before anything is
    signaled, and the session retries once per negotiation window, so an app
    that attaches later serves the next offer. An app that detaches, quits,
    attaches again (restarted), or leaves a command unacknowledged for
    `MAX_IDLE_TIMEOUT_MS` (the no-progress bound) fails its connections
    `peer-host-unavailable`, back to the relay.
  - **Backpressure counts both hops.** The daemon's figure for a connection
    is the bytes it handed to the app and the app has not yet acknowledged,
    plus the app's last reported load (its IPC hop and both channels'
    `bufferedAmount`). The app's load only grows by bytes the daemon sent,
    which stay counted until the ack that reports the load after them, so the
    figure never undercounts and `BUFFER_HIGH_BYTES` holds end to end.
  - **Latency adds the daemon ↔ app hop**: one more local IPC traversal each
    way (JSON, base64 carrier bytes), and a drain reaches the coordinator one
    hop later. The bytes on that hop are inside the same bound, so the
    control-latency bound above is unchanged in form: base RTT plus the time
    to drain what the backpressure allows ahead, now including both hops.
- The receiver accepts kind 3 from the control channel and from the relay,
  and opens it with the lane it came on.
- **Control lanes** (`RelayE2EEControlLane`): `{kind:'relay'}`, or
  `{kind:'direct', epoch, connectionId}` for one peer connection. The
  `connectionId` is the one its offer minted; the **epoch** is the
  `generation` of the offer that first created that connection.
  - **An ICE restart keeps the lane.** It raises the generation on the same
    `connectionId`, but the SCTP association and its ordered control stream
    survive it, so it is the same FIFO lane: nothing is registered, activated
    or retired, and the epoch stays the creating offer's generation. Only a
    new `connectionId` is a new lane. This is what the epoch floor needs: a
    new connection's creating generation is above every earlier one
    (generations only rise), so it always registers, while no restart can
    ever re-register or bump a lane.
  - **Authenticated.** `sealControl(value, lane)` binds the lane (kind, epoch,
    connectionId) into the AAD; `openControl(raw, lane)` verifies it. A box
    sealed for one lane or epoch never opens on another: it throws like any
    forged box.
  - **Authorized and bounded.** Each end keeps the relay lane, the current
    direct lane and at most one pending lane, plus a monotonic epoch floor
    (the highest epoch ever registered). `registerControlLane(lane)` adds a
    new connection as pending (its epoch must exceed the floor, so a
    superseded or retired connection can never return at high-water 0; a
    previous pending lane is retired by it); `activateControlLane(lane)`
    makes it current on promotion and retires the old current one;
    `retireControlLane(lane)` drops a closed connection. Sealing for a lane
    that is not authorized throws; a box arriving on a retired lane is
    `stale`.
  - **Ordered handoff.** A sealed control box is handed to exactly one lane,
    in seal order (`sealControl` resolves in sequence order; send on
    resolution). A box sealed for a direct carrier that failed before sending
    is dropped and its content (ack, ping, repair) regenerated — it cannot be
    moved to another lane, since the lane is in its AAD. Signaling only ever
    uses the relay lane.
- **Message size.** After connect, both ends read `pc.sctp.maxMessageSize`. A
  carrier is promotable only if `remoteTransportCarrierFits(value)` is true,
  that is, the value is at least `REMOTE_TRANSPORT_MAX_MESSAGE_BYTES`. The
  RFC 8841 default of 65 536 passes; +∞ means unlimited.

### Loss recovery: an adaptation of RFC 9002

Loss detection, repair and probing are an **adaptation** of RFC 9002 (QUIC
Loss Detection and Congestion Control). Its estimator, thresholds, PTO
formula and constants are used with their RFC values, but the setting is
different, so the behaviour is not RFC 9002's. The differences:

1. **Receiver-driven.** The carriers are reliable, so the receiver detects
   loss and asks for it (`repair`); the sender never retransmits on its own.
   RFC 9002 runs at the sender.
2. **Timed from receiver evidence, not send time.** The time threshold starts
   when the receiver sees evidence that a record was sent (a later record, or
   `ping.sent`), not when the sender sent it (§6.1.2 measures from the send
   time of the lost packet).
3. **Retransmissions keep their record identity.** A re-sent record carries
   its original sequence; QUIC sends retransmitted data in new packets with
   new packet numbers. So a late original and its re-send are duplicates of
   one sequence, and an ack cannot tell them apart.
4. **Delivery commits reset the backoff.** `pto_count` resets when the
   receiver delivers (commits) a record, not when an ack arrives (§6.2.1).
5. **No congestion control.** Nothing from RFC 9002 §7 is used; sending is
   bounded by the byte window and the carrier's backpressure.

| RFC 9002 definition | Used here for |
|---|---|
| §5.3 `smoothed_rtt`, `rttvar`, `min_rtt`, `latest_rtt` | `RemoteTransportPathMonitor.rttSample`, fed only by matched pongs (a pong is immediate, so `ack_delay` = 0). |
| §6.2.2 initial `smoothed_rtt` = kInitialRtt (333 ms), `rttvar` = kInitialRtt/2 | A carrier with no sample; every carrier change returns here (RFC 9000 §9.4). |
| §6.1.1 kPacketThreshold = 3 | A missing record is declared lost once a record 3 or more sequences later has arrived. |
| §6.1.2 loss delay = kTimeThreshold (9/8) × max(`smoothed_rtt`, `latest_rtt`), at least kGranularity (1 ms) | A missing record is declared lost when the receiver's evidence that it was sent is that old (difference 2). |
| §6.2.1 PTO = `smoothed_rtt` + max(4·`rttvar`, kGranularity) + `max_ack_delay`; ×2 per expiry | Receiver: re-request of still-missing declared records (difference 4 for the reset). Sender: when to send a probe ping. |
| §6.2.4 up to two probes per PTO expiry | The receiver re-requests at most the 2 lowest still-missing records per expiry. |
| RFC 9000 §10.1 idle timeout = max(`max_idle_timeout`, 3 × PTO) | `silent` demotion; incomplete-assembly eviction. |
| RFC 9000 §13.2 ack after 2 ack-eliciting packets or `max_ack_delay` (25 ms, §18.2) | `ackDue`. |

Not from RFC 9002:
- the **post-switch hold** of one PTO (`carrierFailed`) is a Mixdog
  optimization that waits for the receiver's resume ack; RFC 9002 prescribes
  nothing like it and only supplies the PTO as the wait;
- the **`no-progress`** demotion is a Mixdog application-progress policy
  (§5), bounded by the relay's existing 6 s.

### Sender (`RemoteTransportSender`)

- **Sequencing.**
  - Sequences are the box's own, assigned at sealing, before any carrier is chosen.
  - They must be contiguous; `push` refuses a hole.
- **Admission.**
  - Before sealing, check `canAdmit()`. It reserves room for a maximal record,
    so a box that was admitted can always be pushed.
  - A refusal before sealing (record or message size, window) leaves
    `nextSequence()` unchanged.
  - The window is in bytes only: the relay's per-leg queue bound, 8 MiB.
    Every record is charged at least one carrier message (65 466 bytes,
    `remoteTransportRecordCharge`), so at most 128 records are in flight
    (`REMOTE_TRANSPORT_MAX_RECORDS_IN_FLIGHT`), and tiny records cannot
    multiply per-record bookkeeping.
  - **Bulk** (media adapter records, `canAdmit({ stream, bufferedAmount })`):
    - admitted only while the carrier queue is at or below 1 MiB, the relay's
      threshold for shedding low-priority frames (`SKIP_PUSH_BUFFER_BYTES`);
    - all bulk together holds at most the window minus one maximal record
      (`REMOTE_TRANSPORT_BULK_OUTSTANDING_BYTES`), so one RPC or state record
      always fits;
    - each media stream holds at most 1 MiB, the relay's per-stream pause point
      (`MEDIA_PAUSE_BUFFER_BYTES`).
- **Retention.** Every box is kept, immutable, until an authenticated
  cumulative ack covers it.
- **Re-sending: never on a timer.** Carriers are reliable and ordered, so a
  record behind a slow queue is not lost. A record is re-sent only when:
  - its carrier failed (`carrierFailed`);
  - the receiver asked with `repair` (see **Loss recovery** below).
- **Probe (§6.2).** `probeDue(now, pto)` is true when records are sent and
  unacked and neither a send nor an ack happened for PTO × 2^`pto_count`; it
  doubles `pto_count`, and an ack advance resets it. The caller then sends one
  ping. Every ping (probe or keep-alive) carries `sent`:
  `probeThrough(carrier, bufferedAmount)`, the highest sequence whose bytes
  have certainly left that carrier's queue (bytes handed over minus
  `bufferedAmount`; framing makes it err low). This is how the receiver learns
  that a FINAL record was lost, which no later record can reveal.
- **Resume point at a carrier switch.**
  - `carrierFailed(carrier, now, holdMs)` holds re-sends for one PTO of the
    surviving carrier (`RemoteTransportPathMonitor.ptoMs()`; 1 024 ms before
    any sample). This hold is an optimization, not an RFC 9002 rule.
  - Meanwhile the receiver (`carrierChanged`) sends its ack at once: the
    delivered-through point plus selective `ranges` (RFC 9000 §19.3) of
    complete records it already holds.
  - The hold ends on an ack whose control sequence is newer than every
    control message observed before `carrierFailed`. That ack is taken as the
    resume point; it is not proof that the receiver sealed it after the
    failure. Only records above `through` and outside the ranges go out again,
    in sequence order.
  - `due(now, budgetBytes)` respects the carrier's room, which is the relay's
    backpressure on the relay carrier.
- **Expiry.** `expired(now)` is true when records are outstanding and no ack
  has advanced for 60 s (the relay's `INGRESS_WAIT_TIMEOUT_MS`). The caller
  must then end the session and fail unacked calls as ambiguous.

### Receiver (`RemoteTransportReceiver`)

This runs before decryption, inside a budget reserved before anything is
allocated: 8 MiB for records behind the head (the relay's per-leg queue
bound) plus the head reserve. Every candidate is charged like the sender's
records (at least one carrier message), and the reorder span is the same
128 records, so a flood of tiny forged records is bounded by bytes: about 128
of them, charged 8 MiB, however small they really are.

- **Binding.** A chunk with index 0 must contain a box header that names the
  sequence the chunk claims; otherwise `mismatch`. A completed assembly is
  checked again. A genuine box therefore never fills another slot, and
  `commit` can only ack the record that actually arrived.
- **Unauthenticated geometry.** Rival `total`s assemble side by side, at most
  2 per slot (the structural minimum: the genuine copy beside one forged one).
  A newcomer evicts the least advanced incomplete rival. An assembly silent
  for one idle timeout is swept (`sweep(now, monitor.idleTimeoutMs())`).
  Every discard or eviction is an explicit loss of that sequence.
- **Head-of-line reserve.**
  - The next required record has its own reserve: its candidates plus the open
    working set.
  - Later records share the rest (`REMOTE_TRANSPORT_FUTURE_BUDGET_BYTES`).
  - Forged future assemblies can fill only the future region, so the head
    record always fits.
- **Opening.** `next` returns the head candidate. The caller opens it (one at a
  time), then calls `commit` if it opened, or `discard` if authentication
  failed. A rival or the retransmission then refills the slot.
- **Acks** (RFC 9000 §13.2: after 2 accepted records or 25 ms).
  - An ack (`{v:1,t:'ack',through}`, sealed in the control domain) means
    "authenticated and accepted into the ordered stream". It does not mean
    "executed".
  - `acknowledge` accepts only objects produced by `readRemoteTransportControl`
    from an opened box. It refuses an ack beyond the highest sequence sent.
  - `ranges` (ascending, disjoint, above `through`, as many as fit one control
    box) name complete records the receiver has not opened yet. They are
    **hints**: they spare re-sends but never release a buffer.
  - A duplicate of a delivered record, or a carrier change, forces a re-ack.
- **Ordering of acks and repairs.** Acks and repairs may come on different
  lanes, so arrival order means nothing. Every authenticated control object keeps the
  control-domain sequence of the box it came out of.
  - `through` only moves forward, whatever order acks arrive in.
  - A repair stamps its record with its control sequence. A selective range
    from an ack sealed before that repair never marks the record held again;
    one sealed after it does.
- **Repair.** `{v:1,t:'repair',sequences}`: every sequence one `repairDue`
  round returned (ascending, distinct, at most 128), sealed as **one** control
  box. A repair round therefore always costs one box. Sequences never sent are
  ignored, not fatal.
- **Loss recovery** (`repairDue(now, monitor)`, `probe(sent, now)`):
  - A missing sequence is **declared lost**, and its repair requested once,
    when its copy was discarded or evicted here, when a record 3 or more
    sequences later has arrived (§6.1.1), or when the evidence that it was
    sent is at least the loss delay old (§6.1.2).
  - A sequence is declared at most once. Further discards and evictions of it
    change nothing, so a forger re-sending bad copies cannot bring repairs
    forward.
  - While declared records are still missing, each PTO expiry (§6.2.1,
    doubling per expiry) re-requests the 2 lowest of them (§6.2.4). Delivery
    progress resets `pto_count`.
  - **Repair budget:** at most one declared repair per sequence over the
    session, plus 2 per backed-off PTO. A ping overtaking data that is still in
    flight (the control channel is a separate SCTP stream) can cause a repair
    for a record already on its way; that costs one duplicate, which the receiver drops,
    and any repetition is bounded by the PTO backoff and the same budget.

### Application messages above the record layer

- A payload whose JSON fits in one record (1 MiB) is one record.
- A larger payload is split (`splitRemoteTransportPayload`) into consecutive
  `transport-fragment` payloads of `FRAGMENT_BYTES` (786 348): the largest
  multiple of 3 whose base64url plus the largest fragment envelope fits one
  record. The sender seals them back to back, with nothing between them.
- **Size cap, both directions: 64 MiB serialized** — the relay's
  `MAX_FRAME_BYTES`, so nothing the relay delivers today is refused. Larger
  messages are refused before sealing, as the relay refuses them today.
- `RemoteTransportMessageAssembler`:
  - restores the payload and parses it whole once complete, as a relay frame
    is parsed today;
  - **one large message per session**: it keeps one partial message at most,
    and treats interleaving or a gap as a protocol error;
  - **process-wide pool**: the first fragment reserves the declared size
    (count × `FRAGMENT_BYTES`) from `REMOTE_TRANSPORT_ASSEMBLY_POOL_BYTES`,
    64 MiB + 8 MiB — what the single relay uplink holds today, one frame of any
    size into an empty queue plus the per-leg queue bound behind it. An empty
    pool always admits one maximal message;
  - a first fragment that finds the pool full returns `wait`: nothing is kept,
    and the caller re-offers it, pulling no further records meanwhile, so
    backpressure reaches the sender through its window;
  - a large message with no fragment for 60 s (`INGRESS_WAIT_TIMEOUT_MS`) is
    `stalled`: the caller ends the session, and `close` frees the pool.
- These are **serialized-byte** bounds. They are not a bound on the parsed
  object, on processing lifetime, or on streaming attachments (see §4, known
  limits).
- Droppable traffic is coalesced or dropped before sealing, when `canAdmit()`
  is false.
- An RPC whose ack never came is never replayed into a new session. It fails as
  ambiguous, and the new session's resync recovers state.

### Signaling (control domain, relay carrier only)

- `offer` (desktop → client), `answer` (client → desktop), `candidate`, `close`.
- Each one carries `v, sessionId, connectionId, generation`.
- The desktop always offers. It creates the `mixdog-transport` channel, mints
  `connectionId`, and raises `generation` with every offer. Anything below the
  current generation is stale.
- The client requests a new offer with `close{reason:'restart'}`.
- Offers and answers carry explicit `fingerprints`:
  - they must equal the SDP's `a=fingerprint` set;
  - after DTLS, the connected certificate must be one of them
    (`remoteWebrtcCertificateMatches`), or the peer is closed with
    `fingerprint-mismatch`.
- SDP, candidates and ICE servers are validated by the live view's exported
  parsers (`parseRemoteWebrtcSdp`, `parseRemoteWebrtcCandidate`,
  `parseRemoteWebrtcIceServers`). The SDP is first held to the control
  plaintext budget, because the shared parser allows 64 KiB.
- A parsed signal must serialize within one control box
  (`REMOTE_TRANSPORT_MAX_CONTROL_PLAINTEXT_BYTES`, 65 421 bytes). That includes
  the SDP, the fingerprints, and the ICE servers with their credentials.
  Senders check with `assertRemoteTransportControlFits` before sealing.
- ICE servers come from the desktop's TURN credentials. The policy is `all`.

### Media adapter (application-stream payloads)

`{type:'transport-media', op}` messages (`readRemoteTransportMedia`):

| Op | Direction | Fields |
|---|---|---|
| `request` | Client → desktop | `id, assetId, variant, range, enc` |
| `cancel` | Client → desktop | `id` |
| `head` | Desktop → client | `id, status` (200/403/404/405/412/416/500) |
| `chunk` | Desktop → client | `id, frame` (base64url of one `remote-media-crypto.ts` frame, meta first) |
| `end`, `error` | Desktop → client | `id` |

- These semantics are unchanged: the 64 KiB segment grid, the 1 MiB and 8 MiB
  windows, the authenticated `version`, and the lease and device checks.
- The session is the stream's own, so a request has no `sid`.
- At most 32 streams run concurrently.

## 4. Bounds and payload parity

Every constant, with its source, is in §10. This section covers what the
bounds mean for existing payloads.

| Class | Size | Travels as |
|---|---|---|
| Most RPCs, state patches, transcript pages (`REMOTE_TRANSCRIPT_TAIL_BYTES` 128 KB) | ≤ 1 MiB | One record |
| Native file-save chunks (1 MiB raw, base64 ≈ 1.33 MiB) | > 1 MiB | 2 fragments |
| File preview, page and download reads (4 MiB raw, base64 ≈ 5.6 MB), server upload chunks (2 MiB raw) | 2–6 MB | Fragments |
| View baselines and snapshots (measured ≤ 243 KB) and the unbounded producers (uncached view frames at `main/remote-view-sync.ts:228`, unbounded RPC results) | Up to 64 MiB | Fragments, as one relay frame carries them today |
| Prompt attachments phone → PC (≈ 58 MB at most) | ≤ 64 MiB | Fragments |
| Anything above 64 MiB, either way | — | Refused before sealing, as the relay refuses it today |
| Media lane: one media-crypto frame (≤ 64 KiB + 32 B, ≈ 87 KiB as base64) | — | One `chunk` record each |

Measurement behind "measured" (`~/.mixdog/data/daemon.log`, 2026-10-27): 49
`[mixdog-remote-meter]` windows, largest per-lane mean frame ≈ 96 KiB
(`viewBaseline`), largest single-frame sample 78 KiB; 34
`[mixdog-remote-first-transcript]` samples, largest 243 KB; no oversize
refusal.

**Known limits shared with the legacy path (follow-up, not this release).**
- Parsed-object size: a 64 MiB message is parsed whole, and its object graph
  can be several times larger than its bytes (a probe of 700 k empty objects
  reserved 15.7 MB and retained 44.8 MB). The relay path parses a 64 MiB frame
  whole today in the same way.
- Processing lifetime: nothing bounds how long the application keeps a parsed
  message.
- Prompt attachments are not streamed; a maximal `sendPrompt` is one message.
- The unbounded producers above (`remote-view-sync.ts:228`, unbounded RPC
  results) should become paged or streamed results.
- Media adapter buffering on the phone: the phone's stream acknowledges media
  records as soon as they are accepted into the ordered stream, whether or not
  the element reads them, and there is no phone → PC credit message. A stalled
  element can therefore leave up to one window per stream buffered in the
  service worker: 1 MiB for media (`MEDIA_WINDOW_MAX_BYTES`), 8 MiB for a file
  download (`DOWNLOAD_WINDOW_MAX_BYTES`), with at most
  `REMOTE_TRANSPORT_MAX_MEDIA_STREAMS` (32) streams. On the HTTP lane the
  relay pauses the producer once 1 MiB sits in its response buffer
  (`MEDIA_PAUSE_BUFFER_BYTES`). Accepted as a known bound for this release.

A fragmented message holds back later application messages in its direction
until its last fragment is sealed. That matches today's single relay frame.
Control traffic (acks, pings, signaling) is not affected.

## 5. Lifecycle

1. **Setup.**
   - After `e2ee-ready` and its confirmation, the relay carries all records
     while the desktop asks its peer host for an offer.
   - With no peer host attached, the session stays relay-only. That is a
     supported mode, because the desktop service is a machine daemon: the
     direct carrier needs the desktop app running (§3, "Where the carrier
     runs"). The session retries once per negotiation window, so an app
     that attaches later serves the next offer.
2. **Promotion.** All of these must hold before new sends use the direct carrier:
   - the certificate matches the signaled fingerprints;
   - both channels are `open`;
   - `remoteTransportCarrierFits(pc.sctp.maxMessageSize)`;
   - one ping/pong round trip has completed on it since it last became
     healthy (path validation, RFC 9000 §8.2).

   There is no promotion hold-down: no standard defines one, so the earlier
   6 s → 300 s ladder was removed. A flapping path costs one stall detection
   (at most the 6 s bound) and one resume per cycle.

   On promotion, `RemoteTransportPathMonitor.reset` clears RTT and progress
   state (RFC 9000 §9.4), and `receiver.carrierChanged` sends the resume ack.
3. **Demotion.** A demotion happens only when progress stops
   (`RemoteTransportPathMonitor.stalled`), or on a hard failure:
   - `silent`: no authenticated inbound for the idle timeout,
     max(6 s, 3 × PTO) (RFC 9000 §10.1);
   - `no-progress` — an **application-progress policy**, not an RFC rule:
     records outstanding, and for the relay's existing 6 s bound
     (`DESKTOP_HANDSHAKE_STALL_MS` + `DESKTOP_LIVENESS_PROBE_MS`, the same
     source as `silent`) since that work
     became outstanding (`outstanding(bytes, now)` after every push and ack)
     neither an ack advance nor an actual `bufferedAmount` decrease. An empty
     queue is not progress: pongs arriving over an empty queue while the
     cumulative ack stands still is `no-progress`;
   - the channel closes or fails, or ICE fails.

   A record's age is never a trigger. A slow uplink with 1 MiB queued is
   healthy while it drains.

   Then `carrierFailed(direct, now, relayMonitor.ptoMs())` runs, the receiver
   calls `carrierChanged`, and the reason is logged.
4. **Recovery.** An ICE restart (a new offer, `generation + 1`) or a new peer
   runs in parallel. Traffic stays on the relay until the next promotion.
5. **Revoke and session replacement.**
   - A revoked device, a new handshake on the leg, `client-left`, or record
     expiry closes the peer and drops both stream cores.
   - Unacked RPCs fail as ambiguous.
6. **Mobile suspension.**
   - When the page becomes hidden, it sends `setForeground(false)` first, then
     `close{reason:'suspended'}` together with the relay socket.
   - The desktop counts a leg as foreground only while it has authenticated
     liveness within `FOREGROUND_STALE_MS`.

**Fallback order:** direct → TURN (reported as `turn`/relayed) → relay carrier.

## 6. Rollout

1. **Relay.** No protocol change; it must never drop transport frames.
2. **Phone page.** `helloFields` and `confirmHandshake` are wired. The phone has
   no switch of its own: it opts in (`remoteTransportOptIn`,
   `renderer/remote-transport-peer.ts`) only when the challenge it received
   offers `transportWebrtc` with `binaryFrames` and the page has
   `RTCPeerConnection`. The relay-served page is shared by every user, so this
   is what keeps a PC without the offer exactly as before: it never offers, and
   its phone never opts in (its hello, proof and frames are the legacy ones).
   No consent prompt is added: the transport adds no authority (same E2EE
   session, the relay stays the fallback).
3. **PC.** The offer is off by default and ships dormant (coordinator and peer
   host included). It is a **local, per-PC switch**, not a build constant: the
   developer option **Direct phone connection (test)** (Settings → Developer
   options → Remote; setup tool `set_developer_option` with name
   `directPhoneConnection`, `enabled:true`, `riskAccepted:true`), stored at
   agent config `developer.directPhoneConnection`. The desktop service reads
   it **once at start-up** (`main/remote-transport/switch.ts`), so a change
   applies after Mixdog restarts. On, the service builds the peer service and
   the challenge carries `transportWebrtc: 1`; off, nothing exists and no
   challenge, hello, frame or log changes. The desktop app always asks the
   service to attach its peer window and the service answers nothing while off.
4. **Enable for everyone.** Make the PC's default on (or retire the option);
   no phone change is needed.

Test on a real phone with one PC: turn the option on, restart Mixdog, open the
phone. Mixed pairs stay legacy: an old PC never offers, so a new phone never
opts in; a new PC that offers serves an older phone a legacy session (§1).

## 7. Diagnostics (never content)

Per session:
- the path (`relay` | `direct` | `turn`) and the last promotion or demotion reason;
- bytes sent and received, and the part that moved on a direct carrier
  (`directBytesSent` / `directBytesReceived`);
- queue depth and outstanding bytes;
- retransmits;
- receiver duplicates, discards, evictions, and head and future bytes.

Log lines (only while the PC offers; prefix `[mixdog-remote-transport]`):
- **PC** — `session=<8> offered=1 negotiated=0|1` per phone handshake (did the
  phone take the offer); `path=direct|turn reason=channel-open` and
  `path=relay reason=…` on every promotion and demotion; `carrying path=direct`
  once, at the first application record written to a direct carrier;
  `ended … tx= rx= direct-tx= direct-rx=` when the session ends (the direct
  share is what really moved on the direct path). The daemon has no
  diagnostics file, so these lines also reach the app as the
  `remote-transport-log` desktop event and are written to
  `%APPDATA%\mixdog-desktop\logs\desktop-diagnostics.jsonl` as
  `{"event":"remote-transport-pc","line":"…"}`. The hidden peer window's own
  events are `remote-transport-peer-*` in the same file; a failed attach is
  `remote-transport-attach-failed`.
- **Phone** (its browser console, `chrome://inspect` / Safari Web Inspector) —
  `session=<8> offered=1 opt-in=0|1 negotiated=0|1`, the same `path=` lines,
  `carrying path=…` and `ended tx= rx= direct-tx= direct-rx=`.

## 8. Routing inventory

**PC↔PC.**
- "Connect to another PC" loads the relay-served web app in a sandboxed window
  (`main/remote-host-windows.ts:118-169`). That is the phone renderer, so it
  uses the phone seam.
- The host's peer host is always the offerer and never needs to answer.
- These stay on the relay:
  - the hook leg (`apps/relay/server.mjs:738`);
  - feedback (`main/feedback-client.ts:5`);
  - revocation (`main/remote-relay-device.ts:250-289`).

**Phone writes and requests.**

| Site | Class |
|---|---|
| `renderer/remote-shim-calls.ts:126` | E2EE seam |
| `remote-shim-calls.ts:132` | Legacy non-E2EE write, unchanged |
| `remote-shim-socket.ts:390` (hello) | Relay |
| `remote-shim-liveness.ts:97,210` (`{"ping":1}`) | Relay |
| `remote-shim-liveness.ts:131,137` (`setForeground`), `remote-shim-api.ts:276` (`setScreenSessions`) | Seam (RPCs) |
| `public/sw-media.js:200,361` | Media lane → adapter |
| `remote-file-preview.ts:697` (Range probe) | Media lane → adapter |
| `push-notification-bridge.ts:110,289,323,445` | Relay |
| `registerNativePush` | Seam |
| `remote-shim-pairing.ts:81`, `remote-pairing-screen.ts:241,302` | Relay |
| `public/sw.js:191`, `sw-shell.js:102-175` | Relay |

**PC side.**
- The seam is `main/remote-relay-delivery.ts:38-119`.
- The media lane is `main/remote-relay-media.ts:167-283`.
- The relay envelopes stay on the relay.

**Foreground.**
- The input to `push-notifier.ts:240` comes from `remote-relay-session-wiring.ts:123-147`.
- It is set by `remote-relay-client-calls.ts:412-421` (`setForeground`,
  `setScreenSessions`), from `remote-shim-liveness.ts:131,137` and
  `remote-shim-api.ts:276`.
- There is no time-based expiry today. A leg stops counting only when it leaves
  the registry:
  - when the socket closes;
  - when the relay sweep runs (`server.mjs:784-805,864`);
  - when suspension runs after the 30 s grace (`remote-shim-liveness.ts:107-160`).
- `setForeground(false)` is sent only by the installed web app.

**Ceilings, keys and framing.**
- Relay `relay-transport.mjs`: `MAX_FRAME_BYTES` 64 MiB (`:13`), undeclared
  capacity 64 KiB (`:44`), queues 8 MiB (`:198-199`).
- Desktop side: `RELAY_DEFAULT_MAX_FRAME_BYTES`.
- Keys: the channel key uses HKDF info `…\0key\0…`, media `…\0media\0…`, and
  transport `…\0transport\0…`.
- Media framing (`remote-media-crypto.ts`): `u32 len | nonce | ct`, 64 KiB
  segments; windows at `remote-relay-media.ts:40-43`.

**References (structure only).**
- A port-forward mux uses a fixed 64 KiB frame cap. It validates each packet
  before buffering, and the receiver grants credit windows that the sender
  never exceeds.
- This contract uses the same shape. No code was taken.

## 9. Scope table

**Protected paths. No stage edits them:**
- `apps/desktop/src/shared/remote-webrtc.ts`
- `apps/desktop/src/main/remote-webrtc/**`
- `apps/desktop/src/renderer/remote-webrtc-*`
- `apps/relay/deploy/coturn/**`
- `apps/desktop/src/main/secure-desktop/**`
- `native/**`

**Stage 0 files are frozen** for the stages below. A needed change goes back to
the contract owner.

Every path is listed explicitly; no stage owns a glob. Paths are relative to
`apps/desktop/` unless rooted otherwise.

| Stage | Exclusive files | Done when |
|---|---|---|
| 0 Contract | `src/shared/remote-transport.ts`, `src/shared/remote-transport.test.mjs`, `src/shared/remote-e2ee.ts`, `src/shared/remote-e2ee-compression.ts`, `src/shared/remote-e2ee-transport.test.mjs`, `docs/remote-transport.md` (repo root) | Parsers, handshake binding (the flag stripped or added on both legs, `binaryFrames` flipped), domains, stream core (no timer re-send, resume point, repair, acks and repairs ordered by control sequence in both arrival orders, RFC 9002 loss declaration and PTO probes with backoff kept across discards and evictions, the sender PTO probe and `ping.sent` for a lost final record, one large assembly per session and the process pool), path monitor (RFC 9002 estimator, idle timeout, persistent congestion; an empty queue is not progress), bulk credit, carrier size gate and fragments are unit-tested. Both typechecks pass. SDP, candidate and ICE-server validation is imported from `remote-webrtc.ts` (`parseRemoteWebrtcSdp`, `parseRemoteWebrtcCandidate`, `parseRemoteWebrtcIceServers`), with the SDP first bounded to the control plaintext budget. |
| 1A Main coordinator | `src/main/remote-transport/coordinator.ts` (new), `src/main/remote-transport/coordinator.test.mjs` (new), `src/main/remote-relay-delivery.ts`, `src/main/remote-relay-client-lifecycle.ts`, `src/main/remote-relay-client-lifecycle.test.mjs`, `src/main/remote-relay-clients.ts`, `src/main/remote-relay-client-calls.ts`, `src/main/remote-relay-client-calls.test.mjs`, `src/main/remote-relay-session-wiring.ts`, `src/main/remote-relay-session-wiring.test.mjs`, `src/main/remote-transport/peer-link.ts` (new), `src/main/remote-relay.ts`, `src/main/desktop-service.ts`, `src/main/index.ts` (startup wiring) | (1) Transport-mode boxes go through split → `canAdmit` → seal → sender, and carrier messages go through receiver → open → commit or discard → assembler. (2) A pre-seal refusal leaves `nextSequence()` unchanged (tested). (3) The transcript confirmation: every `e2ee-ready` of a server that offered carries `handshakeConfirmation()`. In a transport session it is app record 1, sent through the sender core as an `MXT` kind-1 record on the relay, with nothing sealed in the app domain before it; otherwise the legacy `e2ee-ready` (§1) (tested). (4) Acks, repair rounds and pings are on the control domain; control boxes are handed to their lane in seal order and opened with `openControl(raw, lane)` (`relay` or `direct:<connectionId>`); a box sealed for a direct carrier that failed before sending is dropped and regenerated, never moved to the relay; signaling only uses the relay lane (tested). Control-lane lifecycle: `registerControlLane({kind:'direct', epoch, connectionId})` when a new connection's offer is sent (1A) or received (1C), with epoch = that offer's `generation`; `activateControlLane` on promotion; `retireControlLane` when the connection closes; nothing on an ICE restart (same `connectionId`); every `sealControl(value, lane)` names the lane the box will be sent on (tested: a retired epoch is refused, churn stays bounded). A pong is accepted only if it matches a locally timed, outstanding ping id sent on the CURRENT carrier, and each id is consumed once; unsolicited pongs, repeats and pongs that arrive for an old carrier are rejected, and only matched pongs feed `rttSample` (tested). (5) Promotion and demotion follow §5. (6) Relay-only mode works without a peer host. (7) Record expiry (`sender.expired`) ends the session and fails unacked RPCs as ambiguous (tested). (8) Demotion only from `RemoteTransportPathMonitor.stalled` or a hard failure; one monitor per carrier, `reset` on every change; resume via `carrierFailed(…, monitor.ptoMs())` + `carrierChanged`; no timer re-sends (tested: a slow but draining carrier is never demoted or re-sent to). (9) Loss recovery: `receiver.repairDue(now, monitor)` on every tick, `sender.probeDue(now, monitor.ptoMs())` → probe ping, `receiver.sweep(now, monitor.idleTimeoutMs())` → ONE sealed `remoteTransportRepair(sequences)` per non-empty round → `sender.repair`; every ping carries `sent: sender.probeThrough(carrier, bufferedAmount)`, and an authenticated ping's `sent` goes to `receiver.probe`; `monitor.outstanding(bytes, now)` after every push and ack (tested: a dropped middle record and a dropped final record are both recovered). (10) Promotion gated by path validation (a fresh ping/pong) and `remoteTransportCarrierFits`; no hold-down. (11) One cached ICE/TURN credential set serves both peers of the session (live view and transport); TURN allocations are logged per session (count, relayed path, never credentials). (12) In `remote-relay-delivery.ts`, every sealed transport message goes on the non-droppable relay path (`droppable: false`, never through the droppable `broadcastEncrypted` fan-out); dropping and coalescing happen only before sealing (tested: a busy relay leg never loses a sealed record). (13) Messages are split with `splitRemoteTransportPayload` (64 MiB cap, refused before sealing through the existing oversize refusal); the desktop uses the shared process pool (`new RemoteTransportMessageAssembler()`), holds a `wait` payload without pulling further records, and ends a `stalled` assembly's session with `close()`. The daemon ↔ app hop (§3 "Where the carrier runs"): the daemon's stand-in bridge implements `RemoteTransportPeerBridge` with `queued` = unacknowledged hop bytes + the app's last reported load, and `BUFFER_HIGH_BYTES` holds end to end across both hops (tested with the real `peer-window` and a fake Electron); no app, a detach, a restart or a silent app fails to the relay as `peer-host-unavailable`, and a later attach serves the next offer (tested); the app accepts commands only from this PC's daemon connection; with the rollout switch off there is no stand-in, no attach, no window and no traffic (tested); the daemon bundle stays Electron-free (`daemon-bundle-electron.test.mjs`). |
| 1B Hidden transport renderer | `src/main/remote-transport/peer-window.ts` (new), `src/main/remote-transport/peer-window.test.mjs` (new), `src/preload/remote-transport-peer.ts` (new), `src/renderer/remote-transport-peer.html` (new), `src/renderer/remote-transport-peer-host/main.ts` (new), `electron.vite.config.ts` (two entries only) | A dedicated hidden renderer, brokered by window main like `sender-window.ts`. It offers, applies the answer and candidates, checks fingerprints, exposes the channel with `bufferedAmountLowThreshold` and the high-water mark, and reports a crash as `peer-host-unavailable`. Plus:
- It creates both channels (`mixdog-transport` and `mixdog-transport-control`, both reliable and ordered) and reports `pc.sctp.maxMessageSize` after connect.
- It sets `bufferedAmountLowThreshold` before the first send, and re-checks `bufferedAmount` right after registering the low listener (a drain that happened in between is not missed).
- Bytes queued on the main → hidden-renderer IPC hop count toward the high-water mark together with `bufferedAmount`.
- Fast-LAN throughput is measured and recorded (MB/s, CPU), and the bounds hold there.
- **Control under bulk saturation** (with 1C): with the app channel kept at the bulk gate by a media transfer, the control channel's ping round trip and ack latency are measured and recorded; they must stay within the base RTT plus the time to drain what the backpressure allows ahead of them (`BUFFER_HIGH_BYTES` across both channels and the IPC hop, at the measured throughput), and the path must never be judged `silent` or `no-progress` while bulk drains (tested). |
| 1C Phone | `src/renderer/remote-transport-peer.ts` (new), `src/renderer/remote-transport-peer.test.mjs` (new), `src/renderer/remote-shim-calls.ts`, `src/renderer/remote-shim-calls.test.mjs`, `src/renderer/remote-shim-socket.ts`, `src/renderer/remote-shim-socket.test.mjs`, `src/renderer/remote-shim-liveness.ts`, `src/renderer/remote-shim-liveness.test.mjs`, `src/renderer/remote-shim-state.ts` | The hello is built with `helloFields`. The phone verifies the transcript confirmation (`confirmHandshake` on `e2ee-ready`) before `finishOpen` and before sending anything on the session; a missing, stripped or altered confirmation sends nothing and ends the session (tested). The phone answers, sends through split → seal → sender, and receives through receiver → open → assembler. A pre-seal refusal leaves the next sequence unchanged. Suspension closes the peer. Gated off until rollout step 4. Plus:
- The same two channels (both ordered), the `maxMessageSize` gate, and the backpressure hardening as 1B: threshold set before the first send, and `bufferedAmount` re-checked after the low listener.
- **Mobile resume:**
  - ping at once (control channel and relay) on `visibilitychange` to visible, `pageshow`, `resume` and `online`;
  - after any hidden period, treat an `open` `readyState` as unproven until that ping is answered, because SCTP never aborts a dead path on its own;
  - rely on no timer during suspension: everything is re-proven on wake.
- Every sealed transport message goes to the relay as non-droppable; dropping and coalescing happen only before sealing (tested).
- Loss recovery as 1A (9): `repairDue(now, monitor)` → one repair box per round, `probeDue` → ping with `sent` from `probeThrough`, `probe(sent, now)` on an authenticated ping.
- `e2ee-ready` in a transport session is taken only as app record 1 from the receiver (`MXT` kind 1), never as a bare box (§1); otherwise the legacy form.
- The control-under-bulk-saturation test as 1B, from the phone side.
- Control lanes and RTT security as 1A (4): the same lane lifecycle (register on the received offer, activate on promotion, retire on close, nothing on ICE restart), seal-order handoff, `sealControl(value, lane)` / `openControl(raw, lane)`, and a pong is accepted only if it matches a locally timed, outstanding ping id sent on the CURRENT carrier, and each id is consumed once; unsolicited pongs, repeats and pongs that arrive for an old carrier are rejected, and only matched pongs feed `rttSample` (tested).
- The phone assembler is `new RemoteTransportMessageAssembler()` (the page's own pool), with the same `wait` and `stalled` handling as 1A. |
| 1D Media adapter | `src/main/remote-relay-media.ts`, `src/main/remote-relay-media.test.mjs`, `src/main/remote-transport/media.ts` (new), `src/main/remote-transport/media.test.mjs` (new), `src/renderer/public/sw-media.js`, `src/renderer/sw-media.slow.test.mjs`, `src/renderer/remote-file-preview.ts`, `src/renderer/remote-file-preview.test.mjs` | Range, version, lease and device semantics are identical on both lanes. Backpressure counts **encoded and encrypted wire bytes** (box plus framing), not plaintext, and pauses readers above the high-water mark (tested). Cancel stops the pump. Media records are pushed with `{ stream: id }`: admitted only at or below the low-water mark, within the bulk share and the per-stream credit, so an RPC sent during a download is never queued behind it (tested). |
| 1E Relay and push | `src/main/push-notifier.ts`, `src/main/push-notifier.test.mjs`, `src/main/remote-transport/foreground.ts` (new), `src/main/remote-transport/foreground.test.mjs` (new); in the relay: `apps/relay/lib/relay-legs.mjs`, `apps/relay/lib/relay-legs.test.mjs`, and only if a change proves necessary `apps/relay/lib/relay-transport.mjs` and its test | (1) A leg is foreground only with authenticated liveness within `FOREGROUND_STALE_MS`. (2) A deterministic fake-clock test of a frozen phone: still foreground at 34 999 ms, not foreground at 35 000 ms, while the leg stays registered; a `hidden` report removes eligibility at once. (3) Transport frames are never dropped as pushes. (4) In `relay-legs.mjs`, transport frames are forwarded with `forwardFrame` (and the binary path, `sendToPhone(phone, frame.data, frame.droppable)`) as non-droppable, and never go through `broadcastFrame`, which is droppable unless `critical`; a relay test proves that a full phone queue never silently drops a transport frame (it waits, defers or cuts the leg). (5) Transport frames of one leg are forwarded FIFO in both directions, never reordered (no `defer` path), so the relay is a FIFO control lane (tested). 1A calls `foreground.ts` from session-wiring. |
| 2 Integration | `src/main/remote-transport/transport-e2e.test.mjs` (new), `src/renderer/remote-transport-e2e.test.mjs` (new) | These pass end to end: relay-only; promote; demote mid-transfer (no loss, no replay error); forged relay frames (recovered within one PTO); a dropped middle record and a dropped final record recovered through repair; a carrier switch re-sends only above the resume point; revoke and suspend; media seek; a 27 MiB upload fragmented while acks and pings flow. |

**Order:** 0 → (1A ∥ 1B ∥ 1C ∥ 1D) → 1E → 2.
- 1A integrates 1B's bridge.
- 1D depends on 1A's stream routing.
- 1E's `foreground.ts` is called from 1A's session-wiring.

## 10. Constants and their sources

Sources: **(a)** a standard and the cited section (where the standard is adapted, §3 lists how); **(b)** an existing Mixdog
limit the relay path already enforces (`file:line`); **(c)** a measurement;
**derived** means computed only from (a)/(b) rows above it. Constant names
drop the `REMOTE_TRANSPORT_` prefix (`apps/desktop/src/shared/remote-transport.ts`).

| Constant | Value | Source | Use |
|---|---|---|---|
| `MAX_MESSAGE_BYTES` | 65 466 | (b) 64 KiB undeclared capacity `apps/relay/lib/relay-transport.mjs:44` − binary header 6 `relay-binary-frame.mjs:4` − longest routing id 64 `ids.mjs:4`, as `uplinkCeilings` computes (`relay-transport.mjs:180-182`); ≤ RFC 8841 §6.1 default 65 536 (a) | Largest carrier message |
| `CHUNK_HEADER_BYTES` / `PREFIX_BYTES` / `BOX_HEADER_BYTES` | 25 / 5 / 24 | Wire format (§3) | Framing |
| `CHUNK_BYTES` | 65 441 | derived: message − chunk header | Chunking |
| `MAX_CONTROL_BOX_BYTES` / `_PLAINTEXT_BYTES` | 65 461 / 65 421 | derived: one message − prefix; − box header and tag | Signaling, acks |
| `MAX_ACK_RANGES` | 1 815 | derived: maximal ranges that fit one control box beside the largest ack envelope (RFC 9000 §19.3 sets no count) | Ack ranges |
| `MAX_RECORD_PLAINTEXT_BYTES` / `MAX_RECORD_BYTES` | 1 MiB / 1 MiB + 40 | (b) `MEDIA_WINDOW_MAX_BYTES` `apps/desktop/src/main/remote-relay-media.ts:40` (= `RELAY_E2EE_TRANSPORT_MAX_PLAINTEXT_BYTES`, `shared/remote-e2ee.ts:392`) | Record cap |
| `MAX_CHUNKS` | 17 | derived | Chunk count bound |
| `remoteTransportRecordCharge` | max(record bytes, 65 466) | derived: one carrier message (`MAX_MESSAGE_BYTES`) per record; the window is in bytes only, as RFC 9000 flow control (§4) | What every record costs against the window, at both ends |
| `MAX_RECORDS_IN_FLIGHT` | 128 | derived: 8 MiB window (`relay-transport.mjs:198-199`) ÷ 65 466 | Receiver reorder span; ack-range bound; `ping.sent` clamp |
| Control replay rule | per authorized lane: accept only above the lane's high-water (reorder window 0); lane in the AAD; at most 3 lanes + an epoch floor | derived: see **Control boxes in flight** below (`shared/remote-e2ee.ts` `openControl`, `registerControlLane`) | `sealControl(value, lane)`, `openControl(raw, lane)` |
| `MAX_OUTSTANDING_BYTES` = `FUTURE_BUDGET_BYTES` | 8 MiB | (b) `PHONE_QUEUE_LIMIT_BYTES` / `UPLINK_QUEUE_LIMIT_BYTES` `relay-transport.mjs:198-199` | Sender window; receiver budget behind the head (both in charged bytes) |
| `CANDIDATES_PER_SLOT` | 2 | Structural minimum (the genuine copy beside one forged one); not a tuning | Rival assemblies |
| `OPEN_WORKING_BYTES` | 2 × record + 5 × plaintext | derived: allocation inventory of `decryptJson` (slice and copy, GCM output, inflate chunks and join, UTF-16 string) | Head reserve |
| `HEAD_RESERVE_BYTES` | ≈ 9.0 MiB | derived: 2 × record + open working set | Head-of-line reserve |
| `RECEIVE_BUDGET_BYTES` | ≈ 17.0 MiB | derived: future budget + head reserve | Receiver record budget |
| `BULK_OUTSTANDING_BYTES` | 8 MiB − 1 MiB − 40 | derived: window − one maximal record | Bulk share |
| `MEDIA_STREAM_CREDIT_BYTES` | 1 MiB | (b) `MEDIA_PAUSE_BUFFER_BYTES` `apps/relay/lib/relay-media-proxy.mjs:20` | Per-stream credit |
| `MEDIA_CHUNK_MAX_CHARS` / `MEDIA_RECORD_MAX_BYTES` | 87 424 / 87 586 | derived from (b) `MEDIA_SEGMENT_BYTES` `shared/remote-media-crypto.ts:27` and the exact chunk envelope | Bulk admission |
| `MAX_MEDIA_STREAMS` | 32 | (b) `MAX_MEDIA_STREAMS` `relay-media-proxy.mjs:24` | Concurrent media streams |
| `BUFFER_LOW_BYTES` | 1 MiB | (b) `SKIP_PUSH_BUFFER_BYTES` `relay-transport.mjs:194` (where the relay sheds low-priority frames) | `bufferedAmountLowThreshold`; bulk gate |
| `BUFFER_HIGH_BYTES` | 8 MiB | (b) per-leg queue `relay-transport.mjs:198-199` | Stop writing; pause readers |
| `MAX_APPLICATION_MESSAGE_BYTES` | 64 MiB | (b) `MAX_FRAME_BYTES` `relay-transport.mjs:13` (`RELAY_DEFAULT_MAX_FRAME_BYTES`, `shared/remote-payload-limit.ts:140`) | Message cap, both directions |
| `FRAGMENT_BYTES` / `MAX_FRAGMENTS` | 786 348 / 86 | derived: largest multiple of 3 whose base64url plus the largest envelope fits one record | Fragmentation |
| `ASSEMBLY_POOL_BYTES` | 72 MiB | (b) 64 MiB frame `relay-transport.mjs:13` + 8 MiB queue `:198-199` | Process-wide large-message assembly |
| `ASSEMBLY_IDLE_MS` / `RECORD_EXPIRY_MS` | 60 s / 60 s | (b) `INGRESS_WAIT_TIMEOUT_MS` `relay-transport.mjs:249` | Stalled large message; no ack progress ends the session |
| `INITIAL_RTT_MS` | 333 ms | (a) RFC 9002 §6.2.2 kInitialRtt | RTT before a sample |
| `GRANULARITY_MS` | 1 ms | (a) RFC 9002 §6.1.2 kGranularity | Loss delay, PTO |
| `PACKET_THRESHOLD` | 3 | (a) RFC 9002 §6.1.1 kPacketThreshold (value as in the RFC; counted on receiver evidence, §3) | Loss declaration |
| `TIME_THRESHOLD_NUM` / `_DEN` | 9 / 8 | (a) RFC 9002 §6.1.2 kTimeThreshold (value as in the RFC; timed from receiver evidence, §3) | Loss declaration |
| PTO | `smoothed_rtt` + max(4·`rttvar`, 1 ms) + 25 ms; 1 024 ms initially; ×2 per expiry | (a) RFC 9002 §6.2.1 formula, adapted (§3: receiver-driven, reset on delivery commit) | Repair re-requests, sender probe; also the post-switch hold, a Mixdog optimization |
| `PTO_PROBES` | 2 | (a) RFC 9002 §6.2.4 ("up to two"), applied to repair re-requests | Re-requests per PTO expiry |
| `MAX_ACK_DELAY_MS` | 25 ms | (a) RFC 9000 §18.2 default `max_ack_delay` | Delayed ack; PTO term |
| `ACK_ELICITING_THRESHOLD` | 2 | (a) RFC 9000 §13.2.2 | Ack after two records |
| `MAX_IDLE_TIMEOUT_MS` | 6 s | (b) `DESKTOP_HANDSHAKE_STALL_MS` 4 s `apps/relay/lib/relay-legs.mjs:58` + `DESKTOP_LIVENESS_PROBE_MS` 2 s `:61`; effective = max(6 s, 3 × PTO), (a) RFC 9000 §10.1 | `silent`; incomplete-assembly eviction; the `no-progress` application-progress policy (a Mixdog policy, not an RFC rule) |
| `PING_MS` | 2 s | (b) `DESKTOP_LIVENESS_PROBE_MS` `relay-legs.mjs:61` (RFC 9000 §10.1.2 keep-alive sets no interval) | Keep-alive ping |
| `FOREGROUND_STALE_MS` | 35 s | (b) `apps/desktop/src/renderer/remote-shim-liveness.ts:93` 25 s silence + `:85` 10 s pong wait | Push foreground eligibility |
| `NEGOTIATION_TIMEOUT_MS` | 39.5 s | (a) RFC 5389 §7.2.1 (Rc = 7, RTO = 500 ms, Rm = 16); same value as `main/remote-webrtc/viewer.ts:38` | Offer to channel open |
| Message measurement | ≤ 96 KiB frames, ≤ 243 KB first transcript | (c) `daemon.log`, §4 | Parity evidence only (no constant depends on it) |

**Removed in this round:** the repair wait "9/8 × RTT" with a "3 × RTT +
50 ms" backoff doubling to 6 s (now RFC 9002 §6.1/§6.2), the repair token
bucket and its per-round cap of 32 (now one declared repair per sequence plus
§6.2.4 probes), the promotion hold-down ladder 6 s → 300 s / 600 s reset (no
standard covers it), the 50 ms ack delay and 256 KiB ack-every (now RFC 9000
§13.2/§18.2), the 32 KiB chunk ("half" of a limit), the 16 MiB receive budget
(a renderer limit, not a relay one), the 256 KiB low-water mark and media
credit, the "half the window" bulk share, the stall bound "3 × ping", and
the 1 024-record window (now byte-only with a per-record charge), the
64-entry control replay window (now per-lane, see below) and the
3 × PTO "persistent congestion" demotion (now the 6 s application-progress
policy).

### Control boxes in flight (the replay-window derivation)

**What one side can seal**, per direction, counted against the 128-record
window and one PTO:

| Source | Boxes |
|---|---|
| Acks | One per 2 delivered records, or one per record when the 25 ms timer fires first (it fires only with a record pending): at most 128 per 128-record window, plus one forced re-ack per duplicate burst or carrier change. |
| Repair rounds | One box per `repairDue` round with output: one declaration round per new piece of evidence, plus one round per PTO expiry (at most 2 sequences). |
| Pings / pongs | One keep-alive per `PING_MS` (2 s) plus one probe per PTO expiry; one pong per peer ping. |
| Signaling | Offer, answer, candidates and close of the current `generation` (relay lane only). |

**Why a shared window has no fixed size.** Across lanes the count of boxes
that overtake one box is not bounded by any constant. Example: on a 1 ms LAN
direct path the 128-record window turns over every RTT, so acks alone run at
about 64 boxes per millisecond; a signaling box on the relay lane spends about
76 ms in transit (half the 152 ms Korea–LA round trip), so about 4 900 direct
acks are sealed after it and arrive before it. No sliding window of fixed
size (64, 1 024 or any other) keeps it, which is the failure the review found.

**Per lane, the bound is 0.** Each lane is FIFO end to end:
- the relay lane: one WebSocket (TCP) per leg, forwarded FIFO by the relay
  (1E done-when 5);
- a direct lane: the ordered `mixdog-transport-control` SCTP stream
  (RFC 9260 §6.6);
- the sender hands boxes to a lane in seal order (`sealControl` resolves in
  sequence order).

So within one lane no genuine box is ever overtaken, the reorder window is
**0**, and the replay rule is "above the lane's high-water mark". Across lanes
no order is assumed. A repair round is one box, so a full 128-sequence round
cannot push its own start out of any window.

**Why the lane is authenticated and the table bounded.** If the lane were only
a local label, anyone able to inject on one carrier (the relay can) could
replay a box under another lane name, and each new name would start at
high-water 0. So the lane (kind, epoch, connectionId) is in the AAD — a box
opens only on the lane it was sealed for — and only lanes authorized by
signaling exist: the relay, the current connection and one pending one. A
direct epoch must exceed every epoch ever registered, so a superseded
connection can never be registered again, and the retained state is three
high-water marks and one floor however many connections a session churns
through.
