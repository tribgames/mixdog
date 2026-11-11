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
    /// Failures before any event of an attempt count against the policy's
    /// `request` row, later ones against `midstream`; each row keeps its own
    /// state across attempts. The permit is held across retries, so a retry
    /// never re-queues.
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
        let mut midstream_state = RetryState::new(RetryClass::Midstream, model);
        let mut attempts = 0;
        let liveness = permit.liveness().cloned();
        loop {
            attempts += 1;
            // A request beginning is the run's doing: the lease measures the
            // silence after it.
            if let Some(liveness) = &liveness {
                liveness.progress();
            }
            let mut streamed = false;
            let failure = match self
                .attempt(adapter, &send.request, sink, cancel, &mut streamed, liveness.as_deref())
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
            let state = if streamed {
                &mut midstream_state
            } else {
                &mut request_state
            };
            let decision =
                self.decider
                    .verdict(&failure, state, adapter.retry_policy_for(&send.request.model), random_samples());
            *state = decision.next;
            let end = |permit: crate::admission::Permit, error: ProviderError| {
                permit.finish(Outcome::Failure {
                    status: error.status,
                    retry_after: error.retry_after,
                });
                error
            };
            match decision.verdict {
                Verdict::Retry { delay, .. } => {
                    if let Some(usage) = &failure.partial_usage {
                        sink.abandoned(usage, failure.partial_model.as_deref());
                    }
                    sink.discard();
                    if !pause(delay, cancel).await {
                        permit.finish(Outcome::Abandoned);
                        return Err(SendError::Cancelled);
                    }
                }
                Verdict::Surface => return Err(SendError::Provider(end(permit, failure))),
                Verdict::Exhausted => return Err(SendError::Exhausted(end(permit, failure))),
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
        liveness: Option<&RunLiveness>,
    ) -> Result<(), Stop> {
        let mut reported: Option<Usage> = None;
        let mut stream = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(Stop::Cancelled),
            opened = adapter.attempt(request.clone()) => opened.map_err(Stop::Failed)?,
        };
        loop {
            let item = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(Stop::Cancelled),
                item = stream.next() => item,
            };
            match item {
                Some(Ok(event)) => {
                    *streamed = true;
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