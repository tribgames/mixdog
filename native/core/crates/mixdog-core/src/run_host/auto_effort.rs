//! Auto effort for a turn's first request (`session/manager/ask-turn-auto-effort.mjs`): the
//! [`AutoEffortSource`] over the config and the environment, and [`TurnAutoEffort`], Node's
//! `resolveTurnAutoEffort` (the judged effort of the first request, never the per-step judging that
//! `step_judge` does). The base is clamped to the model's ladder by `ladder::clamp_base`
//! (`clampAutoEffortBase`), the ladder itself is `ladder_facts`' options.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_ports::ports::route_facts::{RouteFacts, RouteSender};
use mixdog_js::{js_trim, utf16_len, value_to_string};
use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken, MaintenanceIo};
use mixdog_services::effort_judge::ladder::{clamp_base, ladder_of, resolve_auto_effort};
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use crate::run_host::run_seams::EnvReader;
use crate::run_host::settings::AutoEffortSource;
use crate::run_host::step_judge::{LadderSources, ladder_facts};
use mixdog_core_config::config::Config;
use mixdog_core_config::tool_modules::value::auto_effort_base;
use mixdog_core_run::run_host::route_wiring::CodexDeclared;
use mixdog_core_run::run_host::route_wiring::ProviderFacts;
use mixdog_core_run::run_host::route_wiring::TurnRoute;
use mixdog_core_run::run_host::route_wiring::WiringSource;
use mixdog_core_run::run_host::route_wiring::turn_effort_configuration_mode;
use mixdog_core_session::session::auto_effort_mode::auto_effort_mode;

/// The auto-effort settings over the saved agent config and the process environment.
pub struct ConfigAutoEffort {
    config: Config,
    env: EnvReader,
}

impl ConfigAutoEffort {
    pub fn new(config: Config, env: EnvReader) -> Self {
        Self { config, env }
    }

    /// `autoEffortMode(config)`: `off`, `observe` or `on`.
    pub fn mode(&self) -> &'static str {
        auto_effort_mode((self.env)("MIXDOG_AUTO_EFFORT").as_deref(), &self.config.agent(), &|name| (self.env)(name))
    }

    /// Effective Auto effort mode for one route:
    /// - Resolves explicit `effortAuto`, or runs the single legacy conversion on pre-update headers
    ///   (`legacy_switch_on && old autoEffort != false`).
    /// - A Manual route never runs the judge.
    /// - For an Auto route, explicit `MIXDOG_AUTO_EFFORT` env overrides (`off`, `observe`, `on`),
    ///   else runs when ONNX runtime is supported (the legacy switch is never re-checked for explicit `effortAuto: true`).
    pub fn route_mode(&self, header: &Header) -> &'static str {
        let legacy_switch_on = mixdog_ai::service::admin_route::config_default_auto_effort(&self.config.agent());
        if !mixdog_ai::effort::EffortAuto::resolve(header, legacy_switch_on).is_auto() {
            return "off";
        }
        if let Some(raw) = (self.env)("MIXDOG_AUTO_EFFORT").filter(|raw| !raw.is_empty()) {
            let mode = js_trim(&raw).to_lowercase();
            return match mode.as_str() {
                "on" => "on",
                "observe" => "observe",
                _ => "off",
            };
        }
        if !mixdog_services::tool_state::onnx_runtime_supported() {
            return "off";
        }
        "on"
    }

    /// `autoEffortBaseSetting(config)`: `low`, `medium` or `high`.
    pub fn base(&self) -> &'static str {
        auto_effort_base(self.config.agent().get("autoEffortBase"))
    }
}

impl AutoEffortSource for ConfigAutoEffort {
    fn mode_on(&self) -> bool {
        self.mode() == "on"
    }

    fn base_setting(&self) -> Option<Value> {
        self.config.agent().get("autoEffortBase").cloned()
    }

    fn steps_enabled(&self) -> bool {
        let raw = (self.env)("MIXDOG_AUTO_EFFORT_STEPS").unwrap_or_default();
        js_trim(&raw).to_lowercase() != "off"
    }
}

/// What the judge reads for a turn (`judgeTurn({ request, prev, prevRequest })`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnJudgeInput {
    pub request: String,
    /// The last non-empty assistant text of the session.
    pub prev: String,
    /// The last non-empty user text of the session.
    pub prev_request: String,
}

/// `judgeTurn`'s answer: the distribution over the four levels, or why the judge cannot answer.
#[derive(Clone, Debug, PartialEq)]
pub enum JudgeAnswer {
    Probs { probs: Vec<f64>, ms: u64 },
    Skipped(String),
}

/// The effort judge for a turn (`judgeTurn`). Owner: the effort-judge service (WP-SVC).
#[async_trait]
pub trait TurnJudge: Send + Sync {
    async fn judge(&self, input: TurnJudgeInput) -> JudgeAnswer;
}

/// `turnEffortConfigurationMode(session, provider)` is not none: the route can take a judged effort.
#[async_trait]
pub trait EffortConfiguration: Send + Sync {
    async fn configured(&self, header: &Header) -> bool;
}

