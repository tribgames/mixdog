use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_remote::clients::Revocation;
use mixdog_remote::media::ByteSource;
use mixdog_remote::media::LeaseGuard;
use mixdog_remote::media::MediaSources;
use mixdog_remote::media::Permit;
use mixdog_remote::media::SourceFailure;
use mixdog_remote::transport::media::MediaLink;
use mixdog_remote::transport::media::TransportMedia;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio::sync::oneshot;
const KEY: [u8; 32] = [7; 32];
const DEVICE: &str = "dev-1";

fn pattern(offset: u64, length: usize) -> Vec<u8> {
    (0..length).map(|i| ((offset + i as u64) % 251) as u8).collect()
}

/// The leases the recorder served, by asset id: (size, mime, version, failure, fails after n reads, held).
fn asset(id: &str) -> Option<(u64, &'static str, Option<&'static str>, Option<&'static str>, Option<u32>, bool)> {
    Some(match id {
        "aaaaaaaa-0001" => (200_000, "video/mp4", Some("v1"), None, None, false),
        "aaaaaaaa-0002" => (70_000, "image/png", None, None, None, false),
        "aaaaaaaa-0003" => (0, "text/plain", None, None, None, false),
        "bbbbbbbb-0001" => (1000, "x/y", None, Some("file-download:changed"), None, false),
        "bbbbbbbb-0002" => (1000, "x/y", None, Some("file-download:expired"), None, false),
        "bbbbbbbb-0003" => (1000, "x/y", None, Some("plain"), None, false),
        "bbbbbbbb-0004" => (200_000, "x/y", None, None, Some(1), false),
        "dddddddd-0001" => (200_000, "video/mp4", None, None, None, true),
        _ => return None,
    })
}

/// The reads the leases keep pending, and the notice (shared with the link's held sends) that one more is.
#[derive(Clone, Default)]
struct Gate {
    held: Arc<Mutex<VecDeque<oneshot::Sender<()>>>>,
    changed: Arc<Notify>,
}

struct Leases {
    gate: Gate,
    counts: Arc<Mutex<HashMap<String, u32>>>,
}

struct Lease {
    id: String,
    gate: Gate,
    counts: Arc<Mutex<HashMap<String, u32>>>,
}

#[async_trait]
impl ByteSource for Lease {
    fn size(&self) -> u64 {
        asset(&self.id).map_or(0, |a| a.0)
    }

    fn mime(&self) -> String {
        asset(&self.id).map_or_else(String::new, |a| a.1.to_owned())
    }

    fn version(&self) -> Option<String> {
        asset(&self.id).and_then(|a| a.2.map(str::to_owned))
    }

    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        let count = {
            let mut counts = self.counts.lock().unwrap();
            let count = counts.entry(self.id.clone()).or_insert(0);
            *count += 1;
            *count
        };
        let (_, _, _, failure, after, held) = asset(&self.id).expect("a known asset");
        if held {
            let (tx, rx) = oneshot::channel();
            self.gate.held.lock().unwrap().push_back(tx);
            self.gate.changed.notify_waiters();
            let _ = rx.await;
        }
        match failure {
            // A lease whose file changed answers a short read; one that ended, not found.
            Some("file-download:changed") => return Ok(Vec::new()),
            Some("file-download:expired") => return Err(std::io::Error::from(std::io::ErrorKind::NotFound)),
            Some(_) => return Err(std::io::Error::other("disk gone")),
            None => {}
        }
        if after.is_some_and(|after| count > after) {
            return Ok(Vec::new());
        }
        Ok(pattern(offset, length))
    }
}

#[async_trait]
impl MediaSources for Leases {
    async fn gallery(&self, _asset_id: &str, _variant: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
        Ok(None)
    }

    async fn download(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
        asset(asset_id)?;
        (device == DEVICE).then(|| Box::new(Lease { id: asset_id.to_owned(), gate: self.gate.clone(), counts: self.counts.clone() }) as Box<dyn ByteSource>)
    }
}

enum Send {
    Value(bool),
    Held,
}

