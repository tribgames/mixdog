//! The process services the turn-assembly seams are built from (WP-RUN-HOST).
//!
//! The composition root builds one [`ProcessServices`] and hands it to each seam's single
//! constructor: [`builder_env`](super::builder_env::builder_env) (the provider builder's inputs),
//! [`accounting_deps`](super::accounting_scope::accounting_deps) (the ledger row of every send),
//! [`ProcessLadder::new`](super::ladder_sources::ProcessLadder::new) (the step judge's ladder) and
//! [`HopBindings::new`](super::hop_bindings::HopBindings::new) (the hop's wiring and error text).
//! Nothing here reads the process itself: the services are what the root owns.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use mixdog_agent::text_only::MediaText;
use mixdog_ai::catalog::{CatalogService, ListingLookup};
use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_ai::registry::keys::{Environment, SecretVault};
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_rt::{LaneToken, LaneTokens};
use mixdog_store::schema::record::Header;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::route_wiring::LocalEntry;
use crate::config::Config;

/// The latest header of an open session, by session id (`opts.session`).
pub trait SessionHeaders: Send + Sync {
    fn header(&self, session_id: &str) -> Option<Arc<Header>>;
}

/// What an endpoint refused per provider and model (`rejectedEffortLevelsSync`'s store).
pub trait EffortRejections: Send + Sync {
    fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry>;
}

/// The managed local runtime, as the text-only gate reads it (`localProviderModelEntry`,
/// `localModelState(model).capabilities.tools`, the media layer).
pub trait LocalModels: Send + Sync {
    fn entry(&self, model: &str) -> Option<LocalEntry>;
    fn runtime_tools(&self, model: &str) -> Option<bool>;
    fn media(&self, updated: &Value) -> Arc<dyn MediaText>;
}

/// The host the codex `User-Agent` describes, in codex's vocabulary: `Windows` / `Mac OS` /
/// `Linux`, the OS release and a rust-style arch (`x86_64`, `aarch64`).
#[derive(Clone, Debug)]
pub struct HostInfo {
    pub os_type: String,
    pub os_release: String,
    pub arch: String,
}

pub struct ProcessServices {
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    /// The one handle the catalog publishes its listing tables into.
    pub listing: ListingLookup,
    pub network: Arc<NetworkProxy>,
    pub vault: Arc<dyn SecretVault>,
    pub env: Arc<dyn Environment>,
    pub lanes: LaneTokens,
    /// The plugin data directory: OAuth credential files, `installation_id`,
    /// `effort-rejections.json`.
    pub plugin_data: PathBuf,
    pub home_dir: PathBuf,
    pub host: HostInfo,
    /// The mixdog build, sent as the client version where a dialect sends one.
    pub build_version: String,
    /// The Codex installation id ([`resolve_installation_id`]).
    pub installation_id: String,
    /// `getUsageLedger()`, read per send.
    pub ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>,
    pub sessions: Arc<dyn SessionHeaders>,
    pub rejections: Arc<dyn EffortRejections>,
    /// `markEffortConfigurationUnsupported`'s set, one per process.
    pub unsupported: Arc<UnsupportedEfforts>,
    pub local: Arc<dyn LocalModels>,
}

/// `MIXDOG_MODEL_PROXY=client`: this daemon serves a server that holds no model credentials.
pub fn remote_client(env: &dyn Environment) -> bool {
    mixdog_ai::service::admin_models::model_proxy_client_mode(&|name| env.var(name))
}

fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn read_id(path: &Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn create_id(path: &Path, id: &str) -> std::io::Result<bool> {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => file.write_all(id.as_bytes()).map(|()| true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// `_codexInstallationId`: `MIXDOG_CODEX_INSTALLATION_ID` when it is a uuid, else the uuid in
/// `<plugin data>/installation_id`, else a new one created there without replacing a concurrent
/// winner. A file that cannot be written leaves the generated id for this process.
pub async fn resolve_installation_id(env: &dyn Environment, lanes: &LaneTokens, plugin_data: &Path) -> String {
    let explicit = env.var("MIXDOG_CODEX_INSTALLATION_ID").map(|v| mixdog_js::js_trim(&v).to_lowercase()).unwrap_or_default();
    if is_uuid(&explicit) {
        return explicit;
    }
    let file = plugin_data.join("installation_id");
    let read = |file: PathBuf| {
        let job = lanes.interactive_io.submit(&CancellationToken::new(), move |_lane| read_id(&file));
        async move { job.ok()?.await.ok()?.ok().map(|t| mixdog_js::js_trim(&t).to_lowercase()).filter(|t| is_uuid(t)) }
    };
    if let Some(existing) = read(file.clone()).await {
        return existing;
    }
    let generated = mixdog_ai::accounts::new_account_id();
    let (path, id) = (file.clone(), generated.clone());
    let created = match lanes.durability_io.submit(&CancellationToken::new(), move |_lane| create_id(&path, &id)) {
        Ok(job) => job.await.ok().and_then(Result::ok),
        Err(_) => None,
    };
    match created {
        Some(false) => read(file).await.unwrap_or(generated),
        _ => generated,
    }
}

/// `effort-rejections.json` (`{version: 1, models: {"provider:model": {rejected, allowed}}}`),
/// read once through the lane and kept; Node re-checks the file's stat on every read, a daemon
/// that records a rejection calls [`FileRejections::note`] for the same effect.
pub struct FileRejections {
    models: std::sync::Mutex<HashMap<String, RejectionEntry>>,
}

fn entry_key(provider: &str, model: &str) -> String {
    format!("{}:{}", mixdog_js::js_trim(provider), mixdog_js::js_trim(model).to_lowercase())
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

impl FileRejections {
    /// A missing, unreadable or foreign-version file holds nothing (Node's `load`).
    pub async fn load(lanes: &LaneTokens, plugin_data: &Path) -> Arc<Self> {
        let path = plugin_data.join("effort-rejections.json");
        let text = match lanes.interactive_io.submit(&CancellationToken::new(), move |_lane| read_id(&path)) {
            Ok(job) => job.await.ok().and_then(Result::ok),
            Err(_) => None,
        };
        let parsed: Option<Value> = text.and_then(|t| serde_json::from_str(&t).ok());
        let mut models = HashMap::new();
        if let Some(doc) = parsed.filter(|d| d.get("version") == Some(&Value::from(1))) {
            for (key, entry) in doc.get("models").and_then(Value::as_object).into_iter().flatten() {
                models.insert(key.clone(), RejectionEntry { rejected: strings(entry.get("rejected")), allowed: strings(entry.get("allowed")) });
            }
        }
        Arc::new(Self { models: std::sync::Mutex::new(models) })
    }

    pub fn note(&self, provider: &str, model: &str, entry: RejectionEntry) {
        self.models.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(entry_key(provider, model), entry);
    }
}

impl EffortRejections for FileRejections {
    fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry> {
        self.models.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(&entry_key(provider, model)).cloned()
    }
}
