use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RetryLine;
use mixdog_core_api::domain::provider::RetryLineStyle;
use mixdog_core_api::domain::provider::SendEnd;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::retry::RetryClass;
use mixdog_core_api::domain::retry::RetryDecider;
use mixdog_core_api::domain::retry::RetryState;
use mixdog_core_api::domain::retry::Verdict;
use tokio_util::sync::CancellationToken;

use crate::admission::Admission;
use crate::admission::AdmissionError;
use crate::admission::AdmissionRequest;
use crate::admission::Lane;
use crate::admission::Outcome;
use crate::admission::RunLiveness;
use crate::retry::random_samples;

/// Receives the events of the current attempt. `discard` tells it that the
/// attempt failed and a retry begins: deltas are hints, and everything the
/// failed attempt showed must be dropped.
pub trait AttemptSink: Send {
    fn event(&mut self, event: StreamEvent);
    fn discard(&mut self);
    /// A retried attempt the provider still billed (`noteAbandonedUsage`):
    /// the usage its failure reported (`ProviderError::partial_usage`). Called
    /// before `discard` on a retry, or once a terminal unary refusal supersedes
    /// the discarded stream's failure. `model` is the served model when known;
    /// `None` means the send's own. The default ignores it; the accounting sink
    /// records it as `<requestId>:abandoned:<i>`.
    fn abandoned(&mut self, _usage: &Usage, _model: Option<&str>) {}
    /// A display-only stage of the send (`onStageChange(stage, payload)`): `requesting` where the provider raises it,
    /// `reconnecting` with its payload before each retry wait. The default ignores it.
    fn stage(&mut self, _stage: &str, _payload: Option<serde_json::Value>) {}
}

pub struct SendRequest {
    pub request: Arc<ModelRequest>,
    pub lane: Arc<Lane>,
    pub admission: AdmissionRequest,
}

#[derive(Debug)]
pub enum SendError {
    Admission(AdmissionError),
    Cancelled,
    /// The verdict surfaced the error.
    Provider(ProviderError),
    /// Retries are spent.
    Exhausted(ProviderError),
    /// Repeated overload: send again with `model`.
    Fallback {
        model: String,
        last: ProviderError,
    },
}

pub struct ModelBroker {
    admission: Arc<Admission>,
    decider: Arc<dyn RetryDecider>,
}

impl ModelBroker {
    pub fn new(admission: Arc<Admission>, decider: Arc<dyn RetryDecider>) -> Self {
        Self { admission, decider }
    }

    pub fn admission(&self) -> &Arc<Admission> {
        &self.admission
    }

