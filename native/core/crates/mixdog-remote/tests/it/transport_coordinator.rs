//! The E2EE channel is a stand-in (see the fixture's `convention`): the boxes are `magic | u64 sequence | 12 zero bytes | JSON |
//! 16 zero bytes`, control messages boxed as canonical JSON. The phone's inputs are the recorded bytes.

use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use mixdog_remote::e2ee::ControlLane;
use mixdog_remote::e2ee::ControlOpen;
use mixdog_remote::transport::coordinator::Coordinator;
use mixdog_remote::transport::coordinator::Ended;
use mixdog_remote::transport::coordinator::Host;
use mixdog_remote::transport::coordinator::LocalOffer;
use mixdog_remote::transport::coordinator::PeerChannel;
use mixdog_remote::transport::coordinator::PeerInit;
use mixdog_remote::transport::coordinator::SealFault;
use mixdog_remote::transport::coordinator::SendError;
use mixdog_remote::transport::coordinator::SendOptions;
use mixdog_remote::transport::coordinator::SendResult;
use mixdog_remote::transport::coordinator::Sent;
use mixdog_remote::transport::coordinator::Settle;
use mixdog_remote::transport::coordinator::StreamChannel;
use mixdog_remote::transport::signal::CloseReason;
use mixdog_remote::transport::split::AssemblyPool;
use mixdog_remote::webrtc::config::Candidate;
use mixdog_remote::webrtc::signal::Fingerprint;
use mixdog_remote::webrtc::signal::candidate_json;
use mixdog_remote::webrtc::signal::ice_servers_json;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const APP_MAGIC: [u8; 4] = [0x4d, 0x58, 0x45, 0x01];
const CONTROL_MAGIC: [u8; 4] = [0x4d, 0x58, 0x43, 0x01];

fn fingerprint_text() -> String {
    (0..32).map(|i| format!("{:02X}", i + 16)).collect::<Vec<_>>().join(":")
}

fn sdp() -> String {
    format!("v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\na=fingerprint:sha-256 {}\r\n", fingerprint_text())
}

fn fingerprints() -> Vec<Fingerprint> {
    vec![Fingerprint { algorithm: "sha-256".into(), value: fingerprint_text() }]
}

fn make_box(magic: [u8; 4], sequence: u64, text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(40 + text.len());
    out.extend_from_slice(&magic);
    out.extend_from_slice(&sequence.to_be_bytes());
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(text.as_bytes());
    out.extend_from_slice(&[0; 16]);
    out
}

fn open_box(bytes: &[u8], magic: [u8; 4]) -> Result<(u64, Vec<u8>), ()> {
    if bytes.len() < 40 || bytes[..4] != magic || bytes[bytes.len() - 16..].iter().any(|b| *b != 0) {
        return Err(());
    }
    let sequence = u64::from_be_bytes(bytes[4..12].try_into().expect("8 bytes"));
    Ok((sequence, bytes[24..bytes.len() - 16].to_vec()))
}

/// JSON with every object's keys sorted: the recorder's `canon`.
fn canon(value: &Value) -> String {
    match value {
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            let body: Vec<String> = keys.into_iter().map(|key| format!("{}:{}", Value::String(key.clone()), canon(&fields[key]))).collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => format!("[{}]", items.iter().map(canon).collect::<Vec<_>>().join(",")),
        other => other.to_string(),
    }
}

fn lane_key(lane: &ControlLane) -> String {
    match lane {
        ControlLane::Relay => "relay".to_owned(),
        ControlLane::Direct { epoch, connection_id } => format!("direct:{epoch}:{connection_id}"),
    }
}

