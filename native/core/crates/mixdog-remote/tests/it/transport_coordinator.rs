//! The transport coordinator against Node's recorded behavior
//! (`fixtures/remote-transport-coordinator/scenarios.json`, recorded from
//! `apps/desktop/src/main/remote-transport/coordinator.ts` at b6f10295a): every step's effects, in
//! order (relay writes, peer sends and closes, sealed control messages, deliveries, callbacks, log
//! lines, lane operations), the settled sends and the diagnostics afterwards are what Node did.
//!
//! The E2EE channel is the recorder's stand-in (see the fixture's `convention`): the boxes are
//! `magic | u64 sequence | 12 zero bytes | JSON | 16 zero bytes`, control messages boxed as
//! canonical JSON. The phone's inputs are the recorded bytes.

use std::cell::Cell;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use base64::Engine;
use mixdog_remote::e2ee::ControlLane;
use mixdog_remote::e2ee::ControlOpen;
use mixdog_remote::transport::coordinator::Coordinator;
use mixdog_remote::transport::coordinator::EndReason;
use mixdog_remote::transport::coordinator::Ended;
use mixdog_remote::transport::coordinator::Host;
use mixdog_remote::transport::coordinator::LocalOffer;
use mixdog_remote::transport::coordinator::MediaAdapter;
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
use mixdog_remote::webrtc::signal::parse_candidate;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const RECORDED: &str = include_str!("../../../../fixtures/remote-transport-coordinator/scenarios.json");

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
    if bytes.len() > 256 {
        json!({ "len": bytes.len(), "sha256": hex(&Sha256::digest(bytes)) })
    } else {
        json!({ "hex": hex(bytes) })
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2).map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).expect("hex")).collect()
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
}

type Log = Rc<RefCell<Shared>>;

