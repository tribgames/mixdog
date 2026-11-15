//! The collapsed model of a tool GROUP card ("Read 3 files, searched 2"): category counts in the header, one detail row
//! (`shared/tool-card-model/aggregate-card.mjs`).

use mixdog_js::json_number;
use mixdog_js::to_number_of;
use mixdog_js::value_to_string;
use serde_json::Map;
use serde_json::Value;

use super::card_input::CardBase;
use super::card_input::common_card_fields;
use super::inline_text::normalize_count_map;
use super::inline_text::safe_inline_text;
use super::terminal_status::display_terminal_status;
use super::terminal_status::result_terminal_status;
use crate::tool_primitives::field;
use crate::tool_primitives::truthy;
use crate::tool_surface::AggregateHeaderOptions;
use crate::tool_surface::format_aggregate_header;

/// `Number(value.count || 0)` of an entry, or `Number(value || 0)` of a bare count.
fn count_of(value: &Value) -> f64 {
    let source = if matches!(value, Value::Object(_) | Value::Array(_)) { field(value, "count") } else { Some(value) };
    if truthy(source) { source.map_or(0.0, |count| to_number_of(Some(count))) } else { 0.0 }
}

fn aggregate_label(base: &CardBase) -> String {
    let display_categories = normalize_count_map(&base.categories);
    let normalized_done = base.done_categories.as_ref().map_or_else(|| display_categories.clone(), normalize_count_map);
    let has_done_counts = normalized_done.as_object().is_some_and(|map| map.values().any(|count| count_of(count) > 0.0));
    let display_done = if has_done_counts { normalized_done } else { display_categories.clone() };
    let order: Option<Vec<String>> = match field(&base.args, "categoryOrder") {
        Some(Value::Array(items)) => Some(items.iter().map(value_to_string).collect()),
        _ => None,
    };
    let order_refs: Option<Vec<&str>> = order.as_ref().map(|items| items.iter().map(String::as_str).collect());
    let mut loading_targets: Vec<String> = Vec::new();
    if let Some(Value::Array(items)) = field(&base.args, "loadingTargets") {
        for item in items {
            let text = if truthy(Some(item)) { mixdog_js::js_trim(&value_to_string(item)).to_owned() } else { String::new() };
            if !text.is_empty() && !loading_targets.contains(&text) {
                loading_targets.push(text);
            }
        }
    }
    let header_categories = if base.header_pending { &display_categories } else { &display_done };
    safe_inline_text(&if loading_targets.is_empty() {
        format_aggregate_header(
            header_categories,
            &AggregateHeaderOptions {
                pending: base.header_pending,
                order: order_refs.as_deref(),
                failed: base.failed_count > 0.0 && base.failed_count >= base.group_count,
                ..AggregateHeaderOptions::default()
            },
        )
    } else {
        format!("{} {}", if base.header_pending { "Loading" } else { "Loaded" }, loading_targets.join(", "))
    })
}

/// `deriveAggregateCardModel`.
pub fn derive_aggregate_card_model(base: &CardBase) -> Value {
    let detail_text = if base.has_result { safe_inline_text(base.rt.as_deref().unwrap_or_default()) } else { String::new() };
    let failed_or_completed = if base.is_error || base.failed_count > 0.0 { "failed" } else { "completed" };
    let terminal_status = if base.pending {
        "running"
    } else {
        match result_terminal_status(base.rt.as_deref().unwrap_or_default()) {
            "" => failed_or_completed,
            reported => reported,
        }
    };
    let detail_line = if !detail_text.is_empty() {
        detail_text.clone()
    } else if base.pending {
        "Running".to_owned()
    } else {
        match display_terminal_status(terminal_status) {
            "" => "Finished".to_owned(),
            word => word.to_owned(),
        }
    };
    let mut model = Map::new();
    model.insert("aggregate".to_owned(), Value::Bool(true));
    model.extend(common_card_fields(base, terminal_status));
    model.insert("labelText".to_owned(), Value::from(aggregate_label(base)));
    model.insert("summaryText".to_owned(), Value::from(""));
    model.insert("headerFailureText".to_owned(), Value::from(""));
    model.insert("detailLine".to_owned(), Value::from(detail_line));
    model.insert("detailIsPlaceholder".to_owned(), Value::Bool(detail_text.is_empty()));
    model.insert("displayedResultBodyText".to_owned(), Value::from(base.rt.clone().unwrap_or_default()));
    model.insert("firstResultLine".to_owned(), Value::from(detail_text.clone()));
    model.insert("totalLines".to_owned(), json_number(if detail_text.is_empty() { 0.0 } else { 1.0 }));
    model.insert("resultSummary".to_owned(), if detail_text.is_empty() { Value::Null } else { Value::from(detail_text) });
    model.insert("toolArgPath".to_owned(), Value::from(""));
    model.insert("normalizedName".to_owned(), Value::from(""));
    model.insert("label".to_owned(), Value::from(""));
    model.insert("parsedArgs".to_owned(), base.args.clone());
    for key in ["isShellSurface", "isSkillSurface", "isAgentSurfaceCard", "isAgentResponse", "isBackgroundResponse", "isBackgroundMetadataResult"] {
        model.insert(key.to_owned(), Value::Bool(false));
    }
    model.insert("backgroundMeta".to_owned(), Value::Null);
    Value::Object(model)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::card_model::card_input::CardOptions;
    use crate::card_model::card_input::read_card_input;

    fn model_of(input: Value) -> Value {
        let base = read_card_input(&input, "", input.get("args").cloned().unwrap_or_else(|| json!({})), &CardOptions::default());
        derive_aggregate_card_model(&base)
    }

    #[test]
    fn a_running_group_reads_the_started_counts() {
        let model = model_of(json!({
            "aggregate": true, "count": 3, "completedCount": 1,
            "categories": { "Read": { "count": 2 }, "Search": { "count": 1 } },
        }));
        assert_eq!(model["aggregate"], json!(true));
        assert_eq!(model["terminalStatus"], json!("running"));
        assert_eq!(model["detailLine"], json!("Running"));
        assert_eq!(model["detailIsPlaceholder"], json!(true));
        assert_eq!(model["resultSummary"], Value::Null);
        assert_eq!(model["pending"], json!(true));
    }

    #[test]
    fn a_finished_group_shows_its_result() {
        let model = model_of(json!({ "aggregate": true, "result": "3 files\nread", "count": 2, "categories": {} }));
        assert_eq!(model["detailLine"], json!("3 files read"));
        assert_eq!(model["totalLines"], json!(1));
        assert_eq!(model["terminalStatus"], json!("completed"));
        let failed = model_of(json!({ "aggregate": true, "result": "", "count": 2, "errorCount": 1 }));
        assert_eq!(failed["terminalStatus"], json!("failed"));
        assert_eq!(failed["detailLine"], json!("Failed"));
    }

    #[test]
    fn loading_targets_replace_the_counts() {
        let model = model_of(json!({ "aggregate": true, "completedCount": 0, "args": { "loadingTargets": ["a", " a", "b"] } }));
        assert_eq!(model["labelText"], json!("Loading a, b"));
        let done = model_of(json!({ "aggregate": true, "result": "x", "args": { "loadingTargets": ["a"] } }));
        assert_eq!(done["labelText"], json!("Loaded a"));
    }
}
