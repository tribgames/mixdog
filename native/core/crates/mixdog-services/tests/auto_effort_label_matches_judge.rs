//! What a route's row says about Auto (the UI's "Auto" or "a level") equals what the turn judge does with the same
//! route (it judges on a ladder, or the saved effort stands): listed, unlisted, no ladder, levels an endpoint refused,
//! and Auto turned off on the route.

use std::collections::HashMap;

use mixdog_ai::effort::{RejectionEntry, anthropic_ladder_row, effort_items_for, effort_options_for, rejection_key, route_auto_effort_on};
use mixdog_ai::service::admin_models::{HydrationFacts, hydrate_provider_model_row};
use mixdog_ai::service::admin_route::Obj;
use mixdog_ai::service::effort_configuration::{UnsupportedEfforts, effort_configuration_mode};
use mixdog_services::effort_judge::ladder::{clamp_base, resolve_auto_effort};
use serde_json::{Value, json};

struct Real {
    unsupported: UnsupportedEfforts,
    rejections: HashMap<String, RejectionEntry>,
    /// What an Anthropic route's wire builder accepts (`anthropicEffortLevelsFor`).
    anthropic_levels: Vec<String>,
}

impl Real {
    fn rejected(&self, provider: &str, row: &Value) -> Option<&RejectionEntry> {
        self.rejections.get(&rejection_key(provider, row["id"].as_str().unwrap()))
    }
}

impl HydrationFacts for Real {
    fn fast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn ultrafast_capable(&self, _: &str, _: &Value) -> bool {
        false
    }
    fn effort_items(&self, provider: &str, row: &Value) -> Value {
        let items = effort_items_for(provider, row, None, self.rejected(provider, row));
        Value::Array(items.into_iter().map(|i| json!({ "value": i.value })).collect())
    }
    fn auto_effort_options(&self, provider: &str, model: &str) -> Option<Vec<String>> {
        provider.starts_with("anthropic").then(|| {
            let row = anthropic_ladder_row(model, self.anthropic_levels.clone());
            effort_options_for(provider, &row, self.rejections.get(&rejection_key(provider, model)))
        })
    }
    fn effort_configuration_mode(&self, provider: &str, model: &str, opts: &Value) -> bool {
        effort_configuration_mode(provider, &Value::from(model), opts, &self.unsupported, &|_| None).is_some()
    }
    fn custom_auto_effort_capable(&self, _: &str, _: Option<&Value>, _: &Value) -> bool {
        false
    }
    fn provider_config(&self, _: &str) -> Obj {
        Obj::new()
    }
}

/// The turn judge's decision for the route: it judges (the route's Auto is on and the base lies on the ladder of its
/// options without the refused levels) or the saved effort stands.
fn judges(facts: &Real, provider: &str, row: &Value, route_auto: Option<&Value>) -> bool {
    let options = if provider.starts_with("anthropic") {
        effort_options_for(provider, &anthropic_ladder_row(row["id"].as_str().unwrap(), facts.anthropic_levels.clone()), facts.rejected(provider, row))
    } else {
        effort_options_for(provider, row, facts.rejected(provider, row))
    };
    let base = clamp_base("medium", &options).unwrap_or("medium");
    route_auto_effort_on(route_auto) && resolve_auto_effort(base, &options, &[0.0, 1.0, 0.0, 0.0]).is_some()
}

/// What the UI labels: "Auto" when the core says the model takes it and the route has it on, else the saved level.
fn labels_auto(facts: &Real, provider: &str, row: &Value, route_auto: Option<&Value>) -> bool {
    let mut cfg = Obj::new();
    if let Some(flag) = route_auto {
        cfg.insert("modelSettings".into(), json!({ format!("{provider}/{}", row["id"].as_str().unwrap()): { "autoEffort": flag } }));
    }
    let hydrated = hydrate_provider_model_row(&cfg, row, facts);
    hydrated["autoEffortCapable"] == json!(true) && hydrated.get("savedAutoEffort") != Some(&json!(false))
}

#[test]
fn the_row_says_auto_exactly_when_the_judge_judges() {
    let levels = json!(["low", "medium", "high", "xhigh", "max", "ultra"]);
    let listed = json!({ "id": "gpt-6-astra", "provider": "openai-oauth", "reasoningLevels": levels });
    // A saved route's placeholder row: the id is GPT-6+, but nothing says what efforts it takes.
    let unlisted = json!({ "id": "gpt-6.2-astra", "provider": "openai-oauth" });
    // A listed model whose only levels are reserved for an explicit choice: no ladder for Auto.
    let no_ladder = json!({ "id": "gpt-6-x", "provider": "openai-oauth", "reasoningLevels": ["max", "ultra"] });
    let refused = |levels: &[&str]| {
        let entry = RejectionEntry { rejected: levels.iter().map(|l| (*l).to_owned()).collect(), allowed: Vec::new() };
        Real {
            unsupported: UnsupportedEfforts::default(),
            rejections: HashMap::from([(rejection_key("openai-oauth", "gpt-6-astra"), entry)]),
            anthropic_levels: Vec::new(),
        }
    };
    let plain = Real { unsupported: UnsupportedEfforts::default(), rejections: HashMap::new(), anthropic_levels: Vec::new() };
    let adaptive = |levels: &[&str]| Real {
        unsupported: UnsupportedEfforts::default(),
        rejections: HashMap::new(),
        anthropic_levels: levels.iter().map(|l| (*l).to_owned()).collect(),
    };
    let opus = json!({ "id": "claude-opus-5-5", "provider": "anthropic-oauth" });
    let off = json!(false);
    let (with_levels, without_levels) = (adaptive(&["low", "medium", "high", "xhigh"]), adaptive(&[]));
    let cases: [(&Real, &Value, Option<&Value>, bool); 10] = [
        // An Anthropic route: its ladder is what its wire builder accepts, for the label and the judge alike.
        (&with_levels, &opus, None, true),
        (&without_levels, &opus, None, false),
        (&with_levels, &opus, Some(&off), false),
        (&plain, &listed, None, true),
        (&plain, &unlisted, None, false),
        (&plain, &no_ladder, None, false),
        // Auto turned off on the route: the saved level is what is labelled and sent.
        (&plain, &listed, Some(&off), false),
        (&refused(&["medium", "high", "xhigh"]), &listed, None, true),
        // Every level Auto could move along was refused by the endpoint.
        (&refused(&["low", "medium", "high", "xhigh"]), &listed, None, false),
        (&plain, &listed, Some(&json!(true)), true),
    ];
    for (facts, row, route_auto, expected) in cases {
        let provider = row["provider"].as_str().unwrap();
        assert_eq!(labels_auto(facts, provider, row, route_auto), expected, "label for {row} {route_auto:?}");
        assert_eq!(judges(facts, provider, row, route_auto), expected, "judge for {row} {route_auto:?}");
    }
}
