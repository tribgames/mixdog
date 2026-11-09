//! The transport media adapter against Node's recorded behavior
//! (`fixtures/remote-transport-media/scenarios.json`, recorded from
//! `apps/desktop/src/main/remote-transport/media.ts` at b6f10295a): every message the adapter seals,
//! in order, per step. A media frame carries a random nonce, so it is compared as what it decrypts
//! to: the meta, or a segment's offset, length and digest.

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use base64::Engine;
use mixdog_remote::media::ByteSource;
use mixdog_remote::media::MediaSources;
use mixdog_remote::media::SourceFailure;
use mixdog_remote::media::crypto::decrypt_media_meta;
use mixdog_remote::media::crypto::decrypt_media_segment;
use mixdog_remote::transport::media::MediaLink;
use mixdog_remote::transport::media::TransportMedia;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tokio::sync::Notify;
use tokio::sync::oneshot;

const RECORDED: &str = include_str!("../../../../fixtures/remote-transport-media/scenarios.json");
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
    Reject,
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

    async fn send(&self, message: Value, stream: Option<&str>) -> Result<bool, ()> {
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
            Send::Reject => Err(()),
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

/// One sealed message as the recording shows it: a frame replaced by what it decrypts to, which
/// the recorded entry names (its meta start, or its segment offset and size).
fn describe(actual: &Value, recorded: &Value, requests: &HashMap<String, Value>) -> Value {
    let message = &actual["message"];
    if actual["e"] != "send" || message["op"] != "chunk" {
        return actual.clone();
    }
    let id = message["id"].as_str().expect("id");
    let request = &requests[id];
    let (asset_id, variant) = (request["assetId"].as_str().expect("asset"), request["variant"].as_str().expect("variant"));
    let frame = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(message["frame"].as_str().expect("frame")).expect("base64url");
    let body = &frame[4..];
    let wanted = &recorded["message"]["frame"];
    let shown = match wanted["kind"].as_str() {
        Some("meta") => {
            let start = wanted["expectedStart"].as_u64().expect("start");
            let meta = decrypt_media_meta(&KEY, asset_id, variant, start, body).expect("the meta frame opens");
            let mut shown = json!({ "size": meta.size, "mime": meta.mime, "start": meta.start, "end": meta.end as i64 });
            if let (Some(version), Some(map)) = (meta.version, shown.as_object_mut()) {
                map.insert("version".into(), Value::String(version));
            }
            json!({ "kind": "meta", "expectedStart": start, "meta": shown })
        }
        Some("segment") => {
            let (offset, size) = (wanted["offset"].as_u64().expect("offset"), wanted["size"].as_u64().expect("size"));
            let plain = decrypt_media_segment(&KEY, asset_id, variant, offset, size, body).expect("the segment frame opens");
            let digest: String = Sha256::digest(&plain).iter().map(|b| format!("{b:02x}")).collect();
            json!({ "kind": "segment", "offset": offset, "size": size, "length": plain.len(), "sha256": digest })
        }
        _ => panic!("a recorded chunk is a meta or a segment"),
    };
    json!({ "e": "send", "stream": actual["stream"], "message": { "type": message["type"], "op": "chunk", "id": id, "frame": shown } })
}

#[tokio::test(flavor = "current_thread")]
async fn the_adapter_seals_what_node_sealed_over_every_recorded_scenario() {
    let recorded: Value = serde_json::from_str(RECORDED).expect("the recording is JSON");
    let scenarios = recorded["scenarios"].as_array().expect("scenarios");
    assert!(scenarios.len() >= 12);
    let mut checked = 0;
    for scenario in scenarios {
        let name = scenario["name"].as_str().expect("name");
        let options = &scenario["options"];
        let gate = Gate::default();
        let state = Arc::new(Mutex::new(LinkState {
            room: HashMap::new(),
            default_room: options["room"] != false,
            held_mode: options["send"] == "held",
            queue: VecDeque::new(),
            held: VecDeque::new(),
            effects: Vec::new(),
            changed: gate.changed.clone(),
        }));
        let sources = Arc::new(Leases { gate: gate.clone(), counts: Arc::new(Mutex::new(HashMap::new())) });
        let key = (options["mediaKey"] != false).then_some(KEY);
        let device = match &options["device"] {
            Value::Null if options.get("device").is_some() => None,
            Value::String(device) => Some(device.clone()),
            _ => Some(DEVICE.to_owned()),
        };
        let adapter = TransportMedia::new(Arc::new(LinkFake { state: state.clone() }), sources, key, device);
        let mut requests: HashMap<String, Value> = HashMap::new();
        for (index, step) in scenario["steps"].as_array().expect("steps").iter().enumerate() {
            state.lock().unwrap().effects.clear();
            let mut results: Vec<Value> = Vec::new();
            match step["op"].as_str().expect("op") {
                "receive" => {
                    let payload = &step["payload"];
                    if payload["op"] == "request" && payload["id"].is_string() && payload["assetId"].is_string() {
                        requests.insert(payload["id"].as_str().expect("id").to_owned(), payload.clone());
                    }
                    results.push(json!({ "receive": adapter.receive(payload) }));
                }
                "writable" => adapter.writable(),
                "room" => {
                    let value = step["value"].as_bool().expect("bool");
                    let mut state = state.lock().unwrap();
                    match step["stream"].as_str() {
                        Some(stream) => {
                            state.room.insert(stream.to_owned(), value);
                        }
                        None => state.default_room = value,
                    }
                }
                "queue-send" => {
                    let mut state = state.lock().unwrap();
                    for value in step["values"].as_array().expect("values") {
                        state.queue.push_back(match value {
                            Value::Bool(sent) => Send::Value(*sent),
                            Value::String(text) if text == "reject" => Send::Reject,
                            other => panic!("a send result: {other}"),
                        });
                    }
                }
                "release-send" => {
                    for _ in 0..step["count"].as_u64().expect("count") {
                        let pending = state.lock().unwrap().held.pop_front();
                        if let Some(pending) = pending {
                            let _ = pending.send(match &step["result"] {
                                Value::Bool(sent) => Ok(*sent),
                                _ => Err(()),
                            });
                        }
                    }
                }
                "release-read" => {
                    for _ in 0..step["count"].as_u64().expect("count") {
                        if let Some(pending) = gate.held.lock().unwrap().pop_front() {
                            let _ = pending.send(());
                        }
                    }
                }
                "close" => adapter.close(),
                other => panic!("an op: {other}"),
            }
            settle(&adapter, &state, &gate).await;
            let actual = state.lock().unwrap().effects.clone();
            let recorded_effects = step["effects"].as_array().expect("effects");
            let described: Vec<Value> = actual
                .iter()
                .enumerate()
                .map(|(i, entry)| describe(entry, recorded_effects.get(i).unwrap_or(&Value::Null), &requests))
                .collect();
            let at = format!("{name}: step {index} ({})", step["op"]);
            assert_eq!(Value::Array(described), step["effects"], "effects of {at}");
            assert_eq!(Value::Array(results), step["results"], "results of {at}");
            checked += 1;
        }
    }
    assert!(checked > 100);
}

/// Two requests past the stream limit arrive before the refusal pump has run, and the first error's
/// send is still pending: the queue head is sealed once. (Node claims the pump synchronously, so the
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