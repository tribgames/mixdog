//! Replays `first-response-budgets` (the budget each provider states, one environment per case): the settings Node reads
//! from the environment (`FirstByteSettings::from_env` over the recorded variables), then the real adapters'
//! `first_response_budget`, compared whole. Vertex AI states one for a Flex route only; Antigravity one per model family
//! on the same-host ladder the variables set (`policy::antigravity_with`); Mimo one over its profile's ladder, held to the
//! environment's ceiling; the other OpenAI-compatible providers none.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::WireRequest;

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




fn compat(profile: CompatProfile, settings: &FirstByteSettings) -> CompatAdapter {
    let key: Option<Arc<dyn ApiKeySource>> = (profile.credential != CredentialKind::Keyless).then(|| Arc::new(Key) as Arc<dyn ApiKeySource>);
    CompatAdapter::new(CompatChatCodec::new(profile, CompatConfig::default()), Arc::new(Idle), key).with_first_byte(settings.clone())
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


