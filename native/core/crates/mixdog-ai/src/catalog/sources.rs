use std::sync::Arc;

use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::oauth_cache::OauthModelCache;
use super::record::Capability;
use super::record::MetadataSource;
use super::record::ModelRecord;
use super::record::Rates;

/// One provider's listing wired to the catalog: the adapter's own
/// [`ModelListing`], read as catalog records. There is one listing contract;
/// this is the catalog's side of it, not a second one.
#[derive(Clone)]
pub struct ModelSource {
    provider: ProviderId,
    listing: Arc<dyn ModelListing>,
    /// What the provider answers in place of a listing that failed (Node's offline floor); only a registry adapter has one.
    floor: Option<Floor>,
    /// The Anthropic OAuth route's 24 h roster cache, read before the fetch and written after it.
    cache: Option<OauthModelCache>,
}

/// The offline floors of Node's providers (`listModels` answering its static list), generated from Node's own lists by
/// `benchmarks/rust-core/recorders/gen-offline-floors.mjs`.
const OFFLINE_FLOORS: &str = include_str!("offline_floors.json");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Floor {
    /// `anthropic.mjs` `listModels`: no key, a failed fetch or an empty listing answers `MODELS`.
    Anthropic,
    /// `anthropic-oauth.mjs` `listModels`: a failed fetch answers `MODELS` as full-id family rows (an empty listing stands).
    AnthropicOauth,
    /// `gemini.mjs` `listModels`: no key or a failed fetch answers `GEMINI_MODELS`.
    Gemini,
}

impl Floor {
    fn of(provider: &str) -> Option<Self> {
        match provider {
            "anthropic" => Some(Self::Anthropic),
            "anthropic-oauth" => Some(Self::AnthropicOauth),
            "gemini" => Some(Self::Gemini),
            _ => None,
        }
    }

    /// Whether an empty successful listing is answered by the floor too.
    fn covers_empty(self) -> bool {
        self == Self::Anthropic
    }

    /// The floor's rows for `provider`, as the catalog stores them.
    fn rows(self, provider: &ProviderId, env: &dyn Fn(&str) -> Option<String>) -> Vec<ModelRecord> {
        let floors: serde_json::Value = serde_json::from_str(OFFLINE_FLOORS).expect("the bundled floors are valid JSON");
        let list = floors[if self == Self::Gemini { "gemini" } else { "anthropic" }].as_array().cloned().unwrap_or_default();
        list.iter()
            .map(|row| {
                let text = |key: &str| row[key].as_str().unwrap_or_default().to_owned();
                let mut id = text("id");
                if self == Self::AnthropicOauth {
                    // ANTHROPIC_DEFAULT_<FAMILY>_MODEL overrides one family's id.
                    let variable = format!("ANTHROPIC_DEFAULT_{}_MODEL", text("family").to_uppercase());
                    if let Some(over) = env(&variable).filter(|v| !v.is_empty()) {
                        id = over;
                    }
                }
                let mut record = ModelRecord::new(provider.clone(), id);
                record.display_name = Some(text("name"));
                record.name = Some(text("name"));
                record.family = row["family"].as_str().map(str::to_owned);
                record.context_window = row["contextWindow"].as_u64();
                if self == Self::AnthropicOauth {
                    record.picker.tier = Some("family".to_owned());
                    record.picker.latest = true;
                }
                record.source = MetadataSource::Native;
                record
            })
            .collect()
    }
}

impl ModelSource {
    pub fn new(provider: ProviderId, listing: Arc<dyn ModelListing>) -> Self {
        Self { provider, listing, floor: None, cache: None }
    }

    /// Gives the `anthropic-oauth` source its disk cache (`anthropic-oauth-models.json`); any other provider has none.
    pub fn with_oauth_cache(mut self, cache: OauthModelCache) -> Self {
        self.cache = (self.provider.as_str() == "anthropic-oauth").then_some(cache);
        self
    }

