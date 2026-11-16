//! The models.dev metadata layer (`api.json`): per provider, per model, the
//! facts the provider's own listing lacks. It is read beside the catalog
//! (`CatalogTraits`, the metadata lookup), never merged into it; what it
//! states is the SDK package (`npm`, which names the wire), the output
//! modalities, limits, rates and capabilities.

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::record::Capability;
use super::record::MetadataSource;
use super::record::ModelRecord;
use super::record::Rates;
use crate::providers::compat::models::ModelTable;

#[derive(Clone, Default, Debug)]
pub struct ModelsDev {
    providers: BTreeMap<ProviderId, BTreeMap<String, MetadataRecord>>,
    /// The overlay as the metadata lookup reads it (`model-catalog-projection.mjs`):
    /// the narrowed models.dev document, or the narrowed LiteLLM one for the
    /// layer [`ModelsDev::parse_litellm`] builds.
    projected: JsonValue,
}

/// Overlay rows do not carry the provider picker's defaults, controls or routing state.
#[derive(Clone, Debug)]
struct MetadataRecord {
    display_name: Option<String>,
    family: Option<String>,
    npm: Option<String>,
    output_modalities: Vec<String>,
    vision: Capability,
    function_calling: Capability,
    reasoning: Capability,
    context_window: Option<u64>,
    output_tokens: Option<u64>,
    rates: Rates,
}

impl MetadataRecord {
    fn materialize(&self, provider: &ProviderId, id: &str) -> ModelRecord {
        let mut row = ModelRecord::new(provider.clone(), id);
        row.source = MetadataSource::ModelsDev;
        row.display_name = self.display_name.clone();
        row.family = self.family.clone();
        row.npm = self.npm.clone();
        row.output_modalities = self.output_modalities.clone();
        row.vision = self.vision;
        row.function_calling = self.function_calling;
        row.reasoning = self.reasoning;
        row.context_window = self.context_window;
        row.output_tokens = self.output_tokens;
        row.rates = self.rates;
        row
    }
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

fn record(provider_npm: Option<&str>, row: &JsonValue) -> MetadataRecord {
    // A model's own package wins over its provider's.
    let npm = row
        .pointer("/provider/npm")
        .and_then(JsonValue::as_str)
        .or(provider_npm)
        .map(str::to_owned);
    let vision = if row.pointer("/modalities/input").is_some() {
        if strings(row.pointer("/modalities/input")).iter().any(|m| m == "image") {
            Capability::Yes
        } else {
            Capability::No
        }
    } else {
        Capability::Unknown
    };
    let rate = |key: &str| row.pointer(&format!("/cost/{key}")).and_then(JsonValue::as_f64);
    MetadataRecord {
        display_name: row.get("name").and_then(JsonValue::as_str).map(str::to_owned),
        family: row.get("family").and_then(JsonValue::as_str).map(str::to_owned),
        npm,
        output_modalities: strings(row.pointer("/modalities/output")),
        vision,
        function_calling: capability(row.get("tool_call")),
        reasoning: capability(row.get("reasoning")),
        context_window: row.pointer("/limit/context").and_then(JsonValue::as_u64),
        output_tokens: row.pointer("/limit/output").and_then(JsonValue::as_u64),
        rates: Rates { input: rate("input"), output: rate("output"), cache_read: rate("cache_read"), cache_write: rate("cache_write") },
    }
}

impl ModelsDev {
    /// `None` when `bytes` is not the models.dev document (an object of
    /// providers); a malformed provider or model row is skipped.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        Self::from_models_dev(serde_json::from_slice(bytes).ok()?)
    }

    /// The LiteLLM price table (`model_prices_and_context_window.json`) as a
    /// metadata overlay; it carries no per-provider records.
    pub fn parse_litellm(bytes: &[u8]) -> Option<Self> {
        let document: JsonValue = serde_json::from_slice(bytes).ok()?;
        document.is_object().then(|| Self { providers: BTreeMap::new(), projected: super::lookup::project_litellm(&document) })
    }

    pub(crate) fn from_models_dev(document: JsonValue) -> Option<Self> {
        let projected = super::lookup::project_models_dev(&document);
        let JsonValue::Object(providers) = document else {
            return None;
        };
        let mut out = BTreeMap::new();
        for (key, entry) in &providers {
            let Some(models) = entry.get("models").and_then(JsonValue::as_object) else {
                continue;
            };
            let provider = ProviderId::from(key.as_str());
            let npm = entry.get("npm").and_then(JsonValue::as_str);
            let list = models
                .iter()
                .filter(|(_, row)| row.is_object())
                .map(|(id, row)| (id.clone(), record(npm, row)))
                .collect();
            out.insert(provider, list);
        }
        Some(Self { providers: out, projected })
    }

    #[cfg(test)]
    pub(crate) fn from_litellm(document: JsonValue) -> Self {
        Self { providers: BTreeMap::new(), projected: super::lookup::project_litellm(&document) }
    }

    /// The narrowed overlay document the metadata lookup reads.
    pub fn projected(&self) -> &JsonValue {
        &self.projected
    }

    pub fn models_of(&self, provider: &ProviderId) -> Vec<ModelRecord> {
        self.providers.get(provider).into_iter().flatten().map(|(id, row)| row.materialize(provider, id)).collect()
    }

    /// The row for `id` as `provider` lists it, else the first provider (in
    /// id order) that lists the model: a gateway serves other providers'
    /// models under their own ids.
    pub fn find(&self, provider: &ProviderId, id: &str) -> Option<ModelRecord> {
        let own = self.providers.get(provider).and_then(|rows| rows.get(id)).map(|row| row.materialize(provider, id));
        own.or_else(|| self.providers.iter().find_map(|(provider, rows)| rows.get(id).map(|row| row.materialize(provider, id))))
    }

    /// Feeds a compat model table the output modalities this layer states.
    pub fn fill_table(&self, provider: &ProviderId, table: &ModelTable) {
        table.fill_output_modalities(|id| {
            self.find(provider, id)
                .map(|r| r.output_modalities)
                .filter(|m| !m.is_empty())
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::compat::profile::CompatProfile;
    use serde_json::json;

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

    #[test]
    fn metadata_lookup_keeps_provider_precedence_and_explicit_empty_strings() {
        let layer = ModelsDev::from_models_dev(json!({
            "z": { "npm": "provider-z", "models": {
                "same": { "name": "", "provider": { "npm": "" } },
                "first": {}
            }},
            "a": { "npm": "provider-a", "models": { "same": { "name": "A" } } }
        })).unwrap();
        let own = layer.find(&"z".into(), "same").unwrap();
        assert_eq!((own.provider.as_str(), own.display_name.as_deref(), own.npm.as_deref()), ("z", Some(""), Some("")));
        let other = layer.find(&"missing".into(), "same").unwrap();
        assert_eq!((other.provider.as_str(), other.display_name.as_deref(), other.npm.as_deref()), ("a", Some("A"), Some("provider-a")));
        assert_eq!(layer.models_of(&"z".into()).into_iter().map(|row| row.id).collect::<Vec<_>>(), ["first", "same"]);
    }
}