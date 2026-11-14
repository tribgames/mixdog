//! [`ConfigSeams`] over [`Config`] and [`AgentDefinitions`]: what a turn reads of the settings and
//! the agent store.
//!
//! `run_settings` fills the fields whose Node origin is the saved config or the session header
//! (`compose-seams.md` "RunSettings: origins"): `hidden_agent`, `agent_mode`, `compact` (minus the
//! request's tool-schema reserve, which the host measures from the sent tools) and
//! `read_body_required`. The route/catalog/provider rows (`effort`, `step_auto_effort`,
//! `text_only`, `escalated_max_output_tokens`, `model_max_output_tokens`, `vision`), the heartbeat
//! `limits` mark and `attachments` have no config or header origin, so they are left empty for the
//! host to fill from the route.

use std::path::PathBuf;
use std::sync::Arc;

use mixdog_agent::boundary::CompactSettings;
use mixdog_agent::compact::settings::{Doc, adopt_session_compaction, normalize_compaction};
use mixdog_core_api::ids::ThreadId;
use mixdog_js::{string_to_number, to_number, to_number_of};
use mixdog_store::agent_mode::session_mode_of;
use mixdog_store::schema::record::Header;
use mixdog_app_protocol::v2::thread::ThreadRoute;
use serde_json::Value;

use mixdog_core_config::config::Config;
use mixdog_core_agents::agents::AgentDefinitions;
use crate::run_host::assemble::RunSettings;
use crate::run_host::host_seams::ConfigSeams;
use crate::run_host::rules_lead::{LeadPaths, build_lead_language};

/// How the process environment is read (`process.env[name]`).
pub type EnvReader = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

const MAX_BUFFER_INPUT_RATIO: f64 = 0.999_999;
const LEGACY_DEFAULT_BUFFER_RATIO: f64 = 0.1;

pub struct ConfigRunSeams {
    config: Config,
    agents: Arc<AgentDefinitions>,
    plugin_root: PathBuf,
    data_dir: PathBuf,
    env: EnvReader,
    /// The configuration was handed in by a headless caller (`usesInjectedConfig(params)`): its sessions keep the
    /// compaction they were created with when they are installed.
    injected_config: bool,
    /// The settings changes this process announced (`announceSettingsChange`); none for a configuration nobody follows.
    settings: Option<Arc<crate::run_host::settings_changes::SettingsChanges>>,
    main_route: Option<Arc<dyn Fn() -> serde_json::Map<String, Value> + Send + Sync>>,
}

impl ConfigRunSeams {
    pub fn new(config: Config, agents: Arc<AgentDefinitions>, plugin_root: PathBuf, data_dir: PathBuf, env: EnvReader) -> Self {
        Self { config, agents, plugin_root, data_dir, env, injected_config: false, settings: None, main_route: None }
    }

    /// The configured Main route (`resolveRoute(config)`), the route of a thread with no session yet.
    pub fn with_main_route(mut self, main_route: Arc<dyn Fn() -> serde_json::Map<String, Value> + Send + Sync>) -> Self {
        self.main_route = Some(main_route);
        self
    }

    /// The announcer of this process's settings changes, which the threads follow.
    pub fn with_settings_changes(mut self, settings: Arc<crate::run_host::settings_changes::SettingsChanges>) -> Self {
        self.settings = Some(settings);
        self
    }

    /// Marks the configuration as injected by the caller rather than the profile on disk.
    pub fn with_injected_config(mut self, injected: bool) -> Self {
        self.injected_config = injected;
        self
    }

    /// The loaded config's `compaction` section. Node's full config always has one (`config.mjs:367`, `compaction: {}`
    /// by default), so a stored agent section without it is the empty one, whose normalization seeds the session
    /// (`onModelChange`, `summaryMode`) and clears the resolved buffer keys.
    fn saved_compaction(&self) -> Value {
        self.config.agent().get("compaction").filter(|c| c.is_object()).cloned().unwrap_or_else(|| Value::Object(Default::default()))
    }

    /// `session.compaction` after `syncSessionCompaction(session, config)`: the header's own
    /// fields stay, the config-owned ones follow the saved section (when the config has one).
    fn session_compaction(&self, header: &Header) -> Doc {
        let mut session = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
        if let Some(saved) = self.config.agent().get("compaction").filter(|c| c.is_object()) {
            adopt_session_compaction(&mut session, &normalize_compaction(Some(saved)));
        }
        session
    }

