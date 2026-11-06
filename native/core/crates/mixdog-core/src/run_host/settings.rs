//! A turn's `RunSettings`: the config-backed part (`ConfigSeams::run_settings`) merged with what the
//! route, the provider and the turn itself decide. One function, [`merge_settings`], so every field has
//! one origin (`compose-seams.md`, "RunSettings: origins").

use std::sync::Arc;

use mixdog_agent::attachments::AttachmentText;
use mixdog_agent::compact::tool_schema::{estimate_request_reserve_tokens, RequestTools};
use mixdog_agent::limits::TurnLimits;
use mixdog_agent::step_effort::StepAutoEffort;
use mixdog_core_api::domain::provider::{ProviderAdapter, ToolDefinition};
use mixdog_core_api::ids::ThreadId;
use mixdog_store::schema::record::Header;
use serde_json::{json, Value};

use super::assemble::RunSettings;
use super::hop_host::HopWiring;
use crate::tool_modules::value::auto_effort_base;

/// `HEARTBEAT_TURN_LIMITS` (`shared/routine-trigger.mjs:82`).
const HEARTBEAT_MAX_TOOL_CALLS: u64 = 8;
const HEARTBEAT_WRAP_UP_MS: i64 = 60_000;

/// `isHeartbeatSession(sessionId)` (`routine-trigger.mjs:98`): an in-process mark set when a heartbeat
/// session is created, not a stored field. Owner: whoever creates heartbeat sessions (WP-CHANNELS).
pub trait HeartbeatMarks: Send + Sync {
    fn is_heartbeat(&self, session_id: &str) -> bool;
}

impl HeartbeatMarks for mixdog_services::bots::HeartbeatSessions {
    fn is_heartbeat(&self, session_id: &str) -> bool {
        self.is_marked(session_id)
    }
}

/// What the route's provider declares it can produce in one reply.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct OutputCeilings {
    /// `provider.escalatedMaxTokens(model, opts, lastSendTools)`.
    pub escalated: Option<u32>,
    /// `opts.modelMaxOutputTokens`: the gateway's or the custom provider's per-model ceiling.
    pub model_max: Option<u32>,
}

/// Owner: WP-AI-SVC (provider adapter and catalog).
pub trait OutputCeilingSource: Send + Sync {
    fn ceilings(&self, provider: &str, model: &str, header: &Header) -> OutputCeilings;
}

/// The auto-effort settings (`ask-turn-auto-effort.mjs`). Owner: WP-CONFIG.
pub trait AutoEffortSource: Send + Sync {
    /// `autoEffortMode(config) === 'on'`: env `MIXDOG_AUTO_EFFORT`, else the builtin feature.
    fn mode_on(&self) -> bool;
    /// `autoEffortBaseSetting(config)`, the raw `autoEffortBase`.
    fn base_setting(&self) -> Option<Value>;
    /// `autoEffortStepsEnabled()`: env `MIXDOG_AUTO_EFFORT_STEPS` is not `off`.
    fn steps_enabled(&self) -> bool;
}

/// The sources of the fields the config does not hold.
pub struct SettingsSources {
    pub wiring: Arc<dyn HopWiring>,
    pub attachments: Arc<dyn AttachmentText>,
    pub heartbeats: Arc<dyn HeartbeatMarks>,
    pub ceilings: Arc<dyn OutputCeilingSource>,
    pub auto_effort: Arc<dyn AutoEffortSource>,
}

/// The turn the settings are for.
pub struct TurnFacts<'a> {
    pub thread: &'a ThreadId,
    pub header: &'a Header,
    pub provider: &'a Arc<dyn ProviderAdapter>,
    /// The session's stored rows before the turn's input (the effort configuration seed is read from them).
    pub prior: &'a [Value],
    /// The turn's prompt text, trimmed (`promptContentText(input.prompt)`).
    pub request: &'a str,
    /// True for a runtime-injected turn (`input.promptSource`).
    pub injected: bool,
    /// The tool definitions the request sends.
    pub tools: &'a [ToolDefinition],
    pub now_ms: i64,
}

fn text<'a>(header: &'a Header, key: &str) -> &'a str {
    header.get(key).and_then(Value::as_str).unwrap_or("")
}

