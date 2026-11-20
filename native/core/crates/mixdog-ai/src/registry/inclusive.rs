//! The usage convention at the boundary where a wire engine's result becomes the enclosing provider's result
//! (`withInclusiveUsage`, `inclusive-usage.mjs`). The Anthropic Messages decoder reports input without its cache read and
//! write; a provider whose own convention is inclusive (`providerInputExcludesCache` false: DeepSeek, OpenRouter, Command
//! Code, OpenCode Go, an OpenAI-compatible custom provider's Messages wire) hands that wire's result on in its own form,
//! so every wire of the provider counts the prompt the same way. The success usage, a failure's partial usage and every
//! abandoned attempt (they travel on the failure) are converted here, once.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ModelStream;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::StreamEvent;
use mixdog_core_api::domain::provider::Usage;

/// `toInclusiveUsage`: the input with its cache read and write added back.
pub fn to_inclusive(usage: &Usage) -> Usage {
    Usage { input_tokens: usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens, ..usage.clone() }
}

/// `toInclusiveUsageError`.
pub fn error_inclusive(mut error: ProviderError) -> ProviderError {
    error.partial_usage = error.partial_usage.take().map(|usage| Box::new(to_inclusive(&usage)));
    error
}

struct InclusiveStream(Box<dyn ModelStream>);

#[async_trait]
impl ModelStream for InclusiveStream {
    async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
        Some(match self.0.next().await? {
            Ok(StreamEvent::Usage(usage)) => Ok(StreamEvent::Usage(to_inclusive(&usage))),
            Ok(other) => Ok(other),
            Err(error) => Err(error_inclusive(error)),
        })
    }
    fn delivery(&self) -> DeliveryState {
        self.0.delivery()
    }
    fn on_wire_left(&mut self, left: std::sync::Arc<dyn Fn() + Send + Sync>) {
        self.0.on_wire_left(left);
    }
}

/// An attempt of the engine's Messages wire, its result in the inclusive convention.
pub fn inclusive_attempt(result: Result<Box<dyn ModelStream>, ProviderError>) -> Result<Box<dyn ModelStream>, ProviderError> {
    match result {
        Ok(stream) => Ok(Box::new(InclusiveStream(stream))),
        Err(error) => Err(error_inclusive(error)),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use mixdog_core_api::domain::provider::ErrorKind;

    use super::*;
    use crate::catalog::{PricedUsage, UsageArgs};
    use crate::registry::accounting::{Completed, Facts, Outcome, SendAccounting, SendIdentity, UsagePricing, UsageRow, UsageSink};

    struct Scripted(VecDeque<Result<StreamEvent, ProviderError>>);

    #[async_trait]
    impl ModelStream for Scripted {
        async fn next(&mut self) -> Option<Result<StreamEvent, ProviderError>> {
            self.0.pop_front()
        }
        fn delivery(&self) -> DeliveryState {
            DeliveryState::Accepted
        }
        fn on_wire_left(&mut self, _: Arc<dyn Fn() + Send + Sync>) {}
    }

    /// The openrouter-messages-usage fixture's answer: 9 fresh, 14,268 read.
    fn answer() -> Usage {
        Usage { input_tokens: 9, output_tokens: 5, cache_read_tokens: 14_268, ..Usage::default() }
    }

    struct Subtracting;
    impl UsagePricing for Subtracting {
        fn price_usage(&self, args: &UsageArgs) -> PricedUsage {
            let input = if args.input_tokens_inclusive == Some(true) { (args.input_tokens - args.cache_read_tokens - args.cache_write_tokens).max(0.0) } else { args.input_tokens };
            PricedUsage { input, cost_usd: None, rates: Default::default() }
        }
    }

    #[derive(Default)]
    struct Rows(Mutex<Vec<UsageRow>>);
    #[async_trait]
    impl UsageSink for Rows {
        async fn record_queued(&self, row: UsageRow) -> Result<(), String> {
            self.0.lock().unwrap().push(row);
            Ok(())
        }
    }

    /// An inclusive-input provider's Messages wire (OpenRouter, DeepSeek, Command Code, OpenCode Go, a custom OpenAI-compatible
    /// provider) hands on 14,277 provider input and the ledger stores the 9 fresh tokens once; a failure's partial usage, which
    /// is how an abandoned attempt reaches the row, is converted the same way and not twice.
    #[tokio::test]
    async fn an_inclusive_providers_messages_result_is_inclusive_once_and_its_row_holds_fresh_input() {
        let wire = Scripted(VecDeque::from([Ok(StreamEvent::Usage(answer()))]));
        let mut stream = inclusive_attempt(Ok(Box::new(wire))).ok().expect("a stream");
        let Some(Ok(StreamEvent::Usage(usage))) = stream.next().await else { panic!("usage") };
        assert_eq!(usage.input_tokens, 14_277);

        let mut failed = ProviderError::new(ErrorKind::Transient, DeliveryState::Accepted);
        failed.partial_usage = Some(Box::new(answer()));
        let Err(error) = inclusive_attempt(Err(failed)) else { panic!("an error") };
        assert_eq!(error.partial_usage.as_deref().map(|u| u.input_tokens), Some(14_277));

        let identity = SendIdentity {
            provider: "openrouter".into(),
            model: "m".into(),
            requested_provider: "openrouter".into(),
            requested_model: "m".into(),
            route_hop: false,
            session_id: Some("s".into()),
            owner_session_id: None,
            source_type: "cli".into(),
            input_tokens_inclusive: true,
            request_service_tier: String::new(),
            account: Ok(String::new()),
            request_id: "r".into(),
            started_at: 1,
        };
        let sink = Arc::new(Rows::default());
        let accounting = SendAccounting::new(identity, Arc::new(Subtracting), Some(sink.clone()));
        accounting.finish(Outcome::Completed(Completed { facts: Some(Facts::from(&usage)), ..Default::default() })).await;
        let rows = sink.0.lock().unwrap();
        assert_eq!((rows[0].input, rows[0].cache_read), (9.0, 14_268.0));
    }
}