fn bytes_record(bytes: &[u8]) -> Value {
    if bytes.len() > 256 { json!({ "len": bytes.len(), "sha256": hex(&Sha256::digest(bytes)) }) } else { json!({ "hex": hex(bytes) }) }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn with(mut entry: Value, extra: Value) -> Value {
    if let (Some(entry), Value::Object(extra)) = (entry.as_object_mut(), extra) {
        entry.extend(extra);
    }
    entry
}

/// What the fakes share: the effect log, the settled results and the options of the scenario.
struct Shared {
    effects: Vec<Value>,
    results: Vec<Value>,
    options: Value,
    refuse: bool,
    buffered: usize,
    encrypt: Option<String>,
    seal_control: Option<String>,
    pending_deliver: usize,
    meters: Vec<String>,
    tickets: HashMap<u64, Value>,
    peers: Vec<String>,
    creates: u64,
    minted: u8,
    /// Every relay message, as written.
    relay_raw: Vec<Vec<u8>>,
    /// Every message written to a direct app channel.
    direct_raw: Vec<Vec<u8>>,
}

/// The shared state behind a lock, so the stand-ins can ride in a Send coordinator.
struct Guarded(std::sync::Mutex<Shared>);

impl Guarded {
    fn borrow(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn borrow_mut(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.borrow()
    }
}

type Log = std::sync::Arc<Guarded>;

struct ChannelFake {
    log: Log,
    encrypt_sequence: u64,
    control_sequence: u64,
    lanes: HashMap<String, (&'static str, u64)>,
    /// Runs as each application record is sealed, with its sequence.
    on_seal: Option<Box<dyn FnMut(u64) + Send>>,
}

impl StreamChannel for ChannelFake {
    fn encrypt_binary(&mut self, plaintext: &str) -> Result<Vec<u8>, SealFault> {
        match self.log.borrow().encrypt.as_deref() {
            Some("range") => return Err(SealFault::Oversize),
            Some("broken") => return Err(SealFault::Broken),
            _ => {}
        }
        if plaintext.len() > 1024 * 1024 {
            return Err(SealFault::Oversize);
        }
        self.encrypt_sequence += 1;
        if let Some(on_seal) = self.on_seal.as_mut() {
            on_seal(self.encrypt_sequence);
        }
        Ok(make_box(APP_MAGIC, self.encrypt_sequence, plaintext))
    }

    fn decrypt_json(&mut self, box_bytes: &[u8]) -> Result<Vec<u8>, ()> {
        open_box(box_bytes, APP_MAGIC).map(|(_, text)| text)
    }

    fn seal_control(&mut self, message: &Value, lane: &ControlLane) -> Result<Vec<u8>, ()> {
        if self.log.borrow().seal_control.as_deref() == Some("fail") {
            return Err(());
        }
        let known = matches!(lane, ControlLane::Relay) || self.lanes.get(&lane_key(lane)).is_some_and(|(state, _)| *state != "retired");
        if !known {
            return Err(());
        }
        self.control_sequence += 1;
        self.log.borrow_mut().effects.push(json!({ "e": "seal-control", "lane": lane_key(lane), "message": message }));
        Ok(make_box(CONTROL_MAGIC, self.control_sequence, &canon(message)))
    }

    fn open_control(&mut self, raw: &[u8], lane: &ControlLane) -> Result<ControlOpen, ()> {
        let key = lane_key(lane);
        let known = match lane {
            ControlLane::Relay => self.lanes.get(&key).copied().unwrap_or(("active", 0)),
            ControlLane::Direct { .. } => *self.lanes.get(&key).ok_or(())?,
        };
        let (sequence, text) = open_box(raw, CONTROL_MAGIC)?;
        if known.0 == "retired" || sequence <= known.1 {
            return Ok(ControlOpen::Stale { sequence });
        }
        self.lanes.insert(key, (known.0, sequence));
        Ok(ControlOpen::Fresh { sequence, value: text })
    }

    fn register_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        if matches!(lane, ControlLane::Relay) {
            return Ok(());
        }
        if self.lanes.contains_key(&lane_key(lane)) {
            return Err(());
        }
        self.lanes.insert(lane_key(lane), ("registered", 0));
        self.log.borrow_mut().effects.push(json!({ "e": "lane", "op": "register", "lane": lane_key(lane) }));
        Ok(())
    }

    fn activate_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        match self.lanes.get_mut(&lane_key(lane)) {
            Some(known) if known.0 != "retired" => known.0 = "active",
            _ => return Err(()),
        }
        self.log.borrow_mut().effects.push(json!({ "e": "lane", "op": "activate", "lane": lane_key(lane) }));
        Ok(())
    }

    fn retire_control_lane(&mut self, lane: &ControlLane) -> Result<(), ()> {
        match self.lanes.get_mut(&lane_key(lane)) {
            Some(known) => known.0 = "retired",
            None => return Err(()),
        }
        self.log.borrow_mut().effects.push(json!({ "e": "lane", "op": "retire", "lane": lane_key(lane) }));
        Ok(())
    }
}

struct HostFake {
    log: Log,
    now: Rc<Cell<u64>>,
}

impl Host for HostFake {
    fn now(&mut self) -> u64 {
        self.now.get()
    }

    fn log(&mut self, line: &str) {
        self.log.borrow_mut().effects.push(json!({ "e": "log", "line": line }));
    }

    fn mint_connection_id(&mut self) -> String {
        let mut shared = self.log.borrow_mut();
        shared.minted += 1;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([shared.minted; 16])
    }

    fn relay_send(&mut self, _channel: PeerChannel, message: &[u8]) -> Settle<bool> {
        let held = self.log.borrow().options["relay"] == "held";
        self.log.borrow_mut().effects.push(with(json!({ "e": "relay" }), bytes_record(message)));
        self.log.borrow_mut().relay_raw.push(message.to_vec());
        if held { Settle::Later } else { Settle::Now(true) }
    }

    fn relay_meter(&mut self, token: u64, bytes: usize) {
        let name = self.log.borrow().meters[token as usize].clone();
        self.log.borrow_mut().effects.push(json!({ "e": "meter", "name": name, "bytes": bytes }));
    }

    fn deliver(&mut self, payload: &[u8], bytes: usize) -> Settle<()> {
        let value: Value = serde_json::from_slice(payload).expect("payload is JSON");
        let held = self.log.borrow().options["deliver"] == "held";
        self.log.borrow_mut().effects.push(json!({ "e": "deliver", "payload": value, "bytes": bytes }));
        if held {
            self.log.borrow_mut().pending_deliver += 1;
            Settle::Later
        } else {
            Settle::Now(())
        }
    }

    fn ended(&mut self, ended: &Ended) {
        self.log.borrow_mut().effects.push(json!({ "e": "ended", "reason": ended.reason.wire_name(), "ambiguousCallIds": ended.ambiguous_call_ids }));
    }

    fn authenticated(&mut self) {
        self.log.borrow_mut().effects.push(json!({ "e": "authenticated" }));
    }

    fn suspended(&mut self) {
        self.log.borrow_mut().effects.push(json!({ "e": "suspended" }));
    }

    fn resolve_ice(&mut self, _connection_id: &str) -> Settle<Result<Value, ()>> {
        self.log.borrow_mut().effects.push(json!({ "e": "ice" }));
        let mode = self.log.borrow().options["ice"].as_str().map(str::to_owned);
        if mode.as_deref() == Some("held") {
            return Settle::Later;
        }
        Settle::Now(match mode.as_deref() {
            Some("reject") => Err(()),
            Some("invalid") => Ok(json!([{ "urls": "http://not-ice" }])),
            _ => Ok(json!([{ "urls": ["turn:turn.example.org:3478"], "username": "user-secret-name", "credential": "credential-secret" }])),
        })
    }

    fn ice_in_hand(&mut self) -> bool {
        self.log.borrow().options["ice"] != "held"
    }

    fn peer_host_attached(&mut self) -> bool {
        self.log.borrow().options["peerHost"] == true
    }

    fn peer_create(&mut self, init: &PeerInit) -> Result<(), ()> {
        let mut shared = self.log.borrow_mut();
        shared.creates += 1;
        let creates = shared.creates;
        if shared.options["createThrows"].as_array().is_some_and(|list| list.iter().any(|n| n.as_u64() == Some(creates))) {
            return Err(());
        }
        shared.effects.push(json!({
            "e": "peer-create",
            "init": { "sessionId": init.session_id, "connectionId": init.connection_id, "iceServers": ice_servers_json(&init.ice_servers) },
        }));
        shared.peers.push(init.connection_id.clone());
        Ok(())
    }

    fn peer_offer(&mut self, _connection_id: &str) -> Settle<Result<LocalOffer, ()>> {
        self.log.borrow_mut().effects.push(json!({ "e": "peer-offer" }));
        if self.log.borrow().options["offer"] == "reject" {
            return Settle::Now(Err(()));
        }
        Settle::Now(Ok(LocalOffer { sdp: sdp(), fingerprints: fingerprints() }))
    }

    fn peer_answer(&mut self, _connection_id: &str, sdp: &str, prints: &[Fingerprint]) -> Settle<Result<(), ()>> {
        let prints: Vec<Value> = prints.iter().map(Fingerprint::to_json).collect();
        self.log.borrow_mut().effects.push(json!({ "e": "peer-answer", "sdp": sdp, "fingerprints": prints }));
        Settle::Now(if self.log.borrow().options["answer"] == "reject" { Err(()) } else { Ok(()) })
    }

    fn peer_candidate(&mut self, _connection_id: &str, candidate: &Option<Candidate>) -> Settle<Result<(), ()>> {
        self.log.borrow_mut().effects.push(json!({ "e": "peer-candidate", "candidate": candidate_json(candidate) }));
        Settle::Now(Ok(()))
    }

    fn peer_send(&mut self, _connection_id: &str, channel: PeerChannel, message: &[u8]) -> bool {
        if self.log.borrow().refuse {
            return false;
        }
        self.log.borrow_mut().effects.push(with(json!({ "e": "peer-send", "channel": channel.name() }), bytes_record(message)));
        if channel == PeerChannel::App {
            self.log.borrow_mut().direct_raw.push(message.to_vec());
        }
        true
    }

    fn peer_buffered(&mut self, _connection_id: &str) -> usize {
        self.log.borrow().buffered
    }

    fn peer_close(&mut self, _connection_id: &str, reason: CloseReason) {
        self.log.borrow_mut().effects.push(json!({ "e": "peer-close", "reason": reason.wire_name() }));
    }

    fn send_settled(&mut self, ticket: u64, result: SendResult) {
        let mut shared = self.log.borrow_mut();
        let tag = shared.tickets.remove(&ticket).unwrap_or(Value::Null);
        let entry = settled_entry(&tag, result);
        shared.results.push(entry);
    }
}

/// How a settled send reads in the recording: an application send by its id, a media send by `media`.
fn settled_entry(tag: &Value, result: SendResult) -> Value {
    if let Some(id) = tag.get("id") {
        return match result {
            Ok(bytes) => json!({ "id": id, "ok": bytes }),
            Err(SendError::Ended(reason)) => json!({ "id": id, "error": "ended", "reason": reason.wire_name() }),
            Err(SendError::Oversize(bytes)) => json!({ "id": id, "error": "oversize", "bytes": bytes }),
            Err(SendError::Range) => json!({ "id": id, "error": "range" }),
            Err(SendError::Other(_)) => json!({ "id": id, "error": "other" }),
        };
    }
    match result {
        Ok(bytes) => json!({ "media": bytes.is_some() }),
        Err(SendError::Ended(reason)) => json!({ "media": "rejected", "reason": reason.wire_name() }),
        Err(_) => json!({ "media": "rejected" }),
    }
}

/// A live-view write is asked about once, at its write, and enters the stream whole in that step: an unpair that lands while a later
/// fragment of a large frame is sealed waits for the write, and the next write after it is refused whole with no hole in the stream
/// (the `mayWrite` question, asked after its last fragment is sealed).
#[test]
fn an_unpair_that_lands_while_a_later_fragment_is_sealed_waits_for_the_whole_write() {
    let log = gated_log();
    let (allowed, writes, gate) = write_gate();
    // The unpair, at the seal of the frame's second record: it revokes at once when no write holds the gate, else after the write.
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let on_seal = {
        let (allowed, writes, events) = (allowed.clone(), writes.clone(), events.clone());
        Box::new(move |sequence: u64| {
            if sequence != 2 {
                return;
            }
            match writes.try_lock() {
                Ok(_) => {
                    allowed.store(false, std::sync::atomic::Ordering::SeqCst);
                    events.lock().unwrap().push("revoked between the frame's records");
                }
                Err(_) => events.lock().unwrap().push("the revocation waits for the write"),
            }
        })
    };
    let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: Some(on_seal) };
    let host = HostFake { log: log.clone(), now: Rc::new(Cell::new(1_000)) };
    let mut coordinator = Coordinator::new("session-1", channel, host, AssemblyPool::default());
    // How each send settled: `{"media": true}` in the stream, `{"media": false}` sent nothing (no ticket is tagged here).
    let send = |coordinator: &mut Coordinator<ChannelFake, HostFake>, text: &str, gate: Option<mixdog_remote::transport::coordinator::WriteGate>| {
        let sent = coordinator.send(text, SendOptions { droppable: false, stream: None, meter: None, gate });
        coordinator.settle();
        match sent {
            Sent::Settled(result) => panic!("settled at once: {result:?}"),
            Sent::Queued(_) => log.borrow_mut().results.pop().expect("the send settled"),
        }
    };
    let frame = format!("{{\"method\":\"browser/frame\",\"params\":{{\"data\":\"{}\"}}}}", "a".repeat(1_200_000));

    let entered = send(&mut coordinator, &frame, Some(gate.clone()));
    assert_eq!(*events.lock().unwrap(), ["the revocation waits for the write"], "the unpair landed between the frame's records");
    assert_eq!(entered, json!({ "media": true }), "the frame, allowed at its write, entered whole");
    assert_eq!(coordinator.next_sequence(), 3, "its two records are in the stream");
    // The revocation, once the write let it.
    {
        let _writes = writes.lock().unwrap();
        allowed.store(false, std::sync::atomic::Ordering::SeqCst);
    }
    assert_eq!(send(&mut coordinator, &frame, Some(gate)), json!({ "media": false }), "the next frame is refused whole");
    assert_eq!(coordinator.next_sequence(), 3, "no record of it is in the stream");
    assert_eq!(send(&mut coordinator, r#"{"method":"event","params":{}}"#, None), json!({ "media": true }));
    assert_eq!(coordinator.next_sequence(), 4, "the next message takes the next sequence: the stream has no hole");
}

/// A direct path that never opens (the phone answers nothing) is tried again one negotiation window after its start, then at doubling
/// waits up to sixteen windows, not every window for the life of the link; each failed attempt is one log line with its reason.
#[test]
fn a_direct_path_that_keeps_failing_is_tried_less_and_less_often_and_each_failure_is_one_line() {
    let log = gated_log();
    log.borrow_mut().options = json!({ "peerHost": true });
    let now = Rc::new(Cell::new(1_000));
    let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: None };
    // A signal names its session by the E2EE challenge (32 bytes, base64url): any other id refuses the offer.
    let session_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    let mut coordinator = Coordinator::new(&session_id, channel, HostFake { log: log.clone(), now: now.clone() }, AssemblyPool::default());
    let mut starts = Vec::new();
    for at in (1_000..=40 * 60_000).step_by(500) {
        now.set(at);
        coordinator.tick();
        coordinator.settle();
        if log.borrow().creates as usize > starts.len() {
            starts.push(at);
        }
    }
    let gaps: Vec<u64> = starts.windows(2).map(|pair| pair[1] - pair[0]).collect();
    assert_eq!(gaps, [39_500, 79_000, 158_000, 316_000, 632_000, 632_000]);
    let closes: Vec<String> =
        log.borrow().effects.iter().filter_map(|effect| effect["line"].as_str().filter(|line| line.contains("direct-closed")).map(str::to_owned)).collect();
    assert_eq!(closes.len(), starts.len(), "one line per attempt: {closes:#?}");
    for (index, line) in closes.iter().enumerate() {
        assert!(line.contains("reason=negotiation-timeout") && line.contains("opened=false"), "{line}");
        assert!(line.contains(&format!("failures={}", index + 1)), "{line}");
    }
}

/// A restart the client asks for during an attempt ends it with one line that names the retry the restart left: no failures, the next
/// attempt one window after the ended one's start, not the backoff the failures before it had earned.
#[test]
fn an_attempt_ended_by_a_client_restart_logs_the_retry_the_restart_left() {
    let log = gated_log();
    log.borrow_mut().options = json!({ "peerHost": true });
    let now = Rc::new(Cell::new(1_000));
    let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: None };
    let session_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    let mut coordinator = Coordinator::new(&session_id, channel, HostFake { log: log.clone(), now: now.clone() }, AssemblyPool::default());
    // Attempts start at 1 000, 40 500 and 119 500 (two failures before the third).
    for at in (1_000..=130_000).step_by(500) {
        now.set(at);
        coordinator.tick();
        coordinator.settle();
    }
    assert_eq!(log.borrow().creates, 3);
    let restart = json!({
        "v": 1,
        "sessionId": session_id,
        "connectionId": base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([3u8; 16]),
        "generation": 3,
        "t": "close",
        "reason": "restart",
    });
    let boxed = make_box(CONTROL_MAGIC, 1, &canon(&restart));
    coordinator.receive("relay", &mixdog_remote::transport::frame::encode_control(&boxed).expect("a control message"));
    coordinator.settle();
    let lines: Vec<String> = log.borrow().effects.iter().filter_map(|effect| effect["line"].as_str().map(str::to_owned)).collect();
    let last = lines.iter().rev().find(|line| line.contains("direct-closed")).expect("the restarted attempt's line");
    assert!(last.contains("reason=superseded detail=restart generation=3 opened=false"), "{last}");
    assert!(last.ends_with("failures=0 next-attempt-ms=29000"), "{last}");
}

