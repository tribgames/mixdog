//! A [`ModelStream`] over a response body and a [`WireDecoder`]: transport
//! chunks in, stream events out. A body fault becomes a transport error with
//! the exposure the decoder recorded; the end of body asks the decoder for
//! its terminal check (a missing terminal event is a truncated stream).

use std::collections::VecDeque;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::WireDecoder;

use crate::transport::http::BodyStream;

pub struct DecodedStream {
    body: Box<dyn BodyStream>,
    decoder: Box<dyn WireDecoder>,
    queue: VecDeque<Result<StreamEvent, ProviderError>>,
    ended: bool,
    fault_code: Option<&'static str>,
    fault_prefix: Option<&'static str>,
}

impl DecodedStream {
    pub fn new(body: Box<dyn BodyStream>, decoder: Box<dyn WireDecoder>) -> Self {
        Self {
            body,
            decoder,
            queue: VecDeque::new(),
            ended: false,
            fault_code: None,
            fault_prefix: None,
        }
    }

    /// The words a body fault is given: this prefix and undici's `terminated`, the error a `fetch` body whose socket failed
    /// rejects with.
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

    fn fail(&mut self, err: ProviderError) {
        self.ended = true;
        self.queue.push_back(Err(err));
    }

    fn push(&mut self, result: Result<Vec<StreamEvent>, ProviderError>) {
        match result {
            Ok(events) => self.queue.extend(events.into_iter().map(Ok)),
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
                    let result = self.decoder.feed(&chunk);
                    self.push(result);
                }
                Some(Err(fault)) => {
                    let mut err = ProviderError::transport(fault, DeliveryState::Accepted);
                    err.exposure = self.decoder.exposure();
                    err.code = self.fault_code.map(str::to_owned);
                    if let Some(prefix) = self.fault_prefix {
                        err.message = format!("{prefix}{}", crate::transport::link::TERMINATED);
                    }
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
