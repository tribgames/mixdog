//! The models.dev metadata layer (`api.json`): per provider, per model, the
//! facts the provider's own listing lacks. It fills gaps only
//! ([`ModelRecord::fill_gaps_from`]); what it states is the SDK package
//! (`npm`, which names the wire), the output modalities, limits, rates and
//! capabilities.

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::record::Capability;
use super::record::MetadataSource;
use super::record::ModelRecord;
use super::store::CatalogSnapshot;
use crate::providers::compat::models::ModelTable;

#[derive(Clone, Default, Debug)]
pub struct ModelsDev {
    providers: BTreeMap<ProviderId, Vec<ModelRecord>>,
}

fn capability(value: Option<&JsonValue>) -> Capability {
    match value.and_then(JsonValue::as_bool) {
        Some(true) => Capability::Yes,
        Some(false) => Capability::No,
        None => Capability::Unknown,
    }
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn record(provider: &ProviderId, provider_npm: Option<&str>, id: &str, row: &JsonValue) -> ModelRecord {
    let mut record = ModelRecord::new(provider.clone(), id);
    record.source = MetadataSource::ModelsDev;
    record.display_name = row.get("name").and_then(JsonValue::as_str).map(str::to_owned);
    record.family = row.get("family").and_then(JsonValue::as_str).map(str::to_owned);
    // A model's own package wins over its provider's.
    record.npm = row
        .pointer("/provider/npm")
        .and_then(JsonValue::as_str)
        .or(provider_npm)
        .map(str::to_owned);
    record.output_modalities = strings(row.pointer("/modalities/output"));
    if row.pointer("/modalities/input").is_some() {
        record.vision = if strings(row.pointer("/modalities/input")).iter().any(|m| m == "image") {
            Capability::Yes
        } else {
            Capability::No
        };
    }
    record.function_calling = capability(row.get("tool_call"));
    record.reasoning = capability(row.get("reasoning"));
    record.context_window = row.pointer("/limit/context").and_then(JsonValue::as_u64);
    record.output_tokens = row.pointer("/limit/output").and_then(JsonValue::as_u64);
    let rate = |key: &str| row.pointer(&format!("/cost/{key}")).and_then(JsonValue::as_f64);
    record.rates.input = rate("input");
    record.rates.output = rate("output");
    record.rates.cache_read = rate("cache_read");
    record.rates.cache_write = rate("cache_write");
    record
}

impl ModelsDev {
    /// `None` when `bytes` is not the models.dev document (an object of
    /// providers); a malformed provider or model row is skipped.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let JsonValue::Object(providers) = serde_json::from_slice(bytes).ok()? else {
            return None;
        };
        let mut out = BTreeMap::new();
        for (key, entry) in &providers {
            let Some(models) = entry.get("models").and_then(JsonValue::as_object) else {
                continue;
            };
            let provider = ProviderId::from(key.as_str());
            let npm = entry.get("npm").and_then(JsonValue::as_str);
            let mut list: Vec<ModelRecord> = models
                .iter()
                .filter(|(_, row)| row.is_object())
                .map(|(id, row)| record(&provider, npm, id, row))
                .collect();
            list.sort_by(|a, b| a.id.cmp(&b.id));
            out.insert(provider, list);
        }
        Some(Self { providers: out })
    }

    pub fn models_of(&self, provider: &ProviderId) -> &[ModelRecord] {
        self.providers.get(provider).map_or(&[], Vec::as_slice)
    }

    /// The row for `id` as `provider` lists it, else the first provider (in
    /// id order) that lists the model: a gateway serves other providers'
    /// models under their own ids.
    pub fn find(&self, provider: &ProviderId, id: &str) -> Option<&ModelRecord> {
        let own = self.models_of(provider).iter().find(|r| r.id == id);
        own.or_else(|| self.providers.values().flatten().find(|r| r.id == id))
    }

    /// Feeds a compat model table the output modalities this layer states.
    pub fn fill_table(&self, provider: &ProviderId, table: &ModelTable) {
        table.fill_output_modalities(|id| {
            self.find(provider, id)
                .map(|r| r.output_modalities.clone())
                .filter(|m| !m.is_empty())
        });
    }
}

