//! Replays `first-response-budgets` (the budget each provider states, one environment per case): the settings Node reads
//! from the environment (`FirstByteSettings::from_env` over the recorded variables), then the real adapters'
//! `first_response_budget`, compared whole. Vertex AI states one for a Flex route only; Antigravity one per model family
//! on the same-host ladder the variables set (`policy::antigravity_with`); Mimo one over its profile's ladder, held to the
//! environment's ceiling; the other OpenAI-compatible providers none.

use std::sync::Arc;

use async_trait::async_trait;
#[cfg(node_twin)]
use mixdog_core_api::domain::provider::FirstResponseBudget;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;
#[cfg(node_twin)]
use serde_json::Value;
#[cfg(node_twin)]
use serde_json::json;

#[cfg(node_twin)]
use super::GoogleAdapter;
#[cfg(node_twin)]
use super::auth::ApiKeyAuth;
#[cfg(node_twin)]
use super::codec::GoogleCodec;
#[cfg(node_twin)]
use super::policy;
#[cfg(node_twin)]
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

#[cfg(node_twin)]
fn plain(budget: Option<FirstResponseBudget>) -> Value {
    budget.map_or(Value::Null, |b| json!({ "transportMs": b.transport_ms, "semanticMs": b.semantic_ms }))
}

#[cfg(node_twin)]
fn settings_of(env: &Value) -> FirstByteSettings {
    FirstByteSettings::from_env(|name| env.get(name).and_then(Value::as_str).map(str::to_owned))
}

#[cfg(node_twin)]
fn antigravity(settings: &FirstByteSettings) -> GoogleAdapter {
    let traits = Arc::new(CatalogGoogleTraits(Vec::new()));
    GoogleAdapter::new(GoogleCodec::antigravity(super::auth::antigravity::ENDPOINT, "p", "2.19.1", traits), policy::antigravity_with(settings), Arc::new(Idle), Arc::new(ApiKeyAuth::new("k")), "p".into())
        .with_first_byte(settings.clone())
}

fn compat(profile: CompatProfile, settings: &FirstByteSettings) -> CompatAdapter {
    let key: Option<Arc<dyn ApiKeySource>> = (profile.credential != CredentialKind::Keyless).then(|| Arc::new(Key) as Arc<dyn ApiKeySource>);
    CompatAdapter::new(CompatChatCodec::new(profile, CompatConfig::default()), Arc::new(Idle), key).with_first_byte(settings.clone())
}

#[cfg(node_twin)]
/// Deliberate: Node states Antigravity's budget over the whole same-host ladder; the watchdog's clock restarts with every attempt,
/// so a model here states one attempt's per-phase windows (head, then first payload: the same window twice), no longer than
/// Node's ladder.
fn assert_one_attempt(adapter: &GoogleAdapter, recorded: &Value, what: &str) {
    for (model, ladder) in recorded.as_object().unwrap() {
        let stated = adapter.first_response_budget(model, None).expect("an Antigravity model states a budget");
        let (transport, semantic) = (ladder["transportMs"].as_i64().unwrap(), ladder["semanticMs"].as_i64().unwrap());
        assert!(0 < stated.transport_ms && stated.transport_ms <= transport, "{what}: {model} transport {} of {transport}", stated.transport_ms);
        assert_eq!(stated.semantic_ms, stated.transport_ms, "{what}: {model}: the first payload waits the head's window again");
        assert!(stated.semantic_ms <= semantic, "{what}: {model} semantic {} of {semantic}", stated.semantic_ms);
    }
}

/// The decided rule, exactly, at the default environment: every Gemini route (the Gemini API, Antigravity Pro and Flash) waits 285,000 ms
/// for its head and 285,000 ms for its first payload, with one first-byte retry that header and payload timeouts share; the
/// watchdog is handed those two windows, not a sum. Compat Mimo declares its own 285,000 ms the same way.
#[test]
fn the_gemini_family_declares_285_seconds_per_phase_with_one_shared_first_byte_retry() {
    let settings = FirstByteSettings::from_env(|_| None);
    for (what, policy) in [("gemini api", settings.gemini_policy()), ("antigravity pro", settings.antigravity_policy(Some("gemini-pro"))), ("antigravity flash", settings.antigravity_policy(Some("gemini-flash")))] {
        assert_eq!(policy.timeout_ms, 285_000, "{what}: the head and payload window");
        assert_eq!(policy.retries, Some(1), "{what}: one first-byte retry, counted for headers and first-chunk timeouts together");
        let budget = crate::providers::first_byte::attempt_budget(&policy);
        assert_eq!((budget.transport_ms, budget.semantic_ms), (285_000, 285_000), "{what}: the windows the watchdog is handed");
    }
    let mimo = compat(CompatProfile::mimo_oauth(), &settings).first_response_budget("", None).expect("declared");
    assert_eq!((mimo.transport_ms, mimo.semantic_ms), (285_000, 285_000), "Mimo declares its profile's window, per phase");
}


