//! The mid-stream idle window of the Anthropic, OpenAI and OpenAI-compatible streams (`anthropic-sse-watchdogs.mjs`
//! `resetIdleTimer`, `openai-http-sse-watchdogs.mjs` and `openai-ws-stream.mjs` `armSemanticIdle`,
//! `nextAsyncWithWatchdog`), on the runtime's clock ([`mixdog_rt::Deadline`]). The window comes from
//! [`policy`](crate::providers::google::cache::policy) (`sse_idle_ms`, `semantic_idle_ms`, `ws_semantic_idle_ms`), which is
//! `None` when `MIXDOG_ENABLE_STREAM_WATCHDOG` turns the watchdog off: a stream then reads without a bound, as in Node.
//!
//! The window is not running until the stream first arms it with [`IdleWatch::rearm`] (before that the first-byte windows
//! bound the stream), and every later `rearm` starts it again; each family decides which reads re-arm it.
//! A read that outlives it fails the stream with `StreamStalledError` (`streamStalledError`, `stall-policy.mjs:161`):
//! `ESTREAMSTALL`, transient, phase `idle`, unsafe to retry once a tool call was dispatched.

use std::future::Future;
use std::time::Duration;

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Exposure;
use mixdog_core_api::domain::provider::ProgressKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::StreamTimeoutPhase;
use mixdog_rt::Deadline;

/// One stream's idle window.
pub(crate) struct IdleWatch {
    window: Option<Duration>,
    label: String,
    deadline: Option<Deadline>,
    /// The logical request's first-output window (`first-output`, `stall-policy.mjs`): its state lives with the request, so
    /// every attempt joins the same deadline. `first_pending`: the running deadline is that one; only output ends it.
    first: Option<(SendIdentity, Duration)>,
    first_pending: bool,
}

impl IdleWatch {
    /// A stream with no idle bound.
    pub(crate) fn off() -> Self {
        Self { window: None, label: String::new(), deadline: None, first: None, first_pending: false }
    }

    /// A stream bounded by `window_ms` (`None`: the watchdog is off), whose stall names `label`.
    pub(crate) fn new(window_ms: Option<f64>, label: impl Into<String>) -> Self {
        Self { window: window_ms.map(|ms| Duration::from_millis(ms as u64)), label: label.into(), deadline: None, first: None, first_pending: false }
    }

    /// Bounds the wait for the first output of `request` by `first_ms`: a model may think silently longer than the idle
    /// window, but not for ever. Takes effect at [`Self::arm_first`].
    pub(crate) fn with_first(mut self, request: &SendIdentity, first_ms: f64) -> Self {
        self.first = Some((request.clone(), Duration::from_millis(first_ms as u64)));
        self
    }

    /// Joins the request's first-output window (idle with the watchdog off), or, once the request had output, runs under
    /// the idle window from the stream's opening.
    pub(crate) fn arm_first(&mut self) {
        let (Some((request, first)), Some(_)) = (&self.first, self.window) else { return };
        let (deadline, seen) = request.first_output(*first);
        if seen {
            self.rearm();
        } else {
            self.deadline = Some(deadline);
            self.first_pending = true;
        }
    }

    /// Starts the window again from now.
    pub(crate) fn rearm(&mut self) {
        self.first_pending = false;
        self.deadline = self.window.map(Deadline::after);
    }

    /// Starts the window again when `events` carry output (text, reasoning, tool deltas), or, once output started it,
    /// an item boundary (`meaningful()` / `lifecycle()`, `openai-oauth-http-sse.mjs`; `reportLifecycle`,
    /// `openai-compat-stream.mjs`). Keepalives and metadata never do: before the first output a model may think silently
    /// longer than the window.
    pub(crate) fn note(&mut self, events: &[StreamEvent]) {
        let armed = self.deadline.is_some() && !self.first_pending;
        let produced = events.iter().any(output);
        if produced && let Some((request, _)) = &self.first {
            request.note_output();
        }
        if produced || (armed && events.iter().any(boundary)) {
            self.rearm();
        }
    }

    /// `read`, or `Err` when the window ended first.
    pub(crate) async fn read<T>(&self, read: impl Future<Output = T>) -> Result<T, Stalled> {
        match self.deadline {
            Some(deadline) => deadline.bound(read).await.ok_or(Stalled),
            None => Ok(read.await),
        }
    }

    /// `streamStalledError(label, timeoutMs, { emittedToolCall })`.
    pub(crate) fn stalled(&self, exposure: Exposure) -> ProviderError {
        let mut err = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        err.code = Some("ESTREAMSTALL".into());
        let window = if self.first_pending { self.first.as_ref().map(|(_, first)| *first).or(self.window) } else { self.window }.unwrap_or_default();
        err.message = format!("{} stream timed out after {}ms of inactivity", self.label, window.as_millis());
        mixdog_rt::node_stderr!("[provider-stall] {} (tool dispatched: {})", err.message, exposure.tool_dispatched);
        err.timed_out = true;
        err.timeout_phase = Some(StreamTimeoutPhase::Idle);
        err.exposure = exposure;
        err.unsafe_to_retry = exposure.tool_dispatched;
        err
    }
}

