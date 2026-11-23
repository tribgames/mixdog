//! Grok's Responses stream through the model-exchange driver: the xAI Responses send's windows (`sendXaiResponses`,
//! openai-compat-xai-send.mjs:118-155) on the test's clock.

use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireRequest;

use crate::catalog::ListingLookup;
use crate::oauth::CredentialFile;
use crate::oauth::CredentialIo;
use crate::providers::compat::CompatProfile;
use crate::providers::connect::rewrite::testing::Paced;
use crate::providers::connect::rewrite::testing::assert_stalls;
use crate::providers::connect::rewrite::testing::responses;
use crate::providers::grok::auth::GrokCredential;
use crate::providers::listing_row::testing::Replay;

#[tokio::test(start_paused = true)]
#[allow(clippy::disallowed_methods, reason = "test: writes a fixture credential file synchronously")]
async fn a_silent_grok_stream_stalls_on_the_responses_windows_and_a_slow_one_reports_transport() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("grok-oauth.json");
    let stored = serde_json::json!({ "access_token": "a1", "refresh_token": "r1", "token_endpoint": "https://auth.x.ai/oauth2/token" });
    std::fs::write(&path, stored.to_string()).unwrap();
    let rt = mixdog_rt::testing::tokens();
    // The token endpoint is apart from the model endpoint: a refresh never takes a body the test scripted for the stream.
    let token_endpoint = Arc::new(Replay::new(|_: &WireRequest| (500, Vec::new())));
    let build = |streams| -> Arc<dyn ProviderAdapter> {
        let http = Paced::new(streams);
        let file = CredentialFile::new(path.clone(), CredentialIo { read: rt.interactive_io, write: rt.durability_io });
        let credential = Arc::new(GrokCredential::new(token_endpoint.clone(), file));
        Arc::new(super::adapter(http, credential, None, CompatProfile::xai().retry_policy(), ListingLookup::new(), None, false))
    };
    let request = ModelRequest { model: "grok-4".into(), messages: Vec::new(), tools: Vec::new(), options: RequestOptions::default() };
    assert_stalls(build, &request, &responses()).await;
}
