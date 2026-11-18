//! Test support for the call sites that bound their own requests: a transport whose every request outlives the timer
//! of the exchange the site chose, so the site's failure can be read. Time is paused
//! (`#[tokio::test(start_paused = true)]`): nothing waits.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

use super::link::Exchange;
use super::link::HttpResponse;
use super::link::HttpSend;
use super::link::deadline_error;

/// What one expired request told the transport.
#[derive(Clone, Debug)]
pub(crate) struct Expired {
    /// The error text the link gives that exchange.
    pub text: String,
    /// The window the exchange gave the request.
    pub after: Duration,
}

#[derive(Default)]
pub(crate) struct NeverAnswers {
    seen: Mutex<Vec<Expired>>,
}

impl NeverAnswers {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn seen(&self) -> Vec<Expired> {
        self.seen.lock().unwrap().clone()
    }

    /// Every request of the site met a timer of its own and ended with the link's text for it.
    pub fn assert_each_request_was_bounded(&self, at_least: usize) {
        let seen = self.seen();
        assert!(seen.len() >= at_least, "{} requests met their timer, wanted at least {at_least}", seen.len());
        for expired in &seen {
            assert!(expired.after > Duration::ZERO, "a request without a window: {expired:?}");
            assert!(!expired.text.is_empty(), "{expired:?}");
        }
    }
}

#[async_trait]
impl HttpSend for NeverAnswers {
    async fn send(&self, _request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("the request is never answered");
        let error = deadline_error(expired, DeliveryState::Ambiguous, exchange.surface);
        self.seen.lock().unwrap().push(Expired { text: error.message.clone(), after: expired.after });
        Err(error)
    }
}
