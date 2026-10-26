# Remote live view over WebRTC

The phone's view of a desktop browser page (later also the whole screen) as a
remote-desktop stream: WebRTC video through this deployment's TURN server,
locked geometry, input on a reliable data channel, and automatic fallback to
the JPEG-over-relay view. The wire contract is
`apps/desktop/src/shared/remote-webrtc.ts` (version `REMOTE_WEBRTC_VERSION`);
this page explains how its pieces fit.

## Roles and files

| Part | Owns | Files |
| --- | --- | --- |
| Service (daemon) | Validates phone signals, checks the client streams the source, resolves ICE servers, mirrors the input-ownership gate in decode order, withholds JPEG images while WebRTC owns a client's view. | `main/remote-webrtc/relay.ts`, `main/remote-relay-client-calls.ts`, `main/remote-browser-streams.ts` |
| Window main | Capture, geometry lock, the per-viewer transport state machine, input dispatch through the relay path's own guard. | `main/remote-webrtc/viewer.ts`, `main/remote-webrtc/host.ts`, `main/browser/remote-geometry.ts`, `main/browser/remote-stream-engine.ts` |
| Sender renderer (hidden, trusted) | Every `RTCPeerConnection`, one canvas-generated track per source, encoder settings, sender stats. | `main/remote-webrtc/sender-window.ts`, `preload/remote-webrtc-sender.ts`, `renderer/remote-webrtc-sender/main.ts`, `shared/remote-webrtc-sender.ts` |
| Phone (projected renderer) | The receiving `RTCPeerConnection`, presentation (zoom, pan, keyboard), input routing per epoch, receiver stats. | phone-side work |
| `main/remote-ice-servers.ts` | `resolveRemoteIceServers()`: STUN + TURN with short-lived credentials from the relay. | |

A host advertises the contract with `browserWebrtc: 1` in its E2EE challenge.
A phone without it, or a host without it, stays on JPEG.

## One path: TURN only

Both ends build their peer connection with `iceTransportPolicy: 'relay'`; the
offer carries `iceTransportPolicy: 'relay'` and the phone must apply it. No
host, srflx or prflx candidate is gathered or accepted: a candidate signal must
be a `typ relay` line (or the empty end-of-candidates line). An offer is valid
only with at least one `turn:`/`turns:` server with credentials.

The service resolves the ICE servers afresh for every `ready` (one per
connection attempt; the credential cache decides reuse). When that yields no
TURN server, the desktop answers `ready` at once with `close` /
`turn-unavailable` and the JPEG view simply stays — the emergency fallback, as
it is when relay negotiation fails.

## Ids and ordering

- **Viewer** = paired client × source (`{kind:'browser', sessionId}`; `screen`
  is reserved for the whole-PC source). All state is per viewer; one viewer's
  failure never restarts the page or touches another viewer.
- **Connection generation** rises with every attempt; `connectionId` is minted
  per attempt by the desktop. Anything of another generation or connection is
  discarded.
- **Geometry generation** belongs to the source's stream and never repeats for
  a session, across streams.
- **Input epoch** rises at every ownership switch. Channel input carries
  `epoch` and a strictly increasing `seq`; a repeat is never applied.

## Signaling

Over the existing E2EE relay channel; no new authentication. Phone → desktop is
the client-bound call `browserRemoteWebrtcSignal([signal])`; desktop → phone is
the per-client push `browserRemoteWebrtc`. The service refuses a signal for a
source the client does not stream (`browserRemoteStream` subscription).

1. The phone, streaming JPEG, sends `ready` with the codecs it can decode. The
   desktop first sends the locked `geometry`; the phone answers `geometry-ack`
   for every geometry it adopts (from `geometry` or from an offer).
2. The desktop answers with `offer`: SDP, its DTLS fingerprints, the ICE
   servers, the relay policy, the locked geometry and the current relay epoch.
   The desktop created the data channel `mixdog-input` before the offer.
