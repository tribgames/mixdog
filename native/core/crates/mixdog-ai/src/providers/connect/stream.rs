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
        assert_eq!((cut.message.as_str(), cut.transport), ("terminated", Some(TransportFault::Closed)));
        assert!(plain.next().await.is_none(), "the stream ends with its fault");
        let mut devin = DecodedStream::new(Box::new(Cut(Some(TransportFault::Reset))), Box::new(Silent)).with_fault_prefix("Devin connection failed: ");
        assert_eq!(devin.next().await.expect("an item").expect_err("the cut").message, "Devin connection failed: terminated");
    }
}
