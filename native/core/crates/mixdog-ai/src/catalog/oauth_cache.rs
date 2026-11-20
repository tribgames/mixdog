//! The model rosters of the OAuth routes (`anthropic-oauth-models.json`, `openai-oauth-models.json`, ...) in the data
//! directory, kept as Node's `makeModelCache` (`model-cache.mjs`) keeps them (schema version, 24 h TTL, atomic write,
//! Node's rows) but one file per identity.
//!
//! - File: `<route>-models.<key>.json`, `{ "version": <n>, "fetchedAt": <ms>, "account": <key>, "provenance": "fetched",
//!   "clientVersion"?: <v>, "models": [<row>, ...] }`. `<key>` is [`roster_key`]: the account of the credential that fetched
//!   the roster (the provider account the credential names, else the roster row it sits in), bound to the endpoint (base
//!   URL, region, auth mode) it was fetched from. A roster is read only under the key it names, so another account's
//!   roster is never served; when the route's signed-in account changes, the other accounts' files of the route are
//!   discarded, so a return to an earlier account fetches its list again.
//! - A 1.4.5 file (`<route>-models.json`, one shared file, no account) proves nothing about the current account: no reader
//!   opens it. The first successful fetch writes the identity's file and removes it.
//! - Read (`loadSync()`): a fetched roster of this version, at most 24 h old, is fresh; an older one (or one fetched for an
//!   older client) is stale: not served as fresh, kept for a failed fetch to fall back to.
//! - Write: only a fetch the provider stated (never its seed), non-empty (an empty answer never replaces a kept roster), by
//!   the credential's own identity while that identity is still the route's, and never over a newer fetch's file;
//!   `fetchedAt` is when the fetch began.
//! - Not ported: `_refreshModelCache` (an internal forced refetch) and the in-memory mirror (`_setInMemoryCatalog`),
//!   which the resident catalog replaces.
//!
//! The rows are Node's cache rows (the normalizer's fields beside the enrichment's), so the typed listing record is
//! written as such a row and read back from one. What no typed field holds (the pricing provenance, the
//! function-calling flag) travels in `ModelRecord::enriched`, the catalog lookup's output row.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use mixdog_core_api::domain::provider::{EnrichedRow, ModelRecord, ReasoningOption, RosterIdentity};
use mixdog_protocol::ProviderId;
use mixdog_rt::LaneToken;
use serde_json::{Map, Value, json};

use tokio_util::sync::CancellationToken;

use super::modelsdev_source::read_file;
use crate::oauth::CredentialIo;

pub const CACHE_FILE: &str = "anthropic-oauth-models.json";
/// `ANTHROPIC_MODEL_CACHE_SCHEMA_VERSION`.
const VERSION: i64 = 2;
/// `CODEX_MODEL_CACHE_OPTIONS.version` (`openai-oauth-catalog-store.mjs`).
const CODEX_VERSION: i64 = 7;
/// `MODEL_CACHE_TTL_MS`, and the Codex cache's `ttlMs`: both 24 h.
const TTL_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// The OAuth routes that keep a live roster on disk (`rosterProviders()`): one mechanism (file, schema version, TTL,
/// atomic write, damaged-file report), each route with its own file, version and TTL as Node's `makeModelCache` options
/// had them. Anthropic's rows are Node's `_normalizeAnthropicModel` rows; every other route's are the provider's listing
/// row (`listing_value`), read back through `listing_row::record`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Roster {
    Anthropic,
    /// `CODEX_MODEL_CACHE_OPTIONS`: version 7, 24 h.
    Codex,
    /// `GROK_MODEL_CACHE_SCHEMA_VERSION` 2, `MODEL_CACHE_TTL_MS` 24 h.
    Grok,
    /// Version 1, 24 h.
    Mimo,
    CommandCode,
    OpencodeGo,
    MuseCode,
}

impl Roster {
    pub fn of(provider: &str) -> Option<Self> {
        Some(match provider {
            "anthropic-oauth" => Self::Anthropic,
            "openai-oauth" => Self::Codex,
            "grok-oauth" => Self::Grok,
            "mimo-oauth" => Self::Mimo,
            "command-code-oauth" => Self::CommandCode,
            "opencode-go-oauth" => Self::OpencodeGo,
            "muse-code-oauth" => Self::MuseCode,
            _ => return None,
        })
    }

