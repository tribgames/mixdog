//! `prewarmSessionAutoEffort(session, provider)` (`ask-turn-auto-effort.mjs`): a session created
//! or opened on a route Auto effort can judge starts the judge's model load, so its first judged
//! turn does not wait on the cold load.

use std::sync::Arc;

use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::effort_configuration::UnsupportedEfforts;
use mixdog_core_api::ids::ThreadId;
use mixdog_services::effort_judge::judge::EffortJudgeModel;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;

use super::seams::EffortPrewarm;
use crate::run_host::route_wiring::CodexDeclared;
use crate::run_host::route_wiring::ProviderFacts;
use crate::run_host::route_wiring::TurnRoute;
use crate::run_host::route_wiring::WiringSource;
use crate::run_host::route_wiring::turn_effort_configuration_mode;

/// `AUTO_EFFORT_MODES`.
const AUTO_EFFORT_MODES: [&str; 3] = ["off", "observe", "on"];

/// `autoEffortMode(config)`: a set `MIXDOG_AUTO_EFFORT` (`normalizeAutoEffortMode`), else the
/// `autoEffort` builtin feature of the agent config.
pub fn auto_effort_mode(env_mode: Option<&str>, agent: &Map<String, Value>, feature_env: &dyn Fn(&str) -> Option<String>) -> &'static str {
    if let Some(raw) = env_mode.filter(|raw| !raw.is_empty()) {
        let mode = mixdog_js::js_trim(raw).to_lowercase();
        return AUTO_EFFORT_MODES.into_iter().find(|m| *m == mode).unwrap_or("off");
    }
    let onnx = mixdog_services::tool_state::onnx_runtime_supported();
    if crate::tool_modules::builtin_feature_active(agent, "autoEffort", feature_env, onnx) { "on" } else { "off" }
}

/// [`EffortPrewarm`] over the daemon's judge, config and provider registry.
pub struct JudgePrewarm {
    judge: Arc<EffortJudgeModel>,
    config: crate::config::Config,
    registry: Arc<ProviderRegistry>,
    wiring: Arc<dyn WiringSource>,
    unsupported: Arc<UnsupportedEfforts>,
    codex_declared: Arc<CodexDeclared>,
}

impl JudgePrewarm {
    /// `wiring`, `unsupported` and `codex_declared` are the ones the turn's `RouteWirer` reads, so
    /// a prewarm and a turn agree on what Auto effort can judge.
    pub fn new(
        judge: Arc<EffortJudgeModel>,
        config: crate::config::Config,
        registry: Arc<ProviderRegistry>,
        wiring: Arc<dyn WiringSource>,
        unsupported: Arc<UnsupportedEfforts>,
        codex_declared: Arc<CodexDeclared>,
    ) -> Self {
        Self { judge, config, registry, wiring, unsupported, codex_declared }
    }
}

impl EffortPrewarm for JudgePrewarm {
    fn prewarm(&self, _thread: &ThreadId, header: &Header) {
        let env = std::env::var("MIXDOG_AUTO_EFFORT").ok();
        let feature_env = |name: &str| std::env::var(name).ok();
        if auto_effort_mode(env.as_deref(), &self.config.agent(), &feature_env) == "off" || header.get("autoEffort") == Some(&Value::Bool(false)) {
            return;
        }
        let text = |key: &str| header.get(key).and_then(Value::as_str).unwrap_or_default().to_owned();
        let (provider, model, effort) = (text("provider"), text("model"), header.get("effort").and_then(Value::as_str).map(str::to_owned));
        let parameters = header.get("modelParameters").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let (judge, registry, wiring) = (self.judge.clone(), self.registry.clone(), self.wiring.clone());
        let (unsupported, codex_declared) = (self.unsupported.clone(), self.codex_declared.clone());
        drop(mixdog_rt::spawn("session-effort-prewarm", mixdog_rt::TaskClass::Work, async move {
            // `getProvider(session.provider)`: none reads as a provider without config or row.
            let facts = match registry.get(&provider).await {
                Some(adapter) => wiring.facts(&provider, &model, &adapter),
                None => ProviderFacts::plain(Value::Null),
            };
            let route = TurnRoute { provider: &provider, model: &model, effort: effort.as_deref(), model_parameters: &parameters, messages: &[] };
            if turn_effort_configuration_mode(&route, &facts, &unsupported, &*codex_declared).is_some() {
                judge.prewarm().await;
            }
        }));
    }
}