struct ChannelFake {
    log: Log,
    encrypt_sequence: u64,
    control_sequence: u64,
    lanes: HashMap<String, (&'static str, u64)>,
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

    fn relay_send(&mut self, message: &[u8]) -> Settle<bool> {
        let held = self.log.borrow().options["relay"] == "held";
        self.log.borrow_mut().effects.push(with(json!({ "e": "relay" }), bytes_record(message)));
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

    fn resolve_ice(&mut self) -> Settle<Result<Value, ()>> {
        self.log.borrow_mut().effects.push(json!({ "e": "ice" }));
        let mode = self.log.borrow().options["ice"].as_str().map(str::to_owned);
        Settle::Now(match mode.as_deref() {
            Some("reject") => Err(()),
            Some("invalid") => Ok(json!([{ "urls": "http://not-ice" }])),
            _ => Ok(json!([{ "urls": ["turn:turn.example.org:3478"], "username": "user-secret-name", "credential": "credential-secret" }])),
        })
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

struct StubMedia {
    log: Log,
}

impl MediaAdapter for StubMedia {
    fn receive(&mut self, payload: &Value) -> bool {
        if payload.get("type").and_then(Value::as_str) == Some("stub-media") {
            self.log.borrow_mut().effects.push(json!({ "e": "media", "payload": payload }));
            return true;
        }
        false
    }

    fn writable(&mut self) {
        self.log.borrow_mut().effects.push(json!({ "e": "media-writable" }));
    }

    fn close(&mut self) {
        self.log.borrow_mut().effects.push(json!({ "e": "media-close" }));
    }
}

fn padded(call_id: u64, length: usize) -> String {
    let head = format!("{{\"id\":{call_id},\"pad\":\"");
    let tail = "\"}";
    format!("{head}{}{tail}", "a".repeat(length.saturating_sub(head.len() + tail.len())))
}

fn end_reason(name: Option<&str>) -> EndReason {
    match name {
        Some("revoked") => EndReason::Revoked,
        Some("record-expiry") => EndReason::RecordExpiry,
        Some("assembly-stalled") => EndReason::AssemblyStalled,
        Some("protocol-error") => EndReason::ProtocolError,
        Some("seal-failed") => EndReason::SealFailed,
        _ => EndReason::SessionEnded,
    }
}

fn close_reason(name: &str) -> CloseReason {
    CloseReason::from_wire(name).unwrap_or_else(|| panic!("a close reason: {name}"))
}

fn run_step(step: &Value, coordinator: &mut Coordinator<ChannelFake, HostFake>, log: &Log, now: &Cell<u64>) {
    now.set(step.get("at").and_then(Value::as_u64).expect("at"));
    {
        let mut shared = log.borrow_mut();
        shared.effects.clear();
        shared.results.clear();
    }
    let op = step["op"].as_str().expect("op");
    let queue = |coordinator: &mut Coordinator<ChannelFake, HostFake>, sent: Sent, tag: Value| match sent {
        Sent::Settled(result) => {
            let entry = settled_entry(&tag, result);
            coordinator.host().log.borrow_mut().results.push(entry);
        }
        Sent::Queued(ticket) => {
            coordinator.host().log.borrow_mut().tickets.insert(ticket, tag);
        }
    };
    match op {
        "receive" => {
            let carrier = step["carrier"].as_str().expect("carrier");
            for text in step["hex"].as_array().expect("hex") {
                coordinator.receive(carrier, &unhex(text.as_str().expect("hex text")));
            }
        }
        "tick" => coordinator.tick(),
        "send" => {
            let id = step["id"].as_u64().expect("id");
            let text = match step.get("fill") {
                Some(fill) => padded(fill["callId"].as_u64().expect("call id"), fill["length"].as_u64().expect("length") as usize),
                None => step["payload"].as_str().expect("payload").to_owned(),
            };
            let meter = step.get("meter").and_then(Value::as_str).map(|name| {
                let mut shared = log.borrow_mut();
                shared.meters.push(name.to_owned());
                (shared.meters.len() - 1) as u64
            });
            let options = SendOptions {
                droppable: step.get("droppable").and_then(Value::as_bool) == Some(true),
                stream: step.get("stream").and_then(Value::as_str).map(str::to_owned),
                meter,
            };
            let sent = coordinator.send(&text, options);
            queue(coordinator, sent, json!({ "id": id }));
        }
        "close" => {
            let ended = coordinator.close(end_reason(step.get("reason").and_then(Value::as_str)));
            log.borrow_mut().effects.push(json!({ "e": "close-result", "reason": ended.reason.wire_name(), "ambiguousCallIds": ended.ambiguous_call_ids }));
        }
        "peer" => {
            let connection = log.borrow().peers.last().cloned().expect("a peer");
            match step["event"].as_str().expect("event") {
                "candidate" => {
                    let candidate = parse_candidate(&step["candidate"]).expect("a candidate");
                    coordinator.peer_candidate_event(&connection, candidate);
                }
                "open" => {
                    let size = match &step["maxMessageSize"] {
                        Value::String(text) if text == "Infinity" => Some(f64::INFINITY),
                        other => other.as_f64(),
                    };
                    coordinator.peer_open(&connection, size, step["relayed"] == true);
                }
                "message" => coordinator.peer_message(&connection, &unhex(step["hex"].as_str().expect("hex"))),
                "drain" => coordinator.peer_drain(&connection),
                "closed" => coordinator.peer_closed(&connection, close_reason(step["reason"].as_str().expect("reason"))),
                other => panic!("a peer event: {other}"),
            }
        }
        "set" => {
            let mut shared = log.borrow_mut();
            let value = &step["value"];
            match step["key"].as_str().expect("key") {
                "buffered" => shared.buffered = value.as_u64().expect("number") as usize,
                "refuse" => shared.refuse = value.as_bool().expect("bool"),
                "encrypt" => shared.encrypt = value.as_str().map(str::to_owned),
                "sealControl" => shared.seal_control = value.as_str().map(str::to_owned),
                other => panic!("a setting: {other}"),
            }
        }
        "relay-release" => {
            for _ in 0..step["count"].as_u64().expect("count") {
                coordinator.complete_relay_send(true);
            }
        }
        "deliver-release" => {
            for _ in 0..step["count"].as_u64().expect("count") {
                let pending = log.borrow().pending_deliver;
                if pending > 0 {
                    log.borrow_mut().pending_deliver = pending - 1;
                    coordinator.complete_deliver();
                }
            }
        }
        "media-send" => {
            let text = step["text"].as_str().expect("text");
            let stream = step.get("stream").and_then(Value::as_str).map(str::to_owned);
            let sent = coordinator.send(text, SendOptions { droppable: false, stream, meter: None });
            queue(coordinator, sent, json!({ "media": true }));
        }
        "media-can-admit" => {
            let admitted = coordinator.media_can_admit(step["stream"].as_str().expect("stream"));
            log.borrow_mut().results.push(json!({ "canAdmit": admitted }));
        }
        "media-protocol-error" => coordinator.media_protocol_error(),
        other => panic!("an op: {other}"),
    }
    coordinator.settle();
}

#[test]
fn the_coordinator_does_what_node_did_over_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(RECORDED).expect("the recording is JSON");
    let scenarios = recorded["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 20);
    let mut steps_checked = 0;
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("name");
        let now = Rc::new(Cell::new(scenario["start"].as_u64().expect("start")));
        let log: Log = Rc::new(RefCell::new(Shared {
            effects: Vec::new(),
            results: Vec::new(),
            options: scenario["options"].clone(),
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
        }));
        let channel = ChannelFake { log: log.clone(), encrypt_sequence: 0, control_sequence: 0, lanes: HashMap::new() };
        let host = HostFake { log: log.clone(), now: now.clone() };
        let mut coordinator = Coordinator::new(scenario["sessionId"].as_str().expect("session"), channel, host, AssemblyPool::default());
        if scenario["options"]["media"] == true {
            coordinator.set_media(Box::new(StubMedia { log: log.clone() }));
        }
        for (index, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
            run_step(step, &mut coordinator, &log, &now);
            let shared = log.borrow();
            let at = format!("{name}: step {index} ({})", step["op"]);
            assert_eq!(Value::Array(shared.effects.clone()), step["effects"], "effects of {at}");
            assert_eq!(Value::Array(shared.results.clone()), step["results"], "results of {at}");
            drop(shared);
            assert_eq!(coordinator.diagnostics().to_json(), step["diagnostics"], "diagnostics of {at}");
            steps_checked += 1;
        }
    }
    assert!(steps_checked > 300);
}