3. The phone sends `answer` with its fingerprints; both sides trickle
   `candidate` (`null` = end of candidates).
4. Either side may `close` with a reason. When the phone closes a viewer in
   `promoting`/`webrtc`, the desktop pushes `demote` before it answers that
   call.
5. `ready` may carry `videoLimit` (`maxWidth`/`maxHeight`, at most 4096): the
   largest video the phone wants, apart from its JPEG frame bound, so a
   desktop-sized page the phone zooms into keeps its detail. A limit above the
   stream's bound widens the capture (never shrinks it) and locks a new
   geometry generation before the offer; JPEG frames grow with it.

### Retry policy

The desktop never retries on a timer. Every attempt ends with `close`:
`retryAfterMs: 0` when another attempt is welcome (the viewer had reached
`webrtc`, or was superseded), absent when not (the path never worked, or no
TURN). A demotion ends with that `close` once the phone's `demote-ack` arrives.
`viewer-left` closes without a demotion. The phone's only automatic retry is
`ready` after a `close` with `retryAfterMs`; otherwise a new stream or relay
connection is a new viewer.

### Fingerprint binding

Each side sends its DTLS certificate fingerprints beside the SDP inside the
E2EE envelope; the receiver requires the SDP's `a=fingerprint` set to equal the
signaled set (SHA-256 or stronger). Once DTLS is up, the sender reads the peer
certificate from `getStats()` (`RTCCertificateStats` of the transport's remote
certificate) and main requires it to be one the E2EE answer named; otherwise
`fingerprint-mismatch` and JPEG. The phone does the same for the desktop's
certificate. The relay (or TURN) therefore cannot substitute a certificate.

## Geometry lock

Main is authoritative. The stream locks the page **as it is**: its CSS size as
the screencast describes it, and its device pixel ratio from
`Page.getLayoutMetrics` (device ÷ CSS visual viewport). The capture pixel size
honours that ratio within the frame bound the stream started with:

- device pixels more than CSS pixels and within the bound: frames are
  `Page.captureScreenshot` of the viewport at device pixels (the screencast,
  which Chromium sizes in CSS pixels and only scales down, is then only the
  repaint signal; one screenshot in flight, newest only);
- otherwise: screencast frames, scaled down to the bound.

Both the JPEG frames and the WebRTC track use that size. Pixel sizes are even.

### Default layout: watching vs take-over

A host that implements this advertises `browserFit: 1` in its E2EE challenge,
next to `browserWebrtc` (`REMOTE_BROWSER_FIT_CAPABILITY`). The phone's renderer
comes from the relay deployment and may be newer than the host: without the
flag the host ignores `fit` and never marks a frame, so the phone must not
wait for a fitted frame. With it, the phone waits for the first frame carrying
`fitSettled: true` — the marker, not a size comparison.

The phone states its intent on the existing stream request
(`browserRemoteStream([sessionId, options])`, `DesktopRemoteBrowserStreamOptions`
in `shared/contract-browser.ts`):

- **Watching** (the agent works; no `fit`): the page keeps its PC geometry.
  Nothing is emulated, so the agent's own page is never disturbed.
- **Take-over** (the agent paused for the person — sign-in, CAPTCHA, 2FA):
  `fit: {width, height, deviceScaleFactor}` = the phone pane's CSS box and
  device pixel ratio (the same bounds as the `viewport` control: 200–3840 CSS
  px, scale 0.5–4). The desktop fits the page **once**: when the stream starts
  with a `fit`, the fit is emulated before the screencast starts, so the first
  geometry and the first frame are already the fitted ones. A stream that was
  watching fits at the first request that carries a `fit` (one new geometry
  generation). After that the fit is locked: later `fit`s, the `viewport`
  control, the keyboard, panels and rotation never change it. With several
  subscribers, the earliest one carrying a `fit` is the one passed on.

