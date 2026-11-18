//! The Gemini API send under the broker, on the paused clock, against a transport that scripts each request's answer and
//! remembers when it arrived and where it went. These are the product's rules, which differ from Node's recording on purpose:
//! a first-byte timeout is retried once and the second one is terminal (no stream attempt, no non-streaming re-issue follows);
//! a payload without output enters the 600 s first-output window of every stream attempt, the stream ladder waits 1, 2 and 4 s
//! between four attempts, one non-streaming `:generateContent` then goes out, and its refusal never replaces the stream's own
//! timeout.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use mixdog_ai::admission::Admission;
use mixdog_ai::admission::AdmissionRequest;
use mixdog_ai::admission::LaneKey;
use mixdog_ai::admission::LaneSettings;
use mixdog_ai::broker::AttemptSink;
use mixdog_ai::broker::ModelBroker;
use mixdog_ai::broker::SendError;
use mixdog_ai::broker::SendRequest;
use mixdog_ai::providers::google::gemini;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_ai::retry::StandardRetryDecider;
use mixdog_ai::transport::BodyStream;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_core_api::domain::provider::WireRequest;
use mixdog_rt::node_log::Channel;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

/// A payload that carries no output (an empty text part).
const QUIET_PAYLOAD: &[u8] = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"\"}]}}]}\n\n";
const FIRST_OUTPUT_WINDOW: &str = "Gemini REST streamGenerateContent first output timed out after 600000ms";

/// One optional chunk, then silence with no end.
struct Silence(Option<Bytes>);

#[async_trait]
impl BodyStream for Silence {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.0.take() {
            Some(chunk) => Some(Ok(chunk)),
            None => std::future::pending().await,
        }
    }
}

struct EmptyBody;

#[async_trait]
impl BodyStream for EmptyBody {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        None
    }
}

/// What a request meets: a streaming one the `stream` body, the non-streaming re-issue `recovery`'s status.
struct Scripted {
    stream: Option<&'static [u8]>,
    recovery_status: u16,
    began: Instant,
    arrivals: Mutex<Vec<(Duration, String)>>,
}

impl Scripted {
    fn new(stream: Option<&'static [u8]>) -> Arc<Self> {
        Arc::new(Self { stream, recovery_status: 503, began: Instant::now(), arrivals: Mutex::default() })
    }

    /// Seconds since the send began and the method the URL names, for each request in arrival order.
    fn seen(&self) -> Vec<(u64, String)> {
        self.arrivals
            .lock()
            .unwrap()
            .iter()
            .map(|(at, url)| {
                let method = url.split(':').next_back().unwrap().split('?').next().unwrap().to_owned();
                (at.as_secs(), method)
            })
            .collect()
    }
}

#[async_trait]
impl HttpSend for Scripted {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        self.arrivals.lock().unwrap().push((self.began.elapsed(), request.url.clone()));
        if request.url.contains(":streamGenerateContent") {
            Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Silence(self.stream.map(Bytes::from_static))) })
        } else {
            Ok(HttpResponse { status: self.recovery_status, headers: vec![], body: Box::new(EmptyBody) })
        }
    }
}

#[derive(Default)]
struct Sink {
    stages: Vec<(String, Option<serde_json::Value>)>,
    text: String,
}

impl AttemptSink for Sink {
    fn event(&mut self, event: StreamEvent) {
        if let StreamEvent::TextDelta(text) = event {
            self.text.push_str(&text);
        }
    }
    fn discard(&mut self) {}
    fn stage(&mut self, stage: &str, payload: Option<serde_json::Value>) {
        self.stages.push((stage.to_owned(), payload));
    }
}