#[cfg(node_twin)]
const GOLDEN: mixdog_testkit::Fixture = mixdog_testkit::fixture_const!("../../fixtures/first-response-budgets/golden.json");
#[cfg(node_twin)]
#[test]
fn every_provider_states_the_budget_node_states_in_each_environment() {
    let golden: Value = serde_json::from_str(&GOLDEN).unwrap();
    let mut compared = 0;
    for case in golden["cases"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let observed = &case["observed"];
        let settings = settings_of(&observed["env"]);
        let budgets = &observed["budgets"];

        // What the environment resolves to, variable by variable (the recorded settings of Node's modules), whole.
        let resolved = json!({
            "maxBeforeWarnMs": settings.max_before_warn_ms, "providerMs": settings.provider_ms, "geminiMs": settings.gemini_ms, "antigravityProMs": settings.antigravity_pro_ms,
            "antigravityAttempts": settings.antigravity_attempts, "antigravityBackoffMs": settings.antigravity_backoff_ms, "antigravityFirstByteRetries": settings.antigravity_first_byte_retries,
        });
        assert_eq!(resolved, budgets["settings"], "{name}: the settings the environment resolves to");
        // Deliberate: every Gemini route waits one long first-byte window, not Node's shared 60 s (`gemini_long_ms`), so the
        // recorded Flash budgets (the default model is one), Vertex AI's standard budget and the Gemini API's lack of a budget
        // are not compared; `head_wait_tests` states the values of the rule that replaced them.

        // Node reads the variables as its modules load: the environment changed afterwards moves no budget.
        let cell = std::sync::Mutex::new(None);
        let at_start = FirstByteSettings::once(&cell, |variable| observed["env"].get(variable).and_then(Value::as_str).map(str::to_owned));
        let later = FirstByteSettings::once(&cell, |variable| budgets["changedTo"].get(variable).and_then(Value::as_str).map(str::to_owned));
        assert_eq!(later, at_start, "{name}: a later change of the environment is not read");
        let adapter = antigravity(&later);
        let kept = |recorded: &Value| -> Value { Value::Object(recorded.as_object().unwrap().iter().filter(|(model, _)| !model.contains("flash") && !model.is_empty()).map(|(model, budget)| (model.clone(), budget.clone())).collect()) };
        assert_one_attempt(&adapter, &kept(&budgets["afterEnvironmentChange"]), &format!("{name}: after the environment changed"));

        let vertex = super::vertex_express("k", Arc::new(Idle), Arc::new(CatalogGoogleTraits(Vec::new())));
        let ask = |parameters: Option<Value>| plain(vertex.first_response_budget("gemini-3.6-flash", parameters.as_ref()));
        let got = json!({
            "noOptions": ask(None), "standard": ask(Some(json!({}))), "flex": ask(Some(json!({ "serviceTier": "flex" }))),
            "flexUpperCase": ask(Some(json!({ "serviceTier": "FLEX" }))), "priority": ask(Some(json!({ "serviceTier": "priority" }))),
            "unknownTier": ask(Some(json!({ "serviceTier": "turbo" }))),
        });
        let flex_only = |value: &Value| json!({ "flex": value["flex"], "flexUpperCase": value["flexUpperCase"] });
        assert_eq!(flex_only(&got), flex_only(&budgets["vertex"]), "{name}: vertex-ai");

        // Compat Mimo's budget was Node's sum over its retry ladder, which stood in for a handoff the phase clock now makes
        // directly: it declares its profile's window per phase (head, then first payload), one attempt's, and no more.
        let mimo = compat(CompatProfile::mimo_oauth(), &settings).first_response_budget("", None).expect("Mimo declares its window");
        let window = settings.compat(CompatProfile::mimo_oauth().chat.first_byte.expect("Mimo has a first-byte window of its own")).timeout_ms;
        assert_eq!((mimo.transport_ms, mimo.semantic_ms), (window, window), "{name}: Mimo's per-phase windows");
        let mut got = serde_json::Map::new();
        for (id, profile) in [("xai", CompatProfile::xai()), ("deepseek", CompatProfile::deepseek()), ("openrouter", CompatProfile::openrouter()), ("command-code-oauth", CompatProfile::command_code_oauth()), ("muse-code-oauth", CompatProfile::muse_code_oauth()), ("opencode-go-oauth", CompatProfile::opencode_go())] {
            got.insert(id.into(), plain(compat(profile, &settings).first_response_budget("", None)));
        }
        let mut recorded = budgets["compat"].as_object().unwrap().clone();
        recorded.remove("mimo-oauth");
        assert_eq!(Value::Object(got), Value::Object(recorded), "{name}: the other OpenAI-compatible providers");

        let adapter = antigravity(&settings);
        assert_one_attempt(&adapter, &kept(&budgets["antigravity"]), &format!("{name}: antigravity-oauth"));

        compared += 1;
    }
    assert_eq!(compared, golden["cases"].as_array().unwrap().len());
}