/// `base` with the fields only the turn knows filled in.
pub fn merge_settings(mut base: RunSettings, sources: &SettingsSources, turn: &TurnFacts<'_>) -> RunSettings {
    let (provider, model) = (text(turn.header, "provider"), text(turn.header, "model"));
    // Effort and the text-only check: the route's wiring over the session row (header and stored messages).
    let mut updated = turn.header.clone();
    updated.insert("messages".into(), Value::Array(turn.prior.to_vec()));
    let (effort, text_only) = sources.wiring.wiring(&Value::Object(updated), turn.provider);
    base.effort = effort;
    base.text_only = text_only;

    // Step judging: auto effort is on for the turn, the route has an effort configuration, steps are enabled.
    // (The installed judge supporting steps is checked where the judge is built.)
    let auto = sources.auto_effort.mode_on()
        && !turn.injected
        && turn.header.get("autoEffort") != Some(&Value::Bool(false))
        && !turn.request.is_empty()
        && !turn.request.starts_with('<');
    base.step_auto_effort = (auto && base.effort.is_some() && sources.auto_effort.steps_enabled()).then(|| StepAutoEffort {
        request: turn.request.to_owned(),
        base: auto_effort_base(sources.auto_effort.base_setting().as_ref()).to_owned(),
    });

    let ceilings = sources.ceilings.ceilings(provider, model, turn.header);
    base.escalated_max_output_tokens = ceilings.escalated;
    base.model_max_output_tokens = ceilings.model_max;

    // Only the heartbeat marks a limit here; an explorer sets its own rounds.
    base.limits = if sources.heartbeats.is_heartbeat(turn.thread.as_str()) {
        Some(TurnLimits { max_tool_calls: Some(HEARTBEAT_MAX_TOOL_CALLS), wrap_up_at_ms: Some(turn.now_ms + HEARTBEAT_WRAP_UP_MS), max_tool_rounds: None })
    } else {
        base.limits
    };
    base.attachments = Some(sources.attachments.clone());

    // The request's reserve is what the tools sent cost (`estimateRequestReserveTokens`); no provider adds native tools.
    if let Some(compact) = base.compact.as_mut() {
        compact.request_reserve_tokens = estimate_request_reserve_tokens(&RequestTools { native: &[], defined: turn.tools });
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Wiring;
    impl HopWiring for Wiring {
        fn wiring(&self, updated: &Value, _: &Arc<dyn ProviderAdapter>) -> (Option<mixdog_agent::effort::EffortWiring>, Option<mixdog_agent::text_only::TextOnlyInput>) {
            assert_eq!(updated["messages"], json!([{ "role": "user" }]), "the stored rows ride the session row");
            (None, None)
        }
    }
    struct Marks(&'static str);
    impl HeartbeatMarks for Marks {
        fn is_heartbeat(&self, id: &str) -> bool {
            id == self.0
        }
    }
    struct Ceilings;
    impl OutputCeilingSource for Ceilings {
        fn ceilings(&self, provider: &str, model: &str, _: &Header) -> OutputCeilings {
            assert_eq!((provider, model), ("anthropic", "opus"));
            OutputCeilings { escalated: Some(64_000), model_max: Some(32_000) }
        }
    }
    struct Auto;
    impl AutoEffortSource for Auto {
        fn mode_on(&self) -> bool {
            true
        }
        fn base_setting(&self) -> Option<Value> {
            Some(json!(" HIGH "))
        }
        fn steps_enabled(&self) -> bool {
            true
        }
    }
    struct NoText;
    #[async_trait::async_trait]
    impl AttachmentText for NoText {
        async fn text_of(&self, _: &mixdog_core_api::domain::provider::ContentPart) -> Result<Option<String>, Box<mixdog_core_api::domain::provider::ProviderError>> {
            Ok(None)
        }
    }


    struct NullProvider {
        id: mixdog_protocol::ProviderId,
        codec: mixdog_core_api::domain::mock::MockCodec,
        policy: mixdog_core_api::domain::retry::RetryPolicy,
        keepalive: mixdog_core_api::domain::keepalive::KeepaliveSchedule,
    }
    impl NullProvider {
        fn new() -> Self {
            Self {
                id: mixdog_protocol::ProviderId::from("anthropic"),
                codec: mixdog_core_api::domain::mock::MockCodec,
                policy: mixdog_core_api::domain::retry::RetryPolicy::codex_default(),
                keepalive: mixdog_core_api::domain::keepalive::KeepaliveSchedule::SPEC,
            }
        }
    }
    #[async_trait::async_trait]
    impl ProviderAdapter for NullProvider {
        fn id(&self) -> &mixdog_protocol::ProviderId {
            &self.id
        }
        fn codec(&self) -> &dyn mixdog_core_api::domain::provider::WireCodec {
            &self.codec
        }
        fn retry_policy(&self) -> &mixdog_core_api::domain::retry::RetryPolicy {
            &self.policy
        }
        fn keepalive(&self) -> &mixdog_core_api::domain::keepalive::KeepaliveSchedule {
            &self.keepalive
        }
        async fn attempt(&self, _: Arc<mixdog_core_api::domain::provider::ModelRequest>) -> Result<Box<dyn mixdog_core_api::domain::provider::ModelStream>, mixdog_core_api::domain::provider::ProviderError> {
            unreachable!("the settings never send")
        }
    }
    fn base() -> RunSettings {
        RunSettings {
            hidden_agent: true,
            agent_mode: true,
            limits: None,
            compact: Some(mixdog_agent::boundary::CompactSettings::default()),
            escalated_max_output_tokens: None,
            read_body_required: true,
            effort: None,
            step_auto_effort: None,
            text_only: None,
            attachments: None,
            model_max_output_tokens: None,
        }
    }

    fn sources(heartbeat: &'static str) -> SettingsSources {
        SettingsSources { wiring: Arc::new(Wiring), attachments: Arc::new(NoText), heartbeats: Arc::new(Marks(heartbeat)), ceilings: Arc::new(Ceilings), auto_effort: Arc::new(Auto) }
    }

    #[test]
    fn the_config_fields_stay_and_the_turn_fields_are_filled() {
        let header: Header = json!({ "provider": "anthropic", "model": "opus" }).as_object().unwrap().clone();
        let thread = ThreadId::from("t1");
        let provider: Arc<dyn ProviderAdapter> = Arc::new(NullProvider::new());
        let prior = [json!({ "role": "user" })];
        let turn = |injected| TurnFacts { thread: &thread, header: &header, provider: &provider, prior: &prior, request: "fix it", injected, tools: &[], now_ms: 1_000 };

        let merged = merge_settings(base(), &sources("other"), &turn(false));
        assert!(merged.hidden_agent && merged.agent_mode && merged.read_body_required, "the config's fields are kept");
        assert_eq!((merged.escalated_max_output_tokens, merged.model_max_output_tokens), (Some(64_000), Some(32_000)));
        assert!(merged.attachments.is_some() && merged.limits.is_none());
        // No effort configuration on the route: no step judging, whatever the setting says.
        assert!(merged.step_auto_effort.is_none());

        let heartbeat = merge_settings(base(), &sources("t1"), &turn(false));
        assert_eq!(heartbeat.limits, Some(TurnLimits { max_tool_calls: Some(8), wrap_up_at_ms: Some(61_000), max_tool_rounds: None }));
    }

    /// `heartbeatTurnLimits` (`ask-turn-loop-options.mjs`): the limits ride the process mark, from marking to unmarking.
    #[test]
    fn the_real_marks_limit_only_a_marked_session_until_its_close_lands() {
        let header: Header = json!({ "provider": "anthropic", "model": "opus" }).as_object().unwrap().clone();
        let thread = ThreadId::from("t1");
        let provider: Arc<dyn ProviderAdapter> = Arc::new(NullProvider::new());
        let prior = [json!({ "role": "user" })];
        let turn = TurnFacts { thread: &thread, header: &header, provider: &provider, prior: &prior, request: "fix it", injected: false, tools: &[], now_ms: 5_000 };
        let marks = mixdog_services::bots::HeartbeatSessions::new();
        let sources = SettingsSources { heartbeats: marks.clone(), ..sources("") };

        assert!(merge_settings(base(), &sources, &turn).limits.is_none());
        marks.mark("t1");
        let limits = merge_settings(base(), &sources, &turn).limits;
        assert_eq!(limits, Some(TurnLimits { max_tool_calls: Some(8), wrap_up_at_ms: Some(65_000), max_tool_rounds: None }));
        marks.unmark("t1");
        assert!(merge_settings(base(), &sources, &turn).limits.is_none());
    }
}