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

use async_trait::async_trait;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::catalog::{CatalogService, ListingLookup};
use mixdog_ai::effort::RejectionEntry;
use mixdog_ai::netproxy::NetworkProxy;
use mixdog_ai::registry::accounting::UsageSink;
use mixdog_ai::registry::keys::{Environment, ProcessEnv, SecretVault};
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_ai::service::model_proxy_inline::AttachmentReader;
use mixdog_core_api::domain::ext::DocumentText;
use mixdog_rt::{LaneToken, LaneTokens};
use mixdog_services::local_provider::LocalProvider;
use mixdog_store::schema::record::Header;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::local_models::ManagedLocalModels;
use super::media::AttachmentFacts;
use super::vault::KeychainVault;

use mixdog_core_run::run_host::route_wiring::LocalEntry;
use mixdog_core_config::config::Config;

/// The latest header of an open session, by session id (`opts.session`).
pub trait SessionHeaders: Send + Sync {
    fn header(&self, session_id: &str) -> Option<Arc<Header>>;
}

/// What an endpoint refused per provider and model (`rejectedEffortLevelsSync`'s store). Each
/// read checks the store's file, so it is async: the check runs on the io lane.
#[async_trait]
pub trait EffortRejections: Send + Sync {
    async fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry>;
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

/// What the composition root owns that [`ProcessServices::production`] cannot derive from the
/// process: the stores it already opened and the session directory's headers.
pub struct ProcessInputs {
    pub config: Config,
    pub catalog: Arc<CatalogService>,
    pub listing: ListingLookup,
    pub network: Arc<NetworkProxy>,
    pub lanes: LaneTokens,
    /// Node's `resolvePluginData()`: the keychain's `secrets/` folder, the OAuth credential
    /// files, `installation_id` and `effort-rejections.json` live in it.
    pub plugin_data: PathBuf,
    /// Node's `os.homedir()`.
    pub home_dir: PathBuf,
    pub build_version: String,
    pub ledger: Arc<dyn Fn() -> Option<Arc<dyn UsageSink>> + Send + Sync>,
    pub sessions: Arc<dyn SessionHeaders>,
    /// The process's one managed local runtime, and the media layer its text-only requests lower
    /// attachments through.
    pub local_provider: Arc<LocalProvider>,
    pub documents: Arc<dyn DocumentText>,
    pub attachments: Arc<dyn AttachmentReader>,
    pub attachment_facts: Arc<dyn AttachmentFacts>,
}

impl ProcessServices {
    /// The services of a real daemon: the host's keychain, the process environment, the machine
    /// it runs on, the Codex installation id (read or created in the plugin data directory), the
    /// effort rejections file, one unsupported-efforts set and the managed local runtime.
    pub async fn production(inputs: ProcessInputs) -> std::io::Result<Self> {
        let env: Arc<dyn Environment> = Arc::new(ProcessEnv);
        let installation_id = resolve_installation_id(&*env, &inputs.lanes, &inputs.plugin_data).await;
        Ok(Self {
            config: inputs.config,
            catalog: inputs.catalog,
            listing: inputs.listing,
            network: inputs.network,
            vault: Arc::new(KeychainVault::open(inputs.lanes.durability_io, &inputs.plugin_data)),
            env,
            rejections: FileRejections::new(&inputs.lanes, &inputs.plugin_data),
            lanes: inputs.lanes,
            plugin_data: inputs.plugin_data,
            home_dir: inputs.home_dir,
            host: HostInfo::current()?,
            build_version: inputs.build_version,
            installation_id,
            ledger: inputs.ledger,
            sessions: inputs.sessions,
            unsupported: Arc::new(UnsupportedEfforts::default()),
            local: Arc::new(ManagedLocalModels::new(inputs.local_provider, inputs.documents, inputs.attachments, inputs.attachment_facts)),
        })
    }
}

/// `MIXDOG_MODEL_PROXY=client`: this daemon serves a server that holds no model credentials.
pub fn remote_client(env: &dyn Environment) -> bool {
    mixdog_ai::service::admin_models::model_proxy_client_mode(&|name| env.var(name))
}

/// `UUID_RE`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`.
fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && [8, 4, 4, 4, 12].iter().zip(&parts).all(|(n, p)| p.len() == *n && p.bytes().all(|b| b.is_ascii_hexdigit()))
        && matches!(parts[2].as_bytes()[0], b'1'..=b'8')
        && matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn read_id(path: &Path) -> std::io::Result<String> {
    std::fs::read_to_string(path)
}

/// `writeFileAtomicSync(file, id, { createOnly, mode: 0o644 })`: `Exists` when `create_only` and
/// the file is there already.
fn publish_id(lane: &mixdog_rt::InLane<mixdog_rt::DurabilityIo>, path: &Path, id: &str, create_only: bool) -> std::io::Result<mixdog_statefile::Published> {
    let opts = mixdog_statefile::Opts { mode: 0o644, create_only, ..mixdog_statefile::Opts::default() };
    mixdog_statefile::write_file(lane, path, id.as_bytes(), &opts).map_err(|error| match error {
        mixdog_statefile::StateError::Io(error) => error,
        other => std::io::Error::other(other.to_string()),
    })
}

/// `_codexInstallationId`: `MIXDOG_CODEX_INSTALLATION_ID` when it is a uuid, else the uuid in
/// `<plugin data>/installation_id`, else a new one created there without replacing a concurrent
/// winner; a file that holds no uuid (damaged) is replaced whole. A file that cannot be written
/// leaves the generated id for this process.
pub async fn resolve_installation_id(env: &dyn Environment, lanes: &LaneTokens, plugin_data: &Path) -> String {
    let explicit = env.var("MIXDOG_CODEX_INSTALLATION_ID").map(|v| mixdog_js::js_trim(&v).to_lowercase()).unwrap_or_default();
    if is_uuid(&explicit) {
        return explicit;
    }
    let file = plugin_data.join("installation_id");
    let generated = mixdog_ai::accounts::new_account_id();
    // `None`: the read never ran, which says nothing about the file. Only a read that ran and found
    // no uuid may lead to replacing the file; otherwise a valid id would be overwritten.
    let read = |file: PathBuf| {
        let job = lanes.interactive_io.submit(&CancellationToken::new(), move |_lane| read_id(&file));
        async move { Some(job.ok()?.await.ok()?.ok().map(|t| mixdog_js::js_trim(&t).to_lowercase()).filter(|t| is_uuid(t))) }
    };
    match read(file.clone()).await {
        Some(Some(existing)) => return existing,
        Some(None) => {}
        None => return generated,
    }
    let publish = |create_only: bool| {
        let (path, id) = (file.clone(), generated.clone());
        let job = lanes.durability_io.submit(&CancellationToken::new(), move |lane| publish_id(lane, &path, &id, create_only));
        async move { job.ok()?.await.ok()?.ok() }
    };
    if publish(true).await == Some(mixdog_statefile::Published::Exists) {
        match read(file.clone()).await {
            Some(Some(winner)) => return winner,
            Some(None) => {
                publish(false).await;
            }
            None => {}
        }
    }
    generated
}

/// `effort-rejections.json` (`{version: 1, models: {"provider:model": {rejected, allowed}}}`).
/// Every read checks the file's signature (mtime and size) on the io lane and reloads the file
/// when it changed, as Node's `load` does: a rejection another process persisted shows at once.
pub struct FileRejections {
    path: PathBuf,
    lane: mixdog_rt::InteractiveIo,
    /// What the last load saw; `None` before the first read.
    cached: std::sync::Mutex<Option<Loaded>>,
}

/// `signature(file)`: `None` when the file cannot be statted.
type Signature = Option<(std::time::SystemTime, u64)>;

struct Loaded {
    sig: Signature,
    models: HashMap<String, RejectionEntry>,
}

enum Refresh {
    Unchanged,
    Loaded { sig: Signature, bytes: Option<Vec<u8>> },
}

/// The body of the lane job: stat the file, and read it only when its signature differs from
/// `known`.
#[allow(clippy::disallowed_methods, reason = "body of a lane job")]
fn refresh(path: &Path, known: Option<Signature>) -> Refresh {
    let sig = std::fs::metadata(path).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    if known == Some(sig) {
        return Refresh::Unchanged;
    }
    Refresh::Loaded { sig, bytes: std::fs::read(path).ok() }
}

fn entry_key(provider: &str, model: &str) -> String {
    format!("{}:{}", mixdog_js::js_trim(provider), mixdog_js::js_trim(model).to_lowercase())
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}

impl FileRejections {
    pub fn new(lanes: &LaneTokens, plugin_data: &Path) -> Arc<Self> {
        Arc::new(Self { path: plugin_data.join("effort-rejections.json"), lane: lanes.interactive_io, cached: std::sync::Mutex::new(None) })
    }