The take-over owns the fit, not the capture: the service passes `fit` exactly
while at least one take-over subscribes. A subscription's take-over lasts for
its life: a renewal that omits `fit` keeps it (so renewals never flap between
restore and re-fit); the phone ends it explicitly with `fit: null` on a
renewal, or by ending the subscription. When the last take-over ends the
desktop restores the page's own metrics and zoom
— no reload — and keeps streaming it, as it is, to the watchers left (a new
geometry generation). A later take-over fits once more. A layout the person
chose with an explicit resize is kept.

If the fit cannot be applied (the page refuses its metrics, or the host cannot
emulate), the desktop gives it up: the page keeps its own geometry and every
frame carries `fitFailed: true` until the layout changes; no frame is ever
marked `fitSettled`. A waiting take-over then stops waiting and shows the page
as when watching; the service sends it pictures again and its WebRTC view may
be promoted on the current (unfitted) geometry. `fitSettled` requires that the
fit was applied to the pictured page and document, not just requested.

What a fit does to the layout depends on the page: metrics-only fitting
re-lays out **width-responsive** pages (media queries, fluid layouts) at the
phone's width, but **desktop-only or fixed-width** pages may keep their
desktop layout (a fixed 1200 px page stays 1200 px wide, scrolled
horizontally), since no mobile user agent or meta-viewport handling is turned
on to change them.

A fit is **device-metrics emulation only** — CSS width/height and device scale
factor; the user agent, mobile and touch emulation stay as the PC pane has
them, and nothing reloads, so a sign-in POST, a CAPTCHA or a one-time-code flow
keeps its state and a responsive page re-lays out in place. Switching mobile
emulation would turn on meta-viewport handling (a desktop-only page jumps to a
zoomed-out 980 px layout) and touch emulation flips pointer media queries, so
neither is changed. No other emulation domain is reset either: the agent's own
overrides (locale, geolocation, extra headers, media, CPU, network) stay in
force throughout (`fitMetrics`/`unfitMetrics` in `main/browser/emulation.ts`
issue only `Emulation.setDeviceMetricsOverride`). When the stream ends the
exact device metrics before the fit come back (or none), the page's zoom before
the fit and the pane's size return — a pane preset or zoom the PC chose during
the take-over wins — again without a reload.

A take-over joining a stream that is already running unfitted is never shown
the unfitted page: frames carry `fitSettled: true` once the stream's layout is
decided (fit applied, or an explicit resize) and the picture is of the capture
at it; until the subscriber's first such picture, the service sends it the
page facts only (no image, 0×0 picture), so its first picture is the fitted
one. The same holds for its WebRTC view: until that settled picture has gone
out, the service drops the subscriber's `media-ready` (the phone re-sends it),
and the window promotes only on a `media-ready` for the current geometry
generation — by then the fitted one — so no unfitted video is ever promoted.

