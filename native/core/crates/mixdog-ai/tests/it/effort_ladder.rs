//! The effort ladder: which efforts a route offers, how a requested one lands on them, and how a refused level
//! steps down.

use std::collections::BTreeSet;

use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::effort::clamp_effort_opts;
use mixdog_ai::effort::coerce_effort_for;
use mixdog_ai::effort::custom_levels;
use mixdog_ai::effort::effort_items_for;
use mixdog_ai::effort::effort_options_for;
use mixdog_ai::effort::nearest_accepted_effort;
use mixdog_ai::effort::normalize_effort_input;
use mixdog_ai::effort::normalize_saved_effort;
use serde_json::Value;
use serde_json::json;

fn set(levels: &[&str]) -> BTreeSet<String> {
    levels.iter().map(|l| (*l).to_owned()).collect()
}

fn refused(levels: &[&str]) -> RejectionEntry {
    RejectionEntry { rejected: levels.iter().map(|l| (*l).to_owned()).collect(), allowed: Vec::new() }
}

#[test]
fn an_effort_input_is_a_known_level_lowercased_or_auto_or_an_error() {
    for (input, level) in [(json!(" High "), Some("high")), (json!("xhigh"), Some("xhigh")), (json!("ULTRA"), Some("ultra"))] {
        assert_eq!(normalize_effort_input(Some(&input)), Ok(level.map(str::to_owned)), "{input}");
    }
    for blank in [json!(""), json!("  "), json!("auto"), json!("AUTO"), Value::Null] {
        assert_eq!(normalize_effort_input(Some(&blank)), Ok(None), "{blank}");
    }
    assert_eq!(normalize_effort_input(None), Ok(None));
    assert_eq!(
        normalize_effort_input(Some(&json!("turbo"))),
        Err("effort must be one of auto, none, minimal, low, medium, high, xhigh, max, ultra".to_owned())
    );
}

#[test]
fn a_saved_effort_that_is_not_a_level_is_no_effort_rather_than_an_error() {
    assert_eq!(normalize_saved_effort(Some(&json!("Medium"))).as_deref(), Some("medium"));
    assert_eq!(normalize_saved_effort(Some(&json!("turbo"))), None);
    assert_eq!(normalize_saved_effort(Some(&json!("auto"))), None);
    assert_eq!(normalize_saved_effort(None), None);
}

#[test]
fn the_levels_a_row_declares_win_in_order_options_then_levels_and_only_known_levels_survive_once() {
    let options = json!({"id": "m", "family": "opus", "reasoningOptions": [{"type": "text", "values": ["x"]}, {"type": "Effort", "values": ["Low", "low", "HIGH", "turbo", ""]}], "reasoningLevels": ["medium"]});
    assert_eq!(effort_options_for("anthropic", &options, None), ["low", "high"]);
    let levels = json!({"id": "m", "family": "opus", "reasoningLevels": [" Medium ", "ultra", "bogus"]});
    assert_eq!(effort_options_for("anthropic", &levels, None), ["medium", "ultra"], "declared order is kept, no sorting");
    let empty_option = json!({"id": "m", "reasoningOptions": [{"type": "effort", "values": []}], "reasoningLevels": ["medium"]});
    assert_eq!(effort_options_for("openai", &empty_option, None), ["medium"], "an option with no values leaves the levels the word");
}

#[test]
fn a_row_that_declares_nothing_takes_its_families_ladder_then_its_providers_then_none() {
    let family = |family: &str| effort_options_for("anthropic", &json!({"id": "m", "family": family}), None);
    assert_eq!(family("opus"), ["low", "medium", "high", "xhigh", "max"]);
    assert_eq!(family("Sonnet"), ["low", "medium", "high"]);
    assert!(family("haiku").is_empty(), "a family known to have no effort has an empty ladder");
    assert_eq!(family("gpt-5.5"), ["none", "low", "medium", "high", "xhigh"]);
    assert_eq!(family("gpt-nano"), ["none", "low", "medium", "high"]);
    assert_eq!(family("grok"), ["low", "medium", "high", "xhigh"]);
    let provider = |provider: &str| effort_options_for(provider, &json!({"id": "m"}), None);
    assert_eq!(provider("openai"), ["none", "low", "medium", "high", "xhigh"]);
    assert_eq!(provider("xai"), ["low", "medium", "high", "xhigh"], "xAI cannot turn reasoning off");
    assert_eq!(provider("mimo-oauth"), ["minimal", "low", "medium", "high"]);
    assert_eq!(provider("command-code-oauth"), ["low", "medium", "high"]);
    assert!(provider("somebody-else").is_empty());
    assert_eq!(effort_options_for("openai", &json!({"id": "m", "family": "unknown-family"}), None), ["none", "low", "medium", "high", "xhigh"], "an unknown family falls through to the provider");
}