    /// A missing, unreadable or foreign-version file holds nothing (Node's `load`).
    fn parse(bytes: Option<Vec<u8>>) -> HashMap<String, RejectionEntry> {
        let doc = bytes.and_then(|b| mixdog_statefile::parse_json_text(&b).ok());
        let mut models = HashMap::new();
        if let Some(doc) = doc.filter(|d| d.get("version").and_then(Value::as_f64) == Some(1.0)) {
            for (key, entry) in doc.get("models").and_then(Value::as_object).into_iter().flatten() {
                models.insert(key.clone(), RejectionEntry { rejected: strings(entry.get("rejected")), allowed: strings(entry.get("allowed")) });
            }
        }
        models
    }
}

#[async_trait]
impl EffortRejections for FileRejections {
    async fn entry(&self, provider: &str, model: &str) -> Option<RejectionEntry> {
        let known = self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_ref().map(|c| c.sig);
        let path = self.path.clone();
        let job = self.lane.submit(&CancellationToken::new(), move |_lane| refresh(&path, known));
        let refreshed = match job {
            Ok(job) => job.await.ok(),
            Err(_) => None,
        };
        let mut cached = self.cached.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(Refresh::Loaded { sig, bytes }) = refreshed {
            *cached = Some(Loaded { sig, models: Self::parse(bytes) });
        }
        cached.as_ref()?.models.get(&entry_key(provider, model)).cloned()
    }
}