    /// Runs the request to its terminal event. Returns the attempts made.
    ///
    /// A failure before any event of the attempt counts against the policy's
    /// `request` row, a later one against `midstream`; for a provider whose
    /// ladder goes by the connection ([`SendStages::ladder_by_connection`]) a
    /// failure before the attempt's stream opened is the `request` row's and
    /// one after it the `midstream` row's, each stream attempt under a fresh
    /// `request` row. Each row keeps its own state across attempts. A provider
    /// that raises `reconnecting` ([`SendStages::reconnecting`]) gets it before
    /// each retry wait. Each attempt holds a slot of the account's lane; a retry's
    /// wait holds none, and the next attempt queues for a slot again, behind the
    /// lane's shared cooldown and in its fair order.
    ///
    /// [`SendStages::ladder_by_connection`]: mixdog_core_api::domain::provider::SendStages::ladder_by_connection
    /// [`SendStages::reconnecting`]: mixdog_core_api::domain::provider::SendStages::reconnecting
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn send(
        &self,
        adapter: &dyn ProviderAdapter,
        mut send: SendRequest,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
    ) -> Result<u32, SendError> {
        // Images are made fit for the provider at the provider boundary (`registry::image_guard`), under every attempt of
        // every caller, not here.
        if send.request.options.send_group.is_some() {
            return self.run(adapter, send, sink, cancel).await;
        }
        // Node's proxy calls the provider's one send, which holds its queue slot and its measurement across the inner
        // retries: the attempts of this send are one send group, and the guard ends it on every exit.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = format!("broker-{}", NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        let mut request = (*send.request).clone();
        request.options.send_group = Some(id.clone());
        send.request = Arc::new(request);
        let mut group = Group { adapter, id, open: true };
        let result = self.run(adapter, send, sink, cancel).await;
        group.open = false;
        match &result {
            Ok(_) => adapter.release_send(&group.id),
            Err(SendError::Cancelled) => adapter.settle_send(&group.id, SendEnd::Cancelled).await,
            Err(_) => adapter.settle_send(&group.id, SendEnd::Surfaced).await,
        }
        result
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn run(
        &self,
        adapter: &dyn ProviderAdapter,
        mut send: SendRequest,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
    ) -> Result<u32, SendError> {
        // One identity per send, shared by its attempts: the ids Node mints per `send` call are minted from it.
        Arc::make_mut(&mut send.request).options.send_identity = Default::default();
        let mut permit = self.capacity(&send, 1, cancel).await?;
        let model = send.request.model.clone();
        let mut request_state = RetryState::new(RetryClass::Request, model.clone());
        let mut midstream_state = RetryState::new(RetryClass::Midstream, model.clone());
        let mut attempts = 0;
        let liveness = permit.liveness().cloned();
        adapter.prepare_send(&send.request).await;
        trace(&send.request, 1, "request-prepared", format_args!("model={model}"));
        let mut stages = adapter.send_stages_of(&send.request);
        for _ in 0..stages.preparing {
            sink.stage("requesting", None);
        }
        loop {
            attempts += 1;
            if stages.each_attempt {
                sink.stage("requesting", None);
            }
            if stages.model_thinking {
                sink.stage("model_thinking", None);
            }
            // A request beginning is the run's doing: the lease measures the
            // silence after it.
            if let Some(liveness) = &liveness {
                liveness.progress();
            }
            let mut streamed = false;
            send.request.options.send_identity.begin_submission();
            let failure = match mixdog_rt::node_log::provider_work(
                log_identity(&send.request, attempts),
                "prepared",
                self.attempt(adapter, &send.request, sink, cancel, (&mut streamed, stages.ladder_by_connection), liveness.as_deref()),
            )
            .await
            {
                Ok(()) => {
                    permit.finish(Outcome::Success);
                    return Ok(attempts);
                }
                Err(Stop::Cancelled) => {
                    permit.finish(Outcome::Abandoned);
                    return Err(SendError::Cancelled);
                }
                Err(Stop::Failed(err)) => err,
            };
            // A gateway knows the wire a send goes out on only once an attempt did: its stages follow it.
            stages = adapter.send_stages_of(&send.request);
            if failure.status == Some(429) {
                permit.report_rate_limit(failure.retry_after);
            }
            let (state, class) = if streamed {
                // The stream is issued anew: a provider that raises `requesting` once per ladder raises it again.
                send.request.options.send_identity.reissue();
                (&mut midstream_state, RetryClass::Midstream)
            } else {
                (&mut request_state, RetryClass::Request)
            };
            let policy = adapter.retry_policy_of(&send.request);
            let decision = self.decider.verdict(&failure, &state.at_elapsed(send.request.options.send_identity.elapsed()), policy, random_samples());
            let attempt = decision.next.count(None).retries + 1;
            *state = decision.next;
            // `runGeminiStreamAttempts` marks every failure after its stream opened as its connection ladder's spent
            // one (`gemini-retry-policy.mjs:151`), whether or not the stream ladder re-issues it.
            let exhausted = matches!(decision.verdict, Verdict::Exhausted) || failure.recovery_exhausted || (streamed && stages.ladder_by_connection);
            let end = |permit: crate::admission::Permit, error: ProviderError| {
                permit.finish(Outcome::Failure { status: error.status, retry_after: error.retry_after });
                error
            };
            match decision.verdict {
                Verdict::Retry { delay, reason, .. } => {
                    let mut max = policy.row(class).map_or(0, |row| row.schedule.max_retries) + 1;
                    let line = adapter.retry_line_of(&send.request);
                    // The Anthropic API's mid-stream ladder counts retries (`retry 1/3`), where a refused request counts
                    // the attempt about to run (`emitProviderRetryStage`).
                    let midstream_ladder = streamed && line.as_ref().is_some_and(|line| line.style == RetryLineStyle::AnthropicApi);
                    let mut attempt = attempt;
                    if midstream_ladder {
                        attempt -= 1;
                        max -= 1;
                    }
                    if stages.reconnecting {
                        sink.stage("reconnecting", Some(crate::retry::stage::reconnecting(&failure, attempt, max, delay, crate::wall::now_ms())));
                    }
                    if let Some(line) = line {
                        write_retry_line(&line, &failure, (attempt, max), delay, midstream_ladder);
                    }
                    if let Some(usage) = &failure.partial_usage {
                        sink.abandoned(usage, failure.partial_model.as_deref());
                    }
                    sink.discard();
                    trace(
                        &send.request,
                        attempts,
                        "retry-scheduled",
                        format_args!(
                            "delay_ms={} reason={reason:?} status={}",
                            delay.as_millis(),
                            failure.status.map_or_else(|| "-".to_owned(), |s| s.to_string())
                        ),
                    );
                    // The wait holds no capacity: the slot goes back to the lane for it, and the next attempt queues for one
                    // again behind the lane's shared cooldown and its fair order, like any other send.
                    let reported = permit.suspend();
                    if !pause(delay, cancel).await {
                        return Err(SendError::Cancelled);
                    }
                    permit = self.capacity(&send, attempts + 1, cancel).await?;
                    permit.carry_rate_limit(reported);
                }
                // A ladder that goes by the connection re-issues only a stream that opened (`runGeminiStreamAttempts`);
                // the Chat Completions send re-issues whatever its ladder ended on (`recoverCompatNonStreaming`).
                Verdict::Surface | Verdict::Exhausted
                    if !failure.unsafe_to_retry
                        && !failure.exposure.text_emitted
                        && !failure.exposure.tool_dispatched
                        && !failure.exposure.tool_input_cut
                        && (streamed || !stages.ladder_by_connection)
                        && !cancel.is_cancelled()
                        && adapter.recovers_spent(&model, &failure) =>
                {
                    // The provider's last re-issue of a stream that died with nothing shown. The ladder's error
                    // still surfaces unless the adapter marks the unary answer as terminal.
                    if stages.before_recovery {
                        sink.stage("requesting", None);
                    }
                    sink.discard();
                    match mixdog_rt::node_log::provider_work(
                        log_identity(&send.request, attempts + 1),
                        "recovering",
                        self.recovered(adapter, &send.request, sink, cancel, liveness.as_deref()),
                    )
                    .await
                    {
                        Ok(()) => {
                            permit.finish(Outcome::Success);
                            // The dead stream's text repeats what the endpoint answered, as the retry line's does.
                            let cause =
                                crate::oauth::carried::remembered().redact_str(failure.code.as_deref().filter(|c| !c.is_empty()).unwrap_or(&failure.message));
                            match adapter.recovery_line(&model, &failure) {
                                Some(line) => mixdog_rt::node_stderr!("{line}"),
                                None => mixdog_rt::node_stderr!("[gemini] stream failed ({cause}); recovered via non-streaming generateContent"),
                            }
                            return Ok(attempts + 1);
                        }
                        Err(Stop::Cancelled) => {
                            permit.finish(Outcome::Abandoned);
                            return Err(SendError::Cancelled);
                        }
                        Err(Stop::Failed(error)) if error.recovery_terminal => {
                            // Only abandon the stream's usage once its error is no longer the one being settled.
                            if let Some(usage) = &failure.partial_usage {
                                sink.abandoned(usage, failure.partial_model.as_deref());
                            }
                            return Err(SendError::Provider(end(permit, error)));
                        }
                        Err(Stop::Failed(_)) if exhausted => return Err(SendError::Exhausted(end(permit, failure))),
                        Err(Stop::Failed(_)) => return Err(SendError::Provider(end(permit, failure))),
                    }
                }
                Verdict::Surface | Verdict::Exhausted if exhausted => return Err(SendError::Exhausted(end(permit, failure))),
                Verdict::Surface | Verdict::Exhausted => return Err(SendError::Provider(end(permit, failure))),
                Verdict::Fallback { model } => {
                    return Err(SendError::Fallback { model, last: end(permit, failure) });
                }
            }
        }
    }

    /// The account's capacity for attempt `attempt` of `send`: a slot of its lane, queued behind the lane's cooldown and fair
    /// order. Each wait and grant is one log line of the send.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn capacity(&self, send: &SendRequest, attempt: u32, cancel: &CancellationToken) -> Result<crate::admission::Permit, SendError> {
        let mut admission = send.admission.clone();
        if admission.owner.is_empty()
            && let Some(session) = &send.request.options.session_id
        {
            admission.owner = Arc::from(session.as_str());
        }
        let mut acquire = std::pin::pin!(self.admission.acquire(&send.lane, admission, cancel));
        let permit = tokio::select! {
            biased;
            granted = &mut acquire => granted,
            () = std::future::ready(()) => {
                trace(&send.request, attempt, "capacity-queued", format_args!("lane={}", send.lane.key()));
                acquire.await
            }
        }
        .map_err(|err| match err {
            AdmissionError::Cancelled => SendError::Cancelled,
            other => SendError::Admission(other),
        })?;
        let metrics = permit.metrics();
        trace(
            &send.request,
            attempt,
            "capacity-granted",
            format_args!(
                "lane={} waited_ms={} active={} limit={}",
                send.lane.key(),
                metrics.queue_wait.as_millis(),
                metrics.active,
                metrics.limit.map_or_else(|| "-".to_owned(), |l| l.to_string())
            ),
        );
        Ok(permit)
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn attempt(
        &self,
        adapter: &dyn ProviderAdapter,
        request: &Arc<ModelRequest>,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
        stream_state: (&mut bool, bool),
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let (streamed, by_connection) = stream_state;
        // The stages the adapter raises from inside the attempt are delivered as the request goes out, ahead of whatever
        // the attempt's end brings.
        let opened = request
            .options
            .send_identity
            .deliver_stages(
                async {
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => Err(Stop::Cancelled),
                        opened = adapter.attempt(request.clone()) => Ok(opened),
                    }
                },
                // The transport mark and the attempt clock's boundaries are facts for a run's watchdog, never stages: the broker has
                // no such consumer. Boundaries are logged where the driver publishes them.
                |stage, payload| match stage {
                    "transport" | "boundary" => {}
                    _ => sink.stage(stage, payload),
                },
            )
            .await?;
        let stream = opened.map_err(Stop::Failed)?;
        if by_connection {
            // The stream opened: a failure from here on is the stream's, not the request's.
            *streamed = true;
        }
        Self::consume(stream, sink, cancel, (!by_connection).then_some(streamed), liveness).await
    }