    pub(super) fn provider_name(self) -> &'static str {
        self.provider()
    }

    fn provider(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic-oauth",
            Self::Codex => "openai-oauth",
            Self::Grok => "grok-oauth",
            Self::Mimo => "mimo-oauth",
            Self::CommandCode => "command-code-oauth",
            Self::OpencodeGo => "opencode-go-oauth",
            Self::MuseCode => "muse-code-oauth",
        }
    }

    fn file(self) -> &'static str {
        match self {
            Self::Anthropic => CACHE_FILE,
            Self::Codex => "openai-oauth-models.json",
            Self::Grok => "grok-oauth-models.json",
            Self::Mimo => "mimo-oauth-models.json",
            Self::CommandCode => "command-code-oauth-models.json",
            Self::OpencodeGo => "opencode-go-oauth-models.json",
            Self::MuseCode => "muse-code-oauth-models.json",
        }
    }

    fn version(self) -> i64 {
        match self {
            Self::Anthropic | Self::Grok => VERSION,
            Self::Codex => CODEX_VERSION,
            Self::Mimo | Self::CommandCode | Self::OpencodeGo | Self::MuseCode => 1,
        }
    }

    fn ttl_ms(self) -> f64 {
        TTL_MS
    }

    /// The roster a 1.4.5 data-directory file (one shared file per route, named by [`Self::file`]) belongs to.
    pub fn of_file(file: &str) -> Option<Self> {
        [Self::Anthropic, Self::Codex, Self::Grok, Self::Mimo, Self::CommandCode, Self::OpencodeGo, Self::MuseCode]
            .into_iter()
            .find(|roster| roster.file() == file)
    }

    /// The file of the roster fetched for identity `key`: the route's plain name with the key before the extension.
    pub fn keyed_file(self, key: &str) -> String {
        format!("{}.{key}.json", self.file().trim_end_matches(".json"))
    }

    fn row_of(self, listed: &ModelRecord) -> Value {
        if self == Self::Anthropic {
            return row_of_record(listed);
        }
        let provider = ProviderId::from(self.provider());
        let record = super::sources::catalog_record(&provider, listed.clone());
        let mut row = crate::service::model_listing::listing_value(&record);
        if let Some(row) = row.as_object_mut() {
            row.insert("provider".into(), json!(self.provider()));
            listing_row_extras(listed, row);
            if self == Self::Codex {
                codex_row_extras(listed, row);
            }
        }
        row
    }

    fn record_of(self, row: &Value) -> Option<ModelRecord> {
        if self == Self::Anthropic {
            return record_of_row(row);
        }
        let row = row.as_object().filter(|row| row.get("id").and_then(Value::as_str).is_some_and(|id| !id.is_empty()))?;
        let mut record = crate::providers::listing_row::record(row.clone());
        read_listing_extras(row, &mut record);
        if self == Self::Codex {
            record.supports_reasoning_summaries = row.get("supportsReasoningSummaries").and_then(Value::as_bool);
        }
        Some(record)
    }
}

/// What the listing row (`listing_value`) leaves out and a roster must keep for the route to be read back whole: the family
/// token, a routing alias's target, the wire ids a send resolves a picker id by, the row's prices and whether it stated its
/// efforts.
fn listing_row_extras(listed: &ModelRecord, row: &mut Map<String, Value>) {
    if let Some(family) = &listed.family {
        row.insert("family".into(), json!(family));
    }
    if let Some(target) = &listed.alias_target {
        row.insert("aliasTarget".into(), json!(target));
    }
    if let Some(wire) = &listed.wire
        && let Ok(wire) = serde_json::to_value(wire)
    {
        row.insert("wire".into(), wire);
    }
    for (key, value) in [
        ("inputCostPerM", listed.input_cost_per_m),
        ("outputCostPerM", listed.output_cost_per_m),
        ("cacheReadCostPerM", listed.cache_read_cost_per_m),
        ("cacheWriteCostPerM", listed.cache_write_cost_per_m),
    ] {
        if let Some(v) = value.filter(|v| v.is_finite()) {
            row.insert(key.into(), number(v));
        }
    }
    if listed.efforts_stated {
        row.insert("effortsStated".into(), json!(true));
    }
}

/// [`listing_row_extras`] read back.
fn read_listing_extras(row: &Map<String, Value>, record: &mut ModelRecord) {
    record.family = row.get("family").and_then(Value::as_str).map(str::to_owned);
    record.alias_target = row.get("aliasTarget").and_then(Value::as_str).map(str::to_owned);
    record.wire = row.get("wire").and_then(|wire| serde_json::from_value(wire.clone()).ok());
    record.input_cost_per_m = finite(row.get("inputCostPerM"));
    record.output_cost_per_m = finite(row.get("outputCostPerM"));
    record.cache_read_cost_per_m = finite(row.get("cacheReadCostPerM"));
    record.cache_write_cost_per_m = finite(row.get("cacheWriteCostPerM"));
    record.efforts_stated = row.get("effortsStated").and_then(Value::as_bool) == Some(true);
}

