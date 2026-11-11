//! `BuilderEnv`: the 21 inputs of `DefaultProviderBuilder`, from the process services
//! ([`builder_env`]). Each input is built the way Node's providers read it:
//!
//! - transports: the routed link and dialer over the one network-proxy policy;
//! - credentials: the API-key store over the vault and environment (a remote client holds no
//!   model credentials), the OAuth credential files under the plugin data dir;
//! - catalog facts: the Anthropic caps ([`CatalogCaps`]), the Gemini traits and the OpenAI model
//!   facts ([`CatalogOpenAiFacts`]);
//! - identities: the Codex block and the client versions ([`client_identity`]);
//! - `gated_off`: `!providerAvailable(name)` over the stored Developer options.

use std::sync::Arc;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::client_versions::{ClientVersions, Live};
use mixdog_ai::oauth::pace::SystemPace;
use mixdog_ai::oauth::CredentialIo;
pub use mixdog_ai::providers::anthropic::catalog_caps::CatalogCaps;
use mixdog_ai::providers::google::traits::CatalogGoogleTraits;
use mixdog_ai::providers::openai::adapter::SessionContext;
use mixdog_ai::providers::openai::config::{CodexIdentity, ModelFacts, ModelFactsSource, PromptCacheLifetime};
use mixdog_ai::registry::builder::BuilderEnv;
use mixdog_ai::registry::keys::{ApiKeyStore, Environment};
use mixdog_ai::service::admin_models::provider_available;
use mixdog_ai::transport::{KeepaliveDialer, KeepaliveSchedule, ReqwestLink};
use mixdog_ai::accounts::AccountStore;
use mixdog_protocol::ProviderId;
use serde_json::{json, Value};

use super::process::{remote_client, HostInfo, ProcessServices};

pub use mixdog_ai::client_versions::CODEX_CLIENT_VERSION_FLOOR;
const CODEX_ORIGINATOR: &str = "codex_cli_rs";
const CODEX_BETA_FEATURES: &str = "remote_compaction_v2";

/// What the dialects send about the client. The versions are read when a request is built:
/// the live answer of [`ClientVersions`] above Node's floors, and the configured overrides above
/// that.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientIdentity {
    pub codex: CodexIdentity,
    pub grok: Live,
    pub cursor: Live,
    pub antigravity: Live,
}

fn set(env: &dyn Environment, name: &str) -> Option<String> {
    env.var(name).map(|v| mixdog_js::js_trim(&v).to_owned()).filter(|v| !v.is_empty())
}

/// `codexUserAgent()`, `codexVersionHeader()`, `_codexBetaFeatures()`, `_codexInstallationId`'s
/// result and the client versions of the three dialects that gate on one. Node reads the
/// overrides from the environment at each call, so the headers do here.
pub fn client_identity(env: &Arc<dyn Environment>, host: &HostInfo, installation_id: &str, versions: &Arc<ClientVersions>) -> ClientIdentity {
    let (agent_env, agent_host, agent_versions) = (Arc::clone(env), host.clone(), Arc::clone(versions));
    let user_agent = Live::new(move || {
        set(&*agent_env, "MIXDOG_CODEX_USER_AGENT").unwrap_or_else(|| {
            let originator = set(&*agent_env, "MIXDOG_CODEX_ORIGINATOR").unwrap_or_else(|| CODEX_ORIGINATOR.to_owned());
            let terminal = set(&*agent_env, "TERM_PROGRAM").unwrap_or_else(|| "unknown".to_owned());
            format!(
                "{originator}/{} ({} {}; {}) {terminal}",
                agent_versions.codex(),
                agent_host.os_type,
                agent_host.os_release,
                agent_host.arch
            )
        })
    });
    let (version_env, version_versions) = (Arc::clone(env), Arc::clone(versions));
    let version = Live::new(move || set(&*version_env, "MIXDOG_CODEX_VERSION").unwrap_or_else(|| version_versions.codex()));
    let beta_features = env.var("MIXDOG_CODEX_BETA_FEATURES").filter(|v| !v.is_empty()).unwrap_or_else(|| CODEX_BETA_FEATURES.to_owned());
    ClientIdentity {
        codex: CodexIdentity { installation_id: installation_id.to_owned(), user_agent, version, beta_features },
        grok: versions.grok_live(),
        cursor: versions.cursor_live(),
        antigravity: versions.antigravity_live(),
    }
}
/// `openAiCatalogMeta` / `openAiDirectSupports*` / the `openAiPublicSupports*` rules over the
/// catalog: the facts of an OpenAI model for the Responses codec.
pub struct CatalogOpenAiFacts {
    catalog: Arc<CatalogService>,
}