    /// The provider's re-issue of a spent send ([`ProviderAdapter::recover_spent`]), to its terminal event.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn recovered(
        &self,
        adapter: &dyn ProviderAdapter,
        request: &Arc<ModelRequest>,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let stream = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Stop::Cancelled),
            opened = adapter.recover_spent(request.clone()) => opened.map_err(Stop::Failed)?,
        };
        Self::consume(stream, sink, cancel, None, liveness).await
    }

    /// An opened stream's events into `sink`, to its terminal event; `evented` is set by the first event.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn consume(
        mut stream: Box<dyn mixdog_core_api::domain::provider::ModelStream>,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
        mut evented: Option<&mut bool>,
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let mut reported: Option<Usage> = None;
        let mut shown = false;
        let mut called = false;
        loop {
            let item = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Stop::Cancelled),
                item = stream.next() => item,
            };
            match item {
                Some(Ok(event)) => {
                    match &event {
                        StreamEvent::TextDelta(s) | StreamEvent::ReasoningDelta(s) | StreamEvent::ProgressDelta(s) => shown |= !s.is_empty(),
                        StreamEvent::ToolCallDone(_) => called = true,
                        _ => {}
                    }
                    if let Some(evented) = evented.as_deref_mut() {
                        *evented = true;
                    }
                    // A provider keepalive is informational, never progress (SPEC §4.9).
                    if let Some(liveness) = liveness
                        && !matches!(event, StreamEvent::ProviderKeepalive)
                    {
                        liveness.progress();
                    }
                    if let StreamEvent::Usage(usage) = &event {
                        reported = Some(usage.clone());
                    }
                    let done = matches!(event, StreamEvent::Completed { .. });
                    sink.event(event);
                    if done {
                        return Ok(());
                    }
                }
                Some(Err(mut err)) => {
                    err.exposure.text_emitted |= shown;
                    err.exposure.tool_dispatched |= called;
                    return Err(Stop::Failed(err));
                }
                None => {
                    // A stream that ends silently is a protocol fault by the
                    // trait's contract; surface it as a truncated stream. This
                    // error is built here, so it carries the last usage the
                    // stream reported, as an adapter's error would.
                    let mut fault = truncated(stream.delivery());
                    fault.exposure.text_emitted = shown;
                    fault.exposure.tool_dispatched = called;
                    fault.partial_usage = reported.map(Box::new);
                    return Err(Stop::Failed(fault));
                }
            }
        }
    }
}

