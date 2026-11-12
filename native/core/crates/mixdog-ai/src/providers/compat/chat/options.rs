//! Provider-specific Chat Completions request fields: reasoning control,
//! sampling, output limit and `tool_choice`. Each rule is selected by a field
//! of the profile's [`ChatDialect`]; nothing reads the provider name or the
//! model id (a model's capability comes from the listing, PW §10.B).

use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_protocol::{JsonObject, JsonValue};
use serde_json::json;

use super::super::models::{CompatModelInfo, fold_declared_effort};
use super::super::profile::{ChatDialect, EffortDialect, OutputLimit, ToolChoiceSupport};

fn lower(value: &str) -> String {
    mixdog_js::js_trim(value).to_lowercase()
}

fn parameter<'a>(request: &'a ModelRequest, key: &str) -> Option<&'a JsonValue> {
    request.options.model_parameters.as_ref()?.get(key)
}

/// `thinking` as the request states it: a boolean, a mode string or `{type}`.
fn requested_thinking(request: &ModelRequest) -> Option<&JsonValue> {
    parameter(request, "thinking")
}

fn effort(request: &ModelRequest) -> Option<&str> {
    request.options.effort.as_deref()
}

/// OpenRouter's unified `reasoning` field, shared by its Chat, Responses and Messages wires
/// (`openRouterReasoning`): `openRouterReasoningEffort`, else the turn effort; `none` disables reasoning. `None` when
/// no effort applies.
pub fn openrouter_reasoning(request: &ModelRequest) -> Option<JsonValue> {
    let raw = parameter(request, "openRouterReasoningEffort").and_then(JsonValue::as_str).or(effort(request));
    match raw.map(lower).as_deref() {
        Some("none") => Some(json!({ "enabled": false })),
        Some(l @ ("minimal" | "low" | "medium" | "high" | "xhigh" | "max")) => Some(json!({ "enabled": true, "effort": l })),
        _ => None,
    }
}