/// [`EffortConfiguration`] over the route facts, with the facts a route wire reads.
pub struct RouteConfiguration {
    routes: Arc<dyn RouteFacts>,
    wiring: Arc<dyn WiringSource>,
    unsupported: Arc<UnsupportedEfforts>,
    codex_declared: Arc<CodexDeclared>,
}

impl RouteConfiguration {
    pub fn new(routes: Arc<dyn RouteFacts>, wiring: Arc<dyn WiringSource>, unsupported: Arc<UnsupportedEfforts>, codex_declared: Arc<CodexDeclared>) -> Self {
        Self { routes, wiring, unsupported, codex_declared }
    }
}

#[async_trait]
impl EffortConfiguration for RouteConfiguration {
    async fn configured(&self, header: &Header) -> bool {
        let (provider, model) = (text(header, "provider"), text(header, "model"));
        let effort = header.get("effort").and_then(Value::as_str);
        let parameters = header.get("modelParameters").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
        // `getProvider(session.provider)`: none, an agent's route included, reads as a provider without config or row.
        let facts = match self.routes.sender(None, provider).await.ok().flatten().and_then(RouteSender::adapter) {
            Some(adapter) => self.wiring.facts(provider, model, &adapter),
            None => ProviderFacts::plain(Value::Null),
        };
        let route = TurnRoute { provider, model, effort, model_parameters: &parameters, messages: &[] };
        turn_effort_configuration_mode(&route, &facts, &self.unsupported, &*self.codex_declared).is_some()
    }
}

/// Where the decision log (`recordEffortDecision`) and the empty-ladder warning go; both are
/// diagnostics only.
pub trait EffortDiagnostics: Send + Sync {
    fn record(&self, entry: Map<String, Value>);
    fn warn(&self, line: &str);
}

/// What a test awaits: how many appends, and rotations they started, are still running.
#[cfg(any(test, feature = "test-support"))]
type Pending = Arc<tokio::sync::watch::Sender<usize>>;

/// [`EffortDiagnostics`] writing the decision log (`recordEffortDecision`), and warning on stderr. A log
/// redirected by `MIXDOG_EFFORT_DECISIONS_LOG` is one plain file with every line; the data directory's
/// own log keeps its newest segments and counts older lines (`decision_log`). Appends are
/// durability-lane jobs, rotations maintenance-lane jobs.
pub struct EffortDecisionLog {
    env: EnvReader,
    plugin_data: PathBuf,
    lane: DurabilityIo,
    maintenance: MaintenanceIo,
    segment_bytes: u64,
    /// One entry per data-directory log file, as Node's `decisionLog(file)`.
    logs: Mutex<HashMap<PathBuf, Arc<decision_log::Segments>>>,
    #[cfg(any(test, feature = "test-support"))]
    pending: Pending,
}

/// One append or rotation that is running: counted from its submission until its lane job has run or been dropped.
#[cfg(any(test, feature = "test-support"))]
struct Running(Pending);

#[cfg(any(test, feature = "test-support"))]
impl Running {
    fn begin(pending: &Pending) -> Self {
        pending.send_modify(|running| *running += 1);
        Self(pending.clone())
    }
}

#[cfg(any(test, feature = "test-support"))]
impl Drop for Running {
    fn drop(&mut self) {
        self.0.send_modify(|running| *running -= 1);
    }
}

impl EffortDecisionLog {
    /// `plugin_data` is `resolvePluginData()` when `MIXDOG_DATA_DIR` is not set.
    pub fn new(env: EnvReader, plugin_data: PathBuf, lane: DurabilityIo, maintenance: MaintenanceIo) -> Self {
        Self {
            env,
            plugin_data,
            lane,
            maintenance,
            segment_bytes: decision_log::DECISION_SEGMENT_BYTES,
            logs: Mutex::default(),
            #[cfg(any(test, feature = "test-support"))]
            pending: Pending::default(),
        }
    }

    /// `process.env.MIXDOG_EFFORT_DECISIONS_LOG`, else the data directory's own log
    /// (`join(resolvePluginData(), 'effort-judge', 'decisions.jsonl')`), read at each append.
    fn destination(&self) -> Result<PathBuf, PathBuf> {
        let set = |name: &str| (self.env)(name).filter(|value| !value.is_empty());
        match set("MIXDOG_EFFORT_DECISIONS_LOG") {
            Some(redirected) => Ok(PathBuf::from(redirected)),
            None => Err(set("MIXDOG_DATA_DIR").map_or_else(|| self.plugin_data.clone(), PathBuf::from).join("effort-judge").join("decisions.jsonl")),
        }
    }

    fn segments(&self, file: PathBuf) -> Arc<decision_log::Segments> {
        let mut logs = self.logs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        logs.entry(file.clone()).or_insert_with(|| Arc::new(decision_log::Segments::new(file, self.segment_bytes))).clone()
    }
}

