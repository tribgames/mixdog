//! The auto-effort step judge of a run (`session/loop/step-auto-effort.mjs`, `stepResult`): the
//! shared model plus the ladder of the turn. A custom (`custom-*`) route snaps the judged effort
//! onto its model row's own levels (`CustomLadder`, `resolveCustomReasoning`); every other route
//! moves along the ladder `effortOptionsFor` gives it (`AutoLadder`, `resolveAutoEffort`).

use std::sync::Arc;

use mixdog_agent::step_effort::StepAutoEffort;
use mixdog_ai::effort::{RejectionEntry, effort_options_for, reasoning_row};
use serde_json::{Map, Value, json};
use mixdog_ai::providers::custom::Protocol;
use mixdog_ai::providers::custom::reasoning::{ReasoningRow, is_custom_provider_name};
use mixdog_services::effort_judge::{AutoLadder, CustomLadder, StepLadder};

/// A custom route's reasoning facts (`providerClient.customConfig` and the effective model row).
pub struct CustomRoute {
    pub row: ReasoningRow,
    pub protocol: Protocol,
    pub base_url: String,
}

/// What the route says about its efforts, read by the run's host for the turn's route.
pub struct StepLadderFacts {
    /// `effortOptionsFor(provider, autoEffortModel(provider, providerClient, model))`.
    pub options: Vec<String>,
    /// Set for a custom route.
    pub custom: Option<CustomRoute>,
}

/// What the ladder reads off the route (`step-auto-effort.mjs:164-167`). The owners: the
/// provider's cached model row (`providerImpl.getCachedModelInfo`), the endpoint's rejected
/// levels (`rejectedEffortLevelsSync`), a custom provider's config (`providerClient.customConfig`)
/// and the Anthropic effort gates (`anthropicEffortLevelsFor`).
pub trait LadderSources: Send + Sync {
    fn cached_row(&self, provider: &str, model: &str) -> Option<Map<String, Value>>;
    fn rejected(&self, provider: &str, model_id: &str) -> Option<RejectionEntry>;
    /// The protocol and base URL of a custom provider; `None` when its config is not known.
    fn custom_config(&self, provider: &str) -> Option<(Protocol, String)>;
    fn anthropic_levels(&self, model: &str) -> Vec<String>;
}

/// `autoEffortModel(provider, providerImpl, model)`: an Anthropic route's id with the levels its
/// wire builder accepts (provider rows ignored, an empty list not falling back to a family
/// ladder); any other route's cached row with its id set to the model.
fn auto_effort_model(sources: &dyn LadderSources, provider: &str, model: &str) -> Value {
    if matches!(provider, "anthropic" | "anthropic-oauth") {
        return json!({ "id": model, "reasoningLevels": sources.anthropic_levels(model), "customReasoning": true });
    }
    let mut row = sources.cached_row(provider, model).unwrap_or_default();
    row.insert("id".into(), json!(model));
    Value::Object(row)
}

/// The ladder facts of a route: `effortOptionsFor(provider, autoEffortModel(..))`, and for a
/// custom route its effective row and config (`resolveCustomReasoning`'s inputs).
pub fn ladder_facts(sources: &dyn LadderSources, provider: &str, model: &str) -> StepLadderFacts {
    let meta = auto_effort_model(sources, provider, model);
    let rejected = sources.rejected(provider, model);
    let options = effort_options_for(provider, &meta, rejected.as_ref());
    let custom = is_custom_provider_name(provider)
        .then(|| sources.custom_config(provider))
        .flatten()
        .map(|(protocol, base_url)| CustomRoute { row: reasoning_row(&meta), protocol, base_url });
    StepLadderFacts { options, custom }
}