struct LinkState {
    room: HashMap<String, bool>,
    default_room: bool,
    held_mode: bool,
    queue: VecDeque<Send>,
    held: VecDeque<oneshot::Sender<Result<bool, ()>>>,
    effects: Vec<Value>,
    /// Notified when a send is kept pending: the gate's, so one wait covers sends and reads.
    changed: Arc<Notify>,
}

struct LinkFake {
    state: Arc<Mutex<LinkState>>,
}

#[async_trait]
impl MediaLink for LinkFake {
    fn can_admit(&self, stream: &str) -> bool {
        let state = self.state.lock().unwrap();
        state.room.get(stream).copied().unwrap_or(state.default_room)
    }

    async fn send(&self, message: Value, stream: Option<&str>, _permit: Option<Permit>, _gated: bool) -> Result<bool, ()> {
        let next = {
            let mut state = self.state.lock().unwrap();
            state.effects.push(json!({ "e": "send", "stream": stream, "message": message }));
            match state.queue.pop_front() {
                Some(next) => next,
                None if state.held_mode => Send::Held,
                None => Send::Value(true),
            }
        };
        match next {
            Send::Value(sent) => Ok(sent),
            Send::Held => {
                let (tx, rx) = oneshot::channel();
                let changed = {
                    let mut state = self.state.lock().unwrap();
                    state.held.push_back(tx);
                    state.changed.clone()
                };
                changed.notify_waiters();
                rx.await.unwrap_or(Err(()))
            }
        }
    }

    fn protocol_error(&self) {
        self.state.lock().unwrap().effects.push(json!({ "e": "protocol-error", "detail": "media streams" }));
    }
}

/// Returns once the adapter says every pump it runs has ended, is parked for room, or waits on a send or read this test keeps
/// pending: the adapter's own resting-point events, not a clock or a count of yields.
async fn settle(adapter: &TransportMedia<LinkFake>, state: &Arc<Mutex<LinkState>>, gate: &Gate) {
    adapter.settled(|| state.lock().unwrap().held.len() + gate.held.lock().unwrap().len(), &gate.changed).await;
}

/// Two requests past the stream limit arrive before the refusal pump has run, and the first error's
/// send is still pending: the queue head is sealed once. (the pump is claimed synchronously, so the
/// second request finds `refusing` set.)
#[tokio::test(flavor = "current_thread")]
async fn two_overflows_before_the_pump_runs_seal_the_head_refusal_once() {
    let gate = Gate::default();
    let state = Arc::new(Mutex::new(LinkState {
        room: HashMap::new(),
        default_room: true,
        held_mode: true,
        queue: VecDeque::new(),
        held: VecDeque::new(),
        effects: Vec::new(),
        changed: gate.changed.clone(),
    }));
    let sources = Arc::new(Leases { gate: gate.clone(), counts: Arc::new(Mutex::new(HashMap::new())) });
    let adapter = TransportMedia::new(Arc::new(LinkFake { state: state.clone() }), sources, Some(KEY), Some(DEVICE.to_owned()));
    let request = |n: u32| json!({ "type": "transport-media", "op": "request", "id": format!("m{n}"), "assetId": "dddddddd-0001", "variant": "download", "range": "", "enc": "e2ee1" });
    // 32 streams fill the limit; m33 and m34 are refused, with no await between them.
    for n in 1..=34 {
        assert!(adapter.receive(&request(n)));
    }
    settle(&adapter, &state, &gate).await;
    let errors: Vec<Value> = state.lock().unwrap().effects.iter().filter(|e| e["message"]["op"] == "error").map(|e| e["message"]["id"].clone()).collect();
    assert_eq!(errors, vec![json!("m33")], "the head refusal is sealed by one pump");
}

// ---- the permission to deliver is asked at the commit, not where the source was obtained ----

/// The id every request of these tests names: the adapter creates a stream only for an id of the shape of an asset id
/// (`^[0-9a-fA-F-]{8,64}$`), so a request for any other id is consumed without a stream and nothing is attempted.
const LEASE_ID: &str = "cccccccc-0001";
/// A second lease of the same source and device, with a lease of its own.
const SECOND_LEASE_ID: &str = "cccccccc-0002";

