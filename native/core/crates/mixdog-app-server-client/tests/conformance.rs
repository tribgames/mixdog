//! Runs every `packages/protocol-client/conformance/*.json` scenario against the Rust engine over the mock transport.
//! The TS runner (`packages/protocol-client/test/conformance.test.ts`) interprets the same files.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use mixdog_app_server_client::{
    BlobDescriptor, BlobRef, ClientError, ClientEvent, Clock, ConnectOptions, ConnectionStatus,
    DEFAULT_LADDER, FeedStamp, Json, LadderConfig, ProtocolClient, RequestId, ResumeWindow,
    RpcNotification, SectionName, ServerRequestAnswer, Target, ThreadId, ThreadReducer, connect,
    engine::{Client, ladder_delay, new_op_id},
    mock::{MockConn, MockNetwork},
};
use serde_json::json;
use tokio::{sync::broadcast, task::JoinHandle};

type Caps = HashMap<String, Json>;
type CallResult = Result<Json, ClientError>;

struct Recorder;
impl ThreadReducer for Recorder {
    fn initial(&self, snapshot: &Json) -> Json {
        json!({ "snap": snapshot, "log": [] })
    }
    fn apply(&self, state: &Json, n: &RpcNotification) -> Json {
        let mut s = state.clone();
        let seq = n.feed.as_ref().map_or(0, |f| f.seq);
        s["log"]
            .as_array_mut()
            .unwrap()
            .push(json!(format!("{}@{}", n.method, seq)));
        s
    }
}

struct MockClock {
    sleeps: Arc<Mutex<Vec<u64>>>,
    jitter: f64,
}
#[async_trait]
impl Clock for MockClock {
    async fn sleep(&self, ms: u64) {
        self.sleeps.lock().unwrap().push(ms);
        tokio::task::yield_now().await;
    }
    fn jitter(&self) -> f64 {
        self.jitter
    }
}

async fn guard<T>(f: impl std::future::Future<Output = T>, what: &str) -> T {
    tokio::time::timeout(Duration::from_secs(2), f)
        .await
        .unwrap_or_else(|_| panic!("timeout: {what}"))
}
async fn settle() {
    for _ in 0..60 {
        tokio::task::yield_now().await;
    }
}

fn matches(expected: &Json, actual: &Json, caps: &mut Caps, path: &str) {
    match expected {
        Json::String(s) if s.starts_with("$cap:") => match caps.get(&s[5..]) {
            Some(v) => assert_eq!(v, actual, "{path}"),
            None => {
                caps.insert(s[5..].to_string(), actual.clone());
            }
        },
        Json::Array(e) => {
            let a = actual
                .as_array()
                .unwrap_or_else(|| panic!("{path}: not an array: {actual}"));
            assert_eq!(e.len(), a.len(), "{path}: {actual}");
            for (i, (x, y)) in e.iter().zip(a).enumerate() {
                matches(x, y, caps, &format!("{path}[{i}]"));
            }
        }
        Json::Object(e) => {
            let a = actual
                .as_object()
                .unwrap_or_else(|| panic!("{path}: not an object: {actual}"));
            let mut ek: Vec<_> = e.keys().collect();
            let mut ak: Vec<_> = a.keys().collect();
            ek.sort();
            ak.sort();
            assert_eq!(ek, ak, "{path}: keys of {actual}");
            for (k, v) in e {
                matches(v, &a[k], caps, &format!("{path}.{k}"));
            }
        }
        other => assert_eq!(other, actual, "{path}"),
    }
}

fn subst(v: &Json, caps: &Caps) -> Json {
    match v {
        Json::String(s) if s.starts_with("$cap:") => caps
            .get(&s[5..])
            .unwrap_or_else(|| panic!("uncaptured {s}"))
            .clone(),
        Json::Array(a) => Json::Array(a.iter().map(|x| subst(x, caps)).collect()),
        Json::Object(o) => {
            Json::Object(o.iter().map(|(k, x)| (k.clone(), subst(x, caps))).collect())
        }
        other => other.clone(),
    }
}

fn digest_of(e: &ClientError) -> Option<String> {
    match e {
        ClientError::BlobNotFound(d) | ClientError::BlobCorrupt(d) => Some(d.clone()),
        _ => None,
    }
}