/// The broker's own send group while its future is alive: dropped open (the caller's future dropped, a panic), it lets
/// go what the send holds that other sends wait for, which needs no runtime.
struct Group<'a> {
    adapter: &'a dyn ProviderAdapter,
    id: String,
    open: bool,
}

impl Drop for Group<'_> {
    fn drop(&mut self) {
        if self.open {
            self.adapter.release_send(&self.id);
        }
    }
}

#[allow(clippy::large_enum_variant, reason = "Forward the canonical ProviderError through the broker without an extra allocation on the failure path")]
enum Stop {
    Cancelled,
    Failed(ProviderError),
}

/// The failure's text repeats what the endpoint answered: any credential the process holds is redacted before a line is written.
fn write_retry_line(line: &RetryLine, failure: &ProviderError, (attempt, max): (u32, u32), delay: Duration, midstream_ladder: bool) {
    let scrub = crate::oauth::carried::remembered();
    let cause = scrub
        .redact_str([Some(failure.message.as_str()), failure.code.as_deref()].into_iter().flatten().find(|text| !text.is_empty()).unwrap_or("transient error"));
    let advised = if failure.retry_after.is_some() { " (retry-after)" } else { "" };
    match line.style {
        RetryLineStyle::Attempt => {
            let wait = if line.delay { format!(", delay {}ms{advised}", delay.as_millis()) } else { String::new() };
            mixdog_rt::node_stderr!("{} retry attempt {attempt} after {cause}{wait}", line.tag);
        }
        RetryLineStyle::OfMax => {
            let reason = failure
                .status
                .map(|status| status.to_string())
                .or_else(|| failure.code.clone().filter(|code| !code.is_empty()))
                .or_else(|| Some(failure.message.clone()).filter(|message| !message.is_empty()))
                .map_or_else(|| "network error".to_owned(), |reason| scrub.redact_str(&reason));
            mixdog_rt::node_stderr!("{} retry attempt {attempt}/{max} after {reason}, backoff {}ms{advised}", line.tag, delay.as_millis());
        }
        RetryLineStyle::Plain => mixdog_rt::node_stderr!("{} retry {attempt} after {cause}", line.tag),
        RetryLineStyle::AnthropicApi if midstream_ladder && failure.transport == Some(mixdog_core_api::domain::provider::TransportFault::TruncatedStream) => {
            mixdog_rt::node_stderr!("{} truncated stream — retry {attempt}/{max}", line.tag);
        }
        RetryLineStyle::AnthropicApi => {
            mixdog_rt::node_stderr!("{} retry attempt {attempt} after {cause}, delay {}ms{advised}", line.tag, delay.as_millis());
        }
    }
}