impl EffortDiagnostics for EffortDecisionLog {
    fn record(&self, entry: Map<String, Value>) {
        let line = format!("{}\n", Value::Object(entry));
        // The log is diagnostic only: a failed append, or a rotation the lane refuses, is dropped.
        // What a test awaits (`appended`) is a count of the jobs running, held by the jobs themselves: nothing is kept
        // for a build that never asks.
        #[cfg(any(test, feature = "test-support"))]
        let appending = Running::begin(&self.pending);
        let submitted = match self.destination() {
            Ok(redirected) => self.lane.submit(&CancellationToken::new(), move |lane: &mixdog_rt::InLane<DurabilityIo>| {
                #[cfg(any(test, feature = "test-support"))]
                let _appending = appending;
                let _ = mixdog_statefile::append_file(lane, &redirected, line.as_bytes());
            }),
            Err(own) => {
                let (segments, maintenance) = (self.segments(own), self.maintenance);
                #[cfg(any(test, feature = "test-support"))]
                let pending = self.pending.clone();
                self.lane.submit(&CancellationToken::new(), move |lane: &mixdog_rt::InLane<DurabilityIo>| {
                    #[cfg(any(test, feature = "test-support"))]
                    let _appending = appending;
                    if !segments.append(lane, &line) {
                        return;
                    }
                    let rotating = segments.clone();
                    #[cfg(any(test, feature = "test-support"))]
                    let rotation = Running::begin(&pending);
                    let submitted = maintenance.submit(&CancellationToken::new(), move |lane: &mixdog_rt::InLane<MaintenanceIo>| {
                        #[cfg(any(test, feature = "test-support"))]
                        let _rotation = rotation;
                        rotating.rotate(lane)
                    });
                    if submitted.is_err() {
                        segments.rotation_refused();
                    }
                })
            }
        };
        drop(submitted);
    }

    fn warn(&self, line: &str) {
        mixdog_rt::node_stderr!("{}", line.trim_end_matches('\n'));
    }
}

/// The turn Auto effort is resolved for.
pub struct TurnAutoEffortInput<'a> {
    pub session_id: &'a str,
    /// The session row: `provider`, `model`, `effort`, `autoEffort`, `modelParameters`.
    pub header: &'a Header,
    /// `session.messages`.
    pub messages: &'a [Value],
    /// `promptContentText(input.prompt)`, not trimmed.
    pub prompt: &'a str,
    /// `input.promptSource`: a runtime-injected turn.
    pub injected: bool,
    /// `promptContentText` of one message's `content`.
    pub content_text: &'a (dyn Fn(&Value) -> String + Sync),
}

/// `{ base, effort, step, level, confidence, applied, mode, request }`.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoEffortDecision {
    pub base: &'static str,
    pub effort: &'static str,
    pub step: i32,
    pub level: Option<usize>,
    pub confidence: f64,
    pub applied: bool,
    pub mode: &'static str,
    pub request: String,
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `String(session.effort || '').toLowerCase()`.
fn chosen_effort(header: &Header) -> String {
    let truthy = match header.get("effort") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(text)) => !text.is_empty(),
        Some(_) => true,
    };
    header.get("effort").filter(|_| truthy).map(value_to_string).unwrap_or_default().to_lowercase()
}

/// `lastText(messages, role)`.
fn last_text(messages: &[Value], role: &str, content_text: &dyn Fn(&Value) -> String) -> String {
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some(role) {
            continue;
        }
        let text = js_trim(&content_text(message.get("content").unwrap_or(&Value::Null))).to_owned();
        if !text.is_empty() {
            return text;
        }
    }
    String::new()
}

fn is_tagged_runtime_block(request: &str) -> bool {
    ["<system-reminder>", "<task-notification>", "<mixdog-runtime>", "<skill", "<command-name>"].iter().any(|prefix| request.starts_with(prefix))
}

/// The session's last Auto-judged effort level on the same provider/model, read from prior turns'
/// `meta.effortConfiguration` stamps marked `judged: true` and checked against the model's supported
/// effort options. Manual turns are never reused as an Auto fallback.
fn last_judged_effort(messages: &[Value], provider: &str, model: &str, options: &[String]) -> Option<&'static str> {
    let want_model = mixdog_agent::effort::model_key(model);
    for message in messages.iter().rev() {
        let Some(cfg) = message.pointer("/meta/effortConfiguration").and_then(Value::as_object) else {
            continue;
        };
        if cfg.get("judged") != Some(&Value::Bool(true)) {
            continue;
        }
        if cfg.get("provider").and_then(Value::as_str) != Some(provider) {
            continue;
        }
        let stamped_model = cfg.get("model").and_then(Value::as_str).map(mixdog_agent::effort::model_key).unwrap_or_default();
        if stamped_model != want_model {
            continue;
        }
        let Some(raw) = cfg.get("effort").and_then(Value::as_str) else {
            continue;
        };
        let normalized = mixdog_js::js_trim(raw).to_lowercase();
        let Some(level) = mixdog_ai::effort::ALL_EFFORT_LEVELS.into_iter().find(|candidate| *candidate == normalized) else {
            continue;
        };
        if options.is_empty() || options.iter().any(|opt| mixdog_js::js_trim(opt).eq_ignore_ascii_case(level)) {
            return Some(level);
        }
    }
    None
}