/// `gpt-5.4` -> (5, 4); `gpt-6-astra` -> (6, 0); a bare multi-digit major (`gpt-60`) and other
/// ids -> `None` (`gptVersion`).
fn gpt_version(id: &str) -> Option<(u64, u64)> {
    mixdog_ai::service::routes::gpt_version(id)
}

fn at_least(version: Option<(u64, u64)>, major: u64, minor: u64) -> bool {
    version.is_some_and(|v| v.0 > major || (v.0 == major && v.1 >= minor))
}

/// `-\d{4}-\d{2}-\d{2}`.
fn is_date_suffix(tail: &str) -> bool {
    let parts: Vec<&str> = tail.strip_prefix('-').unwrap_or("x").split('-').collect();
    parts.len() == 3 && parts.iter().zip([4, 2, 2]).all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_digit()))
}

/// A dated snapshot reads as its undated alias: `-\d{4}-\d{2}-\d{2}$` removed.
fn undated(id: &str) -> &str {
    let Some(cut) = id.len().checked_sub(11) else { return id };
    match id.get(cut..) {
        Some(tail) if is_date_suffix(tail) => &id[..cut],
        _ => id,
    }
}

const PRE_CATALOG_GPT_56_PLUS: [&str; 7] = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const EXTENDED_RETENTION: [&str; 12] = [
    "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.2", "gpt-5.1-codex-max", "gpt-5.1", "gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1-chat-latest", "gpt-5", "gpt-5-codex", "gpt-4.1",
];

impl CatalogOpenAiFacts {
    pub fn new(catalog: Arc<CatalogService>) -> Self {
        Self { catalog }
    }

    fn meta(&self, id: &str) -> Option<serde_json::Map<String, Value>> {
        [id, undated(id)].into_iter().filter(|c| !c.is_empty()).find_map(|c| self.catalog.sync_meta(c, "openai"))
    }

    /// `PRE_CATALOG_GPT_56_PLUS`: `^(?:bases)(?:-\d{4}-\d{2}-\d{2})?$`.
    fn pre_catalog_56_plus(id: &str) -> bool {
        PRE_CATALOG_GPT_56_PLUS.iter().any(|base| id.strip_prefix(base).is_some_and(|rest| rest.is_empty() || is_date_suffix(rest)))
    }
}

impl ModelFactsSource for CatalogOpenAiFacts {
    fn facts(&self, model: &str) -> ModelFacts {
        let id = mixdog_js::js_trim(model);
        let version = gpt_version(id);
        let reasoning = self.meta(id).and_then(|m| m.get("supportsReasoning").and_then(Value::as_bool)).unwrap_or_else(|| {
            if id.starts_with("gpt-5-chat") {
                return false;
            }
            let o_series = id.strip_prefix('o').is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
            o_series || at_least(version, 5, 0)
        });
        let prompt_cache = if at_least(version, 5, 6) || Self::pre_catalog_56_plus(id) {
            PromptCacheLifetime::Options30m
        } else if EXTENDED_RETENTION.contains(&id) || EXTENDED_RETENTION.contains(&undated(id)) {
            PromptCacheLifetime::Retention24h
        } else {
            PromptCacheLifetime::None
        };
        let row = json!({ "id": id });
        let snapshot = self.catalog.snapshot();
        // The cached Codex roster's row for the exact id (`findCachedCodexModel`).
        let codex_row = snapshot.models_of(&ProviderId::from("openai-oauth")).iter().find(|r| r.id == model);
        // `modelSupportsServiceTier` (`model-service-tiers.mjs`): a tier the row lists, a speed tier it adds, or its
        // default; a model the roster does not hold has none.
        let codex_tier = |tier: &str| {
            codex_row.is_some_and(|r| {
                r.picker.service_tiers.iter().any(|t| t.id == tier)
                    || r.picker.additional_speed_tiers.iter().any(|t| t == tier)
                    || r.picker.default_service_tier.as_deref() == Some(tier)
            })
        };
        ModelFacts {
            reasoning: Some(reasoning),
            // `_codexModelSupportsReasoningSummaries`: an id the roster does not hold takes summaries.
            reasoning_summaries: codex_row.and_then(|r| r.supports_reasoning_summaries),
            codex_fast_tier: codex_tier("priority"),
            codex_ultrafast_tier: codex_tier("ultrafast"),
            verbosity: Some(at_least(version, 5, 0)),
            native_tool_search: Some(at_least(version, 5, 4)),
            fast_tier: self.catalog.fast_capable("openai", &row, None, &json!({})),
            ultrafast_tier: self.catalog.ultrafast_capable("openai", &row),
            prompt_cache,
            access_programs: None,
        }
    }
}