#[test]
fn a_custom_providers_row_is_authoritative_and_gets_no_family_or_provider_ladder() {
    let undeclared = json!({"id": "m", "family": "opus", "customReasoning": true});
    assert!(effort_options_for("openai", &undeclared, None).is_empty());
    let declared = json!({"id": "m", "customReasoning": true, "reasoningOptions": [{"type": "effort", "values": ["high", "low"]}]});
    assert_eq!(effort_options_for("custom-x", &declared, None), ["low", "high"], "ranked weakest first");
    assert_eq!(custom_levels(&declared), Some(vec!["low".to_owned(), "high".to_owned()]));
    assert_eq!(custom_levels(&json!({"id": "m"})), None);
    assert_eq!(custom_levels(&json!({"id": "m", "reasoningLevels": []})), Some(Vec::new()), "an explicit empty list means no reasoning");
}

#[test]
fn what_an_endpoint_refused_is_taken_off_the_ladder_but_only_for_a_row_with_an_id() {
    let row = json!({"id": "m", "family": "opus"});
    assert_eq!(effort_options_for("anthropic", &row, Some(&refused(&["max", "xhigh"]))), ["low", "medium", "high"]);
    assert_eq!(effort_options_for("anthropic", &json!({"family": "opus"}), Some(&refused(&["max"]))).len(), 5, "a row without an id is not filtered");
    let named = RejectionEntry { rejected: Vec::new(), allowed: vec!["low".into(), "medium".into()] };
    assert_eq!(effort_options_for("anthropic", &row, Some(&named)), ["low", "medium"], "a list the endpoint named refuses everything outside it");
    assert_eq!(named.levels(), set(&["none", "minimal", "high", "xhigh", "max", "ultra"]));
    assert_eq!(refused(&["high"]).levels(), set(&["high"]));
    assert!(RejectionEntry::default().levels().is_empty());
}

#[test]
fn a_requested_effort_the_route_offers_is_kept_and_one_it_does_not_lands_on_the_nearest_lower_it_does() {
    let opus = json!({"id": "m", "family": "opus"});
    assert_eq!(coerce_effort_for("anthropic", &opus, "high", None).as_deref(), Some("high"));
    assert_eq!(coerce_effort_for("anthropic", &opus, "ultra", None).as_deref(), Some("max"));
    assert_eq!(coerce_effort_for("anthropic", &opus, "minimal", None).as_deref(), Some("low"), "minimal looks up before it gives up");
    assert_eq!(coerce_effort_for("anthropic", &opus, "none", None), None, "none is never replaced by a real level");
    let sonnet = json!({"id": "m", "family": "sonnet"});
    assert_eq!(coerce_effort_for("anthropic", &sonnet, "max", None).as_deref(), Some("high"));
    assert_eq!(coerce_effort_for("anthropic", &sonnet, "xhigh", None).as_deref(), Some("high"));
    assert_eq!(coerce_effort_for("anthropic", &json!({"id": "m", "family": "haiku"}), "low", None), None);
    assert_eq!(coerce_effort_for("anthropic", &opus, "", None), None);
    assert_eq!(coerce_effort_for("anthropic", &opus, "high", Some(&refused(&["high"]))).as_deref(), Some("medium"));
    assert_eq!(coerce_effort_for("anthropic", &opus, "turbo", None), None);
}

#[test]
fn a_custom_rows_effort_snaps_down_to_what_it_declares_and_never_up() {
    let row = json!({"id": "m", "customReasoning": true, "reasoningLevels": ["low", "high"]});
    assert_eq!(coerce_effort_for("custom-x", &row, "medium", None).as_deref(), Some("low"));
    assert_eq!(coerce_effort_for("custom-x", &row, "max", None).as_deref(), Some("high"));
    assert_eq!(coerce_effort_for("custom-x", &row, "high", None).as_deref(), Some("high"));
    assert_eq!(coerce_effort_for("custom-x", &row, "none", None), None);
    assert_eq!(coerce_effort_for("custom-x", &json!({"id": "m", "customReasoning": true, "reasoningLevels": ["medium"]}), "low", None), None, "nothing at or below the request");
}

