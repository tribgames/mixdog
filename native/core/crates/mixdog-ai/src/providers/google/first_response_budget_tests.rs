//! Replays `first-response-budgets` (the budget each provider states, one environment per case): the settings Node reads
//! from the environment (`FirstByteSettings::from_env` over the recorded variables), then the real adapters'
//! `first_response_budget`, compared whole. Vertex AI states one for a Flex route only; Antigravity one per model family
//! on the same-host ladder the variables set (`policy::antigravity_with`); Mimo one over its profile's ladder, held to the
//! environment's ceiling; the other OpenAI-compatible providers none.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;
use serde_json::json;

use super::GoogleAdapter;
use super::auth::ApiKeyAuth;
use super::codec::GoogleCodec;
use super::policy;
use super::traits::CatalogGoogleTraits;
use crate::providers::compat::adapter::CompatAdapter;
use crate::providers::compat::CompatChatCodec;
use crate::providers::compat::CompatConfig;
use crate::providers::compat::profile::CompatProfile;
use crate::providers::compat::profile::CredentialKind;
use crate::providers::first_byte::FirstByteSettings;
use crate::providers::key_source::ApiKeySource;
use crate::transport::Exchange;
use crate::transport::HttpResponse;
use crate::transport::HttpSend;

const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/first-response-budgets/golden.json");

struct Idle;

#[async_trait]
impl HttpSend for Idle {
    async fn send(&self, _: WireRequest, _: Exchange) -> Result<HttpResponse, ProviderError> {
        unreachable!("a budget is stated without a request")
    }
}

struct Key;

#[async_trait]
impl ApiKeySource for Key {
    async fn key(&self) -> Result<String, ProviderError> {
        Ok("k".into())
    }
    async fn reload(&self) -> Result<String, ProviderError> {
        Ok("k".into())
    }
}

fn plain(budget: Option<FirstResponseBudget>) -> Value {
    budget.map_or(Value::Null, |b| json!({ "transportMs": b.transport_ms, "semanticMs": b.semantic_ms }))
}

fn settings_of(env: &Value) -> FirstByteSettings {
    FirstByteSettings::from_env(|name| env.get(name).and_then(Value::as_str).map(str::to_owned))
}

fn antigravity(settings: &FirstByteSettings) -> GoogleAdapter {
    let traits = Arc::new(CatalogGoogleTraits(Vec::new()));
    GoogleAdapter::new(GoogleCodec::antigravity(super::auth::antigravity::ENDPOINT, "p", "2.19.1", traits), policy::antigravity_with(settings), Arc::new(Idle), Arc::new(ApiKeyAuth::new("k")), "p".into())
        .with_first_byte(settings.clone())
}

fn compat(profile: CompatProfile, settings: &FirstByteSettings) -> CompatAdapter {
    let key: Option<Arc<dyn ApiKeySource>> = (profile.credential != CredentialKind::Keyless).then(|| Arc::new(Key) as Arc<dyn ApiKeySource>);
    CompatAdapter::new(CompatChatCodec::new(profile, CompatConfig::default()), Arc::new(Idle), key).with_first_byte(settings.clone())
}

#[test]
fn every_provider_states_the_budget_node_states_in_each_environment() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let observed = &case["observed"];
        let settings = settings_of(&observed["env"]);
        let budgets = &observed["budgets"];

        let vertex = super::vertex_express("k", Arc::new(Idle), Arc::new(CatalogGoogleTraits(Vec::new())));
        let ask = |parameters: Option<Value>| plain(vertex.first_response_budget("gemini-3.6-flash", parameters.as_ref()));
        let got = json!({
            "noOptions": ask(None), "standard": ask(Some(json!({}))), "flex": ask(Some(json!({ "serviceTier": "flex" }))),
            "flexUpperCase": ask(Some(json!({ "serviceTier": "FLEX" }))), "priority": ask(Some(json!({ "serviceTier": "priority" }))),
            "unknownTier": ask(Some(json!({ "serviceTier": "turbo" }))),
        });
        assert_eq!(got, budgets["vertex"], "{name}: vertex-ai");

        let mut got = serde_json::Map::new();
        got.insert("mimo-oauth".into(), plain(compat(CompatProfile::mimo_oauth(), &settings).first_response_budget("", None)));
        for (id, profile) in [("xai", CompatProfile::xai()), ("deepseek", CompatProfile::deepseek()), ("openrouter", CompatProfile::openrouter()), ("command-code-oauth", CompatProfile::command_code_oauth()), ("muse-code-oauth", CompatProfile::muse_code_oauth()), ("opencode-go-oauth", CompatProfile::opencode_go())] {
            got.insert(id.into(), plain(compat(profile, &settings).first_response_budget("", None)));
        }
        assert_eq!(Value::Object(got), budgets["compat"], "{name}: the OpenAI-compatible providers");

        let adapter = antigravity(&settings);
        let got: serde_json::Map<String, Value> = budgets["antigravity"].as_object().unwrap().keys().map(|model| (model.clone(), plain(adapter.first_response_budget(model, None)))).collect();
        assert_eq!(Value::Object(got), budgets["antigravity"], "{name}: antigravity-oauth");

        assert_eq!(plain(super::gemini("k", Arc::new(Idle), Arc::new(CatalogGoogleTraits(Vec::new()))).first_response_budget("gemini-3.6-flash", None)), Value::Null, "{name}: the Gemini API states none");
        compared += 1;
    }
    assert_eq!(compared, golden["cases"].as_array().unwrap().len());
}
