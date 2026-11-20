//! The custom-provider probes: credential-looking text is redacted to one short line, and a discovery that never answers ends at the
//! probe's sixty seconds.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use mixdog_ai::transport::HttpResponse;
use mixdog_ai::transport::HttpSend;
use mixdog_core_api::domain::provider::DeliveryState;

use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::json;

use super::custom_probe::*;














/// A transport whose every request outlives the timer of its exchange, through the link's own `deadline_error`.
struct TimingOut;

#[async_trait]
impl HttpSend for TimingOut {
    async fn send(&self, _request: WireRequest, exchange: mixdog_ai::transport::Exchange) -> Result<HttpResponse, ProviderError> {
        let expired = exchange.liveness.bound_head(std::future::pending::<()>()).await.expect_err("the request is never answered");
        Err(mixdog_ai::transport::link::deadline_error(expired, DeliveryState::Ambiguous, exchange.surface))
    }
}

#[test]
fn credential_looking_text_is_redacted_to_one_short_line() {
    let secrets = vec!["hunter2hunter2".to_owned(), String::new()];
    assert_eq!(
        sanitize_message("Authorization: Bearer abc.def-ghi\nkey hunter2hunter2 token=zzz api_key: \"qq\" sk-abcdefgh12", &secrets),
        // Node's own result: the field rule also takes the redacted scheme word.
        "Authorization: [redacted] [redacted] key [redacted] token=[redacted] api_key: \"[redacted]\" [redacted]"
    );
    assert_eq!(sanitize_message("", &[]), "request failed");
    let long = sanitize_message(&"x".repeat(400), &[]);
    assert_eq!(long.chars().count(), 301);
    assert!(long.ends_with('…'));
}


/// The settings page's discovery of an endpoint that never answers, on each protocol, through the real admin stack:
/// the probe waits its own 60 s (the discovery's timer is the same 60 s and armed after it, so the probe's ends the
/// wait), and shows "model discovery timed out after 60s" with no models (`customOpenaiChatProbe`,
/// `customAnthropicProbe`).
#[tokio::test(start_paused = true)]
async fn a_discovery_that_never_answers_ends_at_the_probes_sixty_seconds() {
    use super::collaborators::CustomProviders as _;
    let shown = json!({ "models": [], "error": { "kind": "timeout", "message": "model discovery timed out after 60s" } });
    for (site, protocol, base) in [("customOpenaiChatProbe", "openai-chat", "https://x.test/v1"), ("customAnthropicProbe", "anthropic", "https://x.test")] {
        let w = super::custom_admin_tests::world_over(std::collections::HashMap::new(), Some(Arc::new(TimingOut))).await;
        let input = json!({ "name": "Probe", "protocol": protocol, "baseURL": base, "apiKey": "sk-DUMMY-probe-secret-0123456789" });
        let started = tokio::time::Instant::now();
        assert_eq!(w.admin.discover_models(input, 0).await.unwrap(), shown, "{site}");
        assert_eq!(started.elapsed(), Duration::from_secs(60), "{site}");
    }
}