/// The relay as one first-in first-out pipe under the test's clock: whatever the desktop hands it (the leg takes every write at once)
/// leaves in that order at `RELAY_BYTES_PER_MS` and reaches the phone `ONE_WAY_MS` later, as the leg queue, the sockets and the
/// relay's per-phone queue keep order.
#[derive(Default)]
struct SlowRelay {
    /// Per message handed so far: when it reaches the phone, and what it is.
    queue: Vec<(f64, String)>,
    /// When the pipe has sent everything handed so far.
    free_at: f64,
    taken: usize,
}

const RELAY_BYTES_PER_MS: f64 = 75.0;
const ONE_WAY_MS: u64 = 150;

impl SlowRelay {
    /// Takes the writes made since the last call, at `at`; returns what they are.
    fn hand(&mut self, log: &Log, at: u64) -> Vec<String> {
        let written: Vec<Vec<u8>> = log.borrow().relay_raw[self.queue.len()..].to_vec();
        let mut kinds = Vec::new();
        for raw in &written {
            self.free_at = self.free_at.max(at as f64) + raw.len() as f64 / RELAY_BYTES_PER_MS;
            let kind = relay_message_kind(raw);
            self.queue.push((self.free_at + ONE_WAY_MS as f64, kind.clone()));
            kinds.push(kind);
        }
        kinds
    }