/// A leased file whose lease is the test's: `valid` is its guarded commit's state (flipped as an expiry, an eviction or an unpair
/// would) and `ended` the terminal event its owner publishes. It counts its own drop.
struct Permitted {
    valid: Arc<std::sync::atomic::AtomicBool>,
    ended: tokio_util::sync::CancellationToken,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
    /// Every read past the first segment fails, so the stream ends with an `error` instead of an `end`.
    fail_later: bool,
}

impl Drop for Permitted {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}

#[async_trait]
impl ByteSource for Permitted {
    fn size(&self) -> u64 {
        300_000
    }

    fn mime(&self) -> String {
        "video/mp4".to_owned()
    }

    async fn read(&mut self, offset: u64, length: usize) -> std::io::Result<Vec<u8>> {
        if self.fail_later && offset > 0 {
            return Err(std::io::Error::other("disk gone"));
        }
        Ok(pattern(offset, length))
    }

    fn lease_guard(&self) -> Option<LeaseGuard> {
        let valid = self.valid.clone();
        Some(LeaseGuard {
            commit: Arc::new(move |write: &mut dyn FnMut()| {
                if valid.load(std::sync::atomic::Ordering::SeqCst) {
                    write();
                    true
                } else {
                    false
                }
            }),
            ended: self.ended.clone(),
        })
    }
}

#[derive(Clone)]
struct PermittedSources {
    valid: Arc<std::sync::atomic::AtomicBool>,
    ended: tokio_util::sync::CancellationToken,
    /// The second lease's own state and event, which ending the first does not touch.
    second: (Arc<std::sync::atomic::AtomicBool>, tokio_util::sync::CancellationToken),
    dropped: Arc<std::sync::atomic::AtomicUsize>,
    fail_later: bool,
}

#[async_trait]
impl MediaSources for PermittedSources {
    async fn gallery(&self, _: &str, _: &str) -> Result<Option<Box<dyn ByteSource>>, SourceFailure> {
        Ok(None)
    }

    async fn download(&self, _: &str, _: &str) -> Option<Box<dyn ByteSource>> {
        None
    }

    async fn project_file(&self, asset_id: &str, device: &str) -> Option<Box<dyn ByteSource>> {
        let (valid, ended) = match asset_id {
            LEASE_ID => (self.valid.clone(), self.ended.clone()),
            SECOND_LEASE_ID => self.second.clone(),
            _ => return None,
        };
        (device == DEVICE).then(|| Box::new(Permitted { valid, ended, dropped: self.dropped.clone(), fail_later: self.fail_later }) as Box<dyn ByteSource>)
    }
}

/// A session link that does what the coordinator does with a permit: a delivery's write (recording the message) runs under its gate,
/// after the wait for capacity, or not at all; the wait for capacity inside the send is left when the permit's end is published,
/// the message withdrawn if not yet sealed. The `stall`th send waits inside the link for `release`, as a send waits for the carrier.
struct GateLink {
    effects: Arc<Mutex<Vec<Value>>>,
    sends: std::sync::atomic::AtomicUsize,
    stall: usize,
    /// Also stalls the first send of a message with this `op` (an `end` or an `error`, which carry no bytes).
    stall_op: Option<&'static str>,
    /// Sends waiting inside the link, which the adapter's `settled` counts as held.
    held: std::sync::atomic::AtomicUsize,
    /// Notified whenever a send is kept pending: the adapter's `settled` takes it as the external activity.
    grew: Arc<Notify>,
    stalled: Arc<Notify>,
    release: Arc<Notify>,
    /// Whether the stream has capacity for a media record.
    room: Arc<std::sync::atomic::AtomicBool>,
}