/// `Number(value.toFixed(3))`.
fn fixed3(value: f64) -> f64 {
    mixdog_js::math::to_fixed(value, 3).parse().unwrap_or(f64::NAN)
}

/// `resolveTurnAutoEffort`.
pub struct TurnAutoEffort {
    auto: Arc<ConfigAutoEffort>,
    judge: Arc<dyn TurnJudge>,
    ladders: Arc<dyn LadderSources>,
    configuration: Arc<dyn EffortConfiguration>,
    diagnostics: Arc<dyn EffortDiagnostics>,
    /// `new Date().toISOString()`.
    now: Arc<dyn Fn() -> String + Send + Sync>,
    /// `warnedEmptyLadders`: one warning per provider/model per process.
    warned: Mutex<HashSet<String>>,
}

impl TurnAutoEffort {
    pub fn new(
        auto: Arc<ConfigAutoEffort>,
        judge: Arc<dyn TurnJudge>,
        ladders: Arc<dyn LadderSources>,
        configuration: Arc<dyn EffortConfiguration>,
        diagnostics: Arc<dyn EffortDiagnostics>,
        now: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        Self { auto, judge, ladders, configuration, diagnostics, now, warned: Mutex::new(HashSet::new()) }
    }

    /// Only a real, unsent turn asks the judge. Observe mode and any skipped
    /// judgment leave both the request's saved effort and its history seed alone.
    /// Returns `(effort, judged)` where `judged` is true only when the judge model answered.
    pub(super) async fn first_request_effort(
        &self,
        session_id: &str,
        header: &Header,
        messages: &[Value],
        prompt: &str,
        injected: bool,
        cancel: &CancellationToken,
    ) -> Option<(&'static str, bool)> {
        let content_text = |content: &Value| mixdog_core_session::session::idle_auto_clear::prompt_content_text(content, &|_| None);
        let input = TurnAutoEffortInput { session_id, header, messages, prompt, injected, content_text: &content_text };
        tokio::select! {
            biased;
            () = cancel.cancelled() => None,
            decision = self.resolve(&input) => decision
                .filter(|decision| decision.applied && decision.mode == "on")
                .map(|decision| (decision.effort, decision.level.is_some())),
        }
    }

    /// `warnEmptyAutoEffortLadder(provider, model, base)`.
    fn warn_empty_ladder(&self, provider: &str, model: &str, base: &str) {
        if base == "max" || base == "ultra" {
            return;
        }
        let key = format!("{provider}/{model}");
        let first = self.warned.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key.clone());
        if first {
            self.diagnostics.warn(&format!("[auto-effort] no effort ladder for {key}; judge skipped\n"));
        }
    }

    /// The judged effort of the turn's first request, or `None` when Auto effort does not apply.
    /// When the judge is not installed (`model-missing`), returns `None` so the route's own effort
    /// runs unchanged. When a late judge skips for another reason, falls back to the session's last
    /// Auto-judged level, and without one returns `None` as well.
    pub async fn resolve(&self, turn: &TurnAutoEffortInput<'_>) -> Option<AutoEffortDecision> {
        let mode = self.auto.route_mode(turn.header);
        if mode == "off" || turn.injected {
            return None;
        }
        let request = js_trim(turn.prompt);
        if request.is_empty() || is_tagged_runtime_block(request) || !self.configuration.configured(turn.header).await {
            return None;
        }
        let (provider, model) = (text(turn.header, "provider"), text(turn.header, "model"));
        let chosen = chosen_effort(turn.header);
        let options = ladder_facts(&*self.ladders, provider, model).await.options;
        let setting = self.auto.base();
        let base = clamp_base(setting, &options).unwrap_or(setting);
        let mut record = Map::new();
        record.insert("at".into(), json!((self.now)()));
        record.insert("sessionId".into(), json!(turn.session_id));
        record.insert("provider".into(), json!(provider));
        record.insert("model".into(), json!(model));
        record.insert("mode".into(), json!(mode));
        record.insert("chosen".into(), json!(chosen));
        record.insert("base".into(), json!(base));
        record.insert("requestChars".into(), json!(utf16_len(request)));
        // No judged outcome can apply when the base is off the model's ladder.
        if !ladder_of(&options).contains(&base) {
            record.insert("skipped".into(), json!("default-outside-auto-range"));
            self.diagnostics.record(record);
            self.warn_empty_ladder(provider, model, base);
            return None;
        }
        let input = TurnJudgeInput {
            request: request.to_owned(),
            prev: last_text(turn.messages, "assistant", turn.content_text),
            prev_request: last_text(turn.messages, "user", turn.content_text),
        };
        let (probs, ms) = match self.judge.judge(input).await {
            JudgeAnswer::Probs { probs, ms } => (probs, ms),
            JudgeAnswer::Skipped(why) => {
                record.insert("skipped".into(), json!(why));
                // Without a judged level to reuse, the turn runs at the route's stored level.
                let fallback = (why != "model-missing").then(|| last_judged_effort(turn.messages, provider, model, &options)).flatten();
                let Some(fallback) = fallback else {
                    self.diagnostics.record(record);
                    return None;
                };
                record.insert("fallback".into(), json!(fallback));
                record.insert("effort".into(), json!(fallback));
                self.diagnostics.record(record);
                return Some(AutoEffortDecision {
                    base,
                    effort: fallback,
                    step: 0,
                    level: None,
                    confidence: 0.0,
                    applied: mode == "on",
                    mode,
                    request: request.to_owned(),
                });
            }
        };
        let resolved = resolve_auto_effort(base, &options, &probs);
        match &resolved {
            Some(found) => {
                record.insert("base".into(), json!(found.base));
                record.insert("effort".into(), json!(found.effort));
                record.insert("step".into(), json!(found.step));
                record.insert("level".into(), json!(found.level));
                record.insert("confidence".into(), mixdog_js::json_number(fixed3(found.confidence)));
            }
            None => {
                record.insert("skipped".into(), json!("default-outside-auto-range"));
            }
        }
        record.insert("ms".into(), json!(ms));
        record.insert("probs".into(), Value::Array(probs.iter().map(|p| mixdog_js::json_number(fixed3(*p))).collect()));
        self.diagnostics.record(record);
        let found = resolved?;
        Some(AutoEffortDecision {
            base: found.base,
            effort: found.effort,
            step: found.step,
            level: found.level,
            confidence: fixed3(found.confidence),
            applied: mode == "on",
            mode,
            request: request.to_owned(),
        })
    }
}

