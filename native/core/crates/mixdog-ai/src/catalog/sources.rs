use std::sync::Arc;

use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ListedRoster;
use mixdog_core_api::domain::provider::ModelListing;
use mixdog_core_api::domain::provider::Provenance;
use mixdog_core_api::domain::provider::ProviderAdapter;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RosterIdentity;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ProviderId;

use super::oauth_cache::Cached;
use super::oauth_cache::OauthModelCache;
use super::oauth_cache::Published;
use super::oauth_cache::Roster;
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
    /// The route's 24 h roster cache, read before the fetch and written after it.
    cache: Option<OauthModelCache>,
    /// A forced refresh (`refreshCodexCatalog`: "ignores the 24h TTL"): the roster is fetched whatever the file holds, and written.
    bypass_cache: bool,
    /// A recorded answer that stands in for the listing ([`Self::answering`]).
    #[cfg(any(test, feature = "test-support"))]
    answer: Option<Result<Vec<ModelRecord>, ProviderError>>,
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

    async fn list_roster(&self) -> Result<ListedRoster, ProviderError> {
        match self.0.models() {
            Some(listing) => listing.list_roster().await,
            None => Ok(ListedRoster { rows: Vec::new(), provenance: Provenance::Fetched, identity: Default::default() }),
        }
    }

    async fn roster_identity(&self) -> mixdog_core_api::domain::provider::RosterIdentity {
        match self.0.models() {
            Some(listing) => listing.roster_identity().await,
            None => Default::default(),
        }
    }

    fn show_roster(&self, rows: &[mixdog_core_api::domain::provider::ModelRecord]) {
        if let Some(listing) = self.0.models() {
            listing.show_roster(rows);
        }
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::mock::MockProvider;
    use mixdog_core_api::domain::provider::PickerFields;
    use mixdog_core_api::domain::provider::ServiceTier;

    use super::*;

    async fn list_through_the_catalog() -> (mixdog_core_api::domain::provider::ModelRecord, ModelRecord) {
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
        let mut records = source.list().await.unwrap();
        assert_eq!(records.len(), 1);
        (listed, records.remove(0))
    }

    fn through_the_cache_file(record: &ModelRecord) -> ModelRecord {
        serde_json::from_value(serde_json::to_value(record).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn an_adapters_listing_reaches_the_catalog_with_its_picker_fields() {
        let (listed, record) = list_through_the_catalog().await;
        assert_eq!(record.provider, ProviderId::from("mock"));
        assert_eq!(record.reasoning, Capability::No);
        assert!(record.hidden);
        assert_eq!(record.default_effort.as_deref(), Some("high"));
        assert_eq!(record.mode.as_deref(), Some("chat"));
        assert_eq!(record.created, Some(1_700_000_000));
        assert_eq!(record.alias_target.as_deref(), Some("anthropic/claude-x"));
        assert_eq!(record.wire, listed.wire);
        assert_eq!(record.max_context_window, Some(1_000_000));
        assert_eq!(record.picker, listed.picker, "an empty access list stays empty, not absent");
    }

    #[tokio::test]
    async fn the_catalog_cache_keeps_the_wire_ids_and_the_context_ceiling() {
        let (listed, record) = list_through_the_catalog().await;
        let cached = through_the_cache_file(&record);
        assert_eq!(cached.wire, listed.wire, "the catalog cache keeps the wire ids");
        assert_eq!(serde_json::to_value(&record).unwrap()["maxContextWindow"], 1_000_000, "the cached row carries Node's key");
        assert_eq!(cached.max_context_window, Some(1_000_000));
    }

    #[tokio::test]
    async fn a_listed_price_that_is_not_finite_is_left_out() {
        let (_, record) = list_through_the_catalog().await;
        let json = serde_json::to_value(&record).unwrap();
        assert_eq!((json["rates"]["input"].as_f64(), json["rates"]["output"].as_f64(), json["rates"]["cacheRead"].as_f64()), (Some(0.4), Some(1.6), Some(0.0)));
        let cached = through_the_cache_file(&record);
        assert_eq!((cached.rates.cache_write, cached.rates), (None, record.rates));
    }

    #[tokio::test]
    async fn every_fact_the_model_list_row_reads_survives_the_bridge_and_the_cache_file() {
        let (listed, record) = list_through_the_catalog().await;
        let cached = through_the_cache_file(&record);
        for record in [&record, &cached] {
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
    config.providers.iter().filter(|entry| entry.enabled).filter_map(|entry| Some(ModelSource::new(entry.id.clone(), factory.source(entry)?))).collect()
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
    async fn an_empty_api_key_listing_is_the_floor_but_an_empty_oauth_listing_stands() {
        assert_eq!(source("anthropic", Some(Vec::new())).list().await.unwrap().len(), 3);
        assert!(source("anthropic-oauth", Some(Vec::new())).list().await.unwrap().is_empty());
        assert!(source("gemini", Some(Vec::new())).list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_gemini_listing_answers_the_gemini_floor_and_another_provider_still_fails() {
        let rows = source("gemini", None).list().await.unwrap();
        assert_eq!(ids(&rows), ["gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite"]);
        assert!(rows.iter().all(|r| r.context_window == Some(1_048_576) && r.family.is_none()));
        assert!(source("openai", None).list().await.is_err());
    }
}

impl ModelSource {
    pub fn new(provider: ProviderId, listing: Arc<dyn ModelListing>) -> Self {
        Self {
            provider,
            listing,
            floor: None,
            cache: None,
            bypass_cache: false,
            #[cfg(any(test, feature = "test-support"))]
            answer: None,
        }
    }

    /// A registered provider whose every listing answers `answer`, already as the catalog stores it: a recording's
    /// provider replayed with the records its listing produced, which an adapter record cannot restate in full.
    #[cfg(any(test, feature = "test-support"))]
    pub fn answering(provider: ProviderId, answer: Result<Vec<ModelRecord>, ProviderError>) -> Self {
        struct Unused;
        #[async_trait::async_trait]
        impl ModelListing for Unused {
            async fn list_models(&self) -> Result<Vec<mixdog_core_api::domain::provider::ModelRecord>, ProviderError> {
                unreachable!("an answering source never lists")
            }
        }
        Self { answer: Some(answer), ..Self::new(provider, Arc::new(Unused)) }
    }

    /// Gives an OAuth route that keeps a live roster its disk cache (`anthropic-oauth-models.json`,
    /// `openai-oauth-models.json`); any other provider has none.
    pub fn with_oauth_cache(mut self, cache: OauthModelCache) -> Self {
        self.cache = Roster::of(self.provider.as_str()).map(|roster| cache.for_roster(roster));
        self
    }

    /// The registry-to-catalog bridge: `adapter`'s listing, or `None` for an
    /// adapter that lists no models (`ProviderAdapter::models`).
    pub fn of_adapter(provider: ProviderId, adapter: Arc<dyn ProviderAdapter>) -> Option<Self> {
        adapter.models()?;
        let floor = Floor::of(provider.as_str());
        Some(Self { floor, ..Self::new(provider, Arc::new(AdapterListing(adapter))) })
    }

    /// The same source for a forced refresh: its saved roster is not served while the fetch succeeds.
    pub fn bypassing_cache(mut self) -> Self {
        self.bypass_cache = true;
        self
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    /// One fetch: the adapter's records, as the catalog stores them.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn list(&self) -> Result<Vec<ModelRecord>, ProviderError> {
        Ok(self.listing().await?.rows)
    }

    /// [`Self::list`], and whether the rows are not the provider's answer to this listing (a kept roster, an unavailable
    /// list): why.
    ///
    /// The rule of a roster that is kept on disk (every OAuth route's), one for all routes:
    /// - the roster is the signed-in account's (the provider account its credential names, else its roster row): a fresh
    ///   roster of that account answers without a fetch, and the lists kept for other accounts of the route are discarded
    ///   once the route's account changed;
    /// - the fetch is coalesced per account, made with the credential signed in, and its rows are written under the
    ///   account of the credential that fetched them while that account is still the route's, never over a newer fetch;
    /// - the answer is delivered only while that account is still the one signed in: a listing that outlived its account
    ///   lists again for the account signed in now;
    /// - a failed fetch answers as the route's Node listing did: Anthropic its public floor, Codex the list kept for an
    ///   older client within its TTL (unless the credential was rejected) else no list, Grok the failure; the compat
    ///   routes keep their last good roster (unless the credential was rejected), else the failure;
    /// - a successful answer with no models, or the provider's seed in place of a listing, never replaces a kept roster: no
    ///   route's account is entitled to nothing, so it is a degraded answer, and the kept roster is shown stale.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn listing(&self) -> Result<SourceListing, ProviderError> {
        #[cfg(any(test, feature = "test-support"))]
        if let Some(answer) = &self.answer {
            return answer.clone().map(|rows| SourceListing { rows, stale: None });
        }
        let env = |name: &str| std::env::var(name).ok();
        let Some(cache) = &self.cache else {
            return match self.listing.list_roster().await {
                Ok(listed) if listed.rows.is_empty() && listed.provenance == Provenance::Fetched && self.floor.is_some_and(Floor::covers_empty) => {
                    Ok(SourceListing { rows: self.floor.expect("checked").rows(&self.provider, &env), stale: None })
                }
                Ok(listed) => Ok(self.shown(listed.rows, uncached_stale(listed.provenance))),
                Err(error) => self.failed(error, &env),
            };
        };
        loop {
            // Who the roster is for: the identity of the credential now signed in (a cache is read and written under it).
            let identity = self.listing.roster_identity().await;
            let sampled = super::oauth_cache::roster_key(&identity);
            // Every answer is delivered past this one check, after the last await that produced it: the account this
            // listing was for is still the one signed in. Otherwise its answer is nobody's, and the listing is the account's
            // signed in now.
            let Some(answer) = self.answer_for(cache, &identity, sampled.as_deref()).await else { continue };
            if super::oauth_cache::roster_key(&self.listing.roster_identity().await) != sampled {
                continue;
            }
            return match answer {
                Answer::Rows(rows, stale) => Ok(self.shown(rows, stale)),
                Answer::Failed { error, previous, within_ttl } => self.roster_failed(cache.roster(), error, previous, within_ttl, &env),
            };
        }
    }

    /// The answer of a kept roster to a listing for `identity` (its key `sampled`), not yet delivered; `None` when the fetch
    /// was made with another account's credential.
    async fn answer_for(&self, cache: &OauthModelCache, identity: &RosterIdentity, sampled: Option<&str>) -> Option<Answer> {
        let (previous, within_ttl) = match cache.read_for(identity).await {
            Cached::Fresh(rows) if !self.bypass_cache => return Some(Answer::Rows(rows, None)),
            Cached::Fresh(rows) | Cached::OlderClient(rows) => (Some(rows), true),
            Cached::Stale(rows) => (Some(rows), false),
            Cached::Missing | Cached::Damaged(_) => (None, false),
        };
        let refreshed = match cache.refresh(self.listing.clone(), sampled).await {
            Ok(refreshed) => refreshed,
            Err(error) => return Some(Answer::Failed { error, previous, within_ttl }),
        };
        let listed = &refreshed.listed;
        // The account the answer was fetched with, when it names one (a seed names none).
        if super::oauth_cache::roster_key(&listed.identity).is_some_and(|used| Some(used.as_str()) != sampled) {
            return None;
        }
        Some(match (listed.provenance, refreshed.published) {
            (Provenance::Proxied { .. }, _) => Answer::Rows(listed.rows.clone(), proxy_stale(listed.provenance)),
            // The seed is what the provider shows when it has nothing to say; a roster it said earlier is better.
            (Provenance::Seed, _) => match previous {
                Some(rows) => Answer::Rows(rows, Some(KEPT_AFTER_SEED.to_owned())),
                None => Answer::Rows(listed.rows.clone(), None),
            },
            (Provenance::Fetched, Published::Empty) => match previous {
                Some(rows) => Answer::Rows(rows, Some(KEPT_AFTER_EMPTY.to_owned())),
                None => Answer::Rows(listed.rows.clone(), None),
            },
            // A newer fetch of this roster was written first: that is the roster, not this older answer.
            (Provenance::Fetched, Published::Superseded) => match cache.read_for(&listed.identity).await {
                Cached::Fresh(rows) | Cached::OlderClient(rows) | Cached::Stale(rows) => Answer::Rows(rows, None),
                Cached::Missing | Cached::Damaged(_) => Answer::Rows(listed.rows.clone(), None),
            },
            (Provenance::Fetched, _) => Answer::Rows(listed.rows.clone(), None),
        })
    }

    /// The roster the picker shows is the roster the listing's own readers describe.
    fn shown(&self, rows: Vec<mixdog_core_api::domain::provider::ModelRecord>, stale: Option<String>) -> SourceListing {
        self.listing.show_roster(&rows);
        SourceListing { rows: rows.into_iter().map(|record| catalog_record(&self.provider, record)).collect(), stale }
    }

    /// A failed fetch of a kept roster, by its route's rule (see [`Self::listing`]); `previous` is the signed-in account's
    /// kept roster, `within_ttl` whether it is within its TTL.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn roster_failed(
        &self,
        roster: Roster,
        error: ProviderError,
        previous: Option<Vec<mixdog_core_api::domain::provider::ModelRecord>>,
        within_ttl: bool,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<SourceListing, ProviderError> {
        let rejected = matches!(error.kind, ErrorKind::Auth | ErrorKind::Permission);
        let provider = self.provider.as_str();
        match roster {
            Roster::Anthropic | Roster::Grok => self.failed(error, env),
            Roster::Codex => match previous.filter(|_| within_ttl && !rejected) {
                Some(rows) => {
                    tracing::warn!(provider, kind = ?error.kind, "[provider] listModels failed; showing the list fetched for an older client");
                    Ok(self.shown(rows, Some(error.into_message())))
                }
                None => {
                    tracing::warn!(provider, kind = ?error.kind, "[provider] listModels failed; no model list is available");
                    Ok(SourceListing { rows: Vec::new(), stale: Some(error.into_message()) })
                }
            },
            Roster::Mimo | Roster::CommandCode | Roster::OpencodeGo | Roster::MuseCode => match previous.filter(|_| !rejected) {
                Some(rows) => {
                    tracing::warn!(provider, kind = ?error.kind, "[provider] listModels failed; keeping the last good roster");
                    Ok(self.shown(rows, Some(error.into_message())))
                }
                None => self.failed(error, env),
            },
        }
    }

    /// A failed fetch with no roster kept: the floor where the provider has one (Node's offline answer), else the failure
    /// (which is the catalog's retry state).
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    fn failed(&self, error: ProviderError, env: &dyn Fn(&str) -> Option<String>) -> Result<SourceListing, ProviderError> {
        if let Some(floor) = self.floor {
            // Node writes the failure to stderr and answers its floor; the catalog sees a listing that worked.
            tracing::warn!(provider = self.provider.as_str(), kind = ?error.kind, "[provider] listModels failed; answering the offline floor");
            return Ok(SourceListing { rows: floor.rows(&self.provider, env), stale: None });
        }
        Err(error)
    }
}

/// What a source's listing answers.
#[derive(Clone, Debug)]
pub struct SourceListing {
    pub rows: Vec<ModelRecord>,
    /// Set when `rows` are not the provider's answer to this listing (a kept roster, an unavailable list): why.
    pub stale: Option<String>,
}

/// A kept roster's answer to one listing, before it is delivered.
enum Answer {
    /// The rows to show, and why they are not the provider's answer to this listing.
    Rows(Vec<mixdog_core_api::domain::provider::ModelRecord>, Option<String>),
    /// The fetch failed: the account's kept roster, and whether it is within its TTL.
    Failed { error: ProviderError, previous: Option<Vec<mixdog_core_api::domain::provider::ModelRecord>>, within_ttl: bool },
}

const KEPT_AFTER_SEED: &str = "The provider's model list could not be fetched; showing the last list it returned.";
const KEPT_AFTER_EMPTY: &str = "The provider returned no models; showing the last list it returned.";

/// A roster with no disk copy: a seed answer (the fixed list standing in for a listing that could not be completed) is
/// shown stale, so the catalog asks again when its backoff passes and keeps no failed fetch as a finished one.
fn uncached_stale(provenance: Provenance) -> Option<String> {
    match provenance {
        Provenance::Seed => Some("The provider's model list could not be fully fetched; showing what is known.".to_owned()),
        other => proxy_stale(other),
    }
}

fn proxy_stale(provenance: Provenance) -> Option<String> {
    matches!(provenance, Provenance::Proxied { complete: false }).then(|| "The desktop did not return a complete model listing.".to_owned())
}

/// An adapter's listed record as a catalog record: what the provider states,
/// before metadata enrichment.
pub(super) fn catalog_record(provider: &ProviderId, listed: mixdog_core_api::domain::provider::ModelRecord) -> ModelRecord {
    catalog_record_row(provider, listed).0
}
/// [`catalog_record`], and the row the provider's listing completed and stores (`getCachedModelInfo`), which the typed
/// fields cannot restate: a custom provider's is its effective row, every other row is the one `enrichModels` wrote
/// and the provider's own later steps adjusted (`None`: the listing kept none).
fn catalog_record_row(provider: &ProviderId, listed: mixdog_core_api::domain::provider::ModelRecord) -> (ModelRecord, Option<JsonValue>) {
    let mut record = ModelRecord::new(provider.clone(), listed.id);
    // `display || name` is every Node reader's label.
    let (display, images, reasoning, raw) = (listed.display_name.clone(), listed.supports_images, listed.supports_reasoning, listed.raw.clone());
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
    let row = if record.effective {
        Some(effective_row_of(&record, display.as_deref(), images, reasoning, raw.as_ref(), listed.enriched.0.as_ref()))
    } else {
        listed.enriched.0.clone().map(JsonValue::Object)
    };
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
    (record, row)
}
/// The row an adapter's listing stored for `listed` (`None`: it kept none).
pub fn listed_row_of(provider: &ProviderId, listed: mixdog_core_api::domain::provider::ModelRecord) -> Option<JsonValue> {
    catalog_record_row(provider, listed).1
}
/// The producer function of the stored-row contract (see `route_meta`): the row the provider's listing completed for
/// `listed`, as Node's provider stores it, or `Value::Null` when the record kept none. Nothing is substituted.
pub fn stored_row(provider: &ProviderId, listed: mixdog_core_api::domain::provider::ModelRecord) -> JsonValue {
    listed_row_of(provider, listed).unwrap_or(JsonValue::Null)
}
/// A custom provider's effective row (`effectiveRow`, `custom-provider-config.mjs`), key for key as the recorded
/// listing has it: the display the provider stated (not the `display || name` label), the flags it stated false, its
/// output limit (`null` when none), its inherited values and, when it names effort levels, both ladders even when
/// empty.
fn effective_row_of(
    record: &ModelRecord,
    display: Option<&str>,
    images: Option<bool>,
    reasoning: Option<bool>,
    raw: Option<&JsonValue>,
    enriched: Option<&serde_json::Map<String, JsonValue>>,
) -> JsonValue {
    let mut row = match crate::service::model_listing::listing_value(record) {
        JsonValue::Object(row) => row,
        _ => serde_json::Map::new(),
    };
    for key in ["display", "supportsVision", "supportsReasoning"] {
        row.shift_remove(key);
    }
    if let Some(display) = display {
        row.insert("display".into(), serde_json::json!(display));
    }
    if let Some(on) = images {
        row.insert("supportsVision".into(), serde_json::json!(on));
    }
    let leveled = raw.and_then(|raw| raw.get("leveled")).and_then(JsonValue::as_bool) == Some(true);
    row.insert("outputTokens".into(), serde_json::json!(record.output_tokens));
    // A compat-discovered row carries the discovery's `created`, `null` when it lists none.
    if raw.and_then(|raw| raw.get("createdStated")).and_then(JsonValue::as_bool) == Some(true) {
        row.insert("created".into(), serde_json::json!(record.created));
    }
    row.insert("supportsReasoning".into(), serde_json::json!(reasoning == Some(true)));
    if let Some(inherited) = raw.and_then(|raw| raw.get("inherited")) {
        row.insert("inherited".into(), inherited.clone());
    }
    // `enrichModels` writes `mode` (`null` when neither the catalog nor the row names one) onto the rows it enriched.
    if let Some(mode) = enriched.and_then(|row| row.get("mode")) {
        row.insert("mode".into(), mode.clone());
    }
    if leveled {
        row.insert("reasoningOptions".into(), serde_json::json!(record.picker.reasoning_options));
        row.insert("reasoningLevels".into(), serde_json::json!(record.reasoning_efforts));
    }
    JsonValue::Object(row)
}
