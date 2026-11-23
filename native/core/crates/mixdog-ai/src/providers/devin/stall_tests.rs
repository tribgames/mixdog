//! The Cascade chat stream through the model-exchange driver: Node consumed it as a Chat Completions stream
//! (`consumeCompatChatCompletionStream`, devin.mjs:404), so a silent one ends on that stream's windows, on the test's clock.

use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;

use super::DevinAdapter;
use super::auth::StaticSessionToken;
use super::auth::StoredCredentials;
use super::session;
use crate::providers::connect::frame;
use crate::providers::connect::pb::Writer;
use crate::providers::connect::rewrite::testing::Paced;
use crate::providers::connect::rewrite::testing::WireStalls;
use crate::providers::connect::rewrite::testing::assert_stalls;
use crate::providers::connect::rewrite::testing::chat;

/// One `GetChatMessageResponse` frame.
fn response_frame(field: u32, text: &str) -> Vec<u8> {
    let mut response = Writer::new();
    response.string(field, text);
    frame::encode(&response.finish(), 0)
}

/// `devin-oauth`'s ladder is none (devin.mjs:383-431 runs no `withRetry`): a stall ends the send.
#[tokio::test(start_paused = true)]
async fn a_silent_devin_stream_stalls_on_the_chat_windows_and_a_slow_one_reports_transport() {
    let build = |streams| -> Arc<dyn ProviderAdapter> {
        let http = Paced::with_unary(streams, |request| {
            if request.url.ends_with(session::GET_USER_JWT_PATH) {
                let mut jwt = Writer::new();
                jwt.string(1, "user-jwt");
                return Some((200, jwt.finish()));
            }
            // The account lists no rows: the turn's model is sent as it is named.
            request.url.ends_with(session::GET_CLI_MODEL_CONFIGS_PATH).then(|| (200, Vec::new()))
        });
        let credentials = StoredCredentials { access_token: "devin-session-token$stall".into(), refresh_token: None, expires_at: None, identity: None };
        Arc::new(DevinAdapter::new(None, http, Arc::new(StaticSessionToken::new(credentials, "devin-stall"))))
    };
    let request = ModelRequest {
        model: "swe-1-6".into(),
        messages: vec![Message::new(Role::User, Content::Text("hi".into()))],
        tools: Vec::new(),
        options: RequestOptions::default(),
    };
    let wire = WireStalls { opening: response_frame(1, "msg-1"), output: response_frame(3, "hi"), retried: false, ..chat() };
    assert_stalls(build, &request, &wire).await;
}
