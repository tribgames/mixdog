//! A catalog [`ModelRecord`] as the provider listing object the picker row mapping reads
//! (`providerModelCacheRow(name, m)`): the shape every Node adapter's `listModels` returns.
//!
//! Every key of a Node listing the picker row reads is a field of the catalog record, filled
//! where Node's listing fills it: `name`, `tier`, `latest`, `description`,
//! `supportsPromptCaching`, `reasoningContentField`, `defaultServiceTier`,
//! `defaultModelParameters`, `defaultFast`, `supportsMaxMode`, `providerName`, `manual`, and
//! the OAuth catalog's `supportsReasoningEffortUpdates`. A key the listing does not state is
//! left out, and the row mapping gives it its default (`''`, `null`, `false`, `{}`).

use serde_json::{Map, Value, json};

use crate::catalog::{Capability, ModelRecord};

fn yes(capability: Capability) -> bool {
    capability == Capability::Yes
}

/// The listing object of `record`; keys the record does not state are left out.
pub fn listing_value(record: &ModelRecord) -> Value {
    let mut m = Map::new();
    let mut put = |key: &str, value: Value| {
        m.insert(key.to_owned(), value);
    };
    put("id", json!(record.id));
    if let Some(display) = &record.display_name {
        put("display", json!(display));
    }
    if let Some(created) = record.created {
        put("created", json!(created));
    }
    if let Some(date) = &record.picker.release_date {
        put("releaseDate", json!(date));
    }
    if let Some(window) = record.context_window {
        put("contextWindow", json!(window));
    }
    if let Some(window) = record.max_context_window {
        put("maxContextWindow", json!(window));
    }
    if let Some(tokens) = record.output_tokens {
        put("outputTokens", json!(tokens));
    }
    if let Some(family) = &record.family {
        put("family", json!(family));
    }
    if let Some(mode) = &record.mode {
        put("mode", json!(mode));
    }
    if record.hidden {
        put("hidden", json!(true));
    }
    for (key, on) in [
        ("supportsVision", yes(record.vision)),
        ("supportsFunctionCalling", yes(record.function_calling)),
        ("supportsReasoning", yes(record.reasoning)),
        ("fastCapable", yes(record.fast_mode)),
    ] {
        if on {
            put(key, json!(true));
        }
    }
    if !record.reasoning_efforts.is_empty() {
        put("reasoningLevels", json!(record.reasoning_efforts));
    }
    let picker = &record.picker;
    if !picker.reasoning_options.is_empty() {
        put("reasoningOptions", json!(picker.reasoning_options));
    }
    if !picker.service_tiers.is_empty() {
        put("serviceTiers", json!(picker.service_tiers));
    }
    if !picker.additional_speed_tiers.is_empty() {
        put("additionalSpeedTiers", json!(picker.additional_speed_tiers));
    }
    if let Some(programs) = &picker.access_programs {
        put("accessPrograms", json!(programs));
    }
    if !picker.fast_efforts.is_empty() {
        put("fastEfforts", json!(picker.fast_efforts));
    }
    if !picker.model_parameter_options.is_empty() {
        put("modelParameterOptions", json!(picker.model_parameter_options));
    }
    if !picker.parameter_variants.is_empty() {
        put("parameterVariants", json!(picker.parameter_variants));
    }
    if let Some(effort) = &record.default_effort {
        put("defaultEffort", json!(effort));
    }
    if let Some(custom) = &picker.custom_reasoning {
        put("customReasoning", json!(custom));
    }
    if let Some(name) = &record.name {
        put("name", json!(name));
    }
    if let Some(tier) = &picker.tier {
        put("tier", json!(tier));
    }
    if picker.latest {
        put("latest", json!(true));
    }
    if let Some(description) = &picker.description {
        put("description", json!(description));
    }
    if yes(record.prompt_caching) {
        put("supportsPromptCaching", json!(true));
    }
    if let Some(field) = &record.reasoning_content_field {
        put("reasoningContentField", json!(field));
    }
    if let Some(tier) = &picker.default_service_tier {
        put("defaultServiceTier", json!(tier));
    }
    if !picker.default_model_parameters.is_empty() {
        put("defaultModelParameters", json!(picker.default_model_parameters));
    }
    if picker.default_fast {
        put("defaultFast", json!(true));
    }
    if picker.supports_max_mode {
        put("supportsMaxMode", json!(true));
    }
    if let Some(name) = &record.provider_name {
        put("providerName", json!(name));
    }
    if record.manual {
        put("manual", json!(true));
    }
    if let Some(updates) = record.supports_reasoning_effort_updates {
        put("supportsReasoningEffortUpdates", json!(updates));
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use mixdog_protocol::ProviderId;

    use super::*;
    use crate::service::admin_models::provider_model_cache_row;

    fn full() -> ModelRecord {
        let mut r = ModelRecord::new(ProviderId::from("custom-gw"), "m1");
        r.name = Some("M One".into());
        r.provider_name = Some("Gateway".into());
        r.manual = true;
        r.supports_reasoning_effort_updates = Some(false);
        r.prompt_caching = Capability::Yes;
        r.reasoning_content_field = Some("reasoning_content".into());
        r.picker.tier = Some("version".into());
        r.picker.latest = true;
        r.picker.description = Some("a model".into());
        r.picker.default_service_tier = Some("priority".into());
        r.picker.default_model_parameters = [("context".to_owned(), "272k".to_owned())].into();
        r.picker.default_fast = true;
        r.picker.supports_max_mode = true;
        r
    }

    /// The picker row of a record states each fact as the Node row does, with no downstream default.
    #[test]
    fn every_fact_of_the_record_reaches_the_picker_row() {
        let row = provider_model_cache_row("custom-gw", &listing_value(&full()), false);
        let want = json!({
            "name": "M One", "providerName": "Gateway", "manual": true, "tier": "version", "latest": true,
            "description": "a model", "supportsPromptCaching": true, "reasoningContentField": "reasoning_content",
            "defaultServiceTier": "priority", "defaultModelParameters": {"context": "272k"},
            "defaultFast": true, "supportsMaxMode": true,
        });
        for (key, value) in want.as_object().unwrap() {
            assert_eq!(row.get(key), Some(value), "{key}");
        }
        assert_eq!(listing_value(&full())["supportsReasoningEffortUpdates"], json!(false));
    }

    #[test]
    fn a_fact_the_record_does_not_state_is_left_out_of_the_listing() {
        let listing = listing_value(&ModelRecord::new(ProviderId::from("openai"), "m"));
        for key in [
            "name", "tier", "latest", "description", "supportsPromptCaching", "reasoningContentField", "defaultServiceTier",
            "defaultModelParameters", "defaultFast", "supportsMaxMode", "providerName", "manual", "supportsReasoningEffortUpdates",
        ] {
            assert!(listing.get(key).is_none(), "{key}");
        }
    }
}