/// `send` of one Gemini API request through the broker: the result, the sink and the lines written to stderr.
async fn send(transport: Arc<dyn HttpSend>) -> (Result<u32, SendError>, Sink, Vec<String>) {
    mixdog_rt::testing::tokens();
    let adapter = gemini("k", transport, Arc::new(CatalogGoogleTraits(Vec::new())));
    let admission = Arc::new(Admission::new());
    let lane = admission.lane(&LaneKey::new("gemini".into(), "default"), LaneSettings::default());
    let broker = ModelBroker::new(admission, Arc::new(StandardRetryDecider));
    let request = Arc::new(ModelRequest {
        model: "gemini-3.6-flash".to_owned(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: vec![],
        options: RequestOptions::default(),
    });
    let (lines, guard) = mixdog_rt::node_log::capture();
    let mut sink = Sink::default();
    let sent = broker
        .send(&adapter, SendRequest { request, lane, admission: AdmissionRequest::default() }, &mut sink, &CancellationToken::new())
        .await;
    drop(guard);
    let stderr = lines.lock().unwrap().iter().filter(|(_, channel, _)| *channel == Channel::Stderr).map(|(_, _, line)| line.clone()).collect();
    (sent, sink, stderr)
}

fn reconnecting(sink: &Sink) -> Vec<&serde_json::Value> {
    sink.stages.iter().filter(|(stage, _)| stage == "reconnecting").map(|(_, payload)| payload.as_ref().expect("a reconnecting payload")).collect()
}

#[tokio::test(start_paused = true)]
async fn a_second_first_byte_timeout_is_terminal_with_no_stream_attempt_or_recovery_after_it() {
    // The head comes at once and no first chunk follows: the 285 s first-byte window, retried once after the stream ladder's first wait.
    let transport = Scripted::new(None);
    let (sent, sink, _) = send(transport.clone()).await;

    assert_eq!(
        transport.seen(),
        [(0, "streamGenerateContent".to_owned()), (286, "streamGenerateContent".to_owned())],
        "the attempt, one retry after 1 s, and nothing after the terminal verdict (no non-streaming re-issue)"
    );
    let Err(SendError::Exhausted(error)) = &sent else { panic!("the send ends exhausted: {sent:?}") };
    assert!(error.message.contains("first byte timed out after 285000ms"), "{error:?}");
    assert!(error.timed_out && error.recovery_terminal && error.should_retry == Some(false), "{error:?}");
    assert_eq!(reconnecting(&sink).len(), 1, "one wait between the two attempts");
    assert!(sink.text.is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_payload_without_output_takes_four_600_second_stream_attempts_then_one_recovery_whose_refusal_does_not_replace_the_timeout() {
    let transport = Scripted::new(Some(QUIET_PAYLOAD));
    let (sent, sink, stderr) = send(transport.clone()).await;

    // Four streaming requests, each expiring at its 600 s window and followed by the wait of 1, 2 and 4 s; then the one recovery.
    let streaming = "streamGenerateContent".to_owned();
    assert_eq!(
        transport.seen(),
        [
            (0, streaming.clone()),
            (601, streaming.clone()),
            (1203, streaming.clone()),
            (1807, streaming),
            (2407, "generateContent".to_owned()),
        ],
        "the requests actually made, when"
    );

    // Precedence: the stream's own timeout, not the recovery's 503, and no recovery line.
    let Err(SendError::Exhausted(error)) = &sent else { panic!("the send ends exhausted: {sent:?}") };
    assert_eq!((error.code.as_deref(), error.message.as_str()), (Some("EGEMINITIMEOUT"), FIRST_OUTPUT_WINDOW));
    assert!(error.timed_out && error.timeout_phase == Some(StreamTimeoutPhase::Idle), "{error:?}");
    assert_ne!(error.status, Some(503), "not the recovery's refusal");
    assert!(sink.text.is_empty());

    // The ladder the user is told about: attempts 2..4 of 4, after 1, 2 and 4 s.
    let ladder: Vec<(u64, u64, u64)> = reconnecting(&sink)
        .iter()
        .map(|p| (p["attempt"].as_u64().unwrap(), p["max"].as_u64().unwrap(), p["waitMs"].as_u64().unwrap()))
        .collect();
    assert_eq!(ladder, [(2, 4, 1_000), (3, 4, 2_000), (4, 4, 4_000)]);
    assert!(reconnecting(&sink).iter().all(|p| p["reason"] == "No progress 10m"));
    let retries: Vec<&String> = stderr.iter().filter(|line| line.contains("retry attempt")).collect();
    let want: Vec<String> = (2..=4).map(|n| format!("[gemini] retry attempt {n} after {FIRST_OUTPUT_WINDOW}")).collect();
    assert_eq!(retries, want.iter().collect::<Vec<_>>());
    assert!(!stderr.iter().any(|line| line.contains("recovered via non-streaming")), "the recovery failed");
}

// ---------------------------------------------------------------------------------------------------------------------
// The other ladders: which failures the connection ladder (ten attempts) retries, which end the send at once, and what
// the stream ladder (four attempts, 1/2/4 s, then one non-streaming request) does after the response opened.
// ---------------------------------------------------------------------------------------------------------------------

/// How a scripted body ends once its chunks are read.
#[derive(Clone, Copy)]
enum End {
    Silence,
    Reset,
    Closed,
}

struct Chunks {
    chunks: std::collections::VecDeque<Bytes>,
    end: End,
}

#[async_trait]
impl BodyStream for Chunks {
    async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
        match self.chunks.pop_front() {
            Some(chunk) => Some(Ok(chunk)),
            None => match self.end {
                End::Silence => std::future::pending().await,
                End::Reset => Some(Err(TransportFault::Reset)),
                End::Closed => None,
            },
        }
    }
}

/// What one request meets.
#[derive(Clone)]
enum Act {
    /// The connection fails before a request byte is written.
    Fail(TransportFault),
    /// A status with its headers and body; a 200 is a stream that ends with the body.
    Status(u16, Vec<(&'static str, &'static str)>, &'static str),
    /// A 200 stream of these chunks, then `End`.
    Stream(Vec<&'static [u8]>, End),
}

/// Request n meets act n; the last act serves every later request. Arrivals are kept as in [`Scripted`].
struct Plan {
    acts: Vec<Act>,
    began: Instant,
    arrivals: Mutex<Vec<(Duration, String)>>,
}

impl Plan {
    fn new(acts: Vec<Act>) -> Arc<Self> {
        Arc::new(Self { acts, began: Instant::now(), arrivals: Mutex::default() })
    }

    /// Whole seconds since the send began and the method each request names, in arrival order.
    fn seen(&self) -> Vec<(u64, String)> {
        self.arrivals
            .lock()
            .unwrap()
            .iter()
            .map(|(at, url)| (at.as_secs(), url.split(':').next_back().unwrap().split('?').next().unwrap().to_owned()))
            .collect()
    }
}

#[async_trait]
impl HttpSend for Plan {
    async fn send(&self, request: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        let n = {
            let mut arrivals = self.arrivals.lock().unwrap();
            arrivals.push((self.began.elapsed(), request.url.clone()));
            arrivals.len() - 1
        };
        match self.acts[n.min(self.acts.len() - 1)].clone() {
            Act::Fail(fault) => Err(ProviderError::transport(fault, DeliveryState::NotSent)),
            Act::Status(status, headers, body) => Ok(HttpResponse {
                status,
                headers: headers.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect(),
                body: Box::new(Chunks { chunks: [Bytes::from_static(body.as_bytes())].into(), end: End::Closed }),
            }),
            Act::Stream(chunks, end) => {
                Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(Chunks { chunks: chunks.into_iter().map(Bytes::from_static).collect(), end }) })
            }
        }
    }
}

const OVERLOADED: &str = r#"{"error":{"code":503,"message":"The model is overloaded. Please try again later.","status":"UNAVAILABLE"}}"#;
const RECOVERY_REFUSED: &str = r#"{"error":{"code":503,"message":"the non-streaming request was refused","status":"UNAVAILABLE"}}"#;
const BAD_REQUEST: &str =r#"{"error":{"code":400,"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}"#;
const RATE_LIMITED: &str = r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#;
const SHOWN_TEXT: &[u8] = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"hello\"}]}}]}\n\n";
const FINISHED: &[u8] = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"done\"}]},\"finishReason\":\"STOP\"}]}\n\n";
const IN_BAND_ERROR: &[u8] = b"data: {\"error\":{\"code\":503,\"message\":\"The model is overloaded.\",\"status\":\"UNAVAILABLE\"}}\n\n";

/// The jitter draws of a send: one (`step`, `advice`) pair per retry decision, each the midpoint of its range, so every
/// wait is the schedule's own; `ending` adds the draw of the verdict that ends a ladder, which carries no wait.
fn exact_waits(decisions: usize, advice: f64, ending: bool) -> Vec<(f64, f64)> {
    let mut draws = vec![(0.5, advice); decisions];
    if ending {
        draws.push((f64::NAN, f64::NAN));
    }
    draws
}

/// The ladder of the connection phase: ten attempts, the waits before the 2nd to the 10th 5, 10, 20, 30 and then 30 s.
const CONNECTION_ARRIVALS: [u64; 10] = [0, 5, 15, 35, 65, 95, 125, 155, 185, 215];

#[tokio::test(start_paused = true)]
async fn a_request_that_never_opens_is_asked_ten_times_on_the_connection_ladder_and_then_fails_with_its_own_error() {
    for (what, act, check) in [
        ("a refused connection", Act::Fail(TransportFault::Connect { os_code: None }), 0),
        ("a reset handshake", Act::Fail(TransportFault::Reset), 0),
        ("a 503", Act::Status(503, vec![], OVERLOADED), 503),
    ] {
        mixdog_ai::random::script_jitter(exact_waits(9, 0.5, true));
        let transport = Plan::new(vec![act]);
        let (sent, sink, _) = send(transport.clone()).await;
        mixdog_ai::random::script_jitter(Vec::new());

        let streaming = "streamGenerateContent".to_owned();
        let want: Vec<(u64, String)> = CONNECTION_ARRIVALS.iter().map(|at| (*at, streaming.clone())).collect();
        assert_eq!(transport.seen(), want, "{what}: ten requests, no non-streaming re-issue (the response never opened)");
        let Err(SendError::Exhausted(error)) = &sent else { panic!("{what}: the send ends exhausted: {sent:?}") };
        match check {
            0 => assert!(error.transport.is_some() && error.status.is_none(), "{what}: the transport's own failure: {error:?}"),
            status => assert_eq!(error.status, Some(status), "{what}: the server's own status: {error:?}"),
        }
        let ladder: Vec<(u64, u64, u64)> = reconnecting(&sink)
            .iter()
            .map(|p| (p["attempt"].as_u64().unwrap(), p["max"].as_u64().unwrap(), p["waitMs"].as_u64().unwrap()))
            .collect();
        let waits = [5_000, 10_000, 20_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
        let want: Vec<(u64, u64, u64)> = waits.iter().enumerate().map(|(i, wait)| (i as u64 + 2, 10, *wait)).collect();
        assert_eq!(ladder, want, "{what}: the stages the user is shown");
        assert!(sink.text.is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn a_400_is_not_retried_and_a_429_waits_for_the_server_advice_when_it_is_longer_than_the_ladder_step() {
    // A refused request is the caller's to fix: one request, the server's status.
    mixdog_ai::random::script_jitter(exact_waits(4, 0.0, false));
    let transport = Plan::new(vec![Act::Status(400, vec![], BAD_REQUEST)]);
    let (sent, sink, _) = send(transport.clone()).await;
    assert_eq!(transport.seen(), [(0, "streamGenerateContent".to_owned())]);
    let Err(error) = &sent else { panic!("a 400 fails the send") };
    assert!(matches!(error, SendError::Provider(e) if e.status == Some(400)), "{error:?}");
    assert!(reconnecting(&sink).is_empty());

    // `Retry-After: 12` is longer than the first step (5 s): the retry comes after 12 s, and the answer is the retry's.
    mixdog_ai::random::script_jitter(exact_waits(4, 0.0, false));
    let transport = Plan::new(vec![Act::Status(429, vec![("retry-after", "12")], RATE_LIMITED), Act::Stream(vec![FINISHED], End::Closed)]);
    let (sent, sink, _) = send(transport.clone()).await;
    mixdog_ai::random::script_jitter(Vec::new());
    assert!(sent.is_ok(), "{sent:?}");
    assert_eq!(transport.seen(), [(0, "streamGenerateContent".to_owned()), (12, "streamGenerateContent".to_owned())]);
    assert_eq!(sink.text, "done");
    assert_eq!(reconnecting(&sink).iter().map(|p| p["waitMs"].as_u64().unwrap()).collect::<Vec<_>>(), [12_000]);

    // A wait over 300 s ends recovery: the server's own refusal, after one request.
    mixdog_ai::random::script_jitter(exact_waits(4, 0.0, false));
    let transport = Plan::new(vec![Act::Status(429, vec![("retry-after", "301")], RATE_LIMITED)]);
    let (sent, _, _) = send(transport.clone()).await;
    mixdog_ai::random::script_jitter(Vec::new());
    assert_eq!(transport.seen().len(), 1, "{:?}", transport.seen());
    let Err(SendError::Provider(error) | SendError::Exhausted(error)) = &sent else { panic!("the send ends with the server's refusal: {sent:?}") };
    assert_eq!(error.status, Some(429));
}

#[tokio::test(start_paused = true)]
async fn a_stream_that_fails_after_it_opened_is_asked_four_times_at_1_2_and_4_seconds_then_once_without_streaming() {
    for (what, body) in [
        ("an in-band error event", vec![IN_BAND_ERROR]),
        ("a reset after a payload that carried no output", vec![QUIET_PAYLOAD]),
        ("a reset before any payload", vec![]),
    ] {
        let transport = Plan::new(vec![Act::Stream(body, End::Reset), Act::Stream(vec![IN_BAND_ERROR], End::Reset)]);
        // Every attempt meets the same failure; the recovery's 503 never replaces the stream's own error.
        let transport = Plan::new({
            let mut acts = vec![transport.acts[0].clone(); 4];
            acts.push(Act::Status(503, vec![], RECOVERY_REFUSED));
            acts
        });
        let (sent, sink, _) = send(transport.clone()).await;
        let streaming = "streamGenerateContent".to_owned();
        assert_eq!(
            transport.seen(),
            [(0, streaming.clone()), (1, streaming.clone()), (3, streaming.clone()), (7, streaming), (7, "generateContent".to_owned())],
            "{what}: four stream attempts after waits of 1, 2 and 4 s, then the one non-streaming request"
        );
        assert!(matches!(&sent, Err(SendError::Exhausted(error)) if !error.message.contains("non-streaming request was refused")), "{what}: the stream's own error, not the recovery's: {sent:?}");
        let ladder: Vec<(u64, u64, u64)> = reconnecting(&sink)
            .iter()
            .map(|p| (p["attempt"].as_u64().unwrap(), p["max"].as_u64().unwrap(), p["waitMs"].as_u64().unwrap()))
            .collect();
        assert_eq!(ladder, [(2, 4, 1_000), (3, 4, 2_000), (4, 4, 4_000)], "{what}");
        assert!(sink.text.is_empty(), "{what}");
    }
}

#[tokio::test(start_paused = true)]
async fn a_reset_after_text_was_shown_surfaces_at_once_and_the_text_stays() {
    let transport = Plan::new(vec![Act::Stream(vec![SHOWN_TEXT], End::Reset)]);
    let (sent, sink, _) = send(transport.clone()).await;
    assert_eq!(transport.seen(), [(0, "streamGenerateContent".to_owned())], "no retry and no re-issue once output was shown");
    assert!(sent.is_err(), "{sent:?}");
    assert_eq!(sink.text, "hello", "what was shown is kept");
    assert!(reconnecting(&sink).is_empty());
}