mod decision_log;

#[cfg(test)]
mod route_configuration_tests {
    use mixdog_agent::text_only::MediaText;
    use mixdog_ai::registry::providers::{ProviderBuilder, ProviderRegistry};
    use mixdog_core_api::domain::provider::ProviderAdapter;
    use mixdog_core_run::run_host::route_wiring::LocalEntry;

    use super::*;

    /// A registry builder that records every provider name it is asked about, and builds nothing.
    #[derive(Default)]
    struct Asked(Mutex<Vec<String>>);

    #[async_trait]
    impl ProviderBuilder for Asked {
        async fn build(&self, name: &str, _: &Value) -> Result<Arc<dyn ProviderAdapter>, String> {
            self.0.lock().unwrap().push(name.to_owned());
            Err("nothing is built here".into())
        }
        async fn custom_key_ids(&self, _: &str) -> Result<Vec<String>, String> {
            Ok(Vec::new())
        }
        fn available(&self, name: &str) -> bool {
            self.0.lock().unwrap().push(name.to_owned());
            true
        }
        async fn oauth_credentials_usable(&self, name: &str) -> Result<bool, String> {
            self.0.lock().unwrap().push(name.to_owned());
            Ok(false)
        }
    }

    /// A route with no provider of the loop is wired from nothing.
    struct Unwired;

    impl WiringSource for Unwired {
        fn facts(&self, _: &str, _: &str, _: &Arc<dyn ProviderAdapter>) -> ProviderFacts {
            unreachable!("an agent's route has no provider to read facts off")
        }
        fn local_entry(&self, _: &str) -> Option<LocalEntry> {
            None
        }
        fn runtime_tools(&self, _: &str) -> Option<bool> {
            None
        }
        fn media(&self, _: &Value) -> Arc<dyn MediaText> {
            unreachable!("the effort configuration reads no media")
        }
    }

    /// Auto effort on a header whose route an agent outside the loop serves is answered by the route facts: the route
    /// has no provider a judged effort could be wired to, and the registry is asked nothing under the agent's name.
    #[tokio::test]
    async fn an_agents_route_takes_no_judged_effort_and_asks_the_registry_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let builder = Arc::new(Asked::default());
        let registry = Arc::new(ProviderRegistry::new(builder.clone()));
        let facts = crate::run_host::compaction_world::tests::facts_in(dir.path(), registry).await;
        let codex_declared: Arc<CodexDeclared> = Arc::new(|_: &str| None::<bool>);
        let configuration = RouteConfiguration::new(facts, Arc::new(Unwired), Arc::default(), codex_declared);
        let header = json!({ "provider": "acp-agent", "model": "m", "effort": "high" }).as_object().cloned().unwrap();
        assert!(!configuration.configured(&header).await);
        assert!(builder.0.lock().unwrap().is_empty(), "the registry was asked about {:?}", builder.0.lock().unwrap());
    }
}

