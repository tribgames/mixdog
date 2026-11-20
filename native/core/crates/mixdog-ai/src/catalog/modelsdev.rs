//! The models.dev metadata layer (`api.json`): per provider, per model, the
//! facts the provider's own listing lacks. It is read beside the catalog
//! (`CatalogTraits`, the metadata lookup), never merged into it; what it
//! states is the SDK package (`npm`, which names the wire), the output
//! modalities, limits, rates and capabilities.

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::overlay::Overlay;
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
    /// layer [`ModelsDev::parse_litellm`] builds, one compact row each ([`Overlay`]).
    projected: Overlay,
    /// A digest of the document this layer was parsed from (0 for one built in a test): two fetches of the same document
    /// have the same digest ([`ModelsDev::digest`]).
    digest: u64,
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
    value.and_then(JsonValue::as_array).map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
}

fn record(provider_npm: Option<&str>, row: &JsonValue) -> MetadataRecord {
    // A model's own package wins over its provider's.
    let npm = row.pointer("/provider/npm").and_then(JsonValue::as_str).or(provider_npm).map(str::to_owned);
    let vision = if row.pointer("/modalities/input").is_some() {
        if strings(row.pointer("/modalities/input")).iter().any(|m| m == "image") { Capability::Yes } else { Capability::No }
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

/// A digest of a fetched document's bytes, stable within the process.
fn digest_of(bytes: &[u8]) -> u64 {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(bytes);
    hasher.finish()
}

/// The documents are several megabytes of JSON and their value tree is ten times that. They are read member by member:
/// one model row is a value at a time, narrowed to its record and its overlay text and dropped, so reading a document
/// costs what the layer keeps and not the tree.
mod stream {
    use indexmap::IndexMap;
    use serde::de::DeserializeSeed;
    use serde::de::Deserializer;
    use serde::de::MapAccess;
    use serde::de::SeqAccess;
    use serde::de::Visitor;

    use super::JsonValue;
    use super::MetadataRecord;

    /// The members of a JSON object handed to `each` one at a time; any other JSON value is read and is `None`.
    struct Object<F>(F);

    /// A member's value: `each` reads it from the map it is given (exactly once).
    pub(super) trait Member {
        fn read<'de, A: MapAccess<'de>>(&mut self, key: String, map: &mut A) -> Result<(), A::Error>;
    }

    impl<'de, F: Member> Visitor<'de> for Object<F> {
        type Value = Option<F>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a JSON value")
        }

        fn visit_map<A: MapAccess<'de>>(mut self, mut map: A) -> Result<Self::Value, A::Error> {
            while let Some(key) = map.next_key::<String>()? {
                self.0.read(key, &mut map)?;
            }
            Ok(Some(self.0))
        }

        fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
            while seq.next_element::<Skipped>()?.is_some() {}
            Ok(None)
        }

        fn visit_bool<E>(self, _: bool) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_i64<E>(self, _: i64) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_u64<E>(self, _: u64) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_f64<E>(self, _: f64) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_str<E>(self, _: &str) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
    }

    impl<'de, F: Member> DeserializeSeed<'de> for Object<F> {
        type Value = Option<F>;

        fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_any(self)
        }
    }

    /// A value nothing reads, checked as a value tree would have checked it (a number out of range, the nesting limit)
    /// and not kept. The deserializer's own skip accepts what a value does not.
    struct Skipped;

    impl<'de> serde::Deserialize<'de> for Skipped {
        fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            struct Skip;

            impl<'de> Visitor<'de> for Skip {
                type Value = Skipped;

                fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                    formatter.write_str("a JSON value")
                }

                fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Skipped, A::Error> {
                    while map.next_entry::<Skipped, Skipped>()?.is_some() {}
                    Ok(Skipped)
                }

                fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Skipped, A::Error> {
                    while seq.next_element::<Skipped>()?.is_some() {}
                    Ok(Skipped)
                }

                fn visit_bool<E>(self, _: bool) -> Result<Skipped, E> {
                    Ok(Skipped)
                }

                fn visit_i64<E>(self, _: i64) -> Result<Skipped, E> {
                    Ok(Skipped)
                }

                fn visit_u64<E>(self, _: u64) -> Result<Skipped, E> {
                    Ok(Skipped)
                }

                fn visit_f64<E>(self, _: f64) -> Result<Skipped, E> {
                    Ok(Skipped)
                }

                fn visit_str<E>(self, _: &str) -> Result<Skipped, E> {
                    Ok(Skipped)
                }

                fn visit_unit<E>(self) -> Result<Skipped, E> {
                    Ok(Skipped)
                }
            }
            deserializer.deserialize_any(Skip)
        }
    }

    /// `bytes` as one JSON object read through `members`; `None` when it is not JSON or not an object.
    pub(super) fn object<F: Member>(bytes: &[u8], members: F) -> Option<F> {
        let mut deserializer = serde_json::Deserializer::from_slice(bytes);
        let read = Object(members).deserialize(&mut deserializer).ok()?;
        deserializer.end().ok()?;
        read
    }

    /// What a key holds once its last occurrence is read: a repeated key keeps its first place and its last value, as the
    /// value tree did, so a value that is not kept still holds its key's place until the document ends.
    type Placed<T> = IndexMap<String, Option<T>>;

    /// The kept values of `placed`, in the order their keys first appeared.
    pub(super) fn kept<T>(placed: Placed<T>) -> impl Iterator<Item = (String, T)> {
        placed.into_iter().filter_map(|(key, value)| value.map(|value| (key, value)))
    }

    /// One provider's `models` map: every row that is an object, as its record and its overlay text.
    #[derive(Default)]
    struct Models(Placed<(MetadataRecord, Box<str>)>);

    /// One provider entry: its package and its models, whichever order the document states them in.
    #[derive(Default)]
    struct Provider {
        npm: Option<String>,
        models: Option<Models>,
    }

    impl Member for Provider {
        fn read<'de, A: MapAccess<'de>>(&mut self, key: String, map: &mut A) -> Result<(), A::Error> {
            match key.as_str() {
                "npm" => self.npm = map.next_value::<JsonValue>()?.as_str().map(str::to_owned),
                "models" => self.models = map.next_value_seed(Object(Models::default()))?,
                _ => {
                    map.next_value::<Skipped>()?;
                }
            }
            Ok(())
        }
    }

    /// One model of the models.dev document: its record and overlay text.
    type ModelEntry = (MetadataRecord, Box<str>);

    /// The models.dev document: provider → model id → record and overlay text, in document order. A provider without a
    /// models map is absent.
    #[derive(Default)]
    pub(super) struct ModelsDevDocument(pub(super) Placed<Vec<(String, ModelEntry)>>);

    impl Member for ModelsDevDocument {
        fn read<'de, A: MapAccess<'de>>(&mut self, key: String, map: &mut A) -> Result<(), A::Error> {
            let provider = map.next_value_seed(Object(Provider::default()))?;
            let models = provider.and_then(|provider| provider.models.map(|models| (provider.npm, models.0))).map(|(npm, models)| {
                let mut models: Vec<_> = kept(models).collect();
                // A model's own package wins over its provider's.
                for (_, (record, _)) in &mut models {
                    if record.npm.is_none() {
                        record.npm.clone_from(&npm);
                    }
                }
                models
            });
            self.0.insert(key, models);
            Ok(())
        }
    }

    /// The LiteLLM table: key → overlay text of the narrowed row.
    #[derive(Default)]
    pub(super) struct LitellmDocument(pub(super) Placed<Box<str>>);

    impl Member for Models {
        fn read<'de, A: MapAccess<'de>>(&mut self, id: String, map: &mut A) -> Result<(), A::Error> {
            let row: JsonValue = map.next_value()?;
            let kept = crate::catalog::lookup::models_dev_row(&row).map(|projected| (super::record(None, &row), crate::catalog::overlay::text(&projected)));
            self.0.insert(id, kept);
            Ok(())
        }
    }
    impl Member for LitellmDocument {
        fn read<'de, A: MapAccess<'de>>(&mut self, key: String, map: &mut A) -> Result<(), A::Error> {
            let row: JsonValue = map.next_value()?;
            let kept =
                crate::catalog::lookup::litellm_row(&row).filter(crate::catalog::overlay::holds).map(|projected| crate::catalog::overlay::text(&projected));
            self.0.insert(key, kept);
            Ok(())
        }
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
        assert_eq!(layer.find(&"anthropic".into(), "odd").unwrap().npm.as_deref(), Some("@ai-sdk/google"), "the model's own package wins");
        assert!(layer.models_of(&"broken".into()).is_empty());
        assert!(ModelsDev::parse(b"[]").is_none());
    }

    #[test]
    fn metadata_lookup_keeps_provider_precedence_and_explicit_empty_strings() {
        let layer = ModelsDev::from_models_dev(json!({
            "z": { "npm": "provider-z", "models": {
                "same": { "name": "", "provider": { "npm": "" } },
                "first": {}
            }},
            "a": { "npm": "provider-a", "models": { "same": { "name": "A" } } }
        }))
        .unwrap();
        let own = layer.find(&"z".into(), "same").unwrap();
        assert_eq!((own.provider.as_str(), own.display_name.as_deref(), own.npm.as_deref()), ("z", Some(""), Some("")));
        let other = layer.find(&"missing".into(), "same").unwrap();
        assert_eq!((other.provider.as_str(), other.display_name.as_deref(), other.npm.as_deref()), ("a", Some("A"), Some("provider-a")));
        assert_eq!(layer.models_of(&"z".into()).into_iter().map(|row| row.id).collect::<Vec<_>>(), ["first", "same"]);
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

impl ModelsDev {
    /// `None` when `bytes` is not the models.dev document (an object of
    /// providers); a malformed provider or model row is skipped.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let document = stream::object(bytes, stream::ModelsDevDocument::default())?.0;
        let mut providers = BTreeMap::new();
        let mut projected = indexmap::IndexMap::with_capacity(document.len());
        for (key, models) in stream::kept(document) {
            let mut records = BTreeMap::new();
            let mut rows = indexmap::IndexMap::with_capacity(models.len());
            for (id, (record, row)) in models {
                records.insert(id.clone(), record);
                rows.insert(id, row);
            }
            providers.insert(ProviderId::from(key.as_str()), records);
            projected.insert(key, rows);
        }
        Some(Self { providers, projected: Overlay::of_rows(indexmap::IndexMap::new(), projected), digest: digest_of(bytes) })
    }

    /// The LiteLLM price table (`model_prices_and_context_window.json`) as a
    /// metadata overlay; it carries no per-provider records.
    pub fn parse_litellm(bytes: &[u8]) -> Option<Self> {
        let rows = stream::kept(stream::object(bytes, stream::LitellmDocument::default())?.0).collect();
        Some(Self { providers: BTreeMap::new(), projected: Overlay::of_rows(rows, indexmap::IndexMap::new()), digest: digest_of(bytes) })
    }

    /// The layer of a document held as a value (a test's fixture): the layer [`ModelsDev::parse`] reads from its text,
    /// without a digest.
    #[cfg(test)]
    pub(crate) fn from_models_dev(document: JsonValue) -> Option<Self> {
        let mut layer = Self::parse(&serde_json::to_vec(&document).ok()?)?;
        layer.digest = 0;
        Some(layer)
    }

    /// The digest of the document this layer was parsed from: equal for two fetches of the same document.
    pub fn digest(&self) -> u64 {
        self.digest
    }

    /// The narrowed overlay document the metadata lookup reads.
    pub fn projected(&self) -> &Overlay {
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
        table.fill_output_modalities(|id| self.find(provider, id).map(|r| r.output_modalities).filter(|m| !m.is_empty()));
    }
}
