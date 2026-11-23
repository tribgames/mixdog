//! A [`ModelStream`] over a response body and a [`WireDecoder`]: transport
//! chunks in, stream events out. A body fault becomes a transport error with
//! the exposure the decoder recorded; the end of body asks the decoder for
//! its terminal check (a missing terminal event is a truncated stream).

use std::collections::VecDeque;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::AttemptHandle;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::SendIdentity;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;
use mixdog_core_api::domain::provider::WireDecoder;

use crate::transport::http::BodyStream;

pub struct DecodedStream {
    body: Box<dyn BodyStream>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    fault_code: Option<&'static str>,
    fault_prefix: Option<&'static str>,
    billed: Option<Billed>,
    attempt: Option<Driven>,
}

/// The driver's attempt a stream answers: each body chunk marks transport on the send, the decoded payload and output move
/// the attempt's phase, and a body the driver ended at a deadline fails with the expiry's classification.
struct Driven {
    handle: AttemptHandle,
    identity: SendIdentity,
    had_output: bool,
}

struct Billed {
    model: String,
    last_usage: Option<Usage>,
}

impl DecodedStream {
    pub fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self { body, decoder, queue: VecDeque::new(), ended: false, fault_code: None, fault_prefix: None, billed: None, attempt: None }
    }

    /// The stream of a driven attempt ([`crate::transport::model_driver::ModelDriver::send`]) of the send `identity`.
    pub(crate) fn driven(mut self, handle: AttemptHandle, identity: SendIdentity) -> Self {
        self.attempt = Some(Driven { handle, identity, had_output: false });
        self
    }

    /// `onStreamDelta('transport')` for a chunk of the body, while the attempt it answers is the current one.
    fn mark_transport(&self) {
        if let Some(driven) = &self.attempt
            && driven.handle.context().is_some()
        {
            driven.identity.raise_transport();
        }
    }

    fn report(&mut self, events: &[StreamEvent]) {
        if let Some(driven) = self.attempt.as_mut() {
            crate::providers::compat::adapter::report_progress(&driven.handle, self.decoder.as_ref(), events, &mut driven.had_output);
        }
    }

    /// The words put before a body fault's `terminated` (undici's error for a `fetch` body whose socket failed); without
    /// them the fault reads `terminated` alone.
    pub fn with_fault_prefix(mut self, prefix: &'static str) -> Self {
        self.fault_prefix = Some(prefix);
        self
    }

    /// The provider code a body fault carries (the provider's own label for
    /// a failed connection).
    pub fn with_fault_code(mut self, code: &'static str) -> Self {
        self.fault_code = Some(code);
        self
    }

    /// Devin reports cumulative usage before a Connect trailer (including failing trailers).
    pub(crate) fn with_billed_usage(mut self, model: String) -> Self {
        self.billed = Some(Billed { model, last_usage: None });
        self
    }

    fn fail(&mut self, mut err: ProviderError) {
        self.ended = true;
        if err.partial_usage.is_none()
            && let Some(billed) = self.billed.as_ref()
            && let Some(usage) = billed.last_usage.as_ref()
        {
            err.partial_usage = Some(Box::new(usage.clone()));
            err.partial_model = Some(billed.model.as_str().into());
        }
        self.queue.push_back(Err(err));
    }

    fn push(&mut self, result: Result<Vec<StreamEvent>, ProviderError>) {
        match result {
            Ok(events) => {
                if let Some(billed) = self.billed.as_mut() {
                    let mut reported = None;
                    let mut output = Vec::new();
                    for event in events {
                        match event {
                            StreamEvent::Usage(usage) => reported = Some(usage),
                            StreamEvent::ServedModel(ref model) => {
                                billed.model.clone_from(model);
                                output.push(event);
                            }
                            _ => output.push(event),
                        }
                    }
                    // A sink can cancel upon seeing output. Give the ledger this chunk's cumulative bill first.
                    if let Some(usage) = reported {
                        billed.last_usage = Some(usage.clone());
                        self.queue.push_back(Ok(StreamEvent::Usage(usage)));
                    }
                    if let Some(usage) = billed.last_usage.as_ref() {
                        crate::registry::accounted::observe_attempt_usage(usage.clone(), Some(billed.model.clone()));
                    }
                    self.queue.extend(output.into_iter().map(Ok));
                } else {
                    self.queue.extend(events.into_iter().map(Ok));
                }
            }
            Err(err) => self.fail(err),
        }
    }
}