#[cfg(test)]
mod turn_auto_effort_tests {
    use super::*;
    use mixdog_ai::effort::EffortAuto;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct StubJudge {
        answer: JudgeAnswer,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl TurnJudge for StubJudge {
        async fn judge(&self, _: TurnJudgeInput) -> JudgeAnswer {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.answer.clone()
        }
    }

    struct StubRoute;

    #[async_trait]
    impl EffortConfiguration for StubRoute {
        async fn configured(&self, _: &Header) -> bool {
            true
        }
    }

    #[async_trait]
    impl LadderSources for StubRoute {
        fn cached_row(&self, _: &str, _: &str) -> Option<Map<String, Value>> {
            json!({ "reasoningLevels": ["low", "medium", "high"] }).as_object().cloned()
        }
        async fn rejected(&self, _: &str, _: &str) -> Option<mixdog_ai::effort::RejectionEntry> {
            None
        }
        fn custom_config(&self, _: &str) -> Option<(mixdog_ai::providers::custom::Protocol, String)> {
            None
        }
        fn anthropic_levels(&self, _: &str) -> Vec<String> {
            Vec::new()
        }
    }

    #[derive(Default)]
    struct StubDiagnostics(Mutex<Vec<Map<String, Value>>>);

    impl EffortDiagnostics for StubDiagnostics {
        fn record(&self, entry: Map<String, Value>) {
            self.0.lock().unwrap().push(entry);
        }
        fn warn(&self, _: &str) {}
    }

    async fn harness(agent_config: Value, answer: JudgeAnswer) -> (TurnAutoEffort, Arc<StubJudge>, Arc<StubDiagnostics>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        std::fs::write(&path, serde_json::to_string(&json!({ "agent": agent_config })).unwrap()).unwrap();
        let tokens = mixdog_rt::testing::tokens();
        let (cfg, _) = Config::open(
            path,
            Arc::new(mixdog_core_api::mock::MockStatePublisher::default()),
            mixdog_core_config::config::ConfigLanes { read: tokens.interactive_io, write: tokens.durability_io },
        )
        .await
        .unwrap();
        let judge = Arc::new(StubJudge { answer, calls: AtomicUsize::new(0) });
        let diagnostics = Arc::new(StubDiagnostics::default());
        let auto = TurnAutoEffort::new(
            Arc::new(ConfigAutoEffort::new(cfg, Arc::new(|_| None))),
            judge.clone(),
            Arc::new(StubRoute),
            Arc::new(StubRoute),
            diagnostics.clone(),
            Arc::new(|| "2026-01-01T00:00:00Z".to_owned()),
        );
        (auto, judge, diagnostics)
    }

    #[tokio::test]
    async fn explicit_route_effort_is_never_replaced_by_judge() {
        let (auto, judge, _) = harness(json!({}), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 5 }).await;
        let header = json!({ "provider": "openai", "model": "gpt-5", "effort": "low", "effortAuto": false }).as_object().cloned().unwrap();
        let input =
            TurnAutoEffortInput { session_id: "s1", header: &header, messages: &[], prompt: "hard problem", injected: false, content_text: &|_| String::new() };
        assert!(auto.resolve(&input).await.is_none());
        assert_eq!(judge.calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn explicit_auto_runs_when_legacy_switch_is_off_and_unconverted_converts_with_switch() {
        let (auto_off, judge_off, _) =
            harness(json!({ "modules": { "autoEffort": { "enabled": false } } }), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 5 }).await;
        // Pre-update session without effortAuto converts with legacy switch OFF -> Manual.
        let unpicked = json!({ "provider": "openai", "model": "gpt-5", "effort": "low" }).as_object().cloned().unwrap();
        let input = TurnAutoEffortInput {
            session_id: "s1",
            header: &unpicked,
            messages: &[],
            prompt: "hard problem",
            injected: false,
            content_text: &|_| String::new(),
        };
        assert!(auto_off.resolve(&input).await.is_none());
        assert_eq!(judge_off.calls.load(Ordering::SeqCst), 0);

        // Session with explicit effortAuto: true runs regardless of the legacy switch.
        let picked_auto = json!({ "provider": "openai", "model": "gpt-5", "effort": "low", "effortAuto": true }).as_object().cloned().unwrap();
        let input = TurnAutoEffortInput {
            session_id: "s1",
            header: &picked_auto,
            messages: &[],
            prompt: "hard problem",
            injected: false,
            content_text: &|_| String::new(),
        };
        let decision = auto_off.resolve(&input).await.expect("explicit Auto runs with switch off");
        assert_eq!((decision.effort, decision.applied), ("high", true));
        assert_eq!(judge_off.calls.load(Ordering::SeqCst), 1);

        // User who had the legacy switch ON converts pre-update unpicked session to Auto.
        let (auto_on, _, _) =
            harness(json!({ "modules": { "autoEffort": { "enabled": true } } }), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 5 }).await;
        let input = TurnAutoEffortInput {
            session_id: "s2",
            header: &unpicked,
            messages: &[],
            prompt: "hard problem",
            injected: false,
            content_text: &|_| String::new(),
        };
        let decision = auto_on.resolve(&input).await.expect("legacy switch on converts unpicked session to Auto");
        assert_eq!((decision.effort, decision.applied), ("high", true));
    }