/// The keys of Node's normalized Codex row (`_normalizeCodexModel`) that the listing row has no place for, read off the
/// catalog's own row (`ModelRecord::raw`, snake_case): reasoning summaries, the catalog's replacement for a retiring model
/// (`upgrade`, what `codexModelSuccessor` reads), picker priority and visibility, verbosity, image generation, the tool
/// types and the two compaction limits.
fn codex_row_extras(listed: &ModelRecord, row: &mut Map<String, Value>) {
    let raw = listed.raw.as_ref();
    let get = |key: &str| raw.and_then(|raw| raw.get(key));
    let positive = |key: &str| get(key).and_then(Value::as_f64).filter(|n| *n > 0.0).map_or(Value::Null, |n| json!(n as u64));
    let text = |key: &str| get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map_or(Value::Null, |s| json!(s));
    row.insert("autoCompactTokenLimit".into(), positive("auto_compact_token_limit"));
    row.insert("effectiveContextWindowPercent".into(), positive("effective_context_window_percent"));
    row.insert("priority".into(), get("priority").and_then(Value::as_f64).filter(|n| n.is_finite()).map_or(Value::Null, |n| json!(n)));
    row.insert("visibility".into(), text("visibility"));
    row.insert("supportVerbosity".into(), json!(get("support_verbosity").and_then(Value::as_bool) == Some(true)));
    row.insert("defaultVerbosity".into(), text("default_verbosity"));
    row.insert("supportsReasoningSummaries".into(), json!(listed.supports_reasoning_summaries == Some(true)));
    if let Some(on) = get("supports_image_generation").and_then(Value::as_bool) {
        row.insert("supportsImageGeneration".into(), json!(on));
    }
    if let Some(tools) = get("supported_tools").and_then(Value::as_array) {
        let names: Vec<&str> = tools.iter().filter_map(|t| t.as_str().or_else(|| t.get("type").and_then(Value::as_str))).filter(|n| !n.is_empty()).collect();
        row.insert("supportedTools".into(), json!(names));
    }
    if let Some(model) = get("upgrade").and_then(|u| u.get("model")).and_then(Value::as_str).filter(|m| !m.is_empty()) {
        let retirement = get("upgrade").and_then(|u| u.get("retirement_at")).and_then(Value::as_str).filter(|s| !s.is_empty());
        row.insert("upgrade".into(), json!({ "model": model, "retirementAt": retirement }));
    }
}

/// What one identity's roster file holds.
#[derive(Debug)]
pub enum Cached {
    /// A fetched roster of this schema version within its TTL.
    Fresh(Vec<ModelRecord>),
    /// A fetched roster of this schema version past its TTL.
    Stale(Vec<ModelRecord>),
    /// A fetched roster of this schema version within its TTL but fetched for an older client than the one asking (or for
    /// one it did not record): the backend lists what the reported client version unlocks, so it is not fresh.
    OlderClient(Vec<ModelRecord>),
    /// No file for this identity (an identity of no account has none), one of another schema version, or one that does not
    /// state that it was fetched for exactly this identity: a file proves nothing about an account it does not name.
    Missing,
    /// A file that cannot be read as a roster (empty, zero-filled, not JSON, no `fetchedAt` or `models`): reported,
    /// and the next listing fetches and replaces it.
    Damaged(String),
}

/// The key an identity's roster is kept under: its account, bound to the endpoint when the listing states one. `None`
/// for a credential that names no account: nothing can be attributed to it.
pub fn roster_key(identity: &RosterIdentity) -> Option<String> {
    let account = identity.account.as_deref().filter(|account| !account.is_empty())?;
    Some(match identity.endpoint.as_deref().filter(|endpoint| !endpoint.is_empty()) {
        Some(endpoint) => account_fingerprint(&[account, endpoint]),
        None => account.to_owned(),
    })
}

/// Which roster `ticket`-ordered work is for: one per route and identity key.
type Slot = (Roster, String);

/// What a refresh settled to, shared by every caller that waited on it.
type Flight = futures::future::Shared<futures::future::BoxFuture<'static, Result<Arc<Refreshed>, mixdog_core_api::domain::provider::ProviderError>>>;