#[async_trait]
impl ModelStream for DecodedStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        loop {
            if let Some(item) = self.queue.pop_front() {
                return Some(item);
            }
            if self.ended {
                return None;
            }
            match self.body.next().await {
                Some(Ok(chunk)) => {
                    self.mark_transport();
                    let result = self.decoder.feed(&chunk);
                    if let Ok(events) = &result {
                        self.report(events);
                    }
                    self.push(result);
                    if self.billed.is_some() && !self.ended && self.decoder.terminal_seen() {
                        self.ended = true;
                        let result = self.decoder.finish();
                        self.push(result);
                    }
                }
                Some(Err(fault)) => {
                    // A phase deadline of the driver ended the body: its one failure, as the wire classifies it.
                    if let Some(timed) = self.body.expired(self.decoder.exposure()) {
                        self.fail(timed);
                        continue;
                    }
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    err.connection = self.body.connection();
                    err.code = self.fault_code.map(str::to_owned);
                    // Node reads these bodies through `fetch`: a socket failure mid-body is undici's `TypeError: terminated`.
                    err.message = format!("{}{}", self.fault_prefix.unwrap_or_default(), crate::transport::link::TERMINATED);
                    self.fail(err);
                }
                None => {
                    self.ended = true;
                    let result = self.decoder.finish();
                    // A decoder that ends in failure but still owes events (the leak guard's held-back text) hands them
                    // out first and keeps the failure for the next call.
                    let owes_failure = matches!(&result, Ok(events) if !events.is_empty()) && !self.decoder.terminal_seen();
                    self.push(result);
                    if owes_failure {
                        let failure = self.decoder.finish();
                        self.push(failure);
                    }
                }
            }
        }
    }

    fn delivery(&self) -> DeliveryState {
        DeliveryState::Accepted
    }

    /// A leaf: `next` awaits nothing after the wire's terminal event.
    fn on_wire_left(&mut self, _left: std::sync::Arc<dyn Fn() + Send + Sync>) {}
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;
    use mixdog_core_api::domain::provider::Exposure;
    use mixdog_core_api::domain::provider::TransportFault;

    use super::*;

    /// A body whose socket fails before its first chunk.
    struct Cut(Option<TransportFault>);

    #[async_trait]
    impl BodyStream for Cut {
        async fn next(&mut self) -> Option<Result<Bytes, TransportFault>> {
            self.0.take().map(Err)
        }
    }

    struct Silent;

    impl WireDecoder for Silent {
        fn feed(&mut self, _: &[u8]) -> Result<Vec<StreamEvent>, ProviderError> {
            Ok(Vec::new())
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

    /// A body cut mid-stream is undici's `terminated` (a custom provider's, the local runtime's, Grok's), after the
    /// provider's own words when it has them (Devin's); never an empty message.
    #[tokio::test]
    async fn a_body_fault_reads_as_undicis_terminated() {
        let mut plain = DecodedStream::new(Box::new(Cut(Some(TransportFault::Closed))), Box::new(Silent));
        let cut = plain.next().await.expect("an item").expect_err("the cut");
        assert_eq!((cut.message.as_str(), cut.transport.clone()), ("terminated", Some(TransportFault::Closed)));
        assert!(plain.next().await.is_none(), "the stream ends with its fault");
        let mut devin = DecodedStream::new(Box::new(Cut(Some(TransportFault::Reset))), Box::new(Silent)).with_fault_prefix("Devin connection failed: ");
        assert_eq!(devin.next().await.expect("an item").expect_err("the cut").message, "Devin connection failed: terminated");
    }
}