The lock survives stream renewals (their bound is ignored), reconnects,
keyboard visibility and rotation. An explicit `resize-request` ("Fit page to
screen") stays available in both modes and uses the same no-reload emulation:
`fit-client` fits the given box, `page` returns the pane's geometry; either one
also decides the stream's fit, so a later request's `fit` no longer applies. A
PC-side resize or zoom also re-lays out the page. Each such change locks a new
generation, sent as `geometry`; pointer and wheel input for a generation is
accepted only after that viewer's `geometry-ack`. Key, text and IME input is
geometry-independent.

## Transport state machine

Desktop-authoritative, per viewer (`REMOTE_WEBRTC_TRANSITIONS`):

```
relay ─► negotiating ─► connected ─► promoting ─► webrtc
              │             │            │           │
              └──► cooldown ◄┘           └► demoting ◄┘
                      │                       │
                      └─► negotiating         └─► cooldown
(any state ─► closed)
```

- JPEG frames reach the phone in every state but `webrtc`.
- `connected` → `promoting` only when the phone's `media-ready` names the
  current document and acknowledged geometry generation with the locked pixel
  size, and the sender took a frame of that document and generation.
- **Promotion barrier.** Desktop sends `promote` (epoch E+1). The phone sends
  `promote-ack` on the relay after its last relay input, then input only on the
  channel. The service, decoding that ack, refuses the client's later relay
  page input and stops its JPEG images; it hands the ack to the window as a
  general-lane write, so it arrives behind every relay call decoded before it.
  Main holds channel input of E+1 until then.
- **Demotion.** Any failure in `promoting`/`webrtc` closes the peer connection
  and sends `demote` (E+2); the service resumes JPEG for that client at once.
  The phone drops unsent channel input (never replays it on the relay),
  answers `demote-ack`, then sends relay input. No page input is dispatched
  between `demote` and `demote-ack`; queued channel input of an older epoch is
  answered `rejected`, never applied. Without a `demote-ack` within the relay
  frame ack window (1.5 s) the desktop sends `close` and input returns to the
  relay.
- Failures before promotion go straight to `cooldown` with `close`.
- **Held buttons.** At hand-back (demotion, or the viewer leaving while the
  channel owned input) the desktop releases every mouse button the channel
  pressed and did not release (`mouseReleased` at its press position, through
  the same guarded path); the phone drops the releases it still had. This is
  the one place a source's release runs.
- **One recovery owner.** See the retry policy: only the desktop's `close`
  decides whether another attempt follows.
- In `webrtc` the relay keeps sending that client metadata-only frames (the
  ordinary frame without `image`: `documentId`, URL, title, loading, history,
  tabs, dialog, viewport), so the phone always knows the current document.

Bounds: offer → promotion is limited to 39.5 s, the STUN transaction timeout
of RFC 5389 §7.2.1 with its defaults; held or queued channel input per viewer
to 256, the per-client outstanding-frame budget of the relay path.

## Data channel

One reliable, ordered channel (`mixdog-input`), JSON text:

- phone → desktop `input`: `{epoch, seq, geometryGeneration, sentAt, control}`;
  `control` is the relay's document-bound page input (pointer, wheel, key,
  text, composition, composition-end), dispatched through the same path as
  relay input (`remote-input.ts` guard, serialized with agent work).
- desktop → phone `input-ack`: `{epoch, seq, outcome, sentAt, queuedMs, dispatchMs}`.
  Every channel input gets a definite outcome. A `rejected` one (stale
  document, unacknowledged geometry, failed dispatch) does **not** poison the
  rest of its epoch: each input is judged on its own, and nothing is uncertain
  to fence. The phone decides what to drop after a rejection.
- phone → desktop `stats`: receiver stats (with `frameWidth`/`frameHeight` and
  `inputToVisibleMs`), logged beside a sender sample.

## Ordered relay input

On a host that advertises `browserWebrtc` the phone may pipeline relay input:
`browserRemoteControl([sessionId, control, order])` with
`order = {v: 1, stream, run, seq}` (`RemoteWebrtcRelayInputOrder`). The service
keeps `{stream, run, lastSeq, poisoned}` per client × session and judges each
ordered control where relay page input executes — general-lane writes, one at
a time in decode order:

1. a new `stream` resets the state;
2. `run` below the current: refused, not dispatched;
3. `run` above the current: adopted, `poisoned` cleared;
4. `seq` ≤ `lastSeq`: refused; else `lastSeq = seq`;
5. `poisoned`: refused; else dispatched — a dispatch that throws sets
   `poisoned` and its error is the reply.

A control without an order keeps the unordered behaviour. The WebRTC input gate
(relay input refused while the channel owns input) applies to both, at decode.

## Sender

The hidden sender window draws each newest picture into a per-source canvas at
the locked pixel size and emits it with `requestFrame()` (no timer). The track
has `contentHint = 'detail'` and the sender `degradationPreference =
'maintain-resolution'`: under congestion frame rate gives way, never size.
Codecs are restricted to those the phone can decode, in Chromium's own order;
H.264 is not forced ahead until measurement shows it helps. Bitrate and frame
rate change with `setParameters` (`encoding` command), never by restarting.
When a connection comes up, the newest picture is sent again so a static page
still has a frame to decode. This first slice feeds the captured JPEGs; the
next one feeds guest shared textures as `VideoFrame`s.

