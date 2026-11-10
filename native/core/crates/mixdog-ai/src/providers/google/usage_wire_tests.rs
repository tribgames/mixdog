//! Gemini usage with each field missing in turn, against Node's recordings (`fixtures/provider-wire/gemini-usage`,
//! recorded by `benchmarks/rust-core/recorders/record-provider-wire.mjs` through the Gemini API and Vertex AI express):
//! the real codec encodes the turn (compared with the bytes Node sent) and decodes the recorded stream, compared whole
//! with Node's result.

use std::sync::Arc;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec;

use super::codec::GEMINI_ORIGIN;
use super::codec::GoogleCodec;
use super::serving::VertexPlace;
use super::traits::CatalogGoogleTraits;
use crate::providers::wire_fixtures::assert_same_result;
use crate::providers::wire_fixtures::core_result;
use crate::providers::wire_fixtures::load;
use crate::providers::wire_fixtures::node_result;
use crate::providers::wire_fixtures::scenarios;

#[test]
fn every_usage_shape_reads_as_node_reads_it() {
    let names = scenarios("gemini-usage");
    assert_eq!(names.len(), 16, "{names:?}");
    for name in names {
        let recorded = load("gemini-usage", &name);
        let input = &recorded.input;
        let traits = Arc::new(CatalogGoogleTraits(Vec::new()));
        let codec = match input["provider"].as_str().unwrap() {
            "gemini" => GoogleCodec::gemini(GEMINI_ORIGIN, traits),
            "vertex-ai-express" => GoogleCodec::vertex(VertexPlace::express(), traits),
            other => panic!("{other}"),
        };
        let messages = input["messages"].as_array().unwrap();
        let text = |i: usize| Content::Text(messages[i]["content"].as_str().unwrap().to_owned());
        let model = input["model"].as_str().unwrap();
        let request = ModelRequest {
            model: model.to_owned(),
            messages: vec![Message::new(Role::System, text(0)), Message::new(Role::User, text(1))],
            tools: Vec::new(),
            options: RequestOptions::default(),
        };
        let wire = codec.encode(&request).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        let posts = recorded.posts("");
        assert_eq!(posts.len(), 1, "{name}: one send");
        assert_eq!(wire.url, format!("{}{}", posts[0]["origin"].as_str().unwrap(), posts[0]["path"].as_str().unwrap()), "{name}: url");
        assert_eq!(String::from_utf8(wire.body).unwrap(), posts[0]["bodyText"].as_str().unwrap(), "{name}: body");
        let mut decoder = codec.decoder(&request);
        let mut events = decoder.feed(posts[0]["served"].as_str().unwrap().as_bytes()).unwrap_or_else(|e| panic!("{name}: {e:?}"));
        events.extend(decoder.finish().unwrap_or_else(|e| panic!("{name}: {e:?}")));
        assert_same_result(&core_result(&events, model), &node_result(&recorded.result), &format!("{name}"));
    }
}
