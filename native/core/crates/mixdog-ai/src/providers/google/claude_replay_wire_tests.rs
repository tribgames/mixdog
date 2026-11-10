//! Claude through Antigravity replays its history as Node does, against Node's recordings
//! (`fixtures/provider-wire/antigravity-claude`, recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs`
//! from the cases of `antigravity-request.test.mjs:402-795` sent through `AntigravityOAuthProvider`): empty parts,
//! rejoined and unsigned or foreign thinking, and the closing of an unthought tool loop. The real codec encodes each
//! history (compared with the bytes Node sent, the per-send `requestId` aside) and decodes the recorded answer, compared
//! whole with Node's result (the replay envelope the next turn sends back included).

use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::WireCodec;
use serde_json::Value;

use super::auth::antigravity::ENDPOINT;
use super::codec::GoogleCodec;
use super::traits::CatalogGoogleTraits;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::message;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::scenarios;
use crate::providers::wire_fixtures::tools;

/// A body with its per-send `requestId` (`agent-<randomUUID>`) removed.
fn without_request_id(body: &str) -> Value {
    let mut value: Value = serde_json::from_str(body).unwrap();
    value.as_object_mut().unwrap().shift_remove("requestId");
    value
}

#[test]
fn every_claude_history_is_replayed_as_node_replays_it() {
    let names = scenarios("antigravity-claude");
    assert_eq!(names.len(), 17, "{names:?}");
    for name in names {
        let recorded = load("antigravity-claude", &name);
        let input = &recorded.input;
        let codec = GoogleCodec::antigravity(ENDPOINT, "fixture-project", "2.19.1", Arc::new(CatalogGoogleTraits(Vec::new())));
        let model = input["model"].as_str().unwrap();
        let request = ModelRequest {
            model: model.to_owned(),
            messages: input["messages"].as_array().unwrap().iter().map(message).collect(),
            tools: tools(&input["tools"]),
            options: RequestOptions { effort: input["opts"]["effort"].as_str().map(str::to_owned), ..RequestOptions::default() },
        };
        let wire = codec.encode(&request).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let posts = recorded.posts("streamGenerateContent");
        assert_eq!(posts.len(), 1, "{name}: one send");
        let post = posts[0];
        assert_eq!(wire.url, format!("{}{}", post["origin"].as_str().unwrap(), post["path"].as_str().unwrap()), "{name}: url");
        let sent = String::from_utf8(wire.body).unwrap();
        assert_eq!(without_request_id(&sent).to_string(), without_request_id(post["bodyText"].as_str().unwrap()).to_string(), "{name}: body");
        let mut decoder = codec.decoder(&request);
        let mut events = decoder.feed(post["served"].as_str().unwrap().as_bytes()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        events.extend(decoder.finish().unwrap_or_else(|e| panic!("{name}: {e:?}")));
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}: result"));
    }
}