    /// What reached the phone by `at`, in order: each message's index among the relay writes, and what it is.
    fn arrived(&mut self, at: u64) -> Vec<(usize, String)> {
        let mut out = Vec::new();
        while let Some((when, kind)) = self.queue.get(self.taken) {
            if *when > at as f64 {
                break;
            }
            out.push((self.taken, kind.clone()));
            self.taken += 1;
        }
        out
    }
}

/// The phone's receiving half: one receiver for both carriers, so a record's second copy, on either, is a duplicate it drops.
struct PhoneStream {
    receiver: mixdog_remote::transport::receiver::Receiver,
    assembler: mixdog_remote::transport::split::MessageAssembler,
    /// Each message the phone delivered: when, the carrier of the record that completed it, and the message.
    delivered: Vec<(u64, &'static str, String)>,
    /// Each record copy the phone dropped as a duplicate: its carrier and sequence.
    dropped: Vec<(&'static str, u64)>,
}

impl PhoneStream {
    fn new() -> Self {
        Self {
            receiver: mixdog_remote::transport::receiver::Receiver::new(),
            assembler: mixdog_remote::transport::split::MessageAssembler::new(AssemblyPool::default()),
            delivered: Vec::new(),
            dropped: Vec::new(),
        }
    }

    fn take(&mut self, raw: &[u8], carrier: &'static str, at: u64) {
        let mixdog_remote::transport::frame::Message::Record(record) = mixdog_remote::transport::frame::decode_message(raw).expect("a conforming message")
        else {
            panic!("an application record")
        };
        if self.receiver.accept(&record, at) == mixdog_remote::transport::receiver::AcceptResult::Duplicate {
            self.dropped.push((carrier, record.sequence()));
        }
        while let Some((sequence, box_bytes)) = self.receiver.next().map(|(sequence, bytes)| (sequence, bytes.to_vec())) {
            let (_, plaintext) = open_box(&box_bytes, APP_MAGIC).expect("an application box");
            self.receiver.commit(sequence, at).expect("in order");
            if let mixdog_remote::transport::split::Assembly::Complete(bytes) = self.assembler.accept(&plaintext, at).expect("the phone's reassembly takes it")
            {
                self.delivered.push((at, carrier, String::from_utf8(bytes).expect("text")));
            }
        }
    }
}

/// `record <sequence>` for an application record, the `t` of a control message.
fn relay_message_kind(raw: &[u8]) -> String {
    match mixdog_remote::transport::frame::decode_message(raw).expect("a conforming message") {
        mixdog_remote::transport::frame::Message::Record(record) => format!("record {}", record.sequence()),
        mixdog_remote::transport::frame::Message::Control { box_bytes } => {
            let (_, text) = open_box(&box_bytes, CONTROL_MAGIC).expect("a control box");
            let value: Value = serde_json::from_slice(&text).expect("JSON");
            value["t"].as_str().unwrap_or_default().to_owned()
        }
    }
}

/// What the phone, the LAN and the desktop's gatherer do, each when its time comes.
enum Step {
    HostCandidate,
    Replies,
    Answer,
    Open,
    Pong(u64),
}

/// The direct path opens while a slow relay (75 KB/s, 150 ms each way) still holds the session's first replies: with the ICE set
/// in hand when the session opens, the phone has the offer and the desktop's host candidate ahead of every reply. The phone answers
/// the offer and asks for its first screen once it reads them; the LAN connects at once and carries the phone's acks. The replies
/// the relay still holds go again on the direct path, so the first screen is complete before the relay delivers its first reply;
/// the relay's copies, arriving later, are dropped, and each message is delivered once, in order.
#[test]
fn the_direct_path_opens_without_waiting_for_the_backlog_a_slow_relay_drains() {
    const LAN_MS: u64 = 10;
    let log = gated_log();
    log.borrow_mut().options = json!({ "peerHost": true });
    let now = Rc::new(Cell::new(0));
    let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: None };
    let session_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    let mut pc = Coordinator::new(&session_id, channel, HostFake { log: log.clone(), now: now.clone() }, AssemblyPool::default());
    let connection = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([1u8; 16]);
    let send = |pc: &mut Coordinator<ChannelFake, HostFake>, text: &str| {
        let _ = pc.send(text, SendOptions { droppable: false, stream: None, meter: None, gate: None });
        pc.settle();
    };
    let control =
        |sequence: u64, text: &str| mixdog_remote::transport::frame::encode_control(&make_box(CONTROL_MAGIC, sequence, text)).expect("a control message");
    send(&mut pc, r#"{"type":"e2ee-ready","version":1}"#);

    let direct = format!("direct:{connection}");
    let mut phone = PhoneStream::new();
    let (mut relay, mut read, mut steps, mut scanned, mut promoted_at) = (SlowRelay::default(), Vec::new(), Vec::new(), 0, None);
    let (mut direct_sequence, mut direct_taken) = (0, 0);
    for at in 0..=12_000 {
        now.set(at);
        if at % 25 == 0 {
            pc.tick();
            pc.settle();
        }
        let due: Vec<(u64, Step)>;
        (due, steps) = steps.into_iter().partition(|(when, _)| *when <= at);
        for (_, step) in due {
            match step {
                Step::HostCandidate => {
                    let host = Candidate {
                        candidate: "candidate:1 1 udp 2122260223 192.168.1.10 50000 typ host".to_owned(),
                        sdp_mid: Some("0".to_owned()),
                        sdp_mline_index: Some(0),
                        username_fragment: None,
                    };
                    pc.peer_candidate_event(&connection, Some(host), None);
                }
                Step::Replies => {
                    for id in 0..12 {
                        send(&mut pc, &format!(r#"{{"id":{id},"result":"{}"}}"#, "r".repeat(50_000)));
                    }
                }
                Step::Answer => {
                    let prints: Vec<Value> = fingerprints().iter().map(Fingerprint::to_json).collect();
                    let answer = json!({ "v": 1, "sessionId": session_id, "connectionId": connection, "generation": 1, "t": "answer", "sdp": sdp(), "fingerprints": prints });
                    pc.receive("relay", &control(1, &canon(&answer)));
                    steps.push((at + LAN_MS, Step::Open));
                }
                Step::Open => pc.peer_open(&connection, Some(262_144.0), None),
                Step::Pong(id) => {
                    direct_sequence += 1;
                    pc.receive(&direct, &control(direct_sequence, &mixdog_remote::transport::control::pong_json(id)));
                }
            }
            pc.settle();
        }
        for kind in relay.hand(&log, at) {
            // The gatherer's host candidates follow the offer at once.
            if kind == "offer" {
                steps.push((at + 1, Step::HostCandidate));
            }
        }
        for (index, kind) in relay.arrived(at) {
            match kind.as_str() {
                // Record 1 confirms the session: the phone asks for its first screen.
                "record 1" => steps.push((at + ONE_WAY_MS, Step::Replies)),
                "offer" => steps.push((at + ONE_WAY_MS, Step::Answer)),
                _ => {}
            }
            if kind.starts_with("record ") {
                let raw = log.borrow().relay_raw[index].clone();
                phone.take(&raw, "relay", at);
            }
            read.push((at, kind));
        }
        let effects: Vec<Value> = log.borrow().effects[scanned..].to_vec();
        scanned += effects.len();
        for effect in effects {
            if effect["e"] == "seal-control" && effect["lane"].as_str().is_some_and(|lane| lane.starts_with("direct:")) && effect["message"]["t"] == "ping" {
                steps.push((at + 1, Step::Pong(effect["message"]["id"].as_u64().expect("a ping id"))));
            }
            if effect["line"].as_str().is_some_and(|line| line.contains("path=direct reason=channel-open")) {
                promoted_at.get_or_insert(at);
            }
        }
        // The LAN delivers at once.
        let written: Vec<Vec<u8>> = log.borrow().direct_raw[direct_taken..].to_vec();
        direct_taken += written.len();
        for raw in &written {
            phone.take(raw, "direct", at);
        }
        if promoted_at.is_some()
            && let Some(due) = phone.receiver.ack_due(at)
        {
            phone.receiver.ack_sent(due.through);
            direct_sequence += 1;
            pc.receive(&direct, &control(direct_sequence, &mixdog_remote::transport::control::ack_json(due.through, &due.ranges)));
            pc.settle();
        }
    }

    let first = |kind: &str| read.iter().position(|(_, read)| read == kind).unwrap_or_else(|| panic!("no {kind} reached the phone: {read:?}"));
    let first_reply = first("record 2");
    assert!(first("offer") < first_reply, "the offer reached the phone behind a reply: {read:?}");
    assert!(first("candidate") < first_reply, "the host candidate reached the phone behind a reply: {read:?}");
    let promoted_at = promoted_at.expect("the direct path opened");
    let reply_at = read[first_reply].0;
    assert!(promoted_at < reply_at, "the direct path opened at {promoted_at} ms, after the first reply reached the phone at {reply_at} ms");

    let delivered: Vec<(u64, &str, String)> = phone.delivered.iter().map(|(at, carrier, text)| (*at, *carrier, text.chars().take(16).collect())).collect();
    let mut expected = vec![r#"{"type":"e2ee-ready","version":1}"#.to_owned()];
    expected.extend((0..12).map(|id| format!(r#"{{"id":{id},"result":"{}"}}"#, "r".repeat(50_000))));
    assert!(phone.delivered.iter().map(|(_, _, text)| text).eq(expected.iter()), "each message once, in order: {delivered:?}");
    assert!(phone.delivered[1..].iter().all(|(_, carrier, _)| *carrier == "direct"), "a reply came over the relay: {delivered:?}");
    let complete_at = phone.delivered.last().expect("the first screen").0;
    let drained_at = read.iter().rev().find(|(_, kind)| kind == "record 13").expect("the relay's last reply").0;
    assert!(
        complete_at < reply_at,
        "the first screen was complete at {complete_at} ms; the relay delivered its first reply at {reply_at} ms and its last at {drained_at} ms"
    );
    // Record 1 reached the phone on the relay before the direct path opened; every reply came direct first.
    let mut dropped = vec![("direct", 1)];
    dropped.extend((2..=13).map(|sequence| ("relay", sequence)));
    assert_eq!(phone.dropped, dropped, "the second copy of each record is dropped");
}

/// A relay that never answers the ICE request holds back no record: the set is not in hand when the session opens, so `e2ee-ready`
/// and the first replies go on the relay the moment each is sent, and only the offer waits for the set.
#[test]
fn records_go_out_at_once_when_the_relay_never_answers_the_ice_request() {
    let log = gated_log();
    log.borrow_mut().options = json!({ "peerHost": true, "ice": "held" });
    let now = Rc::new(Cell::new(1_000));
    let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: None };
    let session_id = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([7u8; 32]);
    let mut pc = Coordinator::new(&session_id, channel, HostFake { log: log.clone(), now: now.clone() }, AssemblyPool::default());
    let send = |pc: &mut Coordinator<ChannelFake, HostFake>, text: &str| {
        let _ = pc.send(text, SendOptions { droppable: false, stream: None, meter: None, gate: None });
        pc.settle();
    };
    let written = |log: &Log| log.borrow().relay_raw.iter().map(|raw| relay_message_kind(raw)).collect::<Vec<String>>();
    let records = |log: &Log| written(log).into_iter().filter(|kind| kind.starts_with("record ")).collect::<Vec<String>>();

    send(&mut pc, r#"{"type":"e2ee-ready","version":1}"#);
    assert_eq!(records(&log), ["record 1"], "e2ee-ready waited");
    // The attempt asks for the set, which never comes.
    for at in (1_000..=1_300).step_by(25) {
        now.set(at);
        pc.tick();
        pc.settle();
    }
    assert!(log.borrow().effects.iter().any(|effect| effect["e"] == "ice"), "the attempt asked for the ICE set");
    for id in 0..3 {
        send(&mut pc, &format!(r#"{{"id":{id},"result":[]}}"#));
        assert_eq!(records(&log).len(), id + 2, "reply {id} waited");
    }
    assert!(!written(&log).iter().any(|kind| kind == "offer"), "an offer without the ICE set: {:?}", written(&log));
}

fn gated_log() -> Log {
    std::sync::Arc::new(Guarded(std::sync::Mutex::new(Shared {
        effects: Vec::new(),
        results: Vec::new(),
        options: json!({}),
        refuse: false,
        buffered: 0,
        encrypt: None,
        seal_control: None,
        pending_deliver: 0,
        meters: Vec::new(),
        tickets: HashMap::new(),
        peers: Vec::new(),
        creates: 0,
        minted: 0,
        relay_raw: Vec::new(),
        direct_raw: Vec::new(),
    })))
}

type Allowed = std::sync::Arc<std::sync::atomic::AtomicBool>;

/// The registry's write gate: the permission, and the lock a write and a revocation each take.
fn write_gate() -> (Allowed, std::sync::Arc<std::sync::Mutex<()>>, mixdog_remote::transport::coordinator::WriteGate) {
    let allowed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let writes = std::sync::Arc::new(std::sync::Mutex::new(()));
    let gate = {
        let (allowed, writes) = (allowed.clone(), writes.clone());
        mixdog_remote::transport::coordinator::WriteGate(std::sync::Arc::new(move |write: &mut dyn FnMut()| {
            let _writes = writes.lock().unwrap();
            let open = allowed.load(std::sync::atomic::Ordering::SeqCst);
            if open {
                write();
            }
            open
        }))
    };
    (allowed, writes, gate)
}

/// The phone on the relay: the stream's receiver and the message assembler, acking what it took.
struct RelayPhone {
    receiver: mixdog_remote::transport::receiver::Receiver,
    assembler: mixdog_remote::transport::split::MessageAssembler,
    taken: usize,
    acks: u64,
    messages: Vec<String>,
}

fn picture(jpeg_bytes: usize) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(vec![0x5a; jpeg_bytes]);
    format!(r#"{{"method":"browser/frame","params":{{"sessionId":"sess_1","seq":1,"image":{{"mimeType":"image/jpeg","data":"{data}"}}}}}}"#)
}

/// A coordinator whose live-view writes ask a gate, and the phone on its relay carrier.
struct LiveView {
    log: Log,
    allowed: Allowed,
    gate: mixdog_remote::transport::coordinator::WriteGate,
    coordinator: Coordinator<ChannelFake, HostFake>,
    phone: RelayPhone,
    tickets: u64,
}

impl LiveView {
    fn new() -> Self {
        let log = gated_log();
        let (allowed, _writes, gate) = write_gate();
        let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new(), on_seal: None };
        let host = HostFake { log: log.clone(), now: Rc::new(Cell::new(1_000)) };
        let coordinator = Coordinator::new("session-1", channel, host, AssemblyPool::default());
        Self { log, allowed, gate, coordinator, phone: RelayPhone::new(), tickets: 0 }
    }

    /// Sends `text`, tagged `name` (the coordinator numbers its tickets from 1); a browser frame asks the gate.
    fn send(&mut self, name: &str, text: &str) {
        self.tickets += 1;
        self.log.borrow_mut().tickets.insert(self.tickets, json!({ "id": name }));
        let gate = text.starts_with(r#"{"method":"browser/frame""#).then(|| self.gate.clone());
        let sent = self.coordinator.send(text, SendOptions { droppable: false, stream: None, meter: None, gate });
        assert!(matches!(sent, Sent::Queued(ticket) if ticket == self.tickets), "{name} was queued as ticket {}", self.tickets);
        self.coordinator.settle();
    }

    fn settled(&self, name: &str) -> Option<Value> {
        self.log.borrow().results.iter().find(|result| result["id"] == name).cloned()
    }

    /// The phone reads and acks until the desktop writes nothing more.
    fn read_all(&mut self) {
        while self.phone.read_and_ack(&self.log, &mut self.coordinator) {}
    }

    fn relay_writes(&self) -> usize {
        self.log.borrow().relay_raw.len()
    }

    fn ended(&self) -> Vec<Value> {
        self.log.borrow().effects.iter().filter(|effect| effect["e"] == "ended").map(|effect| effect["reason"].clone()).collect()
    }

    fn unpair(&self) {
        self.allowed.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

#[test]
fn a_live_view_picture_past_the_old_ceiling_arrives_whole_and_one_waiting_at_an_unpair_none_of_it() {
    let mut view = LiveView::new();
    for (name, jpeg_bytes) in [("past the old ceiling", 4 * 1024 * 1024), ("past the window", 10 * 1024 * 1024)] {
        let text = picture(jpeg_bytes);
        view.send(name, &text);
        view.read_all();
        let result = view.settled(name).unwrap_or_else(|| panic!("the picture {name} settled"));
        assert!(result["ok"].as_u64().is_some(), "the picture {name} entered the stream: {result}");
        assert_eq!(view.phone.messages.last().map(String::len), Some(text.len()), "the phone rebuilt the picture {name}");
        assert!(view.phone.messages.last() == Some(&text), "the phone rebuilt the picture {name} byte for byte");
    }

    // A large message of another kind fills the window, a picture waits behind it, the device is unpaired, the phone acks.
    let rebuilt = view.phone.messages.len();
    let other = format!(r#"{{"method":"thread/updated","params":{{"data":"{}"}}}}"#, "b".repeat(6 * 1024 * 1024));
    view.send("other", &other);
    view.send("at the unpair", &picture(4 * 1024 * 1024));
    assert!(view.settled("at the unpair").is_none(), "the picture waits for the window");
    view.unpair();
    view.read_all();
    assert_eq!(view.settled("at the unpair"), Some(json!({ "id": "at the unpair", "ok": null })), "the waiting picture was refused");
    assert_eq!(view.phone.messages[rebuilt..], [other], "the phone rebuilt the other message and nothing of the refused picture");
    view.send("after", r#"{"method":"event","params":{}}"#);
    view.read_all();
    assert_eq!(view.phone.messages.last().map(String::as_str), Some(r#"{"method":"event","params":{}}"#), "the stream has no hole");
    assert!(view.ended().is_empty(), "the session goes on");
}

/// A 6 MiB picture whose head is in the stream and whose tail waits for the window when the device is unpaired, its connection
/// still open: no record of its tail enters, and the session ends (`revoked`), at the unpair (`view_revoked`) or, without it, at
/// the tail's next entry. A picture that completed before the unpair stays whole on the phone.
#[test]
fn a_live_view_picture_half_in_the_stream_at_an_unpair_sends_no_more_and_ends_the_session() {
    for at_the_unpair in [true, false] {
        let mut view = LiveView::new();
        let before = picture(1024 * 1024);
        view.send("before", &before);
        view.read_all();
        assert_eq!(view.phone.messages, [before.clone()], "the picture before the unpair arrived whole");

        view.send("half sent", &picture(6 * 1024 * 1024));
        view.send("behind it", &picture(1024));
        let written = view.relay_writes();
        assert!(view.settled("half sent").is_none() && written > 2, "its head entered, its tail waits for the window");
        view.unpair();
        if at_the_unpair {
            view.coordinator.view_revoked();
            view.coordinator.settle();
            assert_eq!(view.ended(), [json!("revoked")], "the session ended at the unpair");
        }
        view.read_all();
        assert_eq!(view.relay_writes(), written, "no record was written after the unpair (at the unpair: {at_the_unpair})");
        assert_eq!(view.ended(), [json!("revoked")], "the session ended (at the unpair: {at_the_unpair})");
        for name in ["half sent", "behind it"] {
            assert_eq!(view.settled(name), Some(json!({ "id": name, "error": "ended", "reason": "revoked" })), "{name} ended with the session");
        }
        assert_eq!(view.phone.messages, [before.clone()], "the phone rebuilt nothing of the half-sent picture");
    }
}

/// A delivery withdrawn while it waits in the queue (its authority ended before it was committed): nothing of it was sealed, so it
/// leaves the queue, settles as dropped, and the stream has no hole — the next message takes the next sequence and arrives. A
/// delivery with a record already in the stream cannot be withdrawn without a hole, so the session ends instead.
#[test]
fn a_send_withdrawn_while_it_waits_for_the_window_leaves_no_hole_and_one_half_in_the_stream_ends_the_session() {
    let mut view = LiveView::new();
    let other = format!(r#"{{"method":"thread/updated","params":{{"data":"{}"}}}}"#, "b".repeat(6 * 1024 * 1024));
    view.send("other", &other);
    view.send("withdrawn", &picture(1024));
    assert!(view.settled("withdrawn").is_none(), "the picture waits for the window behind the other message");
    let ticket = view.tickets;
    view.coordinator.cancel_send(ticket);
    view.coordinator.settle();
    assert_eq!(view.settled("withdrawn"), Some(json!({ "id": "withdrawn", "ok": null })), "withdrawn: dropped, its ticket released");
    // A ticket already settled is not found: nothing happens.
    view.coordinator.cancel_send(ticket);
    view.coordinator.settle();
    view.read_all();
    assert_eq!(view.phone.messages.last(), Some(&other), "the other message arrived whole");
    view.send("after", r#"{"method":"event","params":{}}"#);
    view.read_all();
    assert_eq!(view.phone.messages.last().map(String::as_str), Some(r#"{"method":"event","params":{}}"#), "the stream has no hole");
    assert!(view.ended().is_empty(), "the session goes on");

    let mut view = LiveView::new();
    view.send("half sent", &picture(6 * 1024 * 1024));
    view.send("behind it", &picture(1024));
    assert!(view.settled("half sent").is_none() && view.relay_writes() > 2, "its head entered, its tail waits for the window");
    view.coordinator.cancel_send(1);
    view.coordinator.settle();
    assert_eq!(view.ended(), [json!("revoked")], "a record of it is in the stream: the session ends rather than leave a hole");
}

impl RelayPhone {
    fn new() -> Self {
        Self {
            receiver: mixdog_remote::transport::receiver::Receiver::new(),
            assembler: mixdog_remote::transport::split::MessageAssembler::new(AssemblyPool::default()),
            taken: 0,
            acks: 0,
            messages: Vec::new(),
        }
    }

    /// Takes what the desktop wrote, then acks what it took. False: nothing new.
    fn read_and_ack(&mut self, log: &Log, coordinator: &mut Coordinator<ChannelFake, HostFake>) -> bool {
        let written: Vec<Vec<u8>> = log.borrow().relay_raw[self.taken..].to_vec();
        self.taken += written.len();
        let mut through = None;
        for message in &written {
            if let mixdog_remote::transport::frame::Message::Record(record) =
                mixdog_remote::transport::frame::decode_message(message).expect("a conforming message")
            {
                self.receiver.accept(&record, 0);
            }
        }
        while let Some((sequence, box_bytes)) = self.receiver.next().map(|(sequence, bytes)| (sequence, bytes.to_vec())) {
            let (_, plaintext) = open_box(&box_bytes, APP_MAGIC).expect("an application box");
            self.receiver.commit(sequence, 0).expect("in order");
            if let mixdog_remote::transport::split::Assembly::Complete(bytes) = self.assembler.accept(&plaintext, 0).expect("the phone's reassembly takes it") {
                self.messages.push(String::from_utf8(bytes).expect("text"));
            }
            through = Some(sequence);
        }
        let Some(through) = through else { return false };
        self.acks += 1;
        let ack = make_box(CONTROL_MAGIC, self.acks, &mixdog_remote::transport::control::ack_json(through, &[]));
        coordinator.receive("relay", &mixdog_remote::transport::frame::encode_control(&ack).expect("a control message"));
        coordinator.settle();
        true
    }
}