    fn env_value(&self, name: &str) -> Option<Value> {
        (self.env)(name).map(Value::String)
    }

    fn env_positive(&self, name: &str) -> Option<u64> {
        positive_int((self.env)(name).as_deref().map(Value::from).as_ref())
    }

    fn env_flag(&self, name: &str, fallback: bool) -> bool {
        let Some(raw) = (self.env)(name) else { return fallback };
        match mixdog_js::js_trim(&raw).to_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "off" | "no" => false,
            _ => fallback,
        }
    }

    /// `resolveWorkerCompactPolicy`'s inputs (`compact-policy.mjs`, `context-compaction-policy.mjs`).
    pub(crate) fn compact_settings(&self, header: &Header, agent_mode: bool) -> CompactSettings {
        self.compact_settings_with(header, agent_mode, self.session_compaction(header))
    }

    /// The same inputs over a `compaction` section the caller states: a route that has no session
    /// yet (an inheritance heir, `inheritanceRouteTarget`) carries `{ auto: true }` and is never
    /// synced with the saved configuration.
    /// The window and sizing are stated whatever `auto` is: with it off the loop's policy is off
    /// (`CompactPolicy::resolve`), while a manual or scheduled pass resolves them with `auto` forced
    /// on (`resolveSessionCompactionPolicy`, `compaction-runner.mjs`).
    pub(crate) fn compact_settings_with(&self, header: &Header, agent_mode: bool, cfg: Doc) -> CompactSettings {
        let agent_owner = header
            .get("owner")
            .is_some_and(|owner| mixdog_js::js_trim(&mixdog_js::value_to_string(owner)).to_lowercase() == "agent");
        let flag_off = cfg.get("auto") == Some(&Value::Bool(false));
        let auto = (!flag_off || agent_mode) && self.env_flag("MIXDOG_AGENT_COMPACT_AUTO", true);
        let mut settings = CompactSettings {
            auto,
            agent_owner,
            token_calibration: token_calibration(header.get("provider"), &|name| (self.env)(name)),
            ..CompactSettings::default()
        };
        let stated = |session_key: &str, cfg_key: &str| positive_int(first_stated(&[header.get(session_key), cfg.get(cfg_key)]));
        settings.context_window = stated("contextWindow", "contextWindow");
        settings.explicit_boundary = stated("compactBoundaryTokens", "boundaryTokens");
        settings.auto_limit = stated("autoCompactTokenLimit", "autoCompactTokenLimit");
        settings.last_context_tokens = header
            .get("lastContextTokens")
            .and_then(|v| positive_int(Some(v)))
            .filter(|_| header.get("lastContextTokensStaleAfterCompact") != Some(&Value::Bool(true)));
        settings.configured_reserve_tokens =
            positive_int(cfg.get("reservedTokens")).or_else(|| self.env_positive("MIXDOG_AGENT_COMPACT_RESERVED_TOKENS")).unwrap_or(0);
        // `handoffTimeoutMs` of the worker policy.
        settings.handoff_timeout_ms = positive_int(cfg.get("timeoutMs")).or_else(|| self.env_positive("MIXDOG_AGENT_COMPACT_TIMEOUT_MS"));
        let boundary = match (settings.explicit_boundary, settings.context_window) {
            (Some(explicit), Some(window)) => Some(explicit.min(window)),
            (explicit, window) => explicit.or(window).or(settings.auto_limit),
        };
        let (tokens, ratio) = if agent_owner { self.agent_buffer(&cfg, boundary) } else { self.main_buffer(&cfg) };
        settings.buffer_tokens = tokens;
        settings.buffer_ratio = ratio;
        self.target(&cfg, &mut settings);
        settings
    }

    /// The agent owner's buffer: `resolveCompactBufferTokens` / `resolveCompactBufferRatio` over the
    /// config with the persisted default-telemetry buffers dropped.
    fn agent_buffer(&self, cfg: &Doc, boundary: Option<u64>) -> (u64, f64) {
        let mut effective = cfg.clone();
        if let Some(boundary) = boundary.filter(|b| *b > 0)
            && (self.is_legacy_default_telemetry(cfg, boundary) || self.is_persisted_zero_telemetry(cfg, boundary))
        {
            for key in ["bufferTokens", "buffer", "bufferRatio"] {
                effective.insert(key.into(), Value::Null);
            }
        }
        let tokens = positive_int(first_stated(&[effective.get("bufferTokens"), effective.get("buffer")]))
            .or_else(|| self.env_positive("MIXDOG_AGENT_COMPACT_BUFFER_TOKENS"))
            .unwrap_or(0);
        let ratio = buffer_ratio_candidate(
            &[effective.get("bufferPercent").cloned(), effective.get("bufferPct").cloned(), self.env_value("MIXDOG_AGENT_COMPACT_BUFFER_PERCENT")],
            &[effective.get("bufferRatio").cloned(), effective.get("bufferFraction").cloned(), self.env_value("MIXDOG_AGENT_COMPACT_BUFFER_RATIO")],
        );
        (tokens, ratio.unwrap_or(0.0))
    }

    /// The main session's buffer (`resolveMainBufferSetting`): config tokens, config ratio, then env.
    fn main_buffer(&self, cfg: &Doc) -> (u64, f64) {
        let first_positive = |values: &[Option<Value>]| values.iter().find_map(|v| positive_int(v.as_ref()));
        let c = |key: &str| cfg.get(key).cloned();
        if let Some(tokens) = first_positive(&[c("mainBufferTokens"), c("mainBuffer")]) {
            return (tokens, 0.0);
        }
        if let Some(ratio) = buffer_ratio_candidate(&[c("mainBufferPercent"), c("mainBufferPct")], &[c("mainBufferRatio"), c("mainBufferFraction")]) {
            return (0, ratio);
        }
        if let Some(tokens) = first_positive(&[self.env_value("MIXDOG_MAIN_COMPACT_BUFFER_TOKENS")]) {
            return (tokens, 0.0);
        }
        let ratio = buffer_ratio_candidate(
            &[self.env_value("MIXDOG_MAIN_COMPACT_BUFFER_PERCENT")],
            &[self.env_value("MIXDOG_MAIN_COMPACT_BUFFER_RATIO")],
        );
        (0, ratio.unwrap_or(0.0))
    }

    /// `resolveCompactTargetTokens`' inputs: the explicit tokens, the floor and the share.
    fn target(&self, cfg: &Doc, settings: &mut CompactSettings) {
        settings.target_tokens = positive_int(first_stated(&[cfg.get("targetTokens"), cfg.get("target")]))
            .or_else(|| self.env_positive("MIXDOG_AGENT_COMPACT_TARGET_TOKENS"))
            .or_else(|| self.env_positive("MIXDOG_COMPACT_TARGET_TOKENS"));
        settings.target_min_tokens = positive_int(first_stated(&[cfg.get("targetMinTokens"), cfg.get("minTargetTokens")]))
            .or_else(|| self.env_positive("MIXDOG_AGENT_COMPACT_TARGET_MIN_TOKENS"))
            .or_else(|| self.env_positive("MIXDOG_COMPACT_TARGET_MIN_TOKENS"));
        let env_percent = self.env_value("MIXDOG_AGENT_COMPACT_TARGET_PERCENT").or_else(|| self.env_value("MIXDOG_COMPACT_TARGET_PERCENT"));
        let raw = first_stated(&[
            cfg.get("targetPercent"),
            cfg.get("targetPct"),
            cfg.get("targetRatio"),
            cfg.get("targetFraction"),
            env_percent.as_ref(),
        ]);
        settings.target_ratio = raw.map(to_number).filter(|n| n.is_finite() && *n > 0.0);
    }

    fn baseline(&self, cfg: &Doc, boundary: u64) -> bool {
        if (self.env_positive("MIXDOG_AGENT_COMPACT_BUFFER_TOKENS")).is_some() {
            return false;
        }
        for name in ["MIXDOG_AGENT_COMPACT_BUFFER_PERCENT", "MIXDOG_AGENT_COMPACT_BUFFER_RATIO"] {
            let n = to_number_of(self.env_value(name).as_ref());
            if n.is_finite() && n > 0.0 {
                return false;
            }
        }
        for key in ["bufferPercent", "bufferPct", "bufferFraction"] {
            let n = to_number_of(cfg.get(key));
            if n.is_finite() && n > 0.0 {
                return false;
            }
        }
        boundary > 0
    }

    /// `isPersistedZeroBufferTelemetry`.
    fn is_persisted_zero_telemetry(&self, cfg: &Doc, boundary: u64) -> bool {
        if !self.baseline(cfg, boundary) {
            return false;
        }
        let ratio = to_number_of(cfg.get("bufferRatio"));
        if ratio.is_finite() && ratio > 0.0 {
            return false;
        }
        let explicit = to_number_of(first_stated(&[cfg.get("bufferTokens"), cfg.get("buffer")]));
        explicit.is_finite() && explicit == 0.0
    }

    /// `isLegacyDefaultBufferTelemetry`.
    fn is_legacy_default_telemetry(&self, cfg: &Doc, boundary: u64) -> bool {
        if !self.baseline(cfg, boundary) {
            return false;
        }
        let explicit = positive_int(first_stated(&[cfg.get("bufferTokens"), cfg.get("buffer")]));
        let ratio = to_number_of(cfg.get("bufferRatio"));
        let Some(explicit) = explicit else { return false };
        if !ratio.is_finite() || (ratio - LEGACY_DEFAULT_BUFFER_RATIO).abs() > 1e-9 {
            return false;
        }
        let expected = (boundary as f64 * LEGACY_DEFAULT_BUFFER_RATIO).floor() as u64;
        let cfg_boundary = positive_int(cfg.get("boundaryTokens"));
        let cfg_trigger = positive_int(cfg.get("triggerTokens")).unwrap_or(0);
        explicit == expected || (cfg_boundary == Some(boundary) && cfg_trigger > 0 && explicit == boundary.saturating_sub(cfg_trigger))
    }
}