/// `openRouterProviderRouting`: `{ sort }` for the request's `provider` field, nothing for Auto or an unknown value.
pub fn openrouter_provider(request: &ModelRequest) -> Option<JsonValue> {
    let sort = parameter(request, "providerSort").and_then(JsonValue::as_str).map(lower);
    match sort.as_deref() {
        Some(sort @ ("price" | "throughput" | "latency")) => Some(json!({ "sort": sort })),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ThinkingMode {
    Enabled,
    Disabled,
}

/// DeepSeek's thinking switch as the request carries it, or `None` when
/// nothing sets it.
fn deepseek_thinking(request: &ModelRequest) -> Option<ThinkingMode> {
    let thinking = requested_thinking(request);
    let effort = effort(request);
    if thinking.is_none() && effort.is_none() {
        return None;
    }
    let mode = match thinking {
        Some(JsonValue::Object(o)) => o.get("type").and_then(JsonValue::as_str).map(lower),
        Some(JsonValue::String(s)) => Some(lower(s)),
        Some(JsonValue::Bool(b)) => Some(b.to_string()),
        Some(_) | None => effort.map(lower),
    };
    let disabled = thinking == Some(&JsonValue::Bool(false))
        || matches!(mode.as_deref(), Some("disabled" | "none"));
    Some(if disabled {
        ThinkingMode::Disabled
    } else {
        ThinkingMode::Enabled
    })
}

use mixdog_js::json_number as number_value;

/// `late` selects the effort fields that follow the sampling and output-limit
/// fields (MiMo's), keeping the body's key order that clients record.
fn apply_effort(
    dialect: &ChatDialect,
    request: &ModelRequest,
    info: Option<&CompatModelInfo>,
    body: &mut JsonObject,
    late: bool,
) {
    if (dialect.effort == EffortDialect::Mimo) != late {
        return;
    }
    let requested = effort(request);
    match dialect.effort {
        EffortDialect::None => {}
        EffortDialect::Xai => {
            // Only a model the listing says takes no effort is held back.
            let supported = info.is_none_or(|i| i.supports_reasoning != Some(false));
            if let Some(level) = requested.map(lower)
                && matches!(level.as_str(), "low" | "medium" | "high" | "xhigh")
                && supported
            {
                body.insert("reasoning_effort".into(), level.into());
            }
        }
        EffortDialect::DeepSeek => {
            let Some(mode) = deepseek_thinking(request) else {
                return;
            };
            let kind = if mode == ThinkingMode::Enabled {
                "enabled"
            } else {
                "disabled"
            };
            body.insert("thinking".into(), json!({ "type": kind }));
            if mode == ThinkingMode::Enabled {
                // `ultra` is DeepSeek's alias for max; `minimal` for low;
                // `medium`/`xhigh` for high. `low` is never promoted.
                let mapped = match requested.map(lower).as_deref() {
                    Some("max" | "ultra") => Some("max"),
                    Some("low" | "minimal") => Some("low"),
                    Some("medium" | "high" | "xhigh") => Some("high"),
                    _ => None,
                };
                if let Some(level) = mapped {
                    body.insert("reasoning_effort".into(), level.into());
                }
            }
        }
        EffortDialect::OpenRouter => {
            if let Some(reasoning) = openrouter_reasoning(request) {
                body.insert("reasoning".into(), reasoning);
            }
            if let Some(provider) = openrouter_provider(request) {
                body.insert("provider".into(), provider);
            }
        }
        EffortDialect::DeclaredOrBasic | EffortDialect::Declared => {
            let levels: &[&str] = info.map_or(&[], |i| i.reasoning_levels.as_slice());
            let level = if !levels.is_empty() {
                requested.and_then(|e| fold_declared_effort(e, levels))
            } else if dialect.effort == EffortDialect::DeclaredOrBasic {
                requested
                    .map(lower)
                    .filter(|e| matches!(e.as_str(), "low" | "medium" | "high"))
            } else {
                None
            };
            if let Some(level) = level {
                body.insert("reasoning_effort".into(), level.into());
            }
        }
        EffortDialect::Mimo => {
            let thinking = requested_thinking(request);
            let level = requested.map(lower).unwrap_or_default();
            let mode = match thinking {
                Some(JsonValue::Object(o)) => o.get("type").and_then(JsonValue::as_str).map(lower),
                Some(JsonValue::String(s)) => Some(lower(s)),
                _ => None,
            };
            let disabled = thinking == Some(&JsonValue::Bool(false))
                || matches!(mode.as_deref(), Some("disabled" | "off" | "none"))
                || level == "none";
            if disabled {
                body.insert("thinking".into(), json!({ "type": "disabled" }));
            } else if thinking.is_some() || !level.is_empty() {
                body.insert("thinking".into(), json!({ "type": "enabled" }));
                // The ladder's top edges fold to high.
                let mapped = match level.as_str() {
                    l @ ("minimal" | "low" | "medium" | "high") => Some(l),
                    "xhigh" | "max" | "ultra" => Some("high"),
                    _ => None,
                };
                if let Some(level) = mapped {
                    body.insert("reasoning_effort".into(), level.into());
                }
            }
        }
    }
}

/// Sampling fields, for dialects with a documented default temperature.
fn apply_sampling(dialect: &ChatDialect, request: &ModelRequest, body: &mut JsonObject) {
    let Some(default) = dialect.temperature else {
        return;
    };
    let number = |key: &str| {
        parameter(request, key)
            .and_then(JsonValue::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
    };
    let temperature = request.options.temperature.map_or(default, |t| t.get());
    body.insert("temperature".into(), number_value(temperature));
    for (key, wire) in [("topP", "top_p"), ("topK", "top_k")] {
        if let Some(n) = number(key) {
            body.insert(wire.into(), number_value(n));
        }
    }
}

/// `max_tokens`, sent only when the request carries a limit; it precedes the
/// tools in the body.
pub fn apply_max_tokens(dialect: &ChatDialect, request: &ModelRequest, body: &mut JsonObject) {
    if dialect.output_limit == OutputLimit::MaxTokens
        && let Some(n) = request.options.max_output_tokens_override.filter(|n| *n > 0)
    {
        body.insert("max_tokens".into(), n.into());
    }
}

fn apply_completion_limit(
    dialect: &ChatDialect,
    request: &ModelRequest,
    info: Option<&CompatModelInfo>,
    body: &mut JsonObject,
) {
    let requested = request.options.max_output_tokens_override.filter(|n| *n > 0);
    match dialect.output_limit {
        OutputLimit::MaxTokens => {}
        OutputLimit::MaxCompletionTokens { default, cap } => {
            let wanted = requested.unwrap_or(default).min(cap);
            let ceiling = info
                .and_then(|i| i.output_tokens)
                .or(request.options.model_max_output_tokens)
                .filter(|n| *n > 0);
            let limit = ceiling.map_or(wanted, |c| wanted.min(c));
            body.insert("max_completion_tokens".into(), limit.into());
        }
    }
}

/// `none` is universal; a forced choice only where the endpoint documents it.
fn apply_tool_choice(dialect: &ChatDialect, request: &ModelRequest, body: &mut JsonObject) {
    if !body.contains_key("tools") {
        return;
    }
    let choice = request.options.tool_choice.as_deref().map(str::trim);
    let none = choice == Some("none");
    if dialect.tool_choice == ToolChoiceSupport::AutoOnly {
        // Nothing but `auto` is documented: `none` is honoured by sending no
        // tools at all.
        if none {
            body.shift_remove("tools");
        }
        return;
    }
    if none {
        body.insert("tool_choice".into(), "none".into());
    }
    if let Some(parallel) = request.options.parallel_tool_calls
        && dialect.parallel_tool_calls
    {
        body.insert("parallel_tool_calls".into(), parallel.into());
    }
    let forced = match choice {
        Some("required") => Some(JsonValue::from("required")),
        Some("" | "none" | "auto") | None => None,
        Some(name) => Some(json!({ "type": "function", "function": { "name": name } })),
    };
    let Some(forced) = forced else {
        return;
    };
    match dialect.tool_choice {
        ToolChoiceSupport::Forced => {
            body.insert("tool_choice".into(), forced);
        }
        ToolChoiceSupport::ForcedWithoutThinking => {
            // Thinking enabled (or left to the server) rejects a forced choice,
            // so it is sent only with thinking explicitly disabled.
            if deepseek_thinking(request) == Some(ThinkingMode::Disabled) {
                body.insert("tool_choice".into(), forced);
            }
        }
        ToolChoiceSupport::NoneOnly | ToolChoiceSupport::AutoOnly => {}
    }
}

/// Applies every provider-specific field that follows the tools.
pub fn apply(
    dialect: &ChatDialect,
    request: &ModelRequest,
    info: Option<&CompatModelInfo>,
    body: &mut JsonObject,
) {
    apply_tool_choice(dialect, request, body);
    apply_effort(dialect, request, info, body, false);
    apply_sampling(dialect, request, body);
    apply_completion_limit(dialect, request, info, body);
    apply_effort(dialect, request, info, body, true);
}
