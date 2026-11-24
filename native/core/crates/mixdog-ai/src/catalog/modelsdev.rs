//! The models.dev metadata layer (`api.json`): per provider, per model, the
//! facts the provider's own listing lacks. It is read beside the catalog
//! (`CatalogTraits`, the metadata lookup), never merged into it; what it
//! states is the SDK package (`npm`, which names the wire), the output
//! modalities, limits, rates and capabilities.

use std::collections::BTreeMap;

use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::overlay::Overlay;
use super::record::MetadataSource;
use super::record::ModelRecord;

#[derive(Clone, Default, Debug)]
pub struct ModelsDev {
    /// Each provider's own package, the one fact its model rows do not carry; the models are read from `projected`.
    provider_npm: BTreeMap<ProviderId, Option<String>>,
    /// The overlay as the metadata lookup reads it (`model-catalog-projection.mjs`):
    /// the narrowed models.dev document, or the narrowed LiteLLM one for the
    /// layer [`ModelsDev::parse_litellm`] builds, one compact row each ([`Overlay`]).
    projected: Overlay,
    /// A digest of the document this layer was parsed from (0 for one built in a test): two fetches of the same document
    /// have the same digest ([`ModelsDev::digest`]).
    digest: u64,
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    value.and_then(JsonValue::as_array).map(|list| list.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default()
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
    struct Models(Placed<Box<str>>);

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

    /// One provider of the models.dev document: its package and its models' overlay text.
    pub(super) type ProviderEntry = (Option<String>, Vec<(String, Box<str>)>);

    /// The models.dev document: provider → package and model id → overlay text, in document order. A provider without a
    /// models map is absent.
    #[derive(Default)]
    pub(super) struct ModelsDevDocument(pub(super) Placed<ProviderEntry>);

    impl Member for ModelsDevDocument {
        fn read<'de, A: MapAccess<'de>>(&mut self, key: String, map: &mut A) -> Result<(), A::Error> {
            let provider = map.next_value_seed(Object(Provider::default()))?;
            let entry = provider.and_then(|provider| provider.models.map(|models| (provider.npm, kept(models.0).collect())));
            self.0.insert(key, entry);
            Ok(())
        }
    }

    /// The LiteLLM table: key → overlay text of the narrowed row.
    #[derive(Default)]
    pub(super) struct LitellmDocument(pub(super) Placed<Box<str>>);

    impl Member for Models {
        fn read<'de, A: MapAccess<'de>>(&mut self, id: String, map: &mut A) -> Result<(), A::Error> {
            let row: JsonValue = map.next_value()?;
            let kept = crate::catalog::lookup::models_dev_row(&row).map(|projected| crate::catalog::overlay::text(&projected));
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
    fn serves_packages_families_and_modalities_from_the_projection() {
        let layer = ModelsDev::parse(&fixture()).unwrap();
        let gpt = layer.find(&"openai".into(), "gpt-x").unwrap();
        assert_eq!(gpt.npm.as_deref(), Some("@ai-sdk/openai"), "the provider's package is the only fact kept beside the rows");
        assert_eq!(gpt.family.as_deref(), Some("gpt"));
        assert_eq!(gpt.output_modalities, ["text"]);
        assert_eq!(gpt.source, MetadataSource::ModelsDev);
        assert_eq!(layer.find(&"anthropic".into(), "odd").unwrap().npm.as_deref(), Some("@ai-sdk/google"), "the model's own package wins");
        assert!(layer.find(&"broken".into(), "gpt-x").is_some(), "a provider without the model falls to the first that lists it");
        assert!(layer.find(&"openai".into(), "nope").is_none());
        assert!(ModelsDev::parse(b"[]").is_none());
    }

    #[test]
    fn a_gateway_model_is_found_under_the_first_provider_in_id_order() {
        let layer = ModelsDev::from_models_dev(json!({
            "z": { "npm": "provider-z", "models": { "same": {}, "first": {} }},
            "a": { "npm": "provider-a", "models": { "same": { "name": "A" } } }
        }))
        .unwrap();
        let own = layer.find(&"z".into(), "same").unwrap();
        assert_eq!((own.provider.as_str(), own.npm.as_deref()), ("z", Some("provider-z")));
        let other = layer.find(&"missing".into(), "same").unwrap();
        assert_eq!((other.provider.as_str(), other.npm.as_deref()), ("a", Some("provider-a")));
    }
}
impl ModelsDev {
    /// `None` when `bytes` is not the models.dev document (an object of
    /// providers); a malformed provider or model row is skipped.
    pub fn parse(bytes: &[u8]) -> Option<Self> {
        let document = stream::object(bytes, stream::ModelsDevDocument::default())?.0;
        let mut provider_npm = BTreeMap::new();
        let mut projected = indexmap::IndexMap::with_capacity(document.len());
        for (key, (npm, models)) in stream::kept(document) {
            provider_npm.insert(ProviderId::from(key.as_str()), npm);
            projected.insert(key, models.into_iter().collect());
        }
        Some(Self { provider_npm, projected: Overlay::of_rows(indexmap::IndexMap::new(), projected), digest: digest_of(bytes) })
    }

    /// The LiteLLM price table (`model_prices_and_context_window.json`) as a
    /// metadata overlay; it carries no per-provider records.
    pub fn parse_litellm(bytes: &[u8]) -> Option<Self> {
        let rows = stream::kept(stream::object(bytes, stream::LitellmDocument::default())?.0).collect();
        Some(Self { provider_npm: BTreeMap::new(), projected: Overlay::of_rows(rows, indexmap::IndexMap::new()), digest: digest_of(bytes) })
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

    /// The package, family and output modalities of `id` as `provider` lists it, else as the first provider (in
    /// id order) that lists the model: a gateway serves other providers' models under their own ids. Read from the
    /// projected row; a model's own package wins over its provider's.
    pub fn find(&self, provider: &ProviderId, id: &str) -> Option<ModelRecord> {
        self.row_of(provider, id).or_else(|| self.provider_npm.keys().find_map(|other| self.row_of(other, id)))
    }

    fn row_of(&self, provider: &ProviderId, id: &str) -> Option<ModelRecord> {
        let row = self.projected.model(provider.as_str(), id)?;
        let mut record = ModelRecord::new(provider.clone(), id);
        record.source = MetadataSource::ModelsDev;
        record.family = row.get("family").and_then(JsonValue::as_str).map(str::to_owned);
        record.npm = row.get("npm").and_then(JsonValue::as_str).or_else(|| self.provider_npm.get(provider)?.as_deref()).map(str::to_owned);
        record.output_modalities = strings(row.pointer("/modalities/output"));
        Some(record)
    }
}
