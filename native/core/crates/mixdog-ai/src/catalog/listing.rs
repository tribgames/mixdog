//! What an adapter does to its listed rows, as Node does it at each adapter
//! (`enrichModels`, then `sanitizeModelList`): the shared steps, over the
//! adapter's own [`ModelRecord`]s. The adapter calls them at the sites Node
//! does, and wraps them with its own steps (the compat family restores native
//! limits and mode, Grok clears `outputTokens`); no step is applied by the
//! catalog on its behalf.
//!
//! The rows carry the limits, display name, vision/reasoning flags, effort
//! ladder (`picker.reasoning_options`) and mode. Prices and the other
//! capability flags have no field on a listed row; they are derived from the
//! same tables whenever the catalog is asked for a model's facts
//! (`CatalogService::model_meta`).

use std::sync::Arc;

use arc_swap::ArcSwap;
use mixdog_core_api::domain::provider::ModelRecord;
use mixdog_core_api::domain::provider::ReasoningOption;
use serde_json::Value;
use serde_json::json;

use super::ModelsDev;
use super::lookup::Lookup;
use super::lookup::enrich_model;
use super::rosters::RosterSnapshot;
use super::sanitize::Context;
use super::sanitize::sanitize_model_list;
use super::sanitize::stale_months;

/// The resident tables the enrichment reads.
#[derive(Default)]
struct Layers {
    litellm: Option<Arc<ModelsDev>>,
    models_dev: Option<Arc<ModelsDev>>,
    rosters: Arc<RosterSnapshot>,
}

/// A handle adapters hold to run the listing steps. The catalog service
/// publishes the tables into it; before it does (a cold start) the steps see
/// empty tables, as Node's do before its catalogs load.
#[derive(Clone, Default)]
pub struct ListingLookup(Arc<ArcSwap<Layers>>);

impl ListingLookup {
    pub fn new() -> Self {
        Self::default()
    }

    pub(super) fn publish(&self, litellm: Option<Arc<ModelsDev>>, models_dev: Option<Arc<ModelsDev>>, rosters: Arc<RosterSnapshot>) {
        self.0.store(Arc::new(Layers { litellm, models_dev, rosters }));
    }

    fn with<R>(&self, read: impl FnOnce(&Lookup<'_>, Option<&Value>) -> R) -> R {
        static EMPTY: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({}));
        let layers = self.0.load();
        let models_dev = layers.models_dev.as_deref().map(ModelsDev::projected);
        read(
            &Lookup {
                litellm: layers.litellm.as_deref().map_or(&EMPTY, ModelsDev::projected),
                models_dev: models_dev.unwrap_or(&EMPTY),
                rosters: &layers.rosters,
            },
            models_dev,
        )
    }

    /// `enrichModels(rows)` for `provider`'s rows.
    pub fn enrich_listed(&self, provider: &str, rows: Vec<ModelRecord>) -> Vec<ModelRecord> {
        self.with(|lookup, _| enrich_listed(lookup, provider, rows))
    }

    /// `getModelsDevProviderModelsSync(provider)`: the resident models.dev
    /// rows of one provider (id → row); `None` before the catalog has loaded.
    pub fn models_dev_models(&self, provider: &str) -> Option<serde_json::Map<String, Value>> {
        self.with(|_, models_dev| models_dev?.get(provider)?.get("models")?.as_object().cloned())
    }

    /// `sanitizeModelList(rows, { provider })`, read against the resident
    /// models.dev table, the clock and `MIXDOG_MODEL_STALE_MONTHS`.
    pub fn sanitize_listed(&self, provider: &str, rows: Vec<ModelRecord>) -> Vec<ModelRecord> {
        self.with(|_, models_dev| {
            let ctx = Context {
                models_dev,
                now_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as i64),
                stale_months: stale_months(std::env::var("MIXDOG_MODEL_STALE_MONTHS").ok().as_deref()),
            };
            sanitize_model_list(rows, provider, &ctx)
        })
    }
}

/// The Node-shaped row the lookup reads for a listed record.
fn row_of(provider: &str, record: &ModelRecord) -> Value {
    let mut row = serde_json::Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("provider".into(), json!(provider));
    if let Some(v) = &record.display_name {
        row.insert("display".into(), json!(v));
    }
    if let Some(v) = &record.name {
        row.insert("name".into(), json!(v));
    }
    if let Some(v) = record.context_window {
        row.insert("contextWindow".into(), json!(v));
    }
    if let Some(v) = record.max_output_tokens {
        row.insert("outputTokens".into(), json!(v));
    }
    if let Some(v) = record.supports_images {
        row.insert("supportsVision".into(), json!(v));
    }
    if let Some(v) = record.supports_reasoning {
        row.insert("supportsReasoning".into(), json!(v));
    }
    if !record.reasoning_levels.is_empty() {
        row.insert("reasoningLevels".into(), json!(record.reasoning_levels));
    }
    if !record.picker.reasoning_options.is_empty() {
        row.insert("reasoningOptions".into(), json!(record.picker.reasoning_options));
    }
    if let Some(v) = &record.mode {
        row.insert("mode".into(), json!(v));
    }
    if let Some(v) = record.created {
        row.insert("created".into(), json!(v));
    }
    Value::Object(row)
}

fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n as u64)
}

