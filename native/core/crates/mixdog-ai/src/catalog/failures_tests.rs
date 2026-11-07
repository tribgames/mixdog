//! The catalog failure store against Node's (`fixtures/catalog-errors/golden.json`,
//! `record-catalog-errors.mjs`): the failures `recordProviderCatalogOutcome` held for each scenario,
//! re-recorded from the errors Rust would raise for the same failure.
//!
//! The kind is NOT taken from Node's answer. A Rust boundary types a failure from facts (the status,
//! the provider's code, the transport fault) with `retry::classify::kind_of`, and a catalog listing
//! that missed its deadline is stamped by the catalog itself (`store::deadline_error`); the rendered
//! `catalogError.errorKind` is compared whole, so a case where the typed mapping and Node's verdict
//! differ fails here unless it is listed in `KNOWN_DIFFERENCES`.

use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::TransportFault;
use mixdog_protocol::ProviderId;
use serde_json::Value;

use super::failures::CatalogFailureStore;
use super::store::deadline_error;
use crate::retry::classify::Facts;
use crate::retry::classify::kind_of;

const GOLDEN: &str = include_str!("../../../../fixtures/catalog-errors/golden.json");

/// Cases where Node's kind is derived from the MESSAGE TEXT of an untyped error, which no Rust
/// boundary produces: a Rust adapter always has the status and the provider's code of a refused
/// listing (so "maximum context length exceeded" arrives as a 400 with `context_length_exceeded`,
/// which both sides type the same, see "typed codes"). Fed only the text, Rust's typed mapping has
/// no fact to type it by and answers `unknown` where Node reads the wording. (scenario, provider,
/// Node's kind). Recorded in decisions.md.
const KNOWN_DIFFERENCES: [(&str, &str, &str); 1] = [("message-only wordings", "gemini", "context_overflow")];

/// The error a Rust boundary would raise for the failure Node's recording was made from.
fn rust_error(provider: &str, raw: &Value, message: String) -> ProviderError {
    let status = raw["status"].as_u64().filter(|status| *status > 0).map(|status| status as u16);
    let code = raw["code"].as_str();
    // The catalog's own deadline.
    if code == Some("ETIMEDOUT") && status.is_none() {
        return deadline_error(&ProviderId::from(provider));
    }
    // A request that never got an answer is a transport fault, typed by the transport.
    let connect = TransportFault::Connect { os_code: None };
    let transport = (message == "fetch failed").then_some(&connect);
    let kind = kind_of(&Facts { status, code, transport, ..Facts::default() });
    let mut error = ProviderError::new(kind, DeliveryState::NotSent);
    error.message = message;
    error.status = status;
    error.code = code.map(str::to_owned);
    if transport.is_some() {
        error.transport = Some(connect.clone());
    }
    error
}

#[test]
fn the_held_failures_are_nodes_for_every_scenario() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let scenarios = golden["scenarios"].as_array().unwrap();
    assert_eq!(scenarios.len(), 14);
    let mut compared = 0;
    for scenario in scenarios {
        let name = scenario["name"].as_str().unwrap();
        let store = CatalogFailureStore::default();
        let held = scenario["held"].as_object().unwrap();
        for (provider, raw) in scenario["raw"].as_object().unwrap() {
            // Node appends the provider's own message to the error's; here it is the error's text.
            let message = match raw["providerMessage"].as_str() {
                Some(reason) => format!("{}: {reason}", raw["message"].as_str().unwrap()),
                None => raw["message"].as_str().unwrap().to_owned(),
            };
            store.record(provider, &rust_error(provider, raw, message));
        }
        for provider in scenario["recover"].as_array().unwrap() {
            store.recover(provider.as_str().unwrap());
        }
        for (provider, want) in held {
            let got = store.failure(provider).unwrap_or_else(|| panic!("{name}: {provider} not held"));
            assert_eq!(got.message, want["message"].as_str().unwrap(), "{name}: {provider}: message");
            let known = KNOWN_DIFFERENCES.iter().find(|(scenario, who, _)| *scenario == name && who == provider);
            if let Some((_, _, node_kind)) = known {
                assert_eq!(want["errorKind"]["kind"], *node_kind, "{name}: {provider}: the listed difference is still Node's");
                assert_eq!(got.error_kind["kind"], "unknown", "{name}: {provider}: Rust has no fact to type it by");
                continue;
            }
            assert_eq!(serde_json::to_string(&got.error_kind).unwrap(), serde_json::to_string(&want["errorKind"]).unwrap(), "{name}: {provider}: errorKind");
            compared += 1;
        }
        for provider in scenario["raw"].as_object().unwrap().keys().filter(|provider| !held.contains_key(*provider)) {
            assert!(store.failure(provider).is_none(), "{name}: {provider} was recovered");
        }
    }
    assert!(compared >= 30, "the golden compares many kinds ({compared})");
}

#[test]
fn an_account_change_clears_every_failure() {
    let store = CatalogFailureStore::default();
    let mut error = ProviderError::new(ErrorKind::Auth, DeliveryState::NotSent);
    error.message = "expired".into();
    store.record("openai", &error);
    store.record("xai", &error);
    store.clear();
    assert!(store.failure("openai").is_none() && store.failure("xai").is_none());
}