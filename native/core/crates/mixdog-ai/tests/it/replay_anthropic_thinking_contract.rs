//! `fixtures/provider-anthropic-thinking-contract` (PURE): with an empty catalog (`setModelEffortCapabilities([])`), the
//! caps the product builds (`CatalogCaps::lookup`, the builder's Anthropic caps) make the Anthropic codec refuse a manual
//! thinking budget on an adaptive-only model with Node's text (`applyAnthropicEffortToBody`), and build the subscription
//! body Node builds (`_buildRequestBodyForCacheSmoke`) per model and effort, whole. Every one of the 15 cases is read here.

use std::sync::Arc;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::catalog::CatalogSnapshot;
use mixdog_ai::catalog::ModelsDevSource;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::anthropic::AnthropicCodec;
use mixdog_ai::providers::anthropic::AnthropicConfig;
use mixdog_ai::providers::anthropic::Flavor;
use mixdog_ai::providers::anthropic::catalog_caps::CatalogCaps;
use mixdog_ai::registry::keys::Environment;
use mixdog_ai::transport::KeepaliveSchedule;
use mixdog_ai::transport::ReqwestLink;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::WireCodec as _;
use mixdog_testkit::Exact;
use mixdog_testkit::provider_fields::error_field;
use serde_json::Value;
use serde_json::json;

use crate::provider_case::CaseSet;
use crate::provider_case::Endpoint;
use crate::provider_cases::plain;

/// The recorder's scrubbed environment: no variable is set.
struct NoVars;

impl Environment for NoVars {
    fn var(&self, _: &str) -> Option<String> {
        None
    }
}

pub const REPLAYS: &[crate::provider_case::Replay] = &[crate::provider_case::Replay { set: "anthropic-thinking-contract", run: every_case_answers_as_nodes }];

#[tokio::test(start_paused = true)]
async fn every_case_answers_as_nodes() {
    let set = CaseSet::load("anthropic-thinking-contract");
    assert_eq!(set.cases.len(), 15, "the recorded cases");
    let endpoint = Endpoint::start().await;
    let home = tempfile::tempdir().expect("a home");
    let tokens = mixdog_rt::testing::tokens();
    let io = CredentialIo { read: tokens.interactive_io, write: tokens.durability_io };
    let link = Arc::new(endpoint.link(ReqwestLink::new(&KeepaliveSchedule::SPEC, false).expect("the production link")));
    let catalog = Arc::new(CatalogService::cold_start(CatalogSnapshot::default(), Vec::new(), ModelsDevSource::new(link, home.path().join("catalog"), io)).await);
    let codec = AnthropicCodec::new(Flavor::OAuth, AnthropicConfig::new(CatalogCaps::new(catalog, &NoVars).lookup()));
    for case in &set.cases {
        let id = case.id.as_str();
        let recorded = case.recorded();
        let entry = |n: usize| case.calls[n].entry.rsplit('.').next().expect("an entry").to_owned();
        if id.starts_with("adaptive-only-rejects-manual-budget:") {
            assert_eq!(case.calls.len(), 1, "{id}");
            assert_eq!(entry(0), "applyAnthropicEffortToBody", "{id}");
            let params = &case.calls[0].args[1];
            let opts = plain(params.get("opts"));
            let request = ModelRequest {
                model: params.get("model").as_str().to_owned(),
                messages: Vec::new(),
                tools: Vec::new(),
                options: RequestOptions {
                    effort: opts["effort"].as_str().map(str::to_owned),
                    model_max_output_tokens: Some(params.get("maxTokens").as_f64() as u32),
                    // A JS number's plain form is a float; the product's parameters arrive as config JSON integers.
                    model_parameters: Some(json!({ "thinkingBudgetTokens": opts["thinkingBudgetTokens"].as_f64().expect("a budget") as u64 })),
                    ..RequestOptions::default()
                },
            };
            let outcome = match codec.encode(&request) {
                Ok(_) => Exact::Null,
                Err(refused) => {
                    // A TypeError thrown before anything is written: a local refusal (invalid, never sent) with Node's text and
                    // no other field, each through the shared table.
                    let mut want = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
                    want.message.clone_from(&refused.message);
                    assert_eq!(refused, want, "{id}: a local refusal, its message only ({})", error_field("name"));
                    Exact::Error { name: "TypeError".into(), message: refused.message.clone(), code: None, cause: None, props: Vec::new() }
                }
            };
            // `bodyAfter` is declared not compared by the manifest; any other recorded property fails the set's drop.
            let _ = error_field("message");
            recorded.get("threw").assert_eq(&format!("{id}: threw"), &outcome);
        } else {
            let entries: Vec<String> = (0..case.calls.len()).map(entry).collect();
            assert_eq!(entries, ["setModelEffortCapabilities", "_buildRequestBodyForCacheSmoke"], "{id}");
            assert!(case.calls[0].args[0].as_array().is_empty(), "{id}: the empty catalog");
            let args = &case.calls[1].args;
            let messages = args[0]
                .as_array()
                .iter()
                .map(|m| {
                    assert_eq!(m.get("role").as_str(), "user", "{id}");
                    Message::new(Role::User, Content::Text(m.get("content").as_str().to_owned()))
                })
                .collect();
            assert!(args[2].as_array().is_empty(), "{id}: no tools");
            let opts = plain(&args[3]);
            assert_eq!(opts.as_object().expect("opts").len(), 1, "{id}: effort only");
            let request = ModelRequest {
                model: args[1].as_str().to_owned(),
                messages,
                tools: Vec::new(),
                options: RequestOptions { effort: opts["effort"].as_str().map(str::to_owned), ..RequestOptions::default() },
            };
            let wire = codec.encode(&request).unwrap_or_else(|e| panic!("{id}: {}", e.message));
            let body: Value = serde_json::from_slice(&wire.body).expect("a JSON body");
            recorded.get("body").assert_eq(&format!("{id}: the request body"), &Exact::plain(&body));
        }
    }
}