/// The single constructor: every input of `DefaultProviderBuilder` from the process services.
pub fn builder_env(p: &ProcessServices) -> BuilderEnv {
    builder_env_shared(p).0
}

/// What the builder inputs hold that other layers use as the same object (the media layer's provider login and
/// Codex session): the routed link, the client versions, and the client identity the dialects send.
pub struct BuilderShared {
    pub http: Arc<dyn mixdog_ai::transport::HttpSend>,
    pub versions: Arc<ClientVersions>,
    pub identity: ClientIdentity,
}

/// [`builder_env`] with the objects it shares, for the caller that hands them on.
pub fn builder_env_shared(p: &ProcessServices) -> (BuilderEnv, BuilderShared) {
    let schedule = KeepaliveSchedule::SPEC;
    let link = Arc::new(ReqwestLink::routed(&schedule, false, p.network.clone()));
    let io = CredentialIo { read: p.lanes.interactive_io, write: p.lanes.durability_io };
    let client = remote_client(&*p.env);
    let versions = ClientVersions::new(link.clone(), p.plugin_data.clone(), io, p.env.clone());
    let identity = client_identity(&p.env, &p.host, &p.installation_id, &versions);
    let (config, env) = (p.config.clone(), p.env.clone());
    let shared = BuilderShared { http: link.clone(), versions: versions.clone(), identity: identity.clone() };
    let built = BuilderEnv {
        http: link.clone(),
        bidi: link,
        dial: Arc::new(KeepaliveDialer::routed(schedule, p.network.clone())),
        keys: ApiKeyStore::new(p.vault.clone(), p.env.clone(), client),
        accounts: AccountStore::new(p.plugin_data.clone(), io).remote_client(client),
        anthropic_caps: CatalogCaps::new(p.catalog.clone(), &*p.env).lookup(),
        google_traits: Arc::new(CatalogGoogleTraits(["gemini", "vertex-ai", "antigravity-oauth"].map(|id| Arc::new(p.catalog.traits(ProviderId::from(id))) as Arc<dyn mixdog_ai::catalog::ModelTraits>).to_vec())),
        openai_facts: Arc::new(CatalogOpenAiFacts::new(p.catalog.clone())),
        openai_context: Arc::new(SessionContext::new()),
        codex_identity: identity.codex,
        pace: Arc::new(SystemPace),
        gzip_lane: p.lanes.cpu_bulk,
        client_version: p.build_version.clone(),
        client_versions: Some(versions),
        grok_client_version: Some(identity.grok),
        cursor_client_version: Some(identity.cursor),
        antigravity_client_version: identity.antigravity,
        listing: p.listing.clone(),
        env: p.env.clone(),
        home_dir: p.home_dir.clone(),
        io,
        gated_off: Arc::new(move |name| {
            let developer = config.agent().get("developer").cloned().unwrap_or(Value::Null);
            !provider_available(name, remote_client(&*env), &developer)
        }),
    };
    (built, shared)
}