#[async_trait::async_trait]
impl ConfigSeams for ConfigRunSeams {
    fn hidden_agent(&self, agent: Option<&str>) -> bool {
        self.agents.hidden_agent(agent)
    }

    fn synced_compaction(&self, header: &Header, install: bool) -> Option<Value> {
        if install && self.injected_config {
            return None;
        }
        super::compaction_follow::sync_change(header, &self.saved_compaction()).set.shift_remove("compaction")
    }

    fn settings_changes(&self, thread: &mixdog_core_api::ids::ThreadId) -> Option<mixdog_core_session::session::turn_ops::SettingsFeed> {
        self.settings.as_ref().map(|settings| settings.feed(thread))
    }

    fn route_config(&self, header: &Header) -> ThreadRoute {
        // `runtime.provider` / `runtime.model`: the session's route, else (no session yet: no model on the header) the configured Main
        // route `resolveRoute` falls to (`DEFAULT_PROVIDER` 'anthropic-oauth' and `DEFAULT_MODEL` '' when none is configured).
        let own = |key: &str| header.get(key).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let (provider, model) = match (own("model"), &self.main_route) {
            (Some(model), _) => (own("provider"), Some(model)),
            (None, Some(main)) => {
                let route = main();
                let text = |key: &str| route.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
                (Some(text("provider")), Some(text("model")))
            }
            (None, None) => (own("provider"), None),
        };
        // A pick held for the next turn (`pendingRoute`) is the runtime's route already (`getRoute()`).
        let held = |key: &str| header.get("pendingRoute").and_then(|pick| pick.get(key)).and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned);
        let (provider, model) = match held("model") {
            Some(model) => (held("provider").or(provider), Some(model)),
            None => (provider, model),
        };
        let route_provider = provider.clone();
        let route_model = model;
        let provider = provider.as_deref();
        // `normalizeSystemShellConfig(config.shell)`: the configured command, else `MIXDOG_SHELL`, else the platform's own.
        let command = self.config.get("shell.command").and_then(|command| command.as_str().map(|c| mixdog_js::js_trim(c).to_owned())).unwrap_or_default();
        let env_command = (self.env)("MIXDOG_SHELL").map(|c| mixdog_js::js_trim(&c).to_owned()).unwrap_or_default();
        let source = if !command.is_empty() {
            "config"
        } else if !env_command.is_empty() {
            "env"
        } else {
            "auto"
        };
        let effective = if command.is_empty() { env_command } else { command.clone() };
        // `webSearchRouteOrDefault(config.webSearchRoute)`; a saved route that does not normalize leaves the seeded default in place.
        let configured = self.config.get("webSearchRoute").unwrap_or(Value::Null);
        let web_search_route = mixdog_ai::service::routes::web_search_route_or_default(&[&configured]).ok();
        ThreadRoute {
            auto_clear: Some(Value::Object(mixdog_agent::compact::settings::get_auto_clear(&self.config.agent(), provider))),
            system_shell: Some(serde_json::json!({ "command": command, "effective": effective, "source": source })),
            web_search_route,
            provider: route_provider,
            model: route_model,
            ..Default::default()
        }
    }
    fn stall_cap_idle_seconds(&self, agent: Option<&str>) -> Option<i64> {
        mixdog_core_config::config::hidden_agents::hidden_agent_stall_cap_idle_seconds(agent?)
    }

    async fn first_response_timeout_ms(&self, agent: &str) -> Option<i64> {
        self.agents.first_response_timeout_ms(agent).await.ok().flatten()
    }

    fn run_settings(&self, _thread: &ThreadId, header: &Header) -> RunSettings {
        let agent_mode = session_mode_of(header) == "agent";
        let provider = header.get("provider").and_then(Value::as_str);
        RunSettings {
            hidden_agent: self.agents.hidden_agent(header.get("agent").and_then(Value::as_str)),
            agent_mode,
            limits: None,
            compact: Some(self.compact_settings(header, agent_mode)),
            escalated_max_output_tokens: None,
            read_body_required: matches!(provider, Some("cursor-oauth" | "cursor-api")),
            vision: None,
            effort: None,
            step_auto_effort: None,
            text_only: None,
            attachments: None,
            file_text: None,
            model_max_output_tokens: None,
        }
    }

    fn stored_instruction_files(&self) -> Option<Value> {
        self.config.stored_instruction_files()
    }

    fn response_language(&self) -> Option<(String, String)> {
        let whole = Value::Object((*self.config.full()).clone());
        let paths = LeadPaths { plugin_root: &self.plugin_root, data_dir: &self.data_dir, config: Some(&whole) };
        build_lead_language(&paths, &mixdog_js::default_locale_tag())
    }
}

