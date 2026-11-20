//! Node-recorded twin: `fixtures/ai-admin/effort-configuration-twin.json`
//! (`benchmarks/rust-core/recorders/record-effort-configuration.mjs`).
use super::*;
use serde_json::json;

#[test]
fn the_oauth_catalogs_own_answer_beats_the_version() {
    let none = UnsupportedEfforts::default();
    let model = json!("gpt-5.4");
    let mode = |declared: Option<bool>| {
        effort_configuration_mode("openai-oauth", &model, &json!({}), &none, &move |id| {
            assert_eq!(id, "gpt-5.4");
            declared
        })
    };
    assert_eq!(mode(Some(true)), Some(UpdateMode::Responses));
    assert_eq!(mode(Some(false)), None);
    assert_eq!(mode(None), None);
}