#[async_trait]
impl MediaLink for GateLink {
    fn can_admit(&self, _: &str) -> bool {
        self.room.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn send(&self, message: Value, _: Option<&str>, permit: Option<Permit>, gated: bool) -> Result<bool, ()> {
        use std::sync::atomic::Ordering::SeqCst;
        let n = self.sends.fetch_add(1, SeqCst) + 1;
        if n == self.stall || self.stall_op.is_some_and(|op| message["op"] == op) {
            self.held.fetch_add(1, SeqCst);
            self.stalled.notify_one();
            self.grew.notify_waiters();
            let withdrawn = match &permit {
                Some(permit) => {
                    tokio::select! {
                        () = self.release.notified() => false,
                        () = permit.ended() => true,
                    }
                }
                None => {
                    self.release.notified().await;
                    false
                }
            };
            self.held.fetch_sub(1, SeqCst);
            // The send is no longer kept pending: the adapter's `settled` counts it, so it is told.
            self.grew.notify_waiters();
            if withdrawn {
                return Ok(false);
            }
        }
        let effects = self.effects.clone();
        let mut record = move || effects.lock().unwrap().push(message.clone());
        match permit {
            // Only a delivery of the file's bytes is committed under the permit.
            Some(permit) if gated => Ok(permit.commit(&mut record)),
            _ => {
                record();
                Ok(true)
            }
        }
    }

    fn protocol_error(&self) {}
}

/// A direct-session adapter over a source with a lease of the test's, and what the tests move and look at.
struct Direct {
    adapter: TransportMedia<GateLink>,
    effects: Arc<Mutex<Vec<Value>>>,
    link: Arc<GateLink>,
    valid: Arc<std::sync::atomic::AtomicBool>,
    ended: tokio_util::sync::CancellationToken,
    dropped: Arc<std::sync::atomic::AtomicUsize>,
}

fn lease_request() -> Value {
    json!({ "type": "transport-media", "op": "request", "id": "m1", "assetId": LEASE_ID, "variant": "original", "range": "", "enc": "e2ee1" })
}

/// With the permission unchanged the same stream runs to its end through the same gate: head, chunks and end are all delivered, so
/// the gate refuses nothing that is allowed.
#[tokio::test(flavor = "multi_thread")]
async fn the_direct_gate_commits_every_delivery_while_it_is_permitted() {
    let direct = Direct::new(usize::MAX, Revocation::default());
    direct.request();
    direct.settled().await;
    assert_eq!(direct.adapter.active(), 0, "the stream ran to its end");
    let ops = direct.ops();
    assert_eq!(ops.first().map(String::as_str), Some("head"), "{ops:?}");
    assert_eq!(ops.last().map(String::as_str), Some("end"), "{ops:?}");
    assert!(ops.iter().filter(|op| *op == "chunk").count() >= 2, "{ops:?}");
}

/// A stream requested under a credential already revoked has no authority: its request is admitted as a stream, then refused before
/// a source is asked, and nothing of the file is sent.
#[tokio::test(flavor = "multi_thread")]
async fn a_stream_under_a_revoked_capability_is_refused_without_a_byte() {
    let revocation = Revocation::default();
    revocation.revoke();
    let direct = Direct::new(usize::MAX, revocation);
    direct.request();
    direct.settled().await;
    assert_eq!(direct.adapter.active(), 0);
    assert_eq!(direct.heads(), [403], "the stream ran, and was refused");
    assert!(direct.ops().iter().all(|op| op != "chunk"), "{:?}", direct.ops());
    assert_eq!(direct.dropped.load(std::sync::atomic::Ordering::SeqCst), 0, "no source was ever obtained");
}

/// A stream parked for room that never returns ends with its authority: the credential's unpair or the lease's end publishes the
/// event, the wait in `changed` is left, the stream is released with its source, and nothing was committed. No writable notification
/// is ever sent. The authority ended before the stream began to wait releases it the same, the event being persistent.
#[tokio::test(flavor = "multi_thread")]
async fn a_direct_stream_parked_for_room_ends_with_its_authority_and_its_source_is_dropped() {
    // (An unpair before the request is refused at its start with a 403, which is the test above's.)
    for (unpair, ended_before) in [(true, false), (false, false), (false, true)] {
        let revocation = Revocation::default();
        let direct = Direct::new(usize::MAX, revocation.clone());
        direct.link.room.store(false, std::sync::atomic::Ordering::SeqCst);
        if ended_before {
            // Before the stream waits at all.
            if unpair {
                revocation.revoke();
            } else {
                direct.end_lease();
            }
        }
        direct.request();
        direct.settled().await;
        if !ended_before {
            assert_eq!(direct.adapter.active(), 1, "unpair={unpair}: parked for room");
            if unpair {
                revocation.revoke();
            } else {
                direct.end_lease();
            }
            direct.settled().await;
        }
        let at = format!("unpair={unpair} ended_before={ended_before}");
        assert_eq!(direct.adapter.active(), 0, "{at}: the stream is gone");
        // Nothing was committed, and the stream did run (it obtained its source, which it released).
        assert!(direct.ops().is_empty(), "{at}: {:?}", direct.ops());
        assert_eq!(direct.dropped.load(std::sync::atomic::Ordering::SeqCst), 1, "{at}: the source was obtained and released");
    }
}

/// Ending one lease releases its stream and leaves the session's other stream parked and then working: when room returns in the
/// ordinary way (the writable notification) the other runs to its end through the same gate.
#[tokio::test(flavor = "multi_thread")]
async fn ending_one_leases_stream_leaves_the_sessions_other_stream_working() {
    let direct = Direct::new(usize::MAX, Revocation::default());
    direct.link.room.store(false, std::sync::atomic::Ordering::SeqCst);
    direct.request();
    let other =
        json!({ "type": "transport-media", "op": "request", "id": "m2", "assetId": SECOND_LEASE_ID, "variant": "original", "range": "", "enc": "e2ee1" });
    assert!(direct.adapter.receive(&other));
    direct.settled().await;
    assert_eq!(direct.adapter.active(), 2, "both parked for room");
    direct.end_lease();
    direct.settled().await;
    assert_eq!(direct.adapter.active(), 1, "the ended lease's stream is gone, the other still parked");
    assert!(direct.ops().is_empty(), "nothing committed while parked");
    direct.link.room.store(true, std::sync::atomic::Ordering::SeqCst);
    direct.adapter.writable();
    direct.settled().await;
    assert_eq!(direct.adapter.active(), 0, "the other stream ran to its end");
    let ops = direct.ops();
    assert_eq!((ops.first().map(String::as_str), ops.last().map(String::as_str)), (Some("head"), Some("end")), "{ops:?}");
    assert!(ops.iter().filter(|op| *op == "chunk").count() >= 2, "{ops:?}");
}

impl Direct {
    fn new(stall: usize, revocation: Revocation) -> Self {
        Self::with(stall, None, false, revocation)
    }