struct RosterState {
    /// The identity key each route's listing last sampled (a reader of the files goes by it).
    current: std::sync::Mutex<std::collections::HashMap<Roster, String>>,
    /// The refreshes in flight: one per route and identity key, with the ticket that names it. A route's account change
    /// drops them: a fetch started before the discard is not what a later listing of that account joins.
    flights: std::sync::Mutex<std::collections::HashMap<Slot, (u64, Flight)>>,
    /// The ticket of the newest refresh each roster file was written by, held across the check and the write so that an
    /// older refresh finishing last never replaces a newer one.
    published: std::sync::Mutex<std::collections::HashMap<Slot, u64>>,
    /// The one permit that holds the publication across the check and the write (and across the awaits between them).
    publishing: tokio::sync::Semaphore,
    tickets: std::sync::atomic::AtomicU64,
}

impl Default for RosterState {
    fn default() -> Self {
        Self {
            current: Default::default(),
            flights: Default::default(),
            published: Default::default(),
            publishing: tokio::sync::Semaphore::new(1),
            tickets: Default::default(),
        }
    }
}

/// The identity each route's roster is currently read under, as the last listing sampled it, and the refreshes in flight.
/// Every reader of a roster file reads the file of this identity and no other.
#[derive(Clone, Default)]
pub struct RosterAccounts(Arc<RosterState>);

impl std::fmt::Debug for RosterAccounts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RosterAccounts").field("current", &self.0.current).finish_non_exhaustive()
    }
}

impl RosterAccounts {
    /// The route's listing is for `key` now; whether that is another key than the one it was last noted for (a first
    /// listing, or one after an account change, follows none).
    pub fn note(&self, roster: Roster, key: Option<&str>) -> bool {
        let mut known = self.0.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let previous = match key {
            Some(key) => known.insert(roster, key.to_owned()),
            None => known.remove(&roster),
        };
        previous.as_deref() != key
    }

    /// The signed-in account is no longer known (an account change, before the next listing names the new one): until
    /// then no roster is served to any reader.
    pub fn forget_all(&self) {
        self.0.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clear();
    }

    pub fn get(&self, roster: Roster) -> Option<String> {
        self.0.current.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&roster).cloned()
    }

    fn ticket(&self) -> u64 {
        self.0.tickets.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1
    }
}

/// What publishing a fetched roster did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Published {
    /// Written as the identity's roster.
    Written,
    /// The credential names no account, so the rows belong to nobody on disk.
    Unattributed,
    /// The provider's seed roster, stated by nobody.
    Seed,
    /// The provider answered successfully with no models: a roster already kept is not replaced by it (no route's account
    /// is entitled to none), and nothing empty is kept.
    Empty,
    /// A newer fetch of the same roster was already written (in this process or another).
    Superseded,
    /// The route's account changed while the fetch ran: the rows are no longer the list of the account signed in, and are
    /// not kept.
    AccountChanged,
    /// The write failed (best effort, as Node's: it only costs the next call a fetch).
    Failed,
}

/// One settled refresh: the fetch, and what became of it on disk.
#[derive(Debug)]
pub struct Refreshed {
    pub listed: mixdog_core_api::domain::provider::ListedRoster,
    pub published: Published,
}

#[derive(Clone)]
pub struct OauthModelCache {
    dir: PathBuf,
    io: CredentialIo,
    now_ms: Clock,
    roster: Roster,
    accounts: RosterAccounts,
}