/// `positiveInt(value)`: `Math.floor(Number(value))` when finite and at least 1.
fn positive_int(value: Option<&Value>) -> Option<u64> {
    let floored = to_number_of(value).floor();
    (floored.is_finite() && floored >= 1.0).then_some(floored as u64)
}

/// JavaScript's `a ?? b ?? c`: the first candidate that is present and not null.
fn first_stated<'a>(candidates: &[Option<&'a Value>]) -> Option<&'a Value> {
    candidates.iter().copied().flatten().find(|v| !v.is_null())
}

/// `resolveBufferRatioCandidate`: the first usable percent (a share of 100), else the first usable ratio.
fn buffer_ratio_candidate(percents: &[Option<Value>], ratios: &[Option<Value>]) -> Option<f64> {
    let usable = |raw: &Option<Value>| match raw {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) if text.is_empty() => None,
        Some(value) => Some(to_number(value)).filter(|n| n.is_finite() && *n >= 0.0),
    };
    if let Some(n) = percents.iter().find_map(usable) {
        return Some(MAX_BUFFER_INPUT_RATIO.min(n / 100.0));
    }
    ratios.iter().find_map(usable).map(|n| MAX_BUFFER_INPUT_RATIO.min(if n > 1.0 { n / 100.0 } else { n }))
}

/// `providerTokenCalibration(provider)`.
pub(crate) fn token_calibration(provider: Option<&Value>, env: &dyn Fn(&str) -> Option<String>) -> f64 {
    let provider = provider.filter(|p| !p.is_null()).map(mixdog_js::value_to_string).unwrap_or_default().to_lowercase();
    let from_env = |name: &str, default: f64| {
        env(name).map(|raw| string_to_number(&raw)).filter(|n| n.is_finite() && *n > 0.0).map_or(default, |n| n.clamp(0.25, 3.0))
    };
    if provider.starts_with("anthropic") {
        from_env("MIXDOG_TOKEN_CALIBRATION_ANTHROPIC", 1.4)
    } else if provider.starts_with("gemini") || provider.starts_with("google") {
        from_env("MIXDOG_TOKEN_CALIBRATION_GEMINI", 1.15)
    } else {
        from_env("MIXDOG_TOKEN_CALIBRATION_DEFAULT", 1.0)
    }
}