    /// A source whose stream stalls inside the link at the first message with `op`; with `fail_later`, one whose read fails after
    /// the first segment, so that message can be an `error`.
    fn stalling_on(op: &'static str, fail_later: bool) -> Self {
        Self::with(usize::MAX, Some(op), fail_later, Revocation::default())
    }

    fn with(stall: usize, stall_op: Option<&'static str>, fail_later: bool, revocation: Revocation) -> Self {
        let (effects, valid, dropped) =
            (Arc::new(Mutex::new(Vec::new())), Arc::new(std::sync::atomic::AtomicBool::new(true)), Arc::new(std::sync::atomic::AtomicUsize::new(0)));
        let ended = tokio_util::sync::CancellationToken::new();
        let link = Arc::new(GateLink {
            effects: effects.clone(),
            sends: std::sync::atomic::AtomicUsize::new(0),
            stall,
            stall_op,
            held: std::sync::atomic::AtomicUsize::new(0),
            grew: Arc::new(Notify::new()),
            stalled: Arc::new(Notify::new()),
            release: Arc::new(Notify::new()),
            room: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        });
        let second = (Arc::new(std::sync::atomic::AtomicBool::new(true)), tokio_util::sync::CancellationToken::new());
        let sources = PermittedSources { valid: valid.clone(), ended: ended.clone(), second, dropped: dropped.clone(), fail_later };
        let adapter = TransportMedia::under(link.clone(), Arc::new(sources), Some(KEY), Some(DEVICE.to_owned()), revocation);
        Self { adapter, effects, link, valid, ended, dropped }
    }