/// The read outlived the idle window.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Stalled;

/// Model output: a text, reasoning or tool delta, or the progress a decoder reports for one.
fn output(event: &StreamEvent) -> bool {
    matches!(
        event,
        StreamEvent::TextDelta(_)
            | StreamEvent::ReasoningDelta(_)
            | StreamEvent::ToolCallStart { .. }
            | StreamEvent::ToolCallArgsDelta { .. }
            | StreamEvent::ToolCallDone(_)
            | StreamEvent::Progress(ProgressKind::Text | ProgressKind::Reasoning | ProgressKind::Tool)
    )
}

/// An item boundary: progress only after output.
fn boundary(event: &StreamEvent) -> bool {
    matches!(event, StreamEvent::ItemStart { .. } | StreamEvent::Progress(ProgressKind::Semantic))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::google::cache::policy;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| (*value).to_owned())
    }

    #[test]
    fn one_reader_turns_the_watchdog_off_for_every_family() {
        for off in ["0", "false", "no", "off"] {
            let get = move |name: &str| (name == "MIXDOG_ENABLE_STREAM_WATCHDOG").then(|| off.to_owned());
            assert!(!policy::stream_watchdog_enabled(&get), "{off}");
            assert_eq!(policy::semantic_idle_ms(get), None, "compat and the OpenAI HTTP stream: {off}");
            assert_eq!(policy::sse_idle_ms(get), None, "Anthropic: {off}");
            assert_eq!(policy::ws_semantic_idle_ms(get), None, "the OpenAI WebSocket: {off}");
        }
        for on in [None, Some(""), Some("1"), Some("true"), Some("yes")] {
            let get = move |name: &str| (name == "MIXDOG_ENABLE_STREAM_WATCHDOG").then(|| on.map(str::to_owned)).flatten();
            assert!(policy::stream_watchdog_enabled(&get), "{on:?}");
            assert_eq!(policy::semantic_idle_ms(get), Some(300_000.0), "{on:?}");
            assert_eq!(policy::sse_idle_ms(get), Some(120_000.0), "{on:?}");
            assert_eq!(policy::ws_semantic_idle_ms(get), Some(300_000.0), "{on:?}");
        }
    }

    #[test]
    fn the_windows_read_their_node_variables() {
        let get = env(&[
            ("MIXDOG_PROVIDER_SSE_IDLE_TIMEOUT_MS", "45000"),
            ("MIXDOG_PROVIDER_WS_OUTPUT_IDLE_TIMEOUT_MS", "20000"),
        ]);
        assert_eq!(policy::sse_idle_ms(&get), Some(45_000.0));
        assert_eq!(policy::semantic_idle_ms(&get), Some(45_000.0), "the semantic window falls back to the SSE variable");
        assert_eq!(policy::ws_semantic_idle_ms(&get), Some(20_000.0));
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_read_stalls_after_the_window_and_only_once_armed() {
        let mut watch = IdleWatch::new(Some(15_000.0), "Anthropic SSE");
        assert_eq!(watch.read(async { 1 }).await, Ok(1), "unarmed reads are unbounded");
        watch.rearm();
        assert_eq!(watch.read(async { 2 }).await, Ok(2));
        let outcome = watch.read(std::future::pending::<()>()).await;
        assert_eq!(outcome, Err(Stalled));
        let err = watch.stalled(Exposure { tool_dispatched: true, ..Exposure::default() });
        assert_eq!(err.code.as_deref(), Some("ESTREAMSTALL"));
        assert_eq!(err.message, "Anthropic SSE stream timed out after 15000ms of inactivity");
        assert!(err.timed_out && err.unsafe_to_retry);
        assert_eq!(err.timeout_phase, Some(StreamTimeoutPhase::Idle));
    }

    #[tokio::test(start_paused = true)]
    async fn a_watch_with_no_window_never_stalls() {
        let mut watch = IdleWatch::new(None, "x");
        watch.rearm();
        let slow = async {
            mixdog_rt::time::sleep(Duration::from_secs(10_000)).await;
            7
        };
        assert_eq!(watch.read(slow).await, Ok(7));
    }

    #[tokio::test(start_paused = true)]
    async fn output_starts_the_window_and_item_boundaries_only_follow_it() {
        let boundary = || StreamEvent::Progress(ProgressKind::Semantic);
        let mut watch = IdleWatch::new(Some(15_000.0), "x");
        watch.note(&[StreamEvent::ProviderKeepalive, boundary()]);
        assert!(watch.deadline.is_none(), "keepalives and an item boundary before output start nothing");
        watch.note(&[StreamEvent::ProviderKeepalive, StreamEvent::TextDelta("a".into())]);
        let first = watch.deadline.expect("output starts the window");
        mixdog_rt::time::sleep(Duration::from_secs(1)).await;
        watch.note(&[StreamEvent::ProviderKeepalive]);
        assert_eq!(watch.deadline, Some(first), "a keepalive does not move it");
        watch.note(&[boundary()]);
        assert!(watch.deadline > Some(first), "after output an item boundary does");
    }

    #[tokio::test(start_paused = true)]
    async fn a_retry_keeps_the_logical_requests_first_output_deadline() {
        let boundary = || StreamEvent::Progress(ProgressKind::Semantic);
        let request = SendIdentity::default();
        let began = tokio::time::Instant::now();
        let mut first = IdleWatch::new(Some(15_000.0), "Responses WS").with_first(&request, 100_000.0);
        first.arm_first();
        first.note(&[StreamEvent::ProviderKeepalive, boundary()]);
        mixdog_rt::time::sleep(Duration::from_secs(60)).await;
        // The attempt failed; the retry opens a new stream for the same request.
        let mut retry = IdleWatch::new(Some(15_000.0), "Responses WS").with_first(&request, 100_000.0);
        retry.arm_first();
        assert_eq!(retry.read(std::future::pending::<()>()).await, Err(Stalled));
        assert_eq!(began.elapsed(), Duration::from_secs(100), "the retry did not restart the window");
        assert_eq!(retry.stalled(Exposure::default()).message, "Responses WS stream timed out after 100000ms of inactivity");
        let mut off = IdleWatch::new(None, "x").with_first(&request, 1.0);
        off.arm_first();
        assert!(off.deadline.is_none(), "the watchdog switched off bounds nothing");
    }

    #[tokio::test(start_paused = true)]
    async fn a_request_that_had_output_runs_its_retries_under_the_idle_window() {
        let request = SendIdentity::default();
        let mut first = IdleWatch::new(Some(15_000.0), "x").with_first(&request, 100_000.0);
        first.arm_first();
        mixdog_rt::time::sleep(Duration::from_secs(50)).await;
        first.note(&[StreamEvent::TextDelta("a".into())]);
        let mut retry = IdleWatch::new(Some(15_000.0), "x").with_first(&request, 100_000.0);
        retry.arm_first();
        let began = tokio::time::Instant::now();
        assert_eq!(retry.read(std::future::pending::<()>()).await, Err(Stalled));
        assert_eq!(began.elapsed(), Duration::from_secs(15));
    }
    #[test]
    fn the_ping_variables_move_the_websocket_schedule_and_nothing_else() {
        let base = mixdog_core_api::domain::keepalive::KeepaliveSchedule::SPEC.ws;
        assert_eq!(policy::ws_ping(|_| None, base), base);
        let tuned = policy::ws_ping(env(&[("MIXDOG_PROVIDER_WS_PING_INTERVAL_MS", "12000"), ("MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS", "3000")]), base);
        assert_eq!((tuned.interval, tuned.timeout, tuned.while_idle), (Duration::from_secs(12), Duration::from_secs(3), base.while_idle));
        let floor = policy::ws_ping(env(&[("MIXDOG_PROVIDER_WS_PING_INTERVAL_MS", "10"), ("MIXDOG_PROVIDER_WS_PONG_TIMEOUT_MS", "999999")]), base);
        assert_eq!((floor.interval, floor.timeout), (Duration::from_secs(5), Duration::from_secs(60)));
    }
}

