//! The caller cancelling a Claude send on Vertex AI, against Node's recordings (`fixtures/provider-wire/
//! vertex-claude-cancel`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`: `opts.signal` aborted,
//! vertex-ai.mjs:507-537). The provider is built by the production builder over the product's own HTTP client, pinned
//! to a loopback TLS endpoint that answers as Node's endpoint did (`transport::loopback`), and sent through the broker,
//! the send path that owns retries and the caller's cancellation. Each step is signalled where Node's was: the held
//! request arriving (before the first byte), the first text delta (mid-stream), the send waiting in its retry wait
//! (pending after the retry's discard; Node's step is its retry sleep arming its timer). Compared: every request whole
//! (so no retry fires after the cancel), the connections the endpoint saw the client close, the callbacks in order, the
//! caller's result (Node's `AbortError` is the broker's `Cancelled`), and the admission slot released. The cancel in the
//! retry wait ends the send under a paused clock that has not moved. Every wait has one deadline naming its step.

use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::task::Poll;
use std::time::Duration;

use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::admission::Admission;
use crate::admission::AdmissionRequest;
use crate::admission::LaneKey;
use crate::admission::LaneSettings;
use crate::broker::AttemptSink;
use crate::broker::ModelBroker;
use crate::broker::SendError;
use crate::broker::SendRequest;
use crate::providers::anthropic::ModelCaps;
use crate::providers::wire_fixtures::Inputs;
use crate::providers::wire_fixtures::Recorded;
use crate::providers::wire_fixtures::assert_minted_bearer;
use crate::providers::wire_fixtures::assert_same_events;
use crate::providers::wire_fixtures::assert_same_requests;
use crate::providers::wire_fixtures::built_on;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::request_of;
use crate::providers::wire_fixtures::scenarios;
use crate::retry::StandardRetryDecider;
use crate::transport::KeepaliveSchedule;
use crate::transport::ReqwestLink;
use crate::transport::loopback::Loopback;
use crate::transport::loopback::Script;

/// The one deadline of each wait: a step that does not come fails the replay naming it.
const DEADLINE: Duration = Duration::from_secs(30);

async fn within<T>(what: &str, step: impl Future<Output = T>) -> T {
    tokio::time::timeout(DEADLINE, step).await.unwrap_or_else(|_| panic!("{what}: not within {DEADLINE:?}"))
}

/// The caller: keeps the events, and cancels at the scenario's step.
struct Caller {
    events: Vec<StreamEvent>,
    cancel: CancellationToken,
    on_text: bool,
    discarded: Arc<AtomicBool>,
}

impl AttemptSink for Caller {
    fn event(&mut self, event: StreamEvent) {
        let text = matches!(event, StreamEvent::TextDelta(_));
        self.events.push(event);
        if text && self.on_text {
            self.cancel.cancel();
        }
    }

    fn discard(&mut self) {
        self.events.clear();
        self.discarded.store(true, Ordering::SeqCst);
    }
}

/// The endpoint Node's recorded: each request answered with the status, headers and body Node's endpoint gave it, a held
/// answer held the same way (`head`: nothing; `part`: the head and the bytes, then nothing).
async fn endpoint(recorded: &Recorded) -> Loopback {
    let records = recorded.exchange["records"].as_array().expect("records");
    let hosts: Vec<String> = records.iter().map(|r| url::Url::parse(r["origin"].as_str().expect("origin")).expect("url").host_str().expect("host").to_owned()).collect();
    let loopback = Loopback::start(&hosts.iter().map(String::as_str).collect::<Vec<_>>()).await;
    let http = records
        .iter()
        .map(|r| {
            json!({
                "status": r["status"],
                "headers": r["answerHeaders"],
                "body": r["served"],
                "then": match r["hold"].as_str() { Some("head") => json!("hold"), Some("part") => json!("part"), _ => Value::Null },
            })
        })
        .collect();
    loopback.begin(Script { http, ..Script::default() });
    loopback
}

