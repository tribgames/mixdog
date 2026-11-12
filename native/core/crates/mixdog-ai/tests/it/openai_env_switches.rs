//! The environment switches of the OpenAI wire: `MIXDOG_OAI_STATELESS_HTTP` drops the three session anchors of the
//! HTTP/SSE request (`_buildOpenAIHttpFallbackHeaders` with `statelessConversation`, Node run on `statelessConversation:
//! true|false`: the three `session_id`, `session-id`, `thread-id` names are the only difference), and only the on/off
//! spellings of `shared/env.mjs` `envFlag` count.

use std::sync::Arc;

use mixdog_ai::providers::openai::codec::OpenAiCodec;
use mixdog_ai::providers::openai::config::CodexIdentity;
use mixdog_ai::providers::openai::config::ModelFacts;
use mixdog_ai::providers::openai::config::ModelFactsSource;
use mixdog_ai::providers::openai::config::OpenAiConfig;
use mixdog_ai::providers::openai::config::WireContext;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderReplay;
use mixdog_ai::providers::openai::config::REPLAY_OWNER;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_protocol::ProviderId;
use mixdog_core_api::domain::provider::WireCodec;

struct Ctx(&'static str, Option<&'static str>);

impl WireContext for Ctx {
    fn request_id(&self) -> String {
        "0".repeat(32)
    }
    fn now_unix_ms(&self) -> u64 {
        0
    }
    fn turn_state(&self, _scope: &str, _turn_id: &str) -> Option<String> {
        None
    }
    fn var(&self, name: &str) -> Option<String> {
        (name == self.0).then(|| self.1.map(str::to_owned)).flatten()
    }
}

struct Facts;
impl ModelFactsSource for Facts {
    fn facts(&self, _model: &str) -> ModelFacts {
        ModelFacts::default()
    }
}

fn codec(name: &'static str, setting: Option<&'static str>) -> OpenAiCodec {
    let identity = CodexIdentity {
        installation_id: "i".into(),
        user_agent: "ua".into(),
        version: "0.166.0".into(),
        beta_features: "remote_compaction_v2".into(),
    };
    OpenAiCodec::new(OpenAiConfig::codex(false, false, identity, Arc::new(Facts), Arc::new(Ctx(name, setting))), TransportKind::Http1)
}

fn anchors(setting: Option<&'static str>) -> Vec<String> {
    let codec = codec("MIXDOG_OAI_STATELESS_HTTP", setting);
    let request = ModelRequest {
        model: "gpt-fixture".into(),
        messages: vec![Message::new(Role::User, Content::Text("go".into()))],
        tools: vec![],
        options: RequestOptions { session_id: Some("s".into()), prompt_cache_key: Some("k".into()), ..Default::default() },
    };
    let wire = codec.encode(&request).unwrap();
    wire.headers.into_iter().map(|(name, _)| name).filter(|name| ["session_id", "session-id", "thread-id"].contains(&name.as_str())).collect()
}

#[test]
fn the_stateless_http_setting_drops_the_session_anchors_as_node_does() {
    let all = ["session_id", "session-id", "thread-id"];
    assert_eq!(anchors(None), all);
    for on in ["1", "true", "yes", "on", " ON "] {
        assert!(anchors(Some(on)).is_empty(), "{on:?}");
    }
    for off in ["0", "false", "off", "no", "bogus", ""] {
        assert_eq!(anchors(Some(off)), all, "{off:?}");
    }
}

/// `MIXDOG_OAI_DISABLE_REASONING_REPLAY` (`replaysEncryptedReasoning`): on, the encrypted reasoning a reply carried is not sent back.
#[test]
fn the_reasoning_replay_kill_switch_keeps_reasoning_off_the_wire_as_node_does() {
    let sent = |setting: Option<&'static str>| {
        let codec = codec("MIXDOG_OAI_DISABLE_REASONING_REPLAY", setting);
        let mut reply = Message::new(Role::Assistant, Content::Text("ok".into()));
        let item = serde_json::json!({"type": "reasoning", "id": "rs_1", "encrypted_content": "ENC", "summary": []});
        reply.push_replay(ProviderReplay { owner: ProviderId::from(REPLAY_OWNER), items: serde_json::json!([item]) });
        let request = ModelRequest {
            model: "gpt-fixture".into(),
            messages: vec![Message::new(Role::User, Content::Text("go".into())), reply, Message::new(Role::User, Content::Text("more".into()))],
            tools: vec![],
            options: RequestOptions::default(),
        };
        String::from_utf8(codec.encode(&request).unwrap().body).unwrap().contains("ENC")
    };
    assert!(sent(None));
    assert!(!sent(Some("1")));
    assert!(sent(Some("0")));
}