/// `enrichModels`: the catalog's facts layered under each row; what the row
/// states stays (limits and display name are gap-filled only).
pub fn enrich_listed(lookup: &Lookup<'_>, provider: &str, rows: Vec<ModelRecord>) -> Vec<ModelRecord> {
    rows.into_iter()
        .map(|mut record| {
            let out = enrich_model(lookup, &row_of(provider, &record));
            if record.display_name.is_none() {
                record.display_name = out.get("display").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
            }
            record.context_window = positive(out.get("contextWindow"));
            record.max_output_tokens = positive(out.get("outputTokens"));
            if record.supports_images.is_none() {
                record.supports_images = out.get("supportsVision").and_then(Value::as_bool);
            }
            if record.supports_reasoning.is_none() {
                record.supports_reasoning = out.get("supportsReasoning").and_then(Value::as_bool);
            }
            record.picker.reasoning_options =
                serde_json::from_value::<Vec<ReasoningOption>>(out.get("reasoningOptions").cloned().unwrap_or(Value::Null)).unwrap_or_default();
            if let Some(mode) = out.get("mode").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                record.mode = Some(mode.to_owned());
            }
            record
        })
        .collect()
}

/// The compat family's step after enrichment (`openai-compat-models.mjs:184-190`):
/// the listing's own limits and mode are restored over what enrichment derived.
/// `native` and `enriched` are the same rows, in the same order.
pub fn keep_native(native: &[ModelRecord], enriched: Vec<ModelRecord>) -> Vec<ModelRecord> {
    enriched
        .into_iter()
        .zip(native)
        .map(|(mut row, native)| {
            if native.context_window.is_some_and(|n| n > 0) {
                row.context_window = native.context_window;
            }
            if native.max_output_tokens.is_some_and(|n| n > 0) {
                row.max_output_tokens = native.max_output_tokens;
            }
            if native.mode.as_deref().is_some_and(|m| !m.is_empty()) {
                row.mode.clone_from(&native.mode);
            }
            row
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::lookup::fixtures::GOLDEN;
    use crate::catalog::lookup::fixtures::LITELLM;
    use crate::catalog::lookup::fixtures::MODELS_DEV;
    use crate::catalog::lookup::fixtures::json;
    use crate::catalog::lookup::fixtures::rosters;
    use crate::catalog::lookup::project_litellm;
    use crate::catalog::lookup::project_models_dev;

    /// A recorded Node input row as a listed record.
    fn listed(input: &Value) -> ModelRecord {
        let mut record = ModelRecord::new(input["id"].as_str().unwrap());
        record.display_name = input.get("display").and_then(Value::as_str).map(str::to_owned);
        record.name = input.get("name").and_then(Value::as_str).map(str::to_owned);
        record.context_window = input.get("contextWindow").and_then(Value::as_u64);
        record.max_output_tokens = input.get("outputTokens").and_then(Value::as_u64);
        record.supports_images = input.get("supportsVision").and_then(Value::as_bool);
        record.supports_reasoning = input.get("supportsReasoning").and_then(Value::as_bool);
        record.reasoning_levels = input
            .get("reasoningLevels")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect())
            .unwrap_or_default();
        if let Some(options) = input.get("reasoningOptions") {
            record.picker.reasoning_options = serde_json::from_value(options.clone()).unwrap();
        }
        record
    }

    #[test]
    fn every_enriched_row_equals_nodes() {
        let litellm = project_litellm(&json(LITELLM));
        let models_dev = project_models_dev(&json(MODELS_DEV));
        let rosters = rosters();
        let lookup = Lookup { litellm: &litellm, models_dev: &models_dev, rosters: &rosters };
        let golden = json(GOLDEN);
        let cases = golden["enriched"].as_array().unwrap();
        assert!(cases.len() >= 13);
        for case in cases {
            let (input, out) = (&case["input"], &case["out"]);
            let got = enrich_listed(&lookup, input["provider"].as_str().unwrap(), vec![listed(input)]).remove(0);
            let what = format!("{input}");
            assert_eq!(got.display_name.as_deref(), out.get("display").and_then(Value::as_str).filter(|s| !s.is_empty()), "display {what}");
            assert_eq!(got.context_window, positive(out.get("contextWindow")), "contextWindow {what}");
            assert_eq!(got.max_output_tokens, positive(out.get("outputTokens")), "outputTokens {what}");
            let flag = |key: &str, own: Option<bool>| own.or(out.get(key).and_then(Value::as_bool));
            assert_eq!(got.supports_images, flag("supportsVision", listed(input).supports_images), "vision {what}");
            assert_eq!(got.supports_reasoning, flag("supportsReasoning", listed(input).supports_reasoning), "reasoning {what}");
            // A model the catalog does not know comes back untouched: no ladder.
            assert_eq!(json!(got.picker.reasoning_options), out.get("reasoningOptions").cloned().unwrap_or(json!([])), "reasoningOptions {what}");
            assert_eq!(got.mode.as_deref(), out.get("mode").and_then(Value::as_str), "mode {what}");
        }
    }

    #[test]
    fn the_compat_step_keeps_native_limits_and_mode() {
        let mut native = ModelRecord::new("m");
        native.context_window = Some(1000);
        native.mode = Some("responses".into());
        let mut enriched = ModelRecord::new("m");
        enriched.context_window = Some(9);
        enriched.max_output_tokens = Some(77);
        enriched.mode = Some("chat".into());
        let kept = keep_native(std::slice::from_ref(&native), vec![enriched]).remove(0);
        assert_eq!((kept.context_window, kept.max_output_tokens, kept.mode.as_deref()), (Some(1000), Some(77), Some("responses")));
    }
}