    /// Asks for the file. Each test shows the stream was admitted by something the stream itself did (a send that stalled, a head it
    /// delivered, its source obtained and dropped): a request the adapter consumes without creating a stream attempts nothing.
    fn request(&self) {
        assert!(self.adapter.receive(&lease_request()));
    }

    /// The statuses of the heads delivered.
    fn heads(&self) -> Vec<u64> {
        self.effects.lock().unwrap().iter().filter(|message| message["op"] == "head").map(|message| message["status"].as_u64().unwrap()).collect()
    }

    /// Returns once the stream has ended, or is parked for room with no send of its own pending: the adapter's own resting-point
    /// events, with no clock and no poll. Whether it is over is the caller's to assert.
    async fn settled(&self) {
        let held = || self.link.held.load(std::sync::atomic::Ordering::SeqCst);
        tokio::time::timeout(std::time::Duration::from_secs(10), self.adapter.settled(held, &self.link.grew)).await.expect("the adapter settled");
    }

    /// Returns once no send is kept pending inside the link (the one the test stalled has left it, released or withdrawn): until then
    /// `settled` would count that send as the caller's own hold and report a rest the pump is about to leave. Event-driven: the link
    /// notifies when a held send leaves, and the subscription is armed before the count is read.
    async fn left_the_link(&self) {
        let wait = async {
            loop {
                let left = self.link.grew.notified();
                tokio::pin!(left);
                left.as_mut().enable();
                if self.link.held.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                    return;
                }
                left.await;
            }
        };
        tokio::time::timeout(std::time::Duration::from_secs(10), wait).await.expect("the stalled send left the link");
    }

    fn ops(&self) -> Vec<String> {
        self.effects.lock().unwrap().iter().map(|message| message["op"].as_str().unwrap().to_owned()).collect()
    }

    /// The lease's owner ends it: the guarded commit's state is cleared and the terminal event published.
    fn end_lease(&self) {
        self.valid.store(false, std::sync::atomic::Ordering::SeqCst);
        self.ended.cancel();
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn a_stall_inside_the_direct_send_commits_nothing_after_the_unpair_or_the_end_of_the_lease() {
    for (unpair, capacity_returns) in [(true, true), (false, true), (true, false), (false, false)] {
        let revocation = Revocation::default();
        // The second send is the meta frame, the first delivery after the head.
        let direct = Direct::new(2, revocation.clone());
        direct.request();
        tokio::time::timeout(std::time::Duration::from_secs(10), direct.link.stalled.notified()).await.expect("the second send stalled inside the link");
        if unpair {
            revocation.revoke();
        } else {
            direct.end_lease();
        }
        if capacity_returns {
            direct.link.release.notify_one();
        }
        direct.left_the_link().await;
        direct.settled().await;
        let at = format!("unpair={unpair} capacity_returns={capacity_returns}");
        assert_eq!(direct.ops(), ["head"], "{at}: only what was committed while permitted");
        assert_eq!((direct.adapter.active(), direct.dropped.load(std::sync::atomic::Ordering::SeqCst)), (0, 1), "{at}: the stream and its source are released");
    }
}
#[tokio::test(flavor = "multi_thread")]
async fn a_queued_end_or_error_send_is_released_by_the_end_of_the_lease_with_no_capacity_returned() {
    for op in ["end", "error"] {
        let direct = Direct::stalling_on(op, op == "error");
        direct.request();
        tokio::time::timeout(std::time::Duration::from_secs(10), direct.link.stalled.notified()).await.expect("the message was queued inside the link");
        let before = direct.ops();
        assert!(before.iter().filter(|sent| *sent == "chunk").count() >= 2 && !before.iter().any(|sent| sent == op), "{op}: the stream ran to it: {before:?}");
        direct.end_lease();
        direct.left_the_link().await;
        direct.settled().await;
        assert_eq!(direct.adapter.active(), 0, "{op}: the stream is gone");
        assert_eq!(direct.dropped.load(std::sync::atomic::Ordering::SeqCst), 1, "{op}: its source is released");
        assert_eq!(direct.ops(), before, "{op}: nothing more was sent");
    }
}