## Source interface (for other video sources)

A source plugs into `createRemoteWebrtcHost` through a resolver returning a
`RemoteWebrtcVideoSource` (`main/remote-webrtc/source.ts`):

- `source` — its `RemoteWebrtcSource` (`{kind:'screen', screenId}` for a screen);
- `start()` / `stop()` — a WebRTC viewer needs frames / none remains (idempotent);
- `page()` — `{documentId, geometry}` now (`documentId` null without documents);
- `dispatch(control)` — validated channel input through the source's own
  authorization path;
- `resize?(request)` — an explicit resize, if the source can.

- `capturePlan?()` — a desktop-capture source (a screen): the sender opens its
  track from this `RemoteScreenCapturePlan` (`source-capture` command,
  `getUserMedia` with `remoteScreenCaptureConstraints`) instead of drawing
  pictures; `captureChanged(sourceKey)` reopens it on a display change;
- `videoLimit?(limit)` — the phone's video limit (browser source: widens the capture);
- `release?()` — release every key and button the viewer holds; without it the
  host dispatches the mouse releases the viewer tracked. The viewer calls it at
  hand-back (demotion) and when the viewer leaves while the channel owned
  input — that one place only.

The source pushes `geometryChanged(sourceKey, geometry | null)`,
`frame(sourceKey, picture)` and `captureChanged(sourceKey)` into the host
(`RemoteWebrtcSourceSink`); the host keeps one picture in flight per source and
drops superseded ones.

### Screen source (contract)

- Channel `screen-input` (phone → desktop): the input envelope with a
  `RemoteScreenInput` control — pointer and wheel in video pixels of the
  locked geometry (pointer/wheel need the acknowledged generation), keys by
  virtual key + scan + extended, Unicode text, `screen-release`. Page input on
  a screen source, or screen input on a browser source, is a contract
  violation (demotion). Acked with `input-ack` like page input.
- Channel `screen-status` (desktop → phone): `RemoteScreenStatus`
  (`readRemoteWebrtcScreenStatus`).
- `media-ready` carries `documentId: null` for a screen source (matched as
  null); a page source must name its document.
- `browserRemoteScreenDisplays()` lists `RemoteScreenDisplaySummary[]`.
- Authorization: pairing is the approval. The service admits screen signals
  and the display list for any paired client whose E2EE channel is
  established and still connected, read live; the window binds each screen
  session to that relay connection (docs/remote-screen.md). Browser sources
  need the client's stream subscription instead.

## Measurement

Logged as `remote-webrtc-*` diagnostics:

- `promoted` and `stats`: sender stats (`RemoteWebrtcSenderStats`): codec and
  `encoderImplementation` as reported at runtime (never assumed hardware),
  encode time, frames captured / superseded / encoded / sent, quality
  limitation, the selected candidate pair (always `relay` locally under this
  policy), with the phone's receiver stats when it sent them.
- `state`: every transition with generation and epoch.
- Input → visible latency on a real phone: input `sentAt` → `input-ack`
  (round trip, desktop queue and dispatch time) → first presented frame whose
  `requestVideoFrameCallback` `captureTime` follows the dispatch.

## JPEG fallback

- A frame hand-off from the window to the service that is never answered no
  longer holds every later frame back: past the relay frame ack window (1.5 s)
  the window sends the newest frame instead.
- Pacing: the service keeps one unacknowledged frame per client per relay round
  trip (≈3 fps at the measured 300–410 ms). A bounded in-flight window of a
  few frames is safe for ordering — frames are latest-only and acks name their
  `seq` — but each extra frame adds a whole JPEG to the relay's per-client
  queue, so it should be sized from the relay's published per-client capacity,
  not fixed. WebRTC replaces this path for the steady state; it stays at one.