#[test]
fn the_picker_lists_each_level_with_its_label_and_marks_the_current_one() {
    let items = effort_items_for("anthropic", &json!({"id": "m", "family": "opus"}), Some("high"), None);
    let shown: Vec<(&str, &str, &str)> = items.iter().map(|i| (i.value.as_str(), i.label.as_str(), i.description.as_str())).collect();
    assert_eq!(
        shown,
        [("low", "Low", ""), ("medium", "Medium", ""), ("high", "High", "current"), ("xhigh", "Extra High", ""), ("max", "Max", "")]
    );
    let none_active = effort_items_for("openai", &json!({"id": "m"}), None, None);
    assert_eq!(none_active[0].label, "None");
    assert!(none_active.iter().all(|i| i.description.is_empty()));
}

#[test]
fn a_refused_level_steps_down_to_the_nearest_open_lower_level() {
    assert_eq!(nearest_accepted_effort("high", &set(&["high"]), false), Some("medium"));
    assert_eq!(nearest_accepted_effort("high", &set(&["high", "medium"]), false), Some("low"));
    assert_eq!(nearest_accepted_effort("xhigh", &set(&["xhigh", "high", "medium", "low", "minimal"]), false), Some("none"));
    assert_eq!(nearest_accepted_effort("low", &set(&["low", "minimal", "none"]), false), None, "nothing lower is open");
    assert_eq!(nearest_accepted_effort("turbo", &set(&[]), true), None, "not a level");
}

#[test]
fn when_the_accepted_levels_are_known_a_level_with_nothing_lower_open_steps_up_to_the_lowest_open_one() {
    assert_eq!(nearest_accepted_effort("low", &set(&["none", "minimal", "low", "xhigh", "max", "ultra"]), true), Some("medium"));
    assert_eq!(nearest_accepted_effort("none", &set(&["none"]), true), Some("minimal"));
    assert_eq!(nearest_accepted_effort("none", &set(&["none"]), false), None);
}

#[test]
fn a_request_whose_level_was_refused_is_stepped_down_and_every_effort_field_follows() {
    let entry = refused(&["high"]);
    let opts = json!({"effort": "high", "temperature": 0.2, "xaiReasoningEffort": "high", "deepseekReasoningEffort": "high"});
    assert_eq!(
        clamp_effort_opts(&opts, None, None, Some(&entry)),
        json!({"effort": "medium", "temperature": 0.2, "xaiReasoningEffort": "medium", "deepseekReasoningEffort": "medium"}),
        "a provider's own effort field present in the request moves with it, an absent one is not invented"
    );
    let untouched = json!({"effort": "low"});
    assert_eq!(clamp_effort_opts(&untouched, None, None, Some(&entry)), untouched, "an accepted level stays");
    assert_eq!(clamp_effort_opts(&untouched, None, None, None), untouched);
    let none = json!({"model": "m"});
    assert_eq!(clamp_effort_opts(&none, Some(&json!("high")), None, Some(&entry)), json!({"model": "m", "effort": "medium"}), "the configured effort stands in when the request names none");
    assert_eq!(clamp_effort_opts(&json!({"effort": "bogus"}), None, None, Some(&entry)), json!({"effort": "bogus"}));
}

#[test]
fn a_wire_that_accepts_only_some_levels_steps_a_level_it_does_not_accept_down_but_leaves_foreign_levels() {
    let opts = json!({"effort": "high"});
    assert_eq!(clamp_effort_opts(&opts, None, Some(&["low", "high"]), Some(&refused(&["high"]))), json!({"effort": "low"}));
    assert_eq!(clamp_effort_opts(&opts, None, Some(&["low", "medium"]), Some(&refused(&["high"]))), opts, "a level outside the wire's ladder is not this clamp's to change");
    let named = RejectionEntry { rejected: Vec::new(), allowed: vec!["medium".into()] };
    assert_eq!(clamp_effort_opts(&json!({"effort": "low"}), None, None, Some(&named)), json!({"effort": "medium"}), "with the endpoint's list known the step may go up");
    assert_eq!(clamp_effort_opts(&json!({"effort": "low"}), None, None, Some(&refused(&["low", "minimal", "none"]))), json!({"effort": "low"}), "no list, nothing lower: left as asked");
}