impl OauthModelCache {
    pub fn new(dir: PathBuf, io: CredentialIo) -> Self {
        let now_ms: Clock = Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64));
        Self { dir, io, now_ms, roster: Roster::Anthropic, accounts: RosterAccounts::default() }
    }

    /// The same cache over another route's file and codec.
    pub fn for_roster(mut self, roster: Roster) -> Self {
        self.roster = roster;
        self
    }

    /// The table the readers of this data directory's rosters share (`Rosters` reads through it too).
    pub fn with_accounts(mut self, accounts: RosterAccounts) -> Self {
        self.accounts = accounts;
        self
    }

    /// The same cache over another clock.
    pub fn with_clock(mut self, now_ms: Clock) -> Self {
        self.now_ms = now_ms;
        self
    }

    pub fn accounts(&self) -> &RosterAccounts {
        &self.accounts
    }

    pub fn roster(&self) -> Roster {
        self.roster
    }

    fn path_of(&self, key: &str) -> PathBuf {
        self.dir.join(self.roster.keyed_file(key))
    }

    /// The fresh roster of `identity`, none otherwise.
    pub async fn load_for(&self, identity: &RosterIdentity) -> Option<Vec<ModelRecord>> {
        match self.read_for(identity).await {
            Cached::Fresh(rows) => Some(rows),
            _ => None,
        }
    }

    /// `loadSync({ allowStale })` for `identity`: the state of its roster file; a damaged file is reported here, once per
    /// read. Each identity has its own file, so another account's roster is never in the way and never read; a file that does
    /// not say it was fetched for this key (a 1.4.5 install kept one shared, unattributed file under the route's plain name,
    /// which no reader opens) proves nothing. The Codex backend lists what the reported client version unlocks, so a roster
    /// fetched for an older client (or one that recorded none) is stale (`fetchedForOlderClient`).
    pub async fn read_for(&self, identity: &RosterIdentity) -> Cached {
        let key = roster_key(identity);
        // The key is known before the file is: the first listing of a roster has no file to read, and the readers must still
        // go by the account that listing is for once it has written one. The route's account changed: the lists kept for
        // the others are discarded. Under the publication guard: a publish checks the key and writes under it too, so a
        // write checked before the change cannot land after the discard.
        {
            let _publishing = self.accounts.0.publishing.acquire().await.expect("the publication gate is never closed");
            if self.accounts.note(self.roster, key.as_deref()) {
                self.accounts.0.flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|(roster, _), _| *roster != self.roster);
                self.discard_others(key.as_deref()).await;
            }
        }
        let Some(key) = key else { return Cached::Missing };
        self.read_key(&key, identity.client_version.as_deref()).await
    }

    /// Removes the route's roster files of every key but `keep`.
    async fn discard_others(&self, keep: Option<&str>) {
        let (dir, stem, keep) = (self.dir.clone(), self.roster.file().trim_end_matches(".json").to_owned(), keep.map(|key| self.roster.keyed_file(key)));
        let discarded = self
            .io
            .write_job(move |lane| {
                let names = match mixdog_statefile::list_dir(lane, &dir) {
                    Ok(names) => names,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(error) => return Err(error),
                };
                for name in names {
                    let keyed = name.strip_prefix(&stem).and_then(|rest| rest.strip_prefix('.')).and_then(|rest| rest.strip_suffix(".json"));
                    if keyed.is_some_and(|key| !key.is_empty()) && keep.as_deref() != Some(name.as_str()) {
                        match mixdog_statefile::remove_file(lane, &dir.join(&name)) {
                            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
                            _ => {}
                        }
                    }
                }
                Ok(())
            })
            .await;
        if let Err(error) = discarded {
            tracing::warn!(%error, "[{}] the model lists of other accounts could not be discarded", self.roster.provider());
        }
    }

    async fn read_key(&self, key: &str, client_version: Option<&str>) -> Cached {
        let path = self.path_of(key);
        let read = match self.io.read.submit(&CancellationToken::new(), move |_| read_file(&path)) {
            Ok(job) => job.await.ok().flatten(),
            Err(_) => None,
        };
        let Some(bytes) = read else { return Cached::Missing };
        let file = self.roster.keyed_file(key);
        let damaged = |why: &str| {
            let why = format!("{file} is damaged ({why}); fetching a new roster");
            tracing::warn!(provider = self.roster.provider(), "[{}] {why}", self.roster.provider());
            Cached::Damaged(why)
        };
        let Ok(record) = serde_json::from_slice::<Value>(&bytes) else { return damaged("not JSON") };
        let (fetched_at, models) = match validated(&record, self.roster, key) {
            Ok(valid) => valid,
            Err(Invalid::Missing) => return Cached::Missing,
            Err(Invalid::Damaged(why)) => return damaged(why),
        };
        let rows: Vec<ModelRecord> = models.iter().filter_map(|row| self.roster.record_of(row)).collect();
        let older_client = client_version.is_some_and(|current| {
            let sent = record.get("clientVersion").and_then(Value::as_str).filter(|v| crate::client_versions::is_semver(v));
            sent.is_none_or(|sent| crate::client_versions::compare_semver(current, sent) == std::cmp::Ordering::Greater)
        });
        if (self.now_ms)() as f64 - fetched_at > self.roster.ttl_ms() {
            Cached::Stale(rows)
        } else if older_client {
            Cached::OlderClient(rows)
        } else {
            Cached::Fresh(rows)
        }
    }

    /// One fetch of the roster, coalesced per route and sampled identity key: callers that ask while one is in flight share
    /// its answer instead of starting another (`refreshCodexCatalog`). `sampled` is the key the caller read the roster
    /// under; a caller with none fetches alone.
    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    pub async fn refresh(&self, listing: Arc<dyn mixdog_core_api::domain::provider::ModelListing>, sampled: Option<&str>) -> Result<Arc<Refreshed>, mixdog_core_api::domain::provider::ProviderError> {
        let Some(sampled) = sampled else { return self.fetch(listing).await };
        let slot: Slot = (self.roster, sampled.to_owned());
        let flight = {
            let mut flights = self.accounts.0.flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            match flights.get(&slot) {
                Some((_, flight)) => flight.clone(),
                None => {
                    let (cache, tables, settled, id) = (self.clone(), self.accounts.clone(), slot.clone(), self.accounts.ticket());
                    let work: Flight = futures::FutureExt::shared(futures::FutureExt::boxed(async move {
                        let refreshed = cache.fetch(listing).await;
                        let mut flights = tables.0.flights.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                        if flights.get(&settled).is_some_and(|(held, _)| *held == id) {
                            flights.remove(&settled);
                        }
                        refreshed
                    }));
                    flights.insert(slot, (id, work.clone()));
                    work
                }
            }
        };
        flight.await
    }

    #[allow(clippy::result_large_err, reason = "Keep the canonical structured failure by value and preserve this contract without an extra boxing allocation")]
    async fn fetch(&self, listing: Arc<dyn mixdog_core_api::domain::provider::ModelListing>) -> Result<Arc<Refreshed>, mixdog_core_api::domain::provider::ProviderError> {
        let (ticket, started) = (self.accounts.ticket(), (self.now_ms)());
        let listed = listing.list_roster().await?;
        let published = self.publish(&listed, ticket, started).await;
        Ok(Arc::new(Refreshed { listed, published }))
    }

    /// Writes a fetched roster as the roster of the identity whose credential fetched it, unless a newer fetch of the same
    /// roster is already there: `ticket` orders the fetches of this process by when they began, `started` the fetches of
    /// every process (the file's `fetchedAt` is the fetch's start). The first write also replaces the shared, unattributed
    /// file an older install left under the route's plain name.
    async fn publish(&self, listed: &mixdog_core_api::domain::provider::ListedRoster, ticket: u64, started: i64) -> Published {
        use mixdog_core_api::domain::provider::Provenance;
        let Some(key) = roster_key(&listed.identity) else { return Published::Unattributed };
        if listed.provenance != Provenance::Fetched {
            return Published::Seed;
        }
        if listed.rows.is_empty() {
            return Published::Empty;
        }
        let slot = (self.roster, key.clone());
        let _publishing = self.accounts.0.publishing.acquire().await.expect("the publication gate is never closed");
        if self.accounts.get(self.roster).as_deref() != Some(key.as_str()) {
            return Published::AccountChanged;
        }
        if self.accounts.0.published.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&slot).is_some_and(|newest| *newest > ticket) {
            return Published::Superseded;
        }
        let path = self.path_of(&key);
        let on_disk = {
            let path = path.clone();
            match self.io.read.submit(&CancellationToken::new(), move |_| read_file(&path)) {
                Ok(job) => job.await.ok().flatten(),
                Err(_) => None,
            }
        };
        let newer_on_disk = on_disk
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|record| record.get("fetchedAt").and_then(Value::as_f64))
            .is_some_and(|at| at > started as f64);
        if newer_on_disk {
            return Published::Superseded;
        }
        let mut record = json!({
            "version": self.roster.version(),
            "fetchedAt": started,
            "account": key,
            "provenance": "fetched",
            "models": listed.rows.iter().map(|m| self.roster.row_of(m)).collect::<Vec<_>>(),
        });
        if let Some(version) = &listed.identity.client_version {
            record["clientVersion"] = json!(version);
        }
        let legacy = self.dir.join(self.roster.file());
        let opts = mixdog_statefile::Opts { lock: true, fsync_dir: true, ..mixdog_statefile::Opts::default() };
        let written = self
            .io
            .write_job(move |lane| {
                mixdog_statefile::write_json(lane, &path, &record, &opts).map(drop).map_err(std::io::Error::other)?;
                match mixdog_statefile::remove_file(lane, &legacy) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error),
                    _ => Ok(()),
                }
            })
            .await;
        match written {
            Ok(()) => {
                self.accounts.0.published.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(slot, ticket);
                Published::Written
            }
            Err(error) => {
                // Best effort, as Node's (a failed write only costs the next call a fetch).
                tracing::warn!(%error, "[{}] the model cache could not be written", self.roster.provider());
                Published::Failed
            }
        }
    }
}

