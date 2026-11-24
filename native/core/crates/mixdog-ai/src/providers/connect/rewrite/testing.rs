#![cfg(test)]

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_core_api::domain::provider::Boundary;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_core_api::domain::retry::JitterSamples;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use tokio::time::Instant;

use crate::transport::link::BodyStream;
use crate::transport::link::Exchange;
use crate::transport::link::HttpResponse;
use crate::transport::link::HttpSend;

/// `(wait in seconds, chunk)` in order; after the last one the body stays silent and open.
pub(crate) type Chunks = Vec<(u64, Vec<u8>)>;

struct Timed(VecDeque<(u64, Vec<u8>)>);

#[async_trait]
impl BodyStream for Timed {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        let Some((wait, _)) = self.0.front() else { return std::future::pending().await };
        mixdog_rt::time::sleep(Duration::from_secs(*wait)).await;
        self.0.pop_front().map(|(_, chunk)| Ok(Bytes::from(chunk)))
    }
}

struct Whole(Option<Vec<u8>>);

#[async_trait]
impl BodyStream for Whole {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        self.0.take().map(|body| Ok(Bytes::from(body)))
    }
}

type Unary = Box<dyn Fn(&WireRequest) -> Option<(u16, Vec<u8>)> + Send + Sync>;

/// Answers a request `unary` names at once and whole; every other request is a stream: its head at once, its body the
/// next of `streams` on its timetable (silent when none is left).
pub(crate) struct Paced {
    pub(crate) streamed: Mutex<Vec<WireRequest>>,
    streams: Mutex<VecDeque<Chunks>>,
    unary: Unary,
}

impl Paced {
    pub(crate) fn new(streams: Vec<Chunks>) -> Arc<Self> {
        Self::with_unary(streams, |_| None)
    }

    pub(crate) fn with_unary(streams: Vec<Chunks>, unary: impl Fn(&WireRequest) -> Option<(u16, Vec<u8>)> + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self { streamed: Mutex::new(Vec::new()), streams: Mutex::new(streams.into()), unary: Box::new(unary) })
    }
}

#[async_trait]
impl HttpSend for Paced {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        if let Some((status, body)) = (self.unary)(&request) {
            return Ok(HttpResponse { status, headers: Vec::new(), body: Box::new(Whole(Some(body))) });
        }
        self.streamed.lock().unwrap().push(request);
        let chunks = self.streams.lock().unwrap().pop_front().unwrap_or_default();
        Ok(HttpResponse { status: 200, headers: Vec::new(), body: Box::new(Timed(chunks.into())) })
    }
}