    /// The registry-to-catalog bridge: `adapter`'s listing, or `None` for an
    /// adapter that lists no models (`ProviderAdapter::models`).
    pub fn of_adapter(provider: ProviderId, adapter: Arc<dyn ProviderAdapter>) -> Option<Self> {
        adapter.models()?;
        let floor = Floor::of(provider.as_str());
        Some(Self { floor, ..Self::new(provider, Arc::new(AdapterListing(adapter))) })
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// One fetch: the adapter's records, as the catalog stores them.
    pub async fn list(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        let env = |name: &str| std::env::var(name).ok();
        // A fresh cache answers without a fetch and is not written again (`listModels`: `if (cached) return cached`).
        if let Some(cached) = match &self.cache {
            Some(cache) => cache.load().await,
            None => None,
        } {
            return Ok(cached.into_iter().map(|record| catalog_record(&self.provider, record)).collect());
        }
        let listed = match (self.listing.list_models().await, self.floor) {
            (Ok(listed), Some(floor)) if listed.is_empty() && floor.covers_empty() => return Ok(floor.rows(&self.provider, &env)),
            (Ok(listed), _) => {
                // `normalizeAndSaveCatalog`: every successful fetch is persisted, an empty list too.
                if let Some(cache) = &self.cache {
                    cache.save(&listed).await;
                }
                listed
            }
            (Err(error), Some(floor)) => {
                // Node writes the failure to stderr and answers its floor; the catalog sees a listing that worked.
                tracing::warn!(provider = self.provider.as_str(), kind = ?error.kind, "[provider] listModels failed; answering the offline floor");
                return Ok(floor.rows(&self.provider, &env));
            }
            (Err(error), None) => return Err(error),
        };
        Ok(listed.into_iter().map(|record| catalog_record(&self.provider, record)).collect())
    }
}

/// A [`ModelListing`] that reads through its adapter.
struct AdapterListing(Arc<dyn ProviderAdapter>);

#[async_trait::async_trait]
impl ModelListing for AdapterListing {
    async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
        match self.0.models() {
            Some(listing) => listing.list_models().await,
            None => Ok(Vec::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::PickerFields;
    use mixdog_core_api::domain::provider::ServiceTier;

    use super::*;

    #[tokio::test]
    async fn an_adapters_listing_reaches_the_catalog_with_its_picker_fields() {
        mixdog_rt::testing::tokens();
        let mut provider = MockProvider::new([]);
        let mut listed = mixdog_core_api::domain::provider::ModelRecord::new("m1");
        listed.supports_reasoning = Some(false);
        listed.hidden = true;
        listed.default_reasoning_level = Some("high".into());
        listed.mode = Some("chat".into());
        listed.created = Some(1_700_000_000);
        listed.alias_target = Some("anthropic/claude-x".into());
        listed.wire = Some(mixdog_core_api::domain::provider::WireIds::Tiers(vec![("high".into(), "m1-high".into())]));
        listed.context_window = Some(272_000);
        listed.max_context_window = Some(1_000_000);
        listed.input_cost_per_m = Some(0.4);
        listed.output_cost_per_m = Some(1.6);
        listed.cache_read_cost_per_m = Some(0.0);
        listed.cache_write_cost_per_m = Some(f64::INFINITY);
        listed.name = Some("m1-name".into());
        listed.provider_name = Some("My Gateway".into());
        listed.manual = true;
        listed.supports_reasoning_effort_updates = Some(false);
        listed.supports_prompt_caching = Some(true);
        listed.reasoning_content_field = Some("reasoning_content".into());
        listed.picker = PickerFields {
            release_date: Some("2026-03-17".into()),
            access_programs: Some(Vec::new()),
            service_tiers: vec![ServiceTier { id: "priority".into(), name: "Fast".into(), description: String::new() }],
            tier: Some("version".into()),
            latest: true,
            description: Some("a model".into()),
            default_service_tier: Some("priority".into()),
            default_model_parameters: [("context".to_owned(), "272k".to_owned())].into(),
            default_fast: true,
            supports_max_mode: true,
            ..PickerFields::default()
        };
        provider.models = vec![listed.clone()];
        let source = ModelSource::of_adapter("mock".into(), Arc::new(provider)).expect("the mock lists models");
        let records = source.list().await.unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].provider, ProviderId::from("mock"));
        assert_eq!(records[0].reasoning, Capability::No);
        assert!(records[0].hidden);
        assert_eq!(records[0].default_effort.as_deref(), Some("high"));
        assert_eq!(records[0].mode.as_deref(), Some("chat"));
        assert_eq!(records[0].created, Some(1_700_000_000));
        assert_eq!(records[0].alias_target.as_deref(), Some("anthropic/claude-x"));
        assert_eq!(records[0].wire, listed.wire);
        let cached: ModelRecord = serde_json::from_value(serde_json::to_value(&records[0]).unwrap()).unwrap();
        assert_eq!(cached.wire, listed.wire, "the catalog cache keeps the wire ids");
        assert_eq!(records[0].max_context_window, Some(1_000_000));
        let cached_json = serde_json::to_value(&records[0]).unwrap();
        assert_eq!(cached_json["maxContextWindow"], 1_000_000, "the cached row carries Node's key");
        assert_eq!(cached.max_context_window, Some(1_000_000));
        assert_eq!(
            (cached_json["rates"]["input"].as_f64(), cached_json["rates"]["output"].as_f64(), cached_json["rates"]["cacheRead"].as_f64()),
            (Some(0.4), Some(1.6), Some(0.0)),
        );
        assert_eq!((cached.rates.cache_write, cached.rates), (None, records[0].rates), "a price that is not finite is left out");
        assert_eq!(records[0].picker, listed.picker, "an empty access list stays empty, not absent");
        // Every fact the `model/list` row reads survives the bridge and the cache file.
        for record in [&records[0], &cached] {
            assert_eq!(record.name.as_deref(), Some("m1-name"));
            assert_eq!(record.display_name.as_deref(), Some("m1-name"), "the label falls back to the name");
            assert_eq!(record.provider_name.as_deref(), Some("My Gateway"));
            assert!(record.manual);
            assert_eq!(record.supports_reasoning_effort_updates, Some(false));
            assert_eq!(record.prompt_caching, Capability::Yes);
            assert_eq!(record.reasoning_content_field.as_deref(), Some("reasoning_content"));
            assert_eq!(record.picker, listed.picker);
        }
    }
}

fn tri(value: Option<bool>) -> Capability {
    match value {
        Some(true) => Capability::Yes,
        Some(false) => Capability::No,
        None => Capability::Unknown,
    }
}

/// An adapter's listed record as a catalog record: what the provider states,
/// before metadata enrichment.
pub(super) fn catalog_record(provider: &ProviderId, listed: mixdog_core_api::domain::provider::ModelRecord) -> ModelRecord {
    let mut record = ModelRecord::new(provider.clone(), listed.id);
    // `display || name` is every Node reader's label.
    record.display_name = listed.display_name.or_else(|| listed.name.clone());
    record.name = listed.name;
    record.provider_name = listed.provider_name;
    record.manual = listed.manual;
    record.supports_reasoning_effort_updates = listed.supports_reasoning_effort_updates;
    record.supports_reasoning_summaries = listed.supports_reasoning_summaries;
    record.thinking_adaptive = listed.thinking_adaptive;
    record.thinking_enabled = listed.thinking_enabled;
    record.efforts_stated = listed.efforts_stated;
    record.reasoning_content_field = listed.reasoning_content_field;
    record.prompt_caching = tri(listed.supports_prompt_caching);
    record.context_window = listed.context_window;
    record.max_context_window = listed.max_context_window;
    record.runtime_context_window = listed.runtime_context_window;
    record.output_tokens = listed.max_output_tokens;
    record.rates = Rates {
        input: listed.input_cost_per_m.filter(|v| v.is_finite()),
        output: listed.output_cost_per_m.filter(|v| v.is_finite()),
        cache_read: listed.cache_read_cost_per_m.filter(|v| v.is_finite()),
        cache_write: listed.cache_write_cost_per_m.filter(|v| v.is_finite()),
    };
    record.reasoning = tri(listed.supports_reasoning);
    record.reasoning_efforts = listed.reasoning_levels;
    record.vision = tri(listed.supports_images);
    record.hidden = listed.hidden;
    record.default_effort = listed.default_reasoning_level;
    record.mode = listed.mode;
    record.created = listed.created;
    record.alias_target = listed.alias_target;
    record.wire = listed.wire;
    record.picker = listed.picker;
    record.family = listed.family;
    record.effective = listed.raw.as_ref().is_some_and(|raw| raw.get("inherited").is_some());
    // `enrichModels` writes the lookup's capability flags over the row's own (`GUESSED_FLAGS`), so the listed row states them.
    let flag = |key: &str| listed.enriched.0.as_ref().and_then(|row| row.get(key)).and_then(|v| v.as_bool());
    record.function_calling = tri(flag("supportsFunctionCalling"));
    if let Some(on) = flag("supportsVision") {
        record.vision = tri(Some(on));
    }
    if let Some(on) = flag("supportsReasoning") {
        record.reasoning = tri(Some(on));
    }
    record.source = MetadataSource::Native;
    record
}

#[derive(Clone, Debug)]
pub struct ProviderEntry {
    pub id: ProviderId,
    pub enabled: bool,
    /// The provider's settings exactly as configured, API keys included.
    pub settings: JsonValue,
}

/// The provider configuration as loaded, secrets included. The only input of
/// [`build_sources`]; a redacted view for display or logs is a separate type
/// with no conversion to this one.
#[derive(Clone, Debug)]
pub struct FullProviderConfig {
    pub providers: Vec<ProviderEntry>,
}

/// Builds the listing source of one provider from its full entry.
pub trait SourceFactory: Send + Sync {
    fn source(&self, entry: &ProviderEntry) -> Option<Arc<dyn ModelListing>>;
}

/// One source per enabled provider the factory knows.
pub fn build_sources(config: &FullProviderConfig, factory: &dyn SourceFactory) -> Vec<ModelSource> {
    config
        .providers
        .iter()
        .filter(|entry| entry.enabled)
        .filter_map(|entry| Some(ModelSource::new(entry.id.clone(), factory.source(entry)?)))
        .collect()
}
#[cfg(test)]
mod floor_tests {
    use async_trait::async_trait;
    use mixdog_core_api::domain::provider::DeliveryState;
    use mixdog_core_api::domain::provider::ErrorKind;

