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

use std::collections::BTreeSet;
use std::sync::Arc;

use mixdog_ai::catalog::CatalogService;
use mixdog_ai::client_versions::{ClientVersions, Live};
use mixdog_ai::oauth::pace::SystemPace;
use mixdog_ai::oauth::CredentialIo;
use mixdog_ai::providers::anthropic::{CapsLookup, ModelCaps};
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
use mixdog_core_run::run_host::route_wiring::claude_generation;
use mixdog_core_run::run_host::route_wiring::ADAPTIVE_FLOOR;
use mixdog_core_run::run_host::route_wiring::MANUAL_REJECTED_FLOOR;
use mixdog_core_run::run_host::route_wiring::MAX_FLOOR;
use mixdog_core_run::run_host::route_wiring::XHIGH_FLOOR;

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
const LEVEL_ORDER: [&str; 6] = ["none", "low", "medium", "high", "xhigh", "max"];
const CONTROL_KEYS: [&str; 3] = ["supported", "enabled", "default"];

/// `_effortLevelsOf(reasoningOptions)`, in the canonical low-to-max order.
fn ladder_of(options: Option<&Value>) -> Vec<String> {
    let first = options.and_then(Value::as_array).into_iter().flatten().find(|o| {
        o.get("type").map(|t| mixdog_js::js_trim(&mixdog_js::value_to_string(t)).to_lowercase()) == Some("effort".to_owned())
    });
    let mut levels: Vec<String> = first
        .and_then(|o| o.get("values"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|v| mixdog_js::js_trim(&mixdog_js::value_to_string(v)).to_lowercase())
        .filter(|v| !v.is_empty() && !CONTROL_KEYS.contains(&v.as_str()))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let rank = |l: &str| LEVEL_ORDER.iter().position(|o| *o == l).unwrap_or(LEVEL_ORDER.len());
    levels.sort_by_key(|l| rank(l));
    levels
}

/// `normalizeClaudeModelId`.
fn normalized(model: &str) -> String {
    model.to_lowercase().replace('.', "-")
}

/// `_catalogKeys`: a dated id and its bare alias describe the same model.
fn keys_of(model: &str) -> Vec<String> {
    let id = normalized(model);
    if id.is_empty() {
        return Vec::new();
    }
    let undated = match id.len().checked_sub(9) {
        Some(cut) if id.is_char_boundary(cut) && id[cut..].starts_with('-') && id[cut + 1..].bytes().all(|b| b.is_ascii_digit()) => id[..cut].to_owned(),
        _ => id.clone(),
    };
    if undated == id { vec![id] } else { vec![id, undated] }
}

/// What the Anthropic catalog states of a model (`_catalogEntry`).
struct Entry {
    levels: Vec<String>,
    /// `thinkingTypes.enabled`.
    manual: Option<bool>,
    /// `thinkingTypes.adaptive`.
    adaptive: Option<bool>,
}

/// The Anthropic model capabilities the codec reads (`anthropic-effort.mjs`), in Node's order for
/// one model: the live roster index (the subscription route's listed rows), then the shared
/// catalog, then the release-generation floor for an id no catalog describes. A listed row that
/// states an empty effort ladder is a model that takes no effort, and its own `thinkingTypes`
/// flags decide the thinking kind; the floor decides only where the catalog is silent.
#[derive(Clone)]
pub struct CatalogCaps {
    catalog: Arc<CatalogService>,
    /// `MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT`.
    always_effort: bool,
}

impl CatalogCaps {
    pub fn new(catalog: Arc<CatalogService>, env: &dyn Environment) -> Self {
        let always = env.var("MIXDOG_ANTHROPIC_ALWAYS_ENABLE_EFFORT").map(|v| mixdog_js::js_trim(&v).to_lowercase());
        Self { catalog, always_effort: matches!(always.as_deref(), Some("1" | "true" | "yes" | "on")) }
    }

    pub fn lookup(self) -> CapsLookup {
        Arc::new(move |model| self.caps(model))
    }

    /// `setModelEffortCapabilities` + `_catalogEntry`: the index over the listed rows (rows that
    /// state no ladder skipped; a bare alias shared by several rows keeps the richer ladder), the
    /// shared catalog's ladder for an id the index does not hold.
    fn entry(&self, model: &str) -> Option<Entry> {
        let wanted = keys_of(model);
        let snapshot = self.catalog.snapshot();
        let mut index: std::collections::HashMap<String, Entry> = std::collections::HashMap::new();
        for record in snapshot.models_of(&ProviderId::from("anthropic-oauth")) {
            if !record.efforts_stated {
                continue;
            }
            let levels = ladder_of(Some(&json!(record.picker.reasoning_options)));
            for key in keys_of(&record.id) {
                if index.get(&key).is_some_and(|e| !e.levels.is_empty()) && levels.is_empty() {
                    continue;
                }
                index.insert(key, Entry { levels: levels.clone(), manual: record.thinking_enabled, adaptive: record.thinking_adaptive });
            }
        }
        if let Some(entry) = wanted.iter().find_map(|key| index.remove(key)) {
            return Some(entry);
        }
        let id = normalized(model);
        let levels = self.catalog.sync_meta(&id, "anthropic").map(|meta| ladder_of(meta.get("reasoningOptions"))).unwrap_or_default();
        (!levels.is_empty()).then_some(Entry { levels, manual: None, adaptive: None })
    }

    pub fn caps(&self, model: &str) -> Option<ModelCaps> {
        let generation = claude_generation(model);
        let at_least = |floor: f64| generation.is_some_and(|g| g >= floor);
        let id = normalized(model);
        let meta = self.catalog.sync_meta(&id, "anthropic");
        let entry = self.entry(model);
        let mut effort_levels = entry.as_ref().map(|e| e.levels.clone());
        let floor_levels = || {
            let mut levels = ["low", "medium", "high"].map(str::to_owned).to_vec();
            if at_least(XHIGH_FLOOR) {
                levels.push("xhigh".into());
            }
            if at_least(MAX_FLOOR) {
                levels.push("max".into());
            }
            levels
        };
        // `modelSupportsEffort`: the switch enables it whatever the ladder, floor-gated top tiers
        // only where no ladder is advertised.
        let levels = match effort_levels.take() {
            Some(l) if l.is_empty() && self.always_effort => vec!["low".to_owned(), "medium".into(), "high".into()],
            Some(l) => l,
            None if self.always_effort || at_least(ADAPTIVE_FLOOR) => floor_levels(),
            None => Vec::new(),
        };
        if levels.is_empty() && generation.is_none() && meta.is_none() && entry.is_none() {
            return None;
        }
        let positive = |key: &str| meta.as_ref().and_then(|m| m.get(key)).and_then(Value::as_f64).filter(|n| *n > 0.0);
        Some(ModelCaps {
            // `_usesAdaptiveThinking`: a declared `adaptive` flag, else the generation floor.
            adaptive_thinking: self.always_effort || entry.as_ref().and_then(|e| e.adaptive).unwrap_or_else(|| at_least(ADAPTIVE_FLOOR)),
            // `isAnthropicAdaptiveOnlyModel`: a declared `enabled` flag, else the generation.
            manual_thinking: entry.as_ref().and_then(|e| e.manual).unwrap_or_else(|| !at_least(MANUAL_REJECTED_FLOOR)),
            ladder_stated: entry.is_some(),
            effort_levels: levels,
            max_output_tokens: positive("outputTokens").map(|n| n as u32),
            fast_mode: self.catalog.supports_anthropic_fast_mode(&id),
            context_window: positive("contextWindow").map(|n| n as u64),
            thinking_display_updates: mixdog_ai::claude_floors::emits_progress_updates(model),
        })
    }
    /// `anthropicEffortLevelsFor(model)`: the levels the wire builder sends unchanged (reserved
    /// `max` excluded); none for a model without adaptive effort.
    pub fn effort_levels_for(&self, model: &str) -> Vec<String> {
        let Some(caps) = self.caps(model).filter(|c| c.supports_effort() && c.adaptive_thinking) else { return Vec::new() };
        let mut levels = vec!["low".to_owned(), "medium".into(), "high".into()];
        if caps.effort_levels.iter().any(|l| l == "xhigh") {
            levels.push("xhigh".into());
        }
        levels
    }

    /// `anthropicEffortLevelsFor(model).length === 0`: the fact the cache warmer reads of a
    /// request (`WarmRequest::effort_levels_empty`).
    pub fn effort_levels_empty(&self, model: &str) -> bool {
        self.effort_levels_for(model).is_empty()
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
        ModelFacts {
            reasoning: Some(reasoning),
            // `_codexModelSupportsReasoningSummaries`: the cached Codex roster's row for the exact
            // id (`findCachedCodexModel`); an id it does not hold takes summaries.
            reasoning_summaries: self
                .catalog
                .snapshot()
                .models_of(&ProviderId::from("openai-oauth"))
                .iter()
                .find(|r| r.id == model)
                .and_then(|r| r.supports_reasoning_summaries),
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
