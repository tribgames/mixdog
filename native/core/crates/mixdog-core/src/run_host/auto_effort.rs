//! Auto effort for a turn's first request (`session/manager/ask-turn-auto-effort.mjs`): the
//! [`AutoEffortSource`] over the config and the environment, and [`TurnAutoEffort`], Node's
//! `resolveTurnAutoEffort` (the judged effort of the first request, never the per-step judging that
//! `step_judge` does). The base is clamped to the model's ladder by `ladder::clamp_base`
//! (`clampAutoEffortBase`), the ladder itself is `ladder_facts`' options.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_js::{js_trim, utf16_len, value_to_string};
use mixdog_rt::{CancellationToken, DurabilityIo, LaneToken};
use mixdog_services::effort_judge::ladder::{clamp_base, ladder_of, resolve_auto_effort};
use mixdog_store::schema::record::Header;
use serde_json::{Map, Value, json};

use mixdog_core_config::config::Config;
use crate::run_host::run_seams::EnvReader;
use mixdog_core_run::run_host::route_wiring::CodexDeclared;
use mixdog_core_run::run_host::route_wiring::ProviderFacts;
use mixdog_core_run::run_host::route_wiring::TurnRoute;
use mixdog_core_run::run_host::route_wiring::WiringSource;
use mixdog_core_run::run_host::route_wiring::turn_effort_configuration_mode;
use crate::run_host::settings::AutoEffortSource;
use crate::run_host::step_judge::{LadderSources, ladder_facts};
use mixdog_core_session::session::effort_prewarm::auto_effort_mode;
use mixdog_core_config::tool_modules::value::auto_effort_base;

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

/// [`EffortConfiguration`] over the provider registry, with the facts a route wire reads (the same
/// ones `JudgePrewarm` is built with, so a prewarm and a turn agree).
pub struct RegistryConfiguration {
    registry: Arc<ProviderRegistry>,
    wiring: Arc<dyn WiringSource>,
    unsupported: Arc<UnsupportedEfforts>,
    codex_declared: Arc<CodexDeclared>,
}

impl RegistryConfiguration {
    pub fn new(registry: Arc<ProviderRegistry>, wiring: Arc<dyn WiringSource>, unsupported: Arc<UnsupportedEfforts>, codex_declared: Arc<CodexDeclared>) -> Self {
        Self { registry, wiring, unsupported, codex_declared }
    }
}

#[async_trait]
impl EffortConfiguration for RegistryConfiguration {
    async fn configured(&self, header: &Header) -> bool {
        let (provider, model) = (text(header, "provider"), text(header, "model"));
        let effort = header.get("effort").and_then(Value::as_str);
        let parameters = header.get("modelParameters").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
        // `getProvider(session.provider)`: none reads as a provider without config or row.
        let facts = match self.registry.get(provider).await {
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

/// [`EffortDiagnostics`] appending to `decisions.jsonl` as a durability-lane job, and warning on stderr.
pub struct EffortDecisionLog {
    env: EnvReader,
    plugin_data: PathBuf,
    lane: DurabilityIo,
    /// The appends still running, for the tests to await.
    #[cfg(test)]
    appends: Mutex<Vec<futures::future::BoxFuture<'static, ()>>>,
}

impl EffortDecisionLog {
    /// `plugin_data` is `resolvePluginData()` when `MIXDOG_DATA_DIR` is not set.
    pub fn new(env: EnvReader, plugin_data: PathBuf, lane: DurabilityIo) -> Self {
        Self {
            env,
            plugin_data,
            lane,
            #[cfg(test)]
            appends: Mutex::default(),
        }
    }

    /// Returns once every append recorded so far has landed.
    #[cfg(test)]
    async fn appended(&self) {
        let appends = std::mem::take(&mut *self.appends.lock().unwrap());
        mixdog_core_session::session::testing::awaiting(|| "every effort-decision append to land".to_owned(), futures::future::join_all(appends)).await;
    }

    /// `process.env.MIXDOG_EFFORT_DECISIONS_LOG || join(resolvePluginData(), 'effort-judge',
    /// 'decisions.jsonl')`, read at each append.
    fn destination(&self) -> PathBuf {
        let set = |name: &str| (self.env)(name).filter(|value| !value.is_empty());
        set("MIXDOG_EFFORT_DECISIONS_LOG").map_or_else(
            || set("MIXDOG_DATA_DIR").map_or_else(|| self.plugin_data.clone(), PathBuf::from).join("effort-judge").join("decisions.jsonl"),
            PathBuf::from,
        )
    }
}

impl EffortDiagnostics for EffortDecisionLog {
    fn record(&self, entry: Map<String, Value>) {
        let (path, line) = (self.destination(), format!("{}\n", Value::Object(entry)));
        // The log is diagnostic only: a failed append is dropped.
        let job = move |lane: &mixdog_rt::InLane<DurabilityIo>| {
            let _ = mixdog_statefile::append_file(lane, &path, line.as_bytes());
        };
        let submitted = self.lane.submit(&CancellationToken::new(), job);
        #[cfg(test)]
        if let Ok(append) = submitted {
            self.appends.lock().unwrap().push(Box::pin(async move {
                let _ = append.await;
            }));
        }
        #[cfg(not(test))]
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

    /// The judged effort of the turn's first request, or `None` when Auto effort does not apply
    /// (or the judge cannot answer in time, and the route's own effort stands).
    pub async fn resolve(&self, turn: &TurnAutoEffortInput<'_>) -> Option<AutoEffortDecision> {
        let mode = self.auto.mode();
        if mode == "off" || turn.injected || turn.header.get("autoEffort") == Some(&Value::Bool(false)) {
            return None;
        }
        let request = js_trim(turn.prompt);
        // Skill bodies and runtime blocks arrive as tagged text, not as a request.
        if request.is_empty() || request.starts_with('<') || !self.configuration.configured(turn.header).await {
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
                self.diagnostics.record(record);
                return None;
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
            applied: mode == "on" && found.effort != chosen,
            mode,
            request: request.to_owned(),
        })
    }
}

#[cfg(test)]
mod tests;