    use super::*;

    /// A listing that answers what it is given: rows, or a transport failure.
    struct Scripted(Option<Vec<mixdog_core_api::domain::provider::ModelRecord>>);

    #[async_trait]
    impl ModelListing for Scripted {
        async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
            self.0.clone().ok_or_else(|| ProviderError::new(ErrorKind::Transient, DeliveryState::NotSent))
        }
    }

    fn source(provider: &str, rows: Option<Vec<mixdog_core_api::domain::provider::ModelRecord>>) -> ModelSource {
        let id = ProviderId::from(provider);
        ModelSource { floor: Floor::of(provider), ..ModelSource::new(id, Arc::new(Scripted(rows))) }
    }

    fn ids(rows: &[ModelRecord]) -> Vec<&str> {
        rows.iter().map(|r| r.id.as_str()).collect()
    }

    #[tokio::test]
    async fn a_failed_anthropic_listing_answers_nodes_models_floor() {
        // `anthropic-models.mjs` MODELS: one id per family, window 1 000 000, family stated.
        let rows = source("anthropic", None).list().await.unwrap();
        assert_eq!(ids(&rows), ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
        assert_eq!(rows[0].display_name.as_deref(), Some("Claude Opus 5.5"));
        assert_eq!((rows[0].context_window, rows[0].family.as_deref()), (Some(1_000_000), Some("opus")));
        assert!(rows.iter().all(|r| r.provider.as_str() == "anthropic" && !r.picker.latest && r.picker.tier.is_none()));
    }

    #[tokio::test]
    async fn an_empty_api_key_listing_is_the_floor_but_an_empty_oauth_listing_stands() {
        assert_eq!(source("anthropic", Some(Vec::new())).list().await.unwrap().len(), 3);
        assert!(source("anthropic-oauth", Some(Vec::new())).list().await.unwrap().is_empty());
        assert!(source("gemini", Some(Vec::new())).list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_oauth_floor_is_family_rows_and_a_family_variable_names_its_id() {
        let provider = ProviderId::from("anthropic-oauth");
        let env = |name: &str| (name == "ANTHROPIC_DEFAULT_SONNET_MODEL").then(|| "claude-sonnet-custom".to_owned());
        let rows = Floor::AnthropicOauth.rows(&provider, &env);
        assert_eq!(ids(&rows), ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-custom"]);
        assert!(rows.iter().all(|r| r.picker.latest && r.picker.tier.as_deref() == Some("family") && r.provider == provider));
        assert!(source("anthropic-oauth", None).list().await.is_ok());
    }

    #[tokio::test]
    async fn a_failed_gemini_listing_answers_the_gemini_floor_and_another_provider_still_fails() {
        let rows = source("gemini", None).list().await.unwrap();
        assert_eq!(ids(&rows), ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]);
        assert!(rows.iter().all(|r| r.context_window == Some(1_048_576) && r.family.is_none()));
        assert!(source("openai", None).list().await.is_err());
    }
}