    #[tokio::test]
    async fn late_judge_falls_back_only_to_last_judged_turn_never_manual_turns_or_when_model_missing() {
        let (auto, _, diagnostics) = harness(json!({}), JudgeAnswer::Skipped("timeout".into())).await;
        for (model, stamped) in [("gpt-5.5", "gpt-5-5"), ("claude-sonnet-4.5-20250929", "claude-sonnet-4-5")] {
            let header = json!({ "provider": "openai", "model": model, "effort": "low", "effortAuto": true }).as_object().cloned().unwrap();
            let prior = [
                json!({
                    "role": "user",
                    "content": "earlier judged task",
                    "meta": { "effortConfiguration": { "provider": "openai", "model": stamped, "mode": "responses", "initialEffort": "high", "effort": "high", "judged": true } }
                }),
                json!({ "role": "assistant", "content": "done" }),
                // A newer manual turn (no `judged: true`) must NOT override the last judged level.
                json!({
                    "role": "user",
                    "content": "manual turn",
                    "meta": { "effortConfiguration": { "provider": "openai", "model": stamped, "mode": "responses", "initialEffort": "low", "effort": "low" } }
                }),
                json!({ "role": "assistant", "content": "done" }),
            ];
            let input = TurnAutoEffortInput {
                session_id: "s1",
                header: &header,
                messages: &prior,
                prompt: "follow up",
                injected: false,
                content_text: &|_| String::new(),
            };
            let decision = auto.resolve(&input).await.expect("timeout falls back to last judged level");
            assert_eq!((decision.effort, decision.applied), ("high", true), "{model} matches {stamped}");
            assert!(decision.level.is_none(), "fallback is not stamped as freshly judged");
        }
        assert_eq!(diagnostics.0.lock().unwrap()[0]["fallback"], json!("high"));
        assert_eq!(diagnostics.0.lock().unwrap()[1]["fallback"], json!("high"));

        // No judged turn yet (a session from before the update): the stored level runs, not the base.
        let header = json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "effortAuto": true }).as_object().cloned().unwrap();
        let input =
            TurnAutoEffortInput { session_id: "s1", header: &header, messages: &[], prompt: "first turn", injected: false, content_text: &|_| String::new() };
        assert!(auto.resolve(&input).await.is_none());

        // When the judge is NOT installed (`model-missing`), TurnAutoEffort returns None directly
        // so the stored/configured effort runs rather than replaying an earlier turn's level.
        let (missing_judge, _, _) = harness(json!({}), JudgeAnswer::Skipped("model-missing".into())).await;
        let header = json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "effortAuto": true }).as_object().cloned().unwrap();
        let prior = [json!({
            "role": "user",
            "content": "earlier turn",
            "meta": { "effortConfiguration": { "provider": "openai", "model": "gpt-5", "mode": "responses", "initialEffort": "low", "effort": "low", "judged": true } }
        })];
        let input =
            TurnAutoEffortInput { session_id: "s1", header: &header, messages: &prior, prompt: "next", injected: false, content_text: &|_| String::new() };
        assert!(missing_judge.resolve(&input).await.is_none(), "missing judge returns None so route's stored level runs");
    }

    #[tokio::test]
    async fn subagent_brief_starting_with_angle_bracket_is_judged_while_runtime_blocks_skip() {
        let (auto, judge, _) = harness(json!({}), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 3 }).await;
        let header = json!({ "provider": "openai", "model": "gpt-5", "effortAuto": true }).as_object().cloned().unwrap();
        let brief = TurnAutoEffortInput {
            session_id: "s1",
            header: &header,
            messages: &[],
            prompt: "<brief>Refactor the parser</brief>",
            injected: false,
            content_text: &|_| String::new(),
        };
        assert_eq!(auto.resolve(&brief).await.map(|d| d.effort), Some("high"));

        let runtime = TurnAutoEffortInput {
            session_id: "s1",
            header: &header,
            messages: &[],
            prompt: "<task-notification>done</task-notification>",
            injected: false,
            content_text: &|_| String::new(),
        };
        assert!(auto.resolve(&runtime).await.is_none());
        assert_eq!(judge.calls.load(Ordering::SeqCst), 1);
    }

    fn load_v150_fixture_header() -> serde_json::Map<String, Value> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../mixdog-store/fixtures/dev-1.5.0-04b0508714/sess_24468_1795314060915_1795314060915_0c98a09bb8f446c28fe31940371d0292/log.000000");
        let raw = std::fs::read_to_string(&path).expect("read 1.5.0 fixture");
        for line in raw.lines().rev() {
            if let Some(idx) = line.find('{') {
                if let Ok(val) = serde_json::from_str::<Value>(&line[idx..]) {
                    if val.get("k") == Some(&json!("checkpoint")) {
                        let header = val["state"]["inline"]["header"].as_object().expect("checkpoint header").clone();
                        assert!(header.get("effortAuto").is_none() && header.get("autoEffort").is_none());
                        return header;
                    }
                }
            }
        }
        panic!("1.5.0 fixture checkpoint not found");
    }

    #[tokio::test]
    async fn update_regression_v150_fixture_and_legacy_hidden_header_across_three_user_states() {
        let v150_header = load_v150_fixture_header();
        // Old hidden-session header written by pre-update heartbeat_host.rs (`autoEffort: route != false`).
        let legacy_hidden: serde_json::Map<String, Value> =
            json!({ "provider": "openai", "model": "gpt-5", "effort": "high", "autoEffort": true }).as_object().cloned().unwrap();

        // 1. Switch-ON user: both the 1.5.0 fixture header and the legacy hidden header convert to Auto and get judged.
        let (auto_on, judge_on, _) =
            harness(json!({ "modules": { "autoEffort": { "enabled": true } } }), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 5 }).await;
        for (label, mut header) in [("v1.5.0 fixture", v150_header.clone()), ("legacy hidden header", legacy_hidden.clone())] {
            header.insert("provider".into(), json!("openai"));
            header.insert("model".into(), json!("gpt-5"));
            assert_eq!(EffortAuto::convert_on_load(&mut header, true), EffortAuto::Auto, "switch-on converts {label} to Auto");
            assert!(header.get("autoEffort").is_none());
            assert_eq!(header.get("effortAuto"), Some(&json!(true)));
            let input = TurnAutoEffortInput {
                session_id: "s-on",
                header: &header,
                messages: &[],
                prompt: "solve this",
                injected: false,
                content_text: &|_| String::new(),
            };
            let decision = auto_on.resolve(&input).await.expect("switch-on user is judged");
            assert_eq!((decision.effort, decision.applied), ("high", true), "{label}");
        }
        assert_eq!(judge_on.calls.load(Ordering::SeqCst), 2);

        // 2. Switch-OFF user: NEITHER the 1.5.0 fixture header NOR legacy `autoEffort: true` gets judged!
        let (auto_off, judge_off, _) =
            harness(json!({ "modules": { "autoEffort": { "enabled": false } } }), JudgeAnswer::Probs { probs: vec![0.0, 0.0, 1.0, 0.0], ms: 5 }).await;
        for (label, mut header) in [("v1.5.0 fixture", v150_header.clone()), ("legacy hidden header", legacy_hidden.clone())] {
            header.insert("provider".into(), json!("openai"));
            header.insert("model".into(), json!("gpt-5"));
            // Even before explicit convert_on_load, TurnAutoEffort resolves legacy data via the switch.
            let raw_input = TurnAutoEffortInput {
                session_id: "s-off",
                header: &header,
                messages: &[],
                prompt: "solve this",
                injected: false,
                content_text: &|_| String::new(),
            };
            assert!(auto_off.resolve(&raw_input).await.is_none(), "switch-off never judges raw {label}");
            assert_eq!(EffortAuto::convert_on_load(&mut header, false), EffortAuto::Manual, "switch-off converts {label} to Manual");
            assert!(header.get("autoEffort").is_none());
            assert_eq!(header.get("effortAuto"), Some(&json!(false)));
            let converted_input = TurnAutoEffortInput {
                session_id: "s-off",
                header: &header,
                messages: &[],
                prompt: "solve this",
                injected: false,
                content_text: &|_| String::new(),
            };
            assert!(auto_off.resolve(&converted_input).await.is_none(), "switch-off never judges converted {label}");
            let status = crate::run_host::tool_pool::session_control::status("s-off", &header, false, false, Value::Null, false);
            assert_eq!(status["effortAuto"], json!(false), "session status reports Auto off for {label}");
        }
        assert_eq!(judge_off.calls.load(Ordering::SeqCst), 0);
        // Also verify session status on raw unconverted headers with switch OFF reports false.
        assert_eq!(crate::run_host::tool_pool::session_control::status("s-raw", &v150_header, false, false, Value::Null, false)["effortAuto"], json!(false));
        assert_eq!(
            crate::run_host::tool_pool::session_control::status("s-raw-h", &legacy_hidden, false, false, Value::Null, false)["effortAuto"],
            json!(false)
        );

        // 3. Judge-NOT-installed user (switch ON, judge returns model-missing): stored level runs, prior manual level is NOT replayed.
        let (no_judge, _, _) = harness(json!({ "modules": { "autoEffort": { "enabled": true } } }), JudgeAnswer::Skipped("model-missing".into())).await;
        let prior_manual = [json!({
            "role": "user",
            "content": "prior manual turn",
            "meta": { "effortConfiguration": { "provider": "openai", "model": "gpt-5", "mode": "responses", "initialEffort": "low", "effort": "low" } }
        })];
        for (label, mut header) in [("v1.5.0 fixture", v150_header), ("legacy hidden header", legacy_hidden)] {
            header.insert("provider".into(), json!("openai"));
            header.insert("model".into(), json!("gpt-5"));
            header.insert("effort".into(), json!("high"));
            EffortAuto::convert_on_load(&mut header, true);
            let input = TurnAutoEffortInput {
                session_id: "s-no-judge",
                header: &header,
                messages: &prior_manual,
                prompt: "solve this",
                injected: false,
                content_text: &|_| String::new(),
            };
            assert!(no_judge.resolve(&input).await.is_none(), "uninstalled judge leaves stored effort in force for {label}");
        }
    }
}