/// Whether a roster record says it was fetched for `key`: it names that key as its owner and its rows' provenance is a
/// fetch (a seed roster is the listing's own, never a provider's statement).
pub fn record_is_fetched_for(record: &Value, key: &str) -> bool {
    record.get("account").and_then(Value::as_str) == Some(key) && record.get("provenance").and_then(Value::as_str) == Some("fetched")
}

/// The shared roster file a 1.4.5 install kept (`file`, `text`) as the core keeps it for identity `key`: the name and the
/// text, with the same version, fetch time and rows, naming the identity (a text that is no record stays as it is). Any
/// other file is returned as it is. For tests that replay the files Node recorded.
#[cfg(any(test, feature = "test-support"))]
pub fn keyed_from_shared(file: &str, text: &str, key: &str) -> (String, String) {
    let Some(roster) = Roster::of_file(file) else { return (file.to_owned(), text.to_owned()) };
    let text = match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(mut record)) => {
            record.insert("account".into(), json!(key));
            record.insert("provenance".into(), json!("fetched"));
            Value::Object(record).to_string()
        }
        _ => text.to_owned(),
    };
    (roster.keyed_file(key), text)
}

/// Why a roster record is not a roster of `key`.
enum Invalid {
    /// Another schema version, or not a fetch for `key`: it proves nothing about this identity.
    Missing,
    Damaged(&'static str),
}

/// The record's `fetchedAt` and rows when it is a fetched roster of `roster`'s schema version for `key`.
fn validated<'a>(record: &'a Value, roster: Roster, key: &str) -> Result<(f64, &'a Vec<Value>), Invalid> {
    if record.get("version").and_then(Value::as_i64) != Some(roster.version()) {
        return Err(Invalid::Missing);
    }
    let fetched_at = record.get("fetchedAt").and_then(Value::as_f64).filter(|at| *at != 0.0).ok_or(Invalid::Damaged("no fetchedAt"))?;
    let models = record.get("models").and_then(Value::as_array).ok_or(Invalid::Damaged("no models list"))?;
    if !record_is_fetched_for(record, key) {
        return Err(Invalid::Missing);
    }
    Ok((fetched_at, models))
}