/// The ladder of a run. `None` when the route cannot take a judged effort: a custom route whose
/// config or row is not known resolves no level at any step (`if (!level) return null`).
pub fn ladder_for(provider: &str, auto: &StepAutoEffort, facts: StepLadderFacts) -> Option<Arc<dyn StepLadder>> {
    if is_custom_provider_name(provider) {
        let CustomRoute { row, protocol, base_url } = facts.custom?;
        return Some(Arc::new(CustomLadder { base: auto.base.clone(), row, protocol, base_url }));
    }
    Some(Arc::new(AutoLadder { base: auto.base.clone(), options: facts.options }))
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use mixdog_ai::providers::custom::reasoning::ReasoningOption;

    use super::*;

    fn auto(base: &str) -> StepAutoEffort {
        StepAutoEffort { request: "r".into(), base: base.into() }
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    /// A first-party route moves along its options from the turn's base; a distribution leaning
    /// to "more" moves up and the effort lands on the tool result alone.
    #[test]
    fn a_first_party_route_moves_along_its_options_and_sets_no_request_level() {
        let facts = StepLadderFacts { options: strings(&["low", "medium", "high"]), custom: None };
        let ladder = ladder_for("openai", &auto("medium"), facts).unwrap();
        let resolved = ladder.resolve(&[0.0, 0.0, 1.0]).unwrap();
        assert_eq!(resolved.level, None);
        assert!(resolved.effort.is_some());
    }

    /// A custom route snaps onto its row's levels, and the level is both the per-request effort
    /// and the recorded effort; a custom route with no known config has no judge.
    #[test]
    fn a_custom_route_snaps_to_its_rows_levels_and_needs_its_config() {
        let row = ReasoningRow {
            reasoning_options: vec![ReasoningOption { kind: "effort".into(), values: strings(&["low", "medium", "high"]) }],
            ..ReasoningRow::default()
        };
        let facts = StepLadderFacts { options: Vec::new(), custom: Some(CustomRoute { row, protocol: Protocol::OpenaiChat, base_url: "https://example.test/v1".into() }) };
        let ladder = ladder_for("custom-acme", &auto("medium"), facts).unwrap();
        let resolved = ladder.resolve(&[0.0, 0.0, 1.0]).unwrap();
        assert_eq!(resolved.level, resolved.effort);
        assert!(resolved.level.is_some());
        assert!(ladder_for("custom-acme", &auto("medium"), StepLadderFacts { options: Vec::new(), custom: None }).is_none());
    }

    struct Sources {
        rows: HashMap<(String, String), Map<String, Value>>,
        anthropic: Vec<String>,
        custom: Option<(Protocol, String)>,
    }

    impl LadderSources for Sources {
        fn cached_row(&self, provider: &str, model: &str) -> Option<Map<String, Value>> {
            self.rows.get(&(provider.to_owned(), model.to_owned())).cloned()
        }
        fn rejected(&self, _: &str, _: &str) -> Option<RejectionEntry> {
            None
        }
        fn custom_config(&self, _: &str) -> Option<(Protocol, String)> {
            self.custom.clone()
        }
        fn anthropic_levels(&self, _: &str) -> Vec<String> {
            self.anthropic.clone()
        }
    }

    /// Node's `effortOptionsFor(provider, autoEffortModel(..))` over 18 routes and rows
    /// (`record-step-ladder.mjs`).
    #[test]
    fn the_options_are_the_ones_node_resolves() {
        let golden: Value = serde_json::from_str(include_str!("../../../../fixtures/step-ladder/golden.json")).expect("fixture");
        for case in golden["cases"].as_array().unwrap() {
            let (provider, model) = (case["provider"].as_str().unwrap(), case["model"].as_str().unwrap());
            let mut rows = HashMap::new();
            if let Some(row) = case["row"].as_object() {
                rows.insert((provider.to_owned(), model.to_owned()), row.clone());
            }
            let anthropic = case["anthropicLevels"].as_array().map(|l| l.iter().map(|v| v.as_str().unwrap().to_owned()).collect()).unwrap_or_default();
            let sources = Sources { rows, anthropic, custom: Some((Protocol::OpenaiChat, "https://example.test/v1".into())) };
            let facts = ladder_facts(&sources, provider, model);
            assert_eq!(json!(facts.options), case["options"], "{provider} {model} {}", case["row"]);
            // A custom route carries its effective row; every other route none.
            assert_eq!(facts.custom.is_some(), provider.starts_with("custom-"), "{provider}");
            if let Some(custom) = facts.custom {
                assert_eq!(json!(custom.row.effort_levels()).is_null(), case["row"]["reasoningLevels"].is_null() && case["row"]["reasoningOptions"].is_null());
            }
        }
    }

    /// A custom route whose config is not known has no ladder at all.
    #[test]
    fn a_custom_route_without_a_config_has_no_custom_facts() {
        let sources = Sources { rows: HashMap::new(), anthropic: Vec::new(), custom: None };
        assert!(ladder_facts(&sources, "custom-acme", "m1").custom.is_none());
    }
}