/// What the stream tests of the three families script: a body that delivers chunks on a timetable and then stays silent,
/// and a decoder that turns `k` into a keepalive and any other chunk into text.
#[cfg(test)]
pub(crate) mod testing {
    use std::collections::VecDeque;
    use std::time::Duration;

    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::Exposure;
    use mixdog_core_api::domain::provider::ProviderError;
    use mixdog_core_api::domain::provider::StreamEvent;
    use mixdog_core_api::domain::provider::TransportFault;
    use mixdog_core_api::domain::provider::WireDecoder;

    use crate::transport::link::BodyStream;

    /// `(wait, chunk)` in order, then no more bytes and no end.
    pub(crate) struct Timetable(VecDeque<(Duration, &'static str)>);

    impl Timetable {
        pub(crate) fn of(items: &[(u64, &'static str)]) -> Box<Self> {
            Box::new(Self(items.iter().map(|(secs, chunk)| (Duration::from_secs(*secs), *chunk)).collect()))
        }
    }

    #[async_trait]
    impl BodyStream for Timetable {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            match self.0.front().copied() {
                Some((wait, chunk)) => {
                    mixdog_rt::time::sleep(wait).await;
                    self.0.pop_front();
                    Some(Ok(Bytes::from_static(chunk.as_bytes())))
                }
                None => std::future::pending().await,
            }
        }
    }

    pub(crate) struct Echo;

    impl WireDecoder for Echo {
        fn feed(&mut self, unit: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
            Ok(match unit {
                b"" => Vec::new(),
                b"k" => vec![StreamEvent::ProviderKeepalive],
                _ => vec![StreamEvent::TextDelta("t".into())],
            })
        }

        fn finish(&mut self) -> Result<Vec<StreamEvent>, ProviderError> {
            Ok(Vec::new())
        }

        fn terminal_seen(&self) -> bool {
            false
        }

        fn exposure(&self) -> Exposure {
            Exposure::default()
        }
    }
}
