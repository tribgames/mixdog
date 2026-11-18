//! Call sites whose request is never answered: each gives up when the window its exchange names has passed (time is
//! paused, nothing waits) and reports it the way its caller reads it.

use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::providers::google::auth::RequestAuth;
use mixdog_ai::registry::vertex_metadata::MetadataAuth;
use mixdog_ai::registry::vertex_metadata::probe_project;
use mixdog_ai::transport::Exchange;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_ai::transport::link::deadline_error;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

/// A transport whose every request outlives its exchange's window; it remembers the windows it was given.
#[derive(Default)]
struct Unanswered {
    windows: Mutex<Vec<Duration>>,
}

#[async_trait]
impl HttpSend for Unanswered {
    async fn send(&self, _request: WireRequest, exchange: Exchange) -> Result<HttpResponse, ProviderError> {
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("never answered");
        self.windows.lock().unwrap().push(expired.after);
        Err(deadline_error(expired, DeliveryState::Ambiguous, exchange.surface))
    }
}

#[tokio::test(start_paused = true)]
async fn a_metadata_server_that_does_not_answer_within_a_second_is_no_server() {
    let transport = Arc::new(Unanswered::default());
    let http: Arc<dyn HttpSend> = transport.clone();
    assert_eq!(probe_project(&http).await, None);
    assert_eq!(*transport.windows.lock().unwrap(), [Duration::from_secs(1)]);
}

#[tokio::test(start_paused = true)]
async fn a_token_request_to_the_metadata_server_that_never_answers_fails_as_an_authentication_failure() {
    let transport = Arc::new(Unanswered::default());
    let auth = MetadataAuth::new(transport.clone(), "project", Box::new(|| 0));
    let error = auth.authorize().await.expect_err("never answers");
    assert_eq!(error.kind, ErrorKind::Auth);
    assert!(error.message.starts_with("Vertex AI authentication failed: "), "{}", error.message);
    assert_eq!(transport.windows.lock().unwrap().len(), 1, "one request, no retry inside the auth");
}