/// What a wire's stall checks expect: a record that carries no output and one that does, the code and window (seconds)
/// of a stream silent before its first byte and of one silent after its first record, and whether the lane's ladder
/// retries them.
pub(crate) struct WireStalls {
    pub(crate) opening: Vec<u8>,
    pub(crate) output: Vec<u8>,
    pub(crate) first_byte: (&'static str, u64),
    pub(crate) mid_body: (&'static str, u64),
    pub(crate) retried: bool,
}

fn sse(record: &serde_json::Value) -> Vec<u8> {
    format!("data: {record}\n\n").into_bytes()
}

/// `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS` in seconds: the window after an OpenAI-compatible stream's first record.
fn first_output_secs() -> u64 {
    crate::providers::first_byte::FirstByteSettings::default().first_output_ms.expect("the stream watchdog is on by default") as u64 / 1000
}

/// Chat Completions: `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (60 s), then `PROVIDER_FIRST_OUTPUT_TIMEOUT_MS` for the first output.
pub(crate) fn chat() -> WireStalls {
    WireStalls {
        opening: sse(&serde_json::json!({ "choices": [{ "index": 0, "delta": { "role": "assistant" } }] })),
        output: sse(&serde_json::json!({ "choices": [{ "index": 0, "delta": { "content": "hi" } }] })),
        first_byte: ("EPROVIDERTIMEOUT", 60),
        mid_body: ("ESTREAMSTALL", first_output_secs()),
        retried: true,
    }
}

/// Responses: the same windows as Chat Completions.
pub(crate) fn responses() -> WireStalls {
    WireStalls {
        opening: sse(&serde_json::json!({ "type": "response.created", "response": { "id": "resp_1", "model": "m" } })),
        output: sse(&serde_json::json!({ "type": "response.output_text.delta", "item_id": "msg_1", "output_index": 0, "content_index": 0, "delta": "hi" })),
        ..chat()
    }
}

/// Messages: no `message_start` within `PROVIDER_FIRST_BYTE_TIMEOUT_MS` (60 s), and `PROVIDER_SSE_IDLE_TIMEOUT_MS` (120 s)
/// of byte silence once it came.
pub(crate) fn messages() -> WireStalls {
    WireStalls {
        opening: concat!(
            "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"claude-sonnet-4-6\",\"usage\":{\"input_tokens\":3,\"output_tokens\":0}}}\n\n",
        )
        .as_bytes()
        .to_vec(),
        output: concat!(
            "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hi\"}}\n\n",
        )
        .as_bytes()
        .to_vec(),
        first_byte: ("EEMPTYSTREAM", 60),
        mid_body: ("ESTREAMSTALL", 120),
        retried: true,
    }
}

fn fresh(request: &ModelRequest) -> ModelRequest {
    let mut request = request.clone();
    request.options.send_identity = SendIdentity::default();
    request
}

/// The failure one send of `request` ends in, and the seconds of the test's clock it took.
async fn failure(adapter: &dyn ProviderAdapter, request: &ModelRequest) -> (ProviderError, u64) {
    let began = Instant::now();
    let failure = match adapter.attempt(Arc::new(fresh(request))).await {
        Err(failure) => failure,
        Ok(mut stream) => loop {
            match stream.next().await.expect("a failure ends the silent stream") {
                Ok(_) => {}
                Err(failure) => break failure,
            }
        },
    };
    (failure, began.elapsed().as_secs())
}

fn assert_retried(adapter: &dyn ProviderAdapter, request: &ModelRequest, failure: &ProviderError, retried: bool) {
    let decision = crate::retry::StandardRetryDecider.verdict(
        failure,
        &RetryState::new(RetryClass::Midstream, request.model.clone()),
        adapter.retry_policy_for(&request.model),
        JitterSamples { step: 0.5, advice: 0.5 },
    );
    assert_eq!(matches!(decision.verdict, Verdict::Retry { .. }), retried, "the lane's ladder on {}", failure.message);
}

/// The three checks of a lane, on the test's clock: `build` makes the lane's adapter over an endpoint that streams the
/// given bodies, and `request` is a turn it serves. A stream silent before its first byte and one silent after its first
/// record each end as the wire's stall after its window, which the lane's ladder retries (a stall after shown output is
/// the loop's to withdraw first); a healthy stream that takes its time reports transport, and the attempt's phases,
/// before its first output.
pub(crate) async fn assert_stalls(build: impl Fn(Vec<Chunks>) -> Arc<dyn ProviderAdapter>, request: &ModelRequest, wire: &WireStalls) {
    let adapter = build(vec![Vec::new()]);
    let (silent, waited) = failure(adapter.as_ref(), request).await;
    assert_eq!((silent.code.as_deref(), waited), (Some(wire.first_byte.0), wire.first_byte.1), "{}", silent.message);
    assert!(silent.timed_out, "{}", silent.message);
    assert_retried(adapter.as_ref(), request, &silent, wire.retried);

    let adapter = build(vec![vec![(0, wire.opening.clone())]]);
    let (stalled, waited) = failure(adapter.as_ref(), request).await;
    assert_eq!((stalled.code.as_deref(), waited), (Some(wire.mid_body.0), wire.mid_body.1), "{}", stalled.message);
    assert!(stalled.timed_out, "{}", stalled.message);
    assert_retried(adapter.as_ref(), request, &stalled, wire.retried);

    let adapter = build(vec![vec![(0, wire.opening.clone()), (50, wire.output.clone())]]);
    let request = fresh(request);
    let identity = request.options.send_identity.clone();
    let read = async {
        let mut stream = adapter.attempt(Arc::new(request)).await.expect("the stream opens");
        while !matches!(stream.next().await.expect("the output comes").expect("a healthy stream"), StreamEvent::TextDelta(_)) {}
    };
    let watch = async {
        mixdog_rt::time::sleep(Duration::from_secs(10)).await;
        (identity.take_transport(), identity.take_published())
    };
    let ((), (transport, published)) = tokio::join!(read, watch);
    assert!(transport, "transport is reported before the first output");
    let boundaries: Vec<Boundary> = published.into_iter().map(|(_, _, boundary)| boundary).collect();
    assert!(boundaries.contains(&Boundary::AttemptStarted) && boundaries.contains(&Boundary::HeadReceived), "{boundaries:?}");
    assert!(!boundaries.contains(&Boundary::FirstSemanticOutput), "{boundaries:?}");
}