/// The saved rows of `roster`'s file for `key` in `dir`, stale or not, read now and validated as the catalog reads them:
/// the reader outside the catalog's lanes (the config migration's `loadSavedCodexCatalog`).
pub fn saved_rows(dir: &Path, roster: Roster, key: &str) -> Option<Vec<Value>> {
    let bytes = mixdog_statefile::read_content(&dir.join(roster.keyed_file(key))).ok()??;
    let record = mixdog_statefile::parse_json_text(&bytes).ok()?;
    validated(&record, roster, key).ok().map(|(_, models)| models.clone())
}
/// `_normalizeAnthropicModel`'s family token: `claude-<letters>` lower-cased, else `other`.
fn family_of(id: &str) -> String {
    let rest = id.get(..7).filter(|head| head.eq_ignore_ascii_case("claude-")).map(|_| &id[7..]);
    let letters: String = rest.unwrap_or_default().chars().take_while(char::is_ascii_alphabetic).collect();
    if letters.is_empty() { "other".to_owned() } else { letters.to_lowercase() }
}

/// The keys of Node's cache row that no typed field of the record holds: the catalog lookup's output carries them
/// (`ModelRecord::enriched`), present for a model the catalog knows and absent for one it does not.
const ENRICHED_KEYS: [&str; 7] = ["pricingTiers", "pricingModel", "pricingProvider", "pricingSource", "supportsFunctionCalling", "reasoningContentField", "mode"];

/// A number as JavaScript writes it: an integral value has no fraction.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 1e15 { json!(value as i64) } else { json!(value) }
}