#[tokio::test]
async fn a_cancelled_claude_send_ends_as_node_ends_it() {
    let names = scenarios("vertex-claude-cancel");
    assert_eq!(names, ["before-first-byte", "mid-stream", "retry-wait"]);
    for name in names {
        let recorded = load("vertex-claude-cancel", &name);
        let loopback = endpoint(&recorded).await;
        let link = Arc::new(ReqwestLink::pinned(&KeepaliveSchedule::SPEC, loopback.addr, loopback.tls.clone()));
        let tapped: Arc<Mutex<Vec<WireRequest>>> = Arc::default();
        let tap = Arc::clone(&tapped);
        // Every request the client sends, HEAD included: Node's Vertex provider runs no socket warm-up, nor does the core's.
        link.tap(Some(Box::new(move |wire: &WireRequest| tap.lock().unwrap().push(wire.clone()))));
        // Node's catalog answers for claude-sonnet-4-6: adaptive thinking with effort, 16k output.
        let caps = Arc::new(|_: &str| {
            Some(ModelCaps {
                adaptive_thinking: true,
                manual_thinking: false,
                ladder_stated: false,
                effort_levels: vec!["low".into(), "medium".into(), "high".into()],
                max_output_tokens: Some(16384),
                fast_mode: false,
                context_window: None,
                thinking_display_updates: false,
            })
        });
        let (adapter, _dir) = built_on(&recorded, link.clone(), Inputs { caps, ..Inputs::default() }).await;
        let admission = Arc::new(Admission::new());
        let lane = admission.lane(&LaneKey::new("vertex-ai".into(), "default"), LaneSettings::default());
        let broker = ModelBroker::new(admission.clone(), Arc::new(StandardRetryDecider));
        let active = || admission.snapshot().iter().map(|lane| lane.active).sum::<usize>();
        let cancel = CancellationToken::new();
        let discarded = Arc::new(AtomicBool::new(false));
        let mut caller = Caller { events: Vec::new(), cancel: cancel.clone(), on_text: name == "mid-stream", discarded: discarded.clone() };
        let send = SendRequest { request: Arc::new(request_of(&recorded)), lane, admission: AdmissionRequest::default() };
        let sent = {
            let mut sending = std::pin::pin!(broker.send(adapter.as_ref(), send, &mut caller, &cancel));
            match name.as_str() {
                "before-first-byte" => {
                    // The held request is the step; a send that ends without making it fails here.
                    within(&format!("{name}: the endpoint holding the request"), async {
                        tokio::select! {
                            sent = &mut sending => panic!("{name}: the send ended ({sent:?}) before the endpoint held its request"),
                            () = loopback.held() => {}
                        }
                    })
                    .await;
                    cancel.cancel();
                    within(&format!("{name}: the cancelled send ending"), sending).await
                }
                "retry-wait" => {
                    // The send is in its retry wait once it is pending after the retry's discard: nothing between the
                    // discard and the broker's wait yields.
                    let early = within(
                        &format!("{name}: the refusal and the retry's discard"),
                        std::future::poll_fn(|cx| match sending.as_mut().poll(cx) {
                            Poll::Ready(sent) => Poll::Ready(Some(sent)),
                            Poll::Pending if discarded.load(Ordering::SeqCst) => Poll::Ready(None),
                            Poll::Pending => Poll::Pending,
                        }),
                    )
                    .await;
                    assert!(early.is_none(), "{name}: the send ended before its retry wait: {early:?}");
                    assert_eq!(active(), 1, "{name}: the send keeps its admission slot through the wait");
                    tokio::time::pause();
                    let at = tokio::time::Instant::now();
                    cancel.cancel();
                    // Under the paused clock a send that does not end lets the clock run to this deadline first.
                    let sent = within(&format!("{name}: the cancelled wait ending"), sending).await;
                    assert_eq!(tokio::time::Instant::now(), at, "{name}: the send ended before the clock moved");
                    tokio::time::resume();
                    sent
                }
                _ => within(&format!("{name}: the send cancelled at its first text"), sending).await,
            }
        };
        assert_eq!(recorded.result["error"]["name"], "AbortError", "{name}: Node's caller got an abort");
        assert!(matches!(sent, Err(SendError::Cancelled)), "{name}: {sent:?}");
        assert_eq!(active(), 0, "{name}: the cancelled send released its admission slot");
        let requests = tapped.lock().unwrap().clone();
        assert_same_requests(&requests, &recorded, &[], &name);
        assert_minted_bearer(&requests, &recorded, &name);
        // The connections the endpoint saw: each held answer's is closed by the client (the peer's end read off the
        // socket), as Node's endpoint saw its own closed (`closedByClient`).
        let conns: Vec<usize> = loopback
            .events()
            .iter()
            .filter(|e| e["kind"] == "http")
            .map(|e| e["conn"].as_u64().expect("conn") as usize)
            .collect();
        let records = recorded.exchange["records"].as_array().expect("records");
        assert_eq!(conns.len(), records.len(), "{name}: requests the endpoint read");
        let mut closed = Vec::new();
        for (conn, record) in conns.iter().zip(records) {
            closed.push(match record["hold"].as_str() {
                Some(_) => {
                    within(&format!("{name}: the client closing connection {conn}"), loopback.closed(*conn, false)).await;
                    Some(true)
                }
                None => None,
            });
        }
        let node_closed: Vec<Option<bool>> = records.iter().map(|r| r["closedByClient"].as_bool()).collect();
        assert_eq!(closed, node_closed, "{name}: connections the client closed");
        assert_same_events(&caller.events, &recorded, &name);
    }
}
