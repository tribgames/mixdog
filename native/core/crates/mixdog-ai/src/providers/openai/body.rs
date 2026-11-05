//! The first-party Responses request body: the OpenAI profile (route and
//! catalog facts resolved per request) fed to the neutral builder in
//! [`super::profile`].

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;

use super::config::Capabilities;
use super::config::ModelFacts;
use super::config::OpenAiConfig;
use super::config::PromptCacheLifetime;
use super::config::REPLAY_OWNER;
use super::config::Route;
use super::effort::EffortProjection;
use super::continuation::ContinuationSpec;
use super::input::LowerOptions;
use super::input::ToolSearchReplay;
use super::profile::BuildInputs;
use super::profile::ORDER_FIRST_PARTY;
use super::profile::ParallelToolCalls;
use super::profile::ReasoningSpec;
use super::profile::ResponsesProfile;
use super::profile::SystemPlacement;
use super::profile::ToolChoicePolicy;
use super::profile::ToolLowering;
use super::profile::build_body;

const DEFAULT_INSTRUCTIONS: &str = "You are a helpful assistant.";
const DEFAULT_EFFORT: &str = "medium";
const DEFAULT_VERBOSITY: &str = "low";

/// The request body plus the facts later stages read.
pub struct BuiltBody {
    pub map: Map<String, Value>,
    pub service_tier: Option<&'static str>,
    pub facts: ModelFacts,
}

/// `priority` is the only fast-class value the Codex backend accepts.
fn service_tier(facts: &ModelFacts, request: &ModelRequest) -> Option<&'static str> {
    if !request.options.fast {
        return None;
    }
    let asks_ultrafast = request
        .options
        .model_parameters
        .as_ref()
        .and_then(|p| p.get("serviceTier"))
        .and_then(Value::as_str)
        == Some("ultrafast");
    if asks_ultrafast && facts.ultrafast_tier {
        return Some("ultrafast");
    }
    facts.fast_tier.then_some("priority")
}

pub fn build(config: &OpenAiConfig, request: &ModelRequest) -> BuiltBody {
    build_with(config, request, None)
}

/// [`build`] with the conversation's mid-turn effort updates.
pub fn build_with(
    config: &OpenAiConfig,
    request: &ModelRequest,
    effort: Option<&EffortProjection>,
) -> BuiltBody {
    let route = config.route();
    let facts = config.facts.facts(&request.model);
    let caps = Capabilities::resolve(route, &facts);
    let codex = route == Route::Codex;
    let tier = service_tier(&facts, request);

    let profile = ResponsesProfile {
        order: ORDER_FIRST_PARTY.to_vec(),
        system: SystemPlacement::Instructions {
            fallback: Some(DEFAULT_INSTRUCTIONS.to_owned()),
            environment_message: true,
        },
        input: LowerOptions {
            replay_owner: ProviderId::from(REPLAY_OWNER),
            codex_parity: codex,
            native_tool_search: caps.native_tool_search,
            custom_tools: true,
            replay_reasoning: caps.reasoning,
            tool_search_replay: ToolSearchReplay::Downgrade,
            phase: true,
            system_in_input: false,
        },
        tools: if caps.native_tool_search {
            ToolLowering::NativeClient
        } else {
            ToolLowering::Function
        },
        tool_choice: ToolChoicePolicy::AutoDefault,
        parallel_tool_calls: ParallelToolCalls::Always,
        reasoning: caps.reasoning.then(|| ReasoningSpec {
            summary: caps.reasoning_summaries,
            default_effort: Some(DEFAULT_EFFORT.to_owned()),
            effort_aliases: vec![("ultra".to_owned(), "max".to_owned())],
        }),
        store: config.store,
        stream: true,
        stream_options: (codex && caps.reasoning && caps.reasoning_summaries)
            .then(|| serde_json::json!({"reasoning_summary_delivery": "sequential_cutoff"})),
        include_encrypted_reasoning: caps.reasoning,
        service_tier: tier.map(str::to_owned),
        prompt_cache_key: true,
        text_verbosity: caps.verbosity.then(|| DEFAULT_VERBOSITY.to_owned()),
        access_programs: facts.access_programs.clone().filter(|_| codex),
        max_output_tokens: !codex || config.send_max_output_tokens,
        cache_lifetime: if route == Route::ApiKey && config.store {
            facts.prompt_cache
        } else {
            PromptCacheLifetime::None
        },
        tool_label: "[openai] tool".to_owned(),
        honor_parallel_override: false,
        instructions_with_previous_response: true,
        continuation: ContinuationSpec {
            state_key: "openaiResponses".to_owned(),
            tag_history_owner: true,
            stateless_only: None,
            marker: None,
        },
    };
    let map = build_body(&profile, &BuildInputs { effort, ..BuildInputs::new(request) }).body;
    BuiltBody {
        map,
        service_tier: tier,
        facts,
    }
}