/// The Node cache row of a listed record, keys in the order `_normalizeAnthropicModel` and `enrichModels` leave them
/// (the provider is `anthropic-oauth`: this is the OAuth route's file).
fn row_of_record(record: &ModelRecord) -> Value {
    let extra = |key: &str| record.enriched.0.as_ref().and_then(|row| row.get(key)).cloned();
    let mut row = Map::new();
    row.insert("id".into(), json!(record.id));
    row.insert("display".into(), json!(record.display_name.clone().or_else(|| record.name.clone()).unwrap_or_else(|| record.id.clone())));
    row.insert("family".into(), json!(family_of(&record.id)));
    row.insert("provider".into(), json!("anthropic-oauth"));
    row.insert("contextWindow".into(), json!(record.context_window));
    row.insert("outputTokens".into(), json!(record.max_output_tokens));
    row.insert("tier".into(), json!(record.picker.tier));
    row.insert("latest".into(), json!(record.picker.latest));
    row.insert("releaseDate".into(), json!(record.picker.release_date));
    row.insert("supportsReasoning".into(), json!(record.supports_reasoning.unwrap_or(false)));
    row.insert("reasoningOptions".into(), json!(record.picker.reasoning_options));
    let mut thinking = Map::new();
    if let Some(v) = record.thinking_adaptive {
        thinking.insert("adaptive".into(), json!(v));
    }
    if let Some(v) = record.thinking_enabled {
        thinking.insert("enabled".into(), json!(v));
    }
    if !thinking.is_empty() {
        row.insert("thinkingTypes".into(), Value::Object(thinking));
    }
    for (key, value) in [
        ("inputCostPerM", record.input_cost_per_m),
        ("outputCostPerM", record.output_cost_per_m),
        ("cacheReadCostPerM", record.cache_read_cost_per_m),
        ("cacheWriteCostPerM", record.cache_write_cost_per_m),
    ] {
        if let Some(v) = value.filter(|v| v.is_finite()) {
            row.insert(key.into(), number(v));
        }
    }
    for key in ["pricingTiers", "pricingModel", "pricingProvider", "pricingSource"] {
        if let Some(v) = extra(key) {
            row.insert(key.into(), v);
        }
    }
    if let Some(v) = record.supports_images {
        row.insert("supportsVision".into(), json!(v));
    }
    if let Some(v) = extra("supportsFunctionCalling") {
        row.insert("supportsFunctionCalling".into(), v);
    }
    if let Some(v) = record.supports_prompt_caching {
        row.insert("supportsPromptCaching".into(), json!(v));
    }
    if let Some(v) = record.reasoning_content_field.as_ref().map(|v| json!(v)).or_else(|| extra("reasoningContentField")) {
        row.insert("reasoningContentField".into(), v);
    }
    if let Some(v) = record.mode.as_ref().map(|v| json!(v)).or_else(|| extra("mode")) {
        row.insert("mode".into(), v);
    }
    Value::Object(row)
}

fn positive(value: Option<&Value>) -> Option<u64> {
    value.and_then(Value::as_f64).filter(|n| *n > 0.0).map(|n| n as u64)
}

fn finite(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// The listed record of a Node cache row; a row with no id is no model.
fn record_of_row(row: &Value) -> Option<ModelRecord> {
    let id = row.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())?;
    let mut record = ModelRecord::new(id);
    record.display_name = row.get("display").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    record.context_window = positive(row.get("contextWindow"));
    record.max_output_tokens = positive(row.get("outputTokens"));
    record.input_cost_per_m = finite(row.get("inputCostPerM"));
    record.output_cost_per_m = finite(row.get("outputCostPerM"));
    record.cache_read_cost_per_m = finite(row.get("cacheReadCostPerM"));
    record.cache_write_cost_per_m = finite(row.get("cacheWriteCostPerM"));
    record.supports_images = row.get("supportsVision").and_then(Value::as_bool);
    record.supports_reasoning = row.get("supportsReasoning").and_then(Value::as_bool);
    record.supports_prompt_caching = row.get("supportsPromptCaching").and_then(Value::as_bool);
    if let Some(options) = row.get("reasoningOptions").and_then(Value::as_array) {
        record.efforts_stated = true;
        record.picker.reasoning_options = options.iter().filter_map(|o| serde_json::from_value::<ReasoningOption>(o.clone()).ok()).collect();
        record.reasoning_levels = record.picker.reasoning_options.iter().filter(|o| o.kind == "effort").flat_map(|o| o.values.iter().cloned()).collect();
    }
    record.picker.tier = row.get("tier").and_then(Value::as_str).map(str::to_owned);
    record.picker.latest = row.get("latest").and_then(Value::as_bool).unwrap_or(false);
    record.picker.release_date = row.get("releaseDate").and_then(Value::as_str).map(str::to_owned);
    let thinking = row.get("thinkingTypes");
    record.thinking_adaptive = thinking.and_then(|t| t.get("adaptive")).and_then(Value::as_bool);
    record.thinking_enabled = thinking.and_then(|t| t.get("enabled")).and_then(Value::as_bool);
    record.mode = row.get("mode").and_then(Value::as_str).map(str::to_owned);
    record.reasoning_content_field = row.get("reasoningContentField").and_then(Value::as_str).map(str::to_owned);
    let extra: Map<String, Value> = ENRICHED_KEYS.iter().filter_map(|key| row.get(*key).map(|v| ((*key).to_owned(), v.clone()))).collect();
    record.enriched = EnrichedRow(Some(extra));
    Some(record)
}
#[cfg(node_twin)]
#[cfg(test)]
#[path = "oauth_cache_tests.rs"]
mod tests;

/// A stable, opaque key of an account (its id is not written to the roster file): the first 16 hex digits of the SHA-256 of
/// the parts.
pub fn account_fingerprint(parts: &[&str]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(parts.join("\u{1f}").as_bytes());
    digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect()
}