fn truncated(delivery: mixdog_core_api::domain::provider::DeliveryState) -> ProviderError {
    ProviderError::transport(mixdog_core_api::domain::provider::TransportFault::TruncatedStream, delivery)
}

/// One line of a send's log: the session and send it belongs to, the attempt and what happened, so one send's wait can be
/// followed from its queue to its end.
fn trace(request: &ModelRequest, attempt: u32, phase: &str, detail: std::fmt::Arguments<'_>) {
    mixdog_rt::turn_trace!("[broker] {} phase={phase} {detail}", log_identity(request, attempt));
}

fn log_identity(request: &ModelRequest, attempt: u32) -> String {
    let options = &request.options;
    format!(
        "session={} turn={} send={} attempt={attempt}",
        options.session_id.as_deref().filter(|s| !s.is_empty()).unwrap_or("-"),
        options.thread.as_ref().and_then(|t| t.turn.as_ref()).map_or("-", |t| t.as_str()),
        options.send_group.as_deref().unwrap_or("-"),
    )
}

/// Waits `delay`, or returns false when `cancel` fires first.
async fn pause(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = mixdog_rt::time::sleep(delay) => true,
    }
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Message;
    use mixdog_core_api::domain::provider::RequestOptions;
    use mixdog_core_api::domain::provider::Role;
    use mixdog_core_api::domain::provider::TransportFault;
    use mixdog_core_api::domain::provider::WireRequest;

    use super::*;
    use crate::providers::google::traits::CatalogGoogleTraits;
    use crate::transport::BodyStream;
    use crate::transport::HttpResponse;
    use crate::transport::HttpSend;

    const META: &[u8] = b"data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"\"}]}}]}\n\n";

    /// One quiet payload, then no more bytes and no end.
    struct QuietPayload(Option<Bytes>);

    #[async_trait]
    impl BodyStream for QuietPayload {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            match self.0.take() {
                Some(chunk) => Some(Ok(chunk)),
                None => std::future::pending().await,
            }
        }
    }

    struct Quiet;

    #[async_trait]
    impl HttpSend for Quiet {
        async fn send(&self, _: WireRequest, _: crate::transport::Exchange) -> Result<HttpResponse, ProviderError> {
            Ok(HttpResponse { status: 200, headers: vec![], body: Box::new(QuietPayload(Some(Bytes::from_static(META)))) })
        }
    }

    struct Sink;

    impl AttemptSink for Sink {
        fn event(&mut self, _: StreamEvent) {}
        fn discard(&mut self) {}
    }

    /// The broker enforces no timer of its own: a Google stream whose payload carries no output ends at the first-output window the
    /// transport driver holds, through the broker's consumer exactly as through a direct call.
    #[tokio::test(start_paused = true)]
    async fn the_broker_consumes_a_google_stream_under_the_drivers_first_output_window() {
        let adapter = crate::providers::google::gemini("k", Arc::new(Quiet), Arc::new(CatalogGoogleTraits(Vec::new())));
        let request = Arc::new(ModelRequest {
            model: "gemini-3.6-flash".to_owned(),
            messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
            tools: vec![],
            options: RequestOptions::default(),
        });
        let stream = adapter.attempt(request).await.ok().expect("the head is answered");
        let began = tokio::time::Instant::now();
        let ended = ModelBroker::consume(stream, &mut Sink, &CancellationToken::new(), None, None).await;
        let Err(Stop::Failed(err)) = ended else { panic!("the silence must end the stream") };
        assert_eq!(began.elapsed(), Duration::from_secs(600));
        assert_eq!(err.message, "Gemini REST streamGenerateContent first output timed out after 600000ms");
    }
}
