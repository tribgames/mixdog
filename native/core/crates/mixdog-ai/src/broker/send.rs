use std::sync::Arc;
use std::time::Duration;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
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
    /// the usage its failure reported (`ProviderError::partial_usage`), called
    /// before `discard`. `model` is the served model when known; `None` means
    /// the send's own. The default ignores it; the accounting sink records it
    /// as `<requestId>:abandoned:<i>`.
    fn abandoned(&mut self, _usage: &Usage, _model: Option<&str>) {}
    /// A display-only stage of the send (`onStageChange(stage, payload)`): `reconnecting` with its payload before each
    /// retry wait. The default ignores it.
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
    Fallback { model: String, last: ProviderError },
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
    /// each retry wait. The permit is held across retries, so a retry never
    /// re-queues.
    ///
    /// [`SendStages::ladder_by_connection`]: mixdog_core_api::domain::provider::SendStages::ladder_by_connection
    /// [`SendStages::reconnecting`]: mixdog_core_api::domain::provider::SendStages::reconnecting
    pub async fn send(
        &self,
        adapter: &dyn ProviderAdapter,
        send: SendRequest,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
    ) -> Result<u32, SendError> {
        let mut permit = self
            .admission
            .acquire(&send.lane, send.admission, cancel)
            .await
            .map_err(|err| match err {
                AdmissionError::Cancelled => SendError::Cancelled,
                other => SendError::Admission(other),
            })?;
        let model = send.request.model.clone();
        let mut request_state = RetryState::new(RetryClass::Request, model.clone());
        let mut midstream_state = RetryState::new(RetryClass::Midstream, model.clone());
        let mut attempts = 0;
        let liveness = permit.liveness().cloned();
        let stages = adapter.send_stages(&model);
        for _ in 0..stages.preparing {
            sink.stage("requesting", None);
        }
        loop {
            attempts += 1;
            if stages.each_attempt {
                sink.stage("requesting", None);
            }
            // A request beginning is the run's doing: the lease measures the
            // silence after it.
            if let Some(liveness) = &liveness {
                liveness.progress();
            }
            let mut streamed = false;
            let failure = match self
                .attempt(adapter, &send.request, sink, cancel, &mut streamed, stages.ladder_by_connection, liveness.as_deref())
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
            if failure.status == Some(429) {
                permit.report_rate_limit(failure.retry_after);
            }
            let (state, class) = if streamed {
                if stages.ladder_by_connection {
                    // `runGeminiStreamAttempts`: each stream attempt opens under a fresh connection ladder.
                    request_state = RetryState::new(RetryClass::Request, model.clone());
                }
                (&mut midstream_state, RetryClass::Midstream)
            } else {
                (&mut request_state, RetryClass::Request)
            };
            let policy = adapter.retry_policy_for(&send.request.model);
            let decision = self.decider.verdict(&failure, state, policy, random_samples());
            // `emitProviderRetryStage`'s attempt: the one about to run, of the row's attempts.
            let attempt = decision.next.count(None).retries + 1;
            *state = decision.next;
            // `runGeminiStreamAttempts` marks every failure after its stream opened as its connection ladder's spent
            // one (`gemini-retry-policy.mjs:151`), whether or not the stream ladder re-issues it.
            let exhausted = matches!(decision.verdict, Verdict::Exhausted) || (streamed && stages.ladder_by_connection);
            let end = |permit: crate::admission::Permit, error: ProviderError| {
                permit.finish(Outcome::Failure {
                    status: error.status,
                    retry_after: error.retry_after,
                });
                error
            };
            match decision.verdict {
                Verdict::Retry { delay, .. } => {
                    if stages.reconnecting {
                        let max = policy.row(class).map_or(0, |row| row.schedule.max_retries) + 1;
                        sink.stage("reconnecting", Some(crate::retry::stage::reconnecting(&failure, attempt, max, delay, crate::wall::now_ms())));
                    }
                    if let Some(tag) = adapter.retry_log_tag(&model) {
                        mixdog_rt::node_stderr!("{tag} retry attempt {attempt} after {}", failure.message);
                    }
                    if let Some(usage) = &failure.partial_usage {
                        sink.abandoned(usage, failure.partial_model.as_deref());
                    }
                    sink.discard();
                    if !pause(delay, cancel).await {
                        permit.finish(Outcome::Abandoned);
                        return Err(SendError::Cancelled);
                    }
                }
                Verdict::Surface | Verdict::Exhausted
                    if streamed && !cancel.is_cancelled() && adapter.recovers_spent(&model, &failure) =>
                {
                    // The provider's last re-issue of a stream that died with nothing shown; its own failure is
                    // dropped and the ladder's surfaces.
                    if stages.before_recovery {
                        sink.stage("requesting", None);
                    }
                    sink.discard();
                    match self.recovered(adapter, &send.request, sink, cancel, liveness.as_deref()).await {
                        Ok(()) => {
                            permit.finish(Outcome::Success);
                            mixdog_rt::node_stderr!(
                                "[gemini] stream failed ({}); recovered via non-streaming generateContent",
                                failure.code.as_deref().filter(|c| !c.is_empty()).unwrap_or(&failure.message)
                            );
                            return Ok(attempts + 1);
                        }
                        Err(Stop::Cancelled) => {
                            permit.finish(Outcome::Abandoned);
                            return Err(SendError::Cancelled);
                        }
                        Err(Stop::Failed(_)) if exhausted => return Err(SendError::Exhausted(end(permit, failure))),
                        Err(Stop::Failed(_)) => return Err(SendError::Provider(end(permit, failure))),
                    }
                }
                Verdict::Surface | Verdict::Exhausted if exhausted => return Err(SendError::Exhausted(end(permit, failure))),
                Verdict::Surface | Verdict::Exhausted => return Err(SendError::Provider(end(permit, failure))),
                Verdict::Fallback { model } => {
                    return Err(SendError::Fallback {
                        model,
                        last: end(permit, failure),
                    });
                }
            }
        }
    }

    async fn attempt(
        &self,
        adapter: &dyn ProviderAdapter,
        request: &Arc<ModelRequest>,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
        streamed: &mut bool,
        by_connection: bool,
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let stream = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Stop::Cancelled),
            opened = adapter.attempt(request.clone()) => opened.map_err(Stop::Failed)?,
        };
        if by_connection {
            // The stream opened: a failure from here on is the stream's, not the request's.
            *streamed = true;
        }
        Self::consume(stream, sink, cancel, (!by_connection).then_some(streamed), liveness).await
    }

    /// The provider's re-issue of a spent send ([`ProviderAdapter::recover_spent`]), to its terminal event.
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
    async fn consume(
        mut stream: Box<dyn mixdog_core_api::domain::provider::ModelStream>,
        sink: &mut dyn AttemptSink,
        cancel: &CancellationToken,
        mut evented: Option<&mut bool>,
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let mut reported: Option<Usage> = None;
        loop {
            let item = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Stop::Cancelled),
                item = stream.next() => item,
            };
            match item {
                Some(Ok(event)) => {
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
                Some(Err(err)) => return Err(Stop::Failed(err)),
                None => {
                    // A stream that ends silently is a protocol fault by the
                    // trait's contract; surface it as a truncated stream. This
                    // error is built here, so it carries the last usage the
                    // stream reported, as an adapter's error would.
                    let mut fault = truncated(stream.delivery());
                    fault.partial_usage = reported.map(Box::new);
                    return Err(Stop::Failed(fault));
                }
            }
        }
    }
}

enum Stop {
    Cancelled,
    Failed(ProviderError),
}

fn truncated(delivery: mixdog_core_api::domain::provider::DeliveryState) -> ProviderError {
    ProviderError::transport(
        mixdog_core_api::domain::provider::TransportFault::TruncatedStream,
        delivery,
    )
}

/// Waits `delay`, or returns false when `cancel` fires first.
async fn pause(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        _ = cancel.cancelled() => false,
        _ = tokio::time::sleep(delay) => true,
    }
}