/// Drains the client's events into the recorded status and blob-failure lists.
fn pump(
    events: &mut broadcast::Receiver<ClientEvent>,
    statuses: &mut Vec<String>,
    blob_failures: &mut Vec<ClientError>,
) {
    while let Ok(e) = events.try_recv() {
        match e {
            ClientEvent::Status(st) => statuses.push(match st {
                ConnectionStatus::Ready { .. } => "ready".into(),
                ConnectionStatus::Reconnecting { attempt } => format!("reconnecting:{attempt}"),
                ConnectionStatus::Closed { .. } => "closed".into(),
            }),
            ClientEvent::BlobUnavailable { error, .. } => blob_failures.push(error),
            _ => {}
        }
    }
}

async fn run(options: Json, steps: Vec<Json>) {
    let net = Arc::new(MockNetwork::default());
    let sleeps = Arc::new(Mutex::new(Vec::new()));
    let mut caps = Caps::new();
    let mut statuses: Vec<String> = Vec::new();
    let mut blob_failures: Vec<ClientError> = Vec::new();
    let mut status_at = 0;
    let mut conn: Option<MockConn> = None;
    let mut client: Option<Arc<Client>> = None;
    let mut events = None;
    let mut connecting: Option<JoinHandle<Result<Client, ClientError>>> = None;
    let mut handshakes = 0;
    let mut calls: HashMap<String, JoinHandle<CallResult>> = HashMap::new();
    let op_seq = Arc::new(Mutex::new(0u32));

    for s in steps {
        let step = s["do"].as_str().unwrap().to_string();
        match step.as_str() {
            "connect" => {
                let counter = op_seq.clone();
                let opts = ConnectOptions {
                    target: Target { id: "local".into() },
                    connector: net.clone(),
                    client_info: serde_json::from_value(options["clientInfo"].clone()).unwrap(),
                    capabilities: serde_json::from_value(options["capabilities"].clone()).unwrap(),
                    thread_reducer: Some(Arc::new(Recorder)),
                    clock: Arc::new(MockClock {
                        sleeps: sleeps.clone(),
                        jitter: options["jitterUnit"].as_f64().unwrap(),
                    }),
                    new_op_id: Some(Arc::new(move || {
                        let mut c = counter.lock().unwrap();
                        *c += 1;
                        format!("op-{c}")
                    })),
                    ladder: LadderConfig {
                        base_ms: options["ladder"]["baseMs"].as_u64().unwrap(),
                        cap_ms: options["ladder"]["capMs"].as_u64().unwrap(),
                    },
                };
                connecting = Some(tokio::spawn(connect(opts)));
            }
            "handshake" => {
                let c = guard(net.accept(), "accept").await;
                let init: Json =
                    serde_json::from_str(&guard(c.next_sent(), "initialize").await).unwrap();
                handshakes += 1;
                matches(
                    &json!({ "id": format!("$cap:init{handshakes}"), "method": "initialize", "params": { "clientInfo": options["clientInfo"], "capabilities": options["capabilities"] } }),
                    &init,
                    &mut caps,
                    "initialize",
                );
                if let Some(reason) = s.get("refuse") {
                    c.server_send(&json!({ "id": init["id"], "error": { "code": -32600, "message": "v", "data": { "reason": reason, "serverVersion": "2.0.0", "clientVersion": "1.4.6" } } }));
                    c.server_close(4002, "version");
                } else {
                    let mut result = options["initializeResult"].clone();
                    result["serverInstanceId"] = s["instance"].clone();
                    if let Some(o) = s.get("limits").and_then(Json::as_object) {
                        for (k, v) in o {
                            result["limits"][k] = v.clone();
                        }
                    }
                    c.server_send(&json!({ "id": init["id"], "result": result }));
                    let initialized: Json =
                        serde_json::from_str(&guard(c.next_sent(), "initialized").await).unwrap();
                    matches(
                        &json!({ "method": "initialized" }),
                        &initialized,
                        &mut caps,
                        "initialized",
                    );
                }
                conn = Some(c);
            }
            "connected" => {
                let r = guard(connecting.take().unwrap(), "connect").await.unwrap();
                if let Some(kind) = s.get("error") {
                    assert_eq!(
                        r.err().expect("expected connect error").kind(),
                        kind.as_str().unwrap()
                    );
                } else {
                    let c = Arc::new(r.expect("connect"));
                    assert_eq!(
                        c.server().server_instance_id,
                        s["instance"].as_str().unwrap()
                    );
                    statuses.push("ready".into());
                    events = Some(c.events());
                    client = Some(c);
                }
            }
            "expectSend" => {
                let f: Json = serde_json::from_str(
                    &guard(conn.as_ref().unwrap().next_sent(), "client frame").await,
                )
                .unwrap();
                matches(&s["frame"], &f, &mut caps, "frame");
            }
            "expectNoSend" => {
                settle().await;
                assert_eq!(
                    conn.as_ref().unwrap().queued(),
                    0,
                    "unexpected client frame"
                );
            }
            "serverSend" => conn
                .as_ref()
                .unwrap()
                .server_send(&subst(&s["frame"], &caps)),
            "serverSendRaw" => conn
                .as_ref()
                .unwrap()
                .server_send_raw(s["text"].as_str().unwrap()),
            "serverClose" => conn.as_ref().unwrap().server_close(
                s["code"].as_u64().unwrap() as u16,
                s["reason"].as_str().unwrap_or_default(),
            ),
            "expectClientClose" => {
                settle().await;
                let want = if s.get("none").is_some() {
                    None
                } else {
                    Some(s["code"].as_u64().unwrap() as u16)
                };
                assert_eq!(conn.as_ref().unwrap().client_close(), want);
            }
            "openFails" => net.fail_next(s["count"].as_u64().unwrap() as usize),
            "call" => {
                let c = client.clone().unwrap();
                let s2 = s.clone();
                let h = tokio::spawn(async move {
                    match s2.get("fn").and_then(Json::as_str).unwrap_or("call") {
                        "call" => {
                            c.call_raw(
                                s2["method"].as_str().unwrap(),
                                s2["params"].clone(),
                                Default::default(),
                            )
                            .await
                        }
                        "resumeThread" => {
                            let w: ResumeWindow =
                                serde_json::from_value(s2["window"].clone()).unwrap();
                            let id = ThreadId::from(s2["threadId"].as_str().unwrap());
                            c.resume_thread(&id, w)
                                .await
                                .map(|r| serde_json::to_value(r).unwrap())
                        }
                        "unsubscribeThread" => c
                            .unsubscribe_thread(&ThreadId::from(s2["threadId"].as_str().unwrap()))
                            .await
                            .map(|_| Json::Null),
                        "subscribeApp" => c.subscribe_app().await.map(|_| Json::Null),
                        "putBlob" => c
                            .put_blob(
                                s2["text"].as_str().unwrap().as_bytes(),
                                s2["mediaType"].as_str().unwrap(),
                            )
                            .await
                            .map(|r| serde_json::to_value(r).unwrap()),
                        "readBlob" => {
                            let blob = BlobRef {
                                blob: BlobDescriptor {
                                    digest: s2["digest"].as_str().unwrap().into(),
                                    bytes: s2["bytes"].as_u64().unwrap(),
                                    media_type: s2["mediaType"].as_str().unwrap().into(),
                                },
                            };
                            c.read_blob(&blob)
                                .await
                                .map(|b| Json::String(String::from_utf8_lossy(&b).into_owned()))
                        }
                        other => panic!("fn {other}"),
                    }
                });
                calls.insert(s["as"].as_str().unwrap().to_string(), h);
            }
            "result" => {
                let name = s["as"].as_str().unwrap();
                let r = guard(calls.remove(name).unwrap(), name).await.unwrap();
                if let Some(e) = s.get("error") {
                    let err = r.expect_err("expected error");
                    assert_eq!(err.kind(), e["kind"].as_str().unwrap(), "{err}");
                    if let Some(reason) = e.get("reason") {
                        assert_eq!(err.reason().as_deref(), reason.as_str());
                    }
                    if let Some(cause) = e.get("cause") {
                        let ClientError::OpOutcomeUnknown {
                            cause: Some(inner), ..
                        } = &err
                        else {
                            panic!("no cause on {err}")
                        };
                        assert_eq!(inner.kind(), cause["kind"].as_str().unwrap());
                    }
                    if let Some(digest) = e.get("digest") {
                        assert_eq!(digest_of(&err).as_deref(), digest.as_str());
                    }
                } else {
                    assert_eq!(r.expect("unexpected error"), s["ok"]);
                }
            }
            "notify" => client
                .as_ref()
                .unwrap()
                .notify(s["method"].as_str().unwrap(), s["params"].clone())
                .await
                .unwrap(),
            "respond" => {
                let id: RequestId = serde_json::from_value(s["id"].clone()).unwrap();
                let a = &s["answer"];
                let answer = match a.get("result") {
                    Some(r) => ServerRequestAnswer::Result(r.clone()),
                    None => ServerRequestAnswer::Error {
                        code: a["error"]["code"].as_i64().unwrap(),
                        message: String::new(),
                        data: None,
                    },
                };
                client.as_ref().unwrap().respond(id, answer).await.unwrap();
            }
            "close" => client.as_ref().unwrap().close().await,
            "settle" => settle().await,
            "expectSleeps" => {
                settle().await;
                let got: Vec<u64> = std::mem::take(&mut *sleeps.lock().unwrap());
                let want: Vec<u64> = s["ms"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_u64().unwrap())
                    .collect();
                assert_eq!(got, want);
            }
            "expectStatus" => {
                settle().await;
                pump(events.as_mut().unwrap(), &mut statuses, &mut blob_failures);
                let want: Vec<String> = s["states"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                assert_eq!(
                    statuses[status_at..(status_at + want.len()).min(statuses.len())],
                    want[..]
                );
                status_at += want.len();
            }
            "expectBlobUnavailable" => {
                settle().await;
                pump(events.as_mut().unwrap(), &mut statuses, &mut blob_failures);
                let got: Vec<Json> = blob_failures
                    .drain(..)
                    .map(|e| json!({ "kind": e.kind(), "digest": digest_of(&e) }))
                    .collect();
                assert_eq!(Json::Array(got), s["errors"]);
            }
            "expectFeed" => {
                let f = client
                    .as_ref()
                    .unwrap()
                    .store()
                    .thread(s["id"].as_str().unwrap())
                    .map(|t| t.feed);
                let want = FeedStamp {
                    id: s["id"].as_str().unwrap().into(),
                    epoch: s["epoch"].as_str().unwrap().into(),
                    seq: s["seq"].as_u64().unwrap(),
                };
                assert_eq!(f, Some(want));
            }
            "expectThreadState" => {
                let t = client
                    .as_ref()
                    .unwrap()
                    .store()
                    .thread(s["thread"].as_str().unwrap());
                assert_eq!(t.map(|t| t.state), Some(s["state"].clone()));
            }
            "expectNoThread" => assert!(
                client
                    .as_ref()
                    .unwrap()
                    .store()
                    .thread(s["thread"].as_str().unwrap())
                    .is_none()
            ),
            "expectSection" => {
                let name: SectionName = serde_json::from_value(s["section"].clone()).unwrap();
                let e = client
                    .as_ref()
                    .unwrap()
                    .store()
                    .section(name, s["key"].as_str());
                if s.get("absent").is_some() {
                    assert!(e.is_none());
                } else {
                    let e = e.expect("section present");
                    assert_eq!(
                        (e.revision, e.value),
                        (s["revision"].as_u64().unwrap(), s["value"].clone())
                    );
                }
            }
            "expectServerRequests" => {
                let got: Vec<RequestId> = client
                    .as_ref()
                    .unwrap()
                    .pending_server_requests()
                    .iter()
                    .map(|r| r.id().clone())
                    .collect();
                let want: Vec<RequestId> = s["ids"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| serde_json::from_value(v.clone()).unwrap())
                    .collect();
                assert_eq!(got, want);
            }
            other => panic!("unknown step {other}"),
        }
    }
}

#[tokio::test(flavor = "current_thread")]
async fn conformance_scenarios() {
    let dir = PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../../packages/protocol-client/conformance"
    ));
    let options: Json =
        serde_json::from_str(&std::fs::read_to_string(dir.join("options.json")).unwrap()).unwrap();
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.as_bytes()[0].is_ascii_digit() && n.ends_with(".json"))
        })
        .collect();
    files.sort();
    assert!(files.len() >= 16, "scenarios missing in {dir:?}");
    let mut failures = Vec::new();
    for f in files {
        let sc: Json = serde_json::from_str(&std::fs::read_to_string(&f).unwrap()).unwrap();
        let steps = sc["steps"].as_array().unwrap().clone();
        if let Err(e) = tokio::spawn(run(options.clone(), steps)).await {
            failures.push(format!("{}: {e}", f.file_name().unwrap().to_string_lossy()));
        }
    }
    assert!(
        failures.is_empty(),
        "failed scenarios:\n{}",
        failures.join("\n")
    );
}

#[test]
fn ladder_is_full_jitter_doubling_to_the_cap() {
    let got: Vec<u64> = [0, 1, 2, 3, 4, 5, 9]
        .iter()
        .map(|a| ladder_delay(*a, 0.5, DEFAULT_LADDER))
        .collect();
    assert_eq!(got, [125, 250, 500, 1000, 2000, 2500, 2500]);
    assert_eq!(ladder_delay(3, 0.0, DEFAULT_LADDER), 0);
}

#[test]
fn default_op_ids_are_uuid_v7() {
    let id = new_op_id();
    assert_eq!(id.len(), 36);
    assert_eq!(id.as_bytes()[14], b'7');
}