impl CatalogSnapshot {
    /// This snapshot with every record's gaps filled from `layer`.
    pub fn with_metadata(&self, layer: &ModelsDev) -> Self {
        let mut next = self.clone();
        for (provider, records) in &mut next.models {
            for record in records {
                if let Some(meta) = layer.find(provider, &record.id) {
                    record.fill_gaps_from(meta);
                }
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::CatalogTraits;
    use crate::catalog::ModelTraits;
    use crate::catalog::ProviderCatalog;
    use crate::providers::compat::profile::CompatProfile;
    use crate::providers::compat::profile::Wire;
    use serde_json::json;
    use std::sync::Arc;

    fn fixture() -> Vec<u8> {
        json!({
            "openai": {"id": "openai", "npm": "@ai-sdk/openai", "models": {
                "gpt-x": {"name": "GPT X", "family": "gpt", "tool_call": true, "reasoning": false,
                    "modalities": {"input": ["text", "image"], "output": ["text"]},
                    "limit": {"context": 400000, "output": 128000},
                    "cost": {"input": 1.25, "output": 10.0, "cache_read": 0.125}},
                "tts-x": {"modalities": {"input": ["text"], "output": ["audio"]}}
            }},
            "anthropic": {"npm": "@ai-sdk/anthropic", "models": {
                "claude-x": {"modalities": {"output": ["text"]}},
                "odd": {"provider": {"npm": "@ai-sdk/google"}}
            }},
            "broken": {"models": "nope"},
            "junk": 7
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn parses_packages_modalities_limits_and_rates() {
        let layer = ModelsDev::parse(&fixture()).unwrap();
        let gpt = layer.find(&"openai".into(), "gpt-x").unwrap();
        assert_eq!(gpt.npm.as_deref(), Some("@ai-sdk/openai"));
        assert_eq!(gpt.output_modalities, ["text"]);
        assert_eq!(gpt.vision, Capability::Yes);
        assert_eq!(gpt.reasoning, Capability::No);
        assert_eq!(gpt.context_window, Some(400000));
        assert_eq!(gpt.rates.cache_read, Some(0.125));
        assert_eq!(gpt.source, MetadataSource::ModelsDev);
        assert_eq!(
            layer.find(&"anthropic".into(), "odd").unwrap().npm.as_deref(),
            Some("@ai-sdk/google"),
            "the model's own package wins"
        );
        assert!(layer.models_of(&"broken".into()).is_empty());
        assert!(ModelsDev::parse(b"[]").is_none());
    }

    #[test]
    fn a_gateway_model_with_no_row_of_its_own_gets_wire_and_picker_from_models_dev() {
        let layer = ModelsDev::parse(&fixture()).unwrap();
        // The gateway lists other providers' models under their ids and states nothing.
        let mut snapshot = CatalogSnapshot::default();
        snapshot.models.insert(
            "gateway".into(),
            ["claude-x", "tts-x", "unlisted"]
                .map(|id| ModelRecord::new("gateway".into(), id))
                .to_vec(),
        );
        let filled = snapshot.with_metadata(&layer);
        let traits = CatalogTraits::new(Arc::new(ProviderCatalog::new(filled)), "gateway".into());
        assert_eq!(traits.catalog_wire("claude-x"), Some(Wire::Messages));
        assert!(traits.outputs_text("claude-x"));
        assert!(!traits.outputs_text("tts-x"));
        assert_eq!(traits.catalog_wire("unlisted"), None);
    }

    #[test]
    fn compat_model_table_receives_the_modalities() {
        use serde_json::json as j;
        let layer = ModelsDev::parse(&fixture()).unwrap();
        let table = CompatProfile::mimo_oauth().model_table();
        table.replace(crate::providers::compat::models::parse_models(&j!([
            {"id": "gpt-x"}, {"id": "tts-x"}
        ])));
        layer.fill_table(&"mimo".into(), &table);
        let ids: Vec<String> = table.chat_models().iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, ["gpt-x"]);
    }
}