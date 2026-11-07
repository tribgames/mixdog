//! The per-provider sign-in rules against the recorded `oauthCredentialProbeState`
//! (`fixtures/oauth-credential-validity/golden.json`): a stored document the rule rejects reads absent.

use serde_json::Value;

use super::validity::credential_valid;

/// A JWT-shaped token is what the secret scan refuses in a fixture: the golden holds `{"$jwt": exp}`
/// and the replay builds the same unsigned token (header and payload only carry `alg` and `exp`).
fn expand(value: &Value) -> Value {
    use base64::Engine;
    let b64 = |value: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string());
    match value {
        Value::Object(map) if map.contains_key("$jwt") => Value::String(format!("{}.{}.sig", b64(&serde_json::json!({"alg": "none"})), b64(&serde_json::json!({"exp": map["$jwt"]})))),
        Value::Object(map) => Value::Object(map.iter().map(|(key, inner)| (key.clone(), expand(inner))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(expand).collect()),
        other => other.clone(),
    }
}

#[test]
fn every_recorded_document_reads_as_the_real_probe_reads_it() {
    let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/oauth-credential-validity/golden.json")).expect("fixture");
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 50);
    // The expiries are 2001 or 2096: the answer is the same on any day from now to then.
    let now = 1_800_000_000_000.0;
    let mut providers = std::collections::BTreeSet::new();
    for case in cases {
        let provider = case["provider"].as_str().expect("provider");
        let document = expand(&case["document"]);
        let got = credential_valid(provider, document.as_object().expect("document"), now);
        let want = case["state"] == "present";
        assert_eq!(got, want, "{provider}: {}", case["name"]);
        providers.insert(provider.to_owned());
    }
    assert_eq!(providers.len(), 10, "every provider has its rule recorded");
}