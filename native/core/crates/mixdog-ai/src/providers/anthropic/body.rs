//! The Messages request body of one attempt: system blocks and their cache
//! breakpoints, lowered messages with the message-tail breakpoint, tools,
//! thinking/effort, `max_tokens`. Key order is the wire order and is part of
//! the contract (prompt-cache prefixes are byte prefixes).

use std::collections::BTreeMap;
use std::collections::HashSet;

use mixdog_core_api::domain::provider::CacheTier;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::providers::action_input::action_input_contract;
use crate::providers::action_input::action_input_union_for;
use crate::providers::compat::schema::Problem;
use crate::providers::compat::schema::Rule;
use crate::providers::compat::schema::ToolExclusion;
use crate::providers::compat::schema::exclusion;
use crate::providers::compat::schema::report_exclusion;
use crate::providers::compat::schema::wire_input_schema;
use crate::providers::flat_schema::merge_flat_schema_property;
use crate::providers::js_value::entries;
use crate::providers::js_value::js_ordered_map;
use crate::providers::js_value::spread;
use crate::providers::js_value::truthy;

use super::betas::BetaFeatures;
use super::caps::ModelCaps;
use super::codec::Flavor;
use super::effort_updates;
use super::effort_updates::Gate;
use super::effort_updates::lower_with_updates;
use super::effort_updates::turn_scoped_layout;
use super::lowering::LowerContext;
use super::lowering::WireContent;
use super::lowering::WireMessage;
use super::lowering::lower_messages;
use super::reminders::append_tail_reminder;
use super::reminders::append_turn_reminder;
use super::reminders::split_tail_reminder;
use super::reminders::with_turn_reminders;

/// The first system block of every OAuth request; the subscription pool is
/// selected by this exact text.
pub(crate) const OAUTH_SYSTEM_PREFIX: &str = "You are Claude Code, Anthropic's official CLI for Claude.";

const MAX_CACHE_BREAKPOINTS: usize = 4;
const MAX_TOKENS_FLOOR: u32 = 8192;
const MAX_TOKENS_SAFETY_CAP: u32 = 65536;
const MIN_THINKING_BUDGET: u64 = 1024;

// ---------------------------------------------------------------------------
// Cache strategy
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CacheTtl {
    OneHour,
    FiveMinutes,
}

impl CacheTtl {
    fn rank(self) -> u8 {
        match self {
            Self::OneHour => 2,
            Self::FiveMinutes => 1,
        }
    }

    fn control(self) -> Value {
        match self {
            Self::OneHour => json!({ "type": "ephemeral", "ttl": "1h" }),
            Self::FiveMinutes => json!({ "type": "ephemeral" }),
        }
    }
}

/// TTL of each cacheable layer; `None` leaves the layer unmarked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CacheStrategy {
    pub system: Option<CacheTtl>,
    pub tier3: Option<CacheTtl>,
    pub messages: Option<CacheTtl>,
}

impl Default for CacheStrategy {
    fn default() -> Self {
        Self {
            system: Some(CacheTtl::OneHour),
            tier3: Some(CacheTtl::OneHour),
            messages: Some(CacheTtl::FiveMinutes),
        }
    }
}

impl CacheStrategy {
    /// A longer TTL must not follow a shorter one (system → tier3 → messages).
    fn ordered(mut self) -> Self {
        let mut min_rank = u8::MAX;
        for layer in [&mut self.system, &mut self.tier3, &mut self.messages] {
            let Some(ttl) = *layer else { continue };
            if ttl.rank() > min_rank {
                *layer = Some(CacheTtl::FiveMinutes);
            } else {
                min_rank = ttl.rank();
            }
        }
        self
    }

    /// `model_parameters.cacheStrategy`: layer → `"1h"` | `"5m"` | `"none"`.
    fn with_overrides(mut self, parameters: Option<&Value>) -> Self {
        let Some(strategy) = parameters.and_then(|p| p.get("cacheStrategy")) else {
            return self;
        };
        let pick = |name: &str, current: Option<CacheTtl>| match strategy.get(name).and_then(Value::as_str) {
            Some("1h") => Some(CacheTtl::OneHour),
            Some("5m") => Some(CacheTtl::FiveMinutes),
            Some("none") => None,
            _ => current,
        };
        self.system = pick("system", self.system);
        self.tier3 = pick("tier3", self.tier3);
        self.messages = pick("messages", self.messages);
        self
    }
}

// ---------------------------------------------------------------------------
// Configuration and result
// ---------------------------------------------------------------------------

pub(crate) struct BodyConfig<'a> {
    pub flavor: Flavor,
    /// `anthropic` or `anthropic-oauth`.
    pub provider_name: &'a str,
    pub owner: &'a ProviderId,
    pub caps: Option<&'a ModelCaps>,
    pub cache: CacheStrategy,
    pub max_output_tokens: Option<u32>,
    /// Fine-grained tool streaming and `updates` thinking display are
    /// first-party features; a gateway base URL turns them off.
    pub first_party: bool,
    /// The base URL is Anthropic's own origin (the OAuth route is first-party
    /// whatever its base URL; mid-conversation effort updates are not).
    pub official_url: bool,
    /// `disableBetaHeaders` is off.
    pub beta_headers: bool,
    /// The process-wide fast-mode state: a request is built at fast speed only while it allows.
    pub fast_mode: &'a super::fast_mode::FastMode,
}

/// Model families (after `model_key`, with the major version) that take the
/// body's `fallbacks: "default"`; no catalog field declares it, and unknown
/// ids stay off because a wrong "yes" is a 400.
const SERVER_FALLBACK_FAMILIES: [&str; 2] = ["claude-opus-5", "claude-fable-5"];

/// Models (by Node's exact id test, see `turn_scoped_model`) that take turn-scoped `clear_at` system messages;
/// an id list because a wrong "yes" is a 400 on every request.
const TURN_SCOPED_MODELS: [&str; 9] = [
    "claude-fable-5-1",
    "claude-mythos-5-1",
    "claude-fable-5",
    "claude-mythos-5",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-sonnet-5-5",
    "claude-haiku-5-5",
];

/// Node's `supportsAnthropicTurnScopedSystemMessages`: the listed ids, each
/// with an optional `-YYYYMMDD` snapshot suffix and nothing else (no trimming,
/// no `-YYYY-MM-DD`), after lowercasing and folding dots to dashes.
pub(super) fn turn_scoped_model(model: &str) -> bool {
    let id = model.to_lowercase().replace('.', "-");
    TURN_SCOPED_MODELS.iter().any(|listed| {
        id.strip_prefix(listed).is_some_and(|rest| {
            rest.is_empty()
                || rest
                    .strip_prefix('-')
                    .is_some_and(|date| date.len() == 8 && date.bytes().all(|b| b.is_ascii_digit()))
        })
    })
}

fn server_fallback(cfg: &BodyConfig<'_>, model: &str, parameters: Option<&Value>) -> bool {
    let key = effort_updates::model_key(model);
    let family = SERVER_FALLBACK_FAMILIES.iter().any(|family| {
        key.strip_prefix(family)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with(['-', '@']))
    });
    family
        && parameters.and_then(|p| p.get("serverFallback")) != Some(&Value::Bool(false))
        && (cfg.flavor == Flavor::OAuth || cfg.beta_headers)
}

pub(crate) struct BuiltBody {
    pub bytes: Vec<u8>,
    pub betas: BetaFeatures,
}

fn local_error(message: impl Into<String>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    err.message = message.into();
    err
}

// ---------------------------------------------------------------------------
// System blocks
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Tier {
    System,
    Tier3,
    Env,
}

fn system_items(request: &ModelRequest) -> Result<Vec<(String, Tier)>, ProviderError> {
    let mut items = Vec::new();
    for message in request.messages.iter().filter(|m| m.role == Role::System) {
        let tier = match message.cache_tier {
            Some(CacheTier::Tier3) => Tier::Tier3,
            Some(CacheTier::Env) => Tier::Env,
            None => Tier::System,
        };
        let mut push = |text: &str| {
            let text = text.trim();
            if !text.is_empty() {
                items.push((text.to_owned(), tier));
            }
        };
        match &message.content {
            Content::Text(text) => push(text),
            Content::Parts(parts) => {
                for part in parts {
                    match part {
                        ContentPart::Text(text, _) => push(text),
                        _ => {
                            return Err(local_error(
                                "Anthropic system instructions must be text",
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(items)
}

fn system_blocks(flavor: Flavor, items: &[(String, Tier)], cache: &CacheStrategy) -> Vec<Value> {
    let mut blocks: Vec<Value> = Vec::new();
    let mut breakpoints = 0;
    if flavor == Flavor::OAuth {
        blocks.push(json!({ "type": "text", "text": OAUTH_SYSTEM_PREFIX }));
    }
    for (index, (text, tier)) in items.iter().enumerate() {
        let mut body = text.as_str();
        if flavor == Flavor::OAuth && index == 0 && body.starts_with(OAUTH_SYSTEM_PREFIX) {
            body = body[OAUTH_SYSTEM_PREFIX.len()..].trim();
            if body.is_empty() {
                continue;
            }
        }
        // Anthropic joins system blocks with no separator: every block after
        // the first opens with a paragraph break.
        let text = if blocks.is_empty() { body.to_owned() } else { format!("\n\n{body}") };
        let mut block = json!({ "type": "text", "text": text });
        let ttl = match tier {
            Tier::Tier3 => cache.tier3,
            Tier::Env => None,
            Tier::System => cache.system,
        };
        if let Some(ttl) = ttl
            && breakpoints < MAX_CACHE_BREAKPOINTS
        {
            block["cache_control"] = ttl.control();
            breakpoints += 1;
        }
        blocks.push(block);
    }
    blocks
}

// ---------------------------------------------------------------------------
// Message-tail cache breakpoint
// ---------------------------------------------------------------------------

fn is_cache_eligible(block: &Value) -> bool {
    match block.get("type").and_then(Value::as_str) {
        _ if !block.is_object() => false,
        Some("thinking" | "redacted_thinking") => false,
        Some("text") => block
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.trim().is_empty()),
        _ => true,
    }
}

fn last_eligible_block(content: &WireContent) -> Option<usize> {
    match content {
        WireContent::Text(text) => (!text.trim().is_empty()).then_some(0),
        WireContent::Blocks(blocks) => blocks.iter().rposition(is_cache_eligible),
    }
}

/// A turn-scoped system message rejects `cache_control`, and an effort control has no block to mark.
fn last_markable_message(messages: &[WireMessage]) -> Option<usize> {
    messages
        .iter()
        .rposition(|m| m.role != "system" && last_eligible_block(&m.content).is_some())
}

/// The breakpoint on the last message that has an eligible block.
fn mark_message_tail(messages: &mut [WireMessage], ttl: CacheTtl) {
    if let Some(index) = last_markable_message(messages)
        && let Some(block_index) = last_eligible_block(&messages[index].content)
    {
        mark_block(&mut messages[index], block_index, ttl);
    }
}

/// The block a content holds at `block_index`, as the JSON it is sent as.
fn block_key(content: &WireContent, block_index: usize) -> Option<Value> {
    match content {
        WireContent::Text(text) => (block_index == 0).then(|| Value::String(text.clone())),
        WireContent::Blocks(blocks) => blocks.get(block_index).cloned(),
    }
}

/// A cache-sharing fork keeps its one message breakpoint on the block the
/// saved request marked: the last markable block of its first `count`
/// messages, lowered as the request lowers them. The fork reads that cache
/// entry and writes none for its own suffix. `lowered_prefix` is that
/// lowering; a prefix that is not part of the request (or lowers to nothing)
/// leaves the request without a message breakpoint.
fn mark_shared_prefix(messages: &mut [WireMessage], lowered_prefix: Option<Vec<WireMessage>>, ttl: CacheTtl) {
    let Some(prefix) = lowered_prefix else {
        return;
    };
    let Some(index) = last_markable_message(&prefix) else {
        return;
    };
    let Some(block_index) = last_eligible_block(&prefix[index].content) else {
        return;
    };
    let Some(key) = block_key(&prefix[index].content, block_index) else {
        return;
    };
    let Some(message) = messages.get_mut(index) else {
        return;
    };
    if block_key(&message.content, block_index) == Some(key) {
        mark_block(message, block_index, ttl);
    }
}

fn mark_block(message: &mut WireMessage, block_index: usize, ttl: CacheTtl) {
    match &mut message.content {
        WireContent::Text(text) => {
            let text = std::mem::take(text);
            message.content = WireContent::Blocks(vec![json!({
                "type": "text",
                "text": text,
                "cache_control": ttl.control(),
            })]);
        }
        WireContent::Blocks(blocks) => {
            if blocks[block_index].get("cache_control").is_none() {
                blocks[block_index]["cache_control"] = ttl.control();
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/// Anthropic forbids `oneOf`/`anyOf`/`allOf` at the top level of
/// `input_schema`: such a schema is flattened into one object schema.
pub(crate) fn sanitize_input_schema(schema: &Value) -> Value {
    let Some(map) = schema.as_object() else {
        // A non-object that is truthy in JavaScript's `typeof` sense (an array) is cloned as is.
        return if schema.is_array() { schema.clone() } else { json!({ "type": "object", "properties": {} }) };
    };
    let Some(key) = ["oneOf", "anyOf", "allOf"].into_iter().find(|k| map.get(*k).is_some_and(truthy)) else {
        return schema.clone();
    };
    let conjunctive = key == "allOf";
    let mut properties = spread(map.get("properties").filter(|p| truthy(p)));
    // A `Set`: a repeated name is kept once.
    let mut required: Vec<Value> = Vec::new();
    let add_required = |required: &mut Vec<Value>, name: &Value| {
        if name.is_object() || name.is_array() || !required.contains(name) {
            required.push(name.clone());
        }
    };
    for name in map.get("required").and_then(Value::as_array).into_iter().flatten() {
        add_required(&mut required, name);
    }
    let mut branch_descriptions: Vec<String> = Vec::new();
    for raw in map[key].as_array().into_iter().flatten() {
        let branch = if conjunctive && raw.get("allOf").is_some_and(truthy) {
            sanitize_input_schema(raw)
        } else {
            raw.clone()
        };
        let Some(branch_map) = branch.as_object() else {
            continue;
        };
        for (name, property) in entries(branch_map.get("properties").filter(|p| truthy(p)).unwrap_or(&Value::Null)) {
            // allOf is an intersection, not an alternative: both constraints stay on a shared field.
            let next = if conjunctive && properties.contains_key(&name) {
                json!({ "allOf": [properties[&name].clone(), property] })
            } else {
                merge_flat_schema_property(properties.get(&name), &property)
            };
            properties.insert(name, next);
        }
        if conjunctive {
            for name in branch_map.get("required").and_then(Value::as_array).into_iter().flatten() {
                add_required(&mut required, name);
            }
        }
        if let Some(description) = branch_map.get("description").filter(|d| truthy(d)) {
            branch_descriptions.push(mixdog_js::value_to_string(description));
        } else if let Some(kind) = branch_map.get("type").filter(|t| truthy(t)) {
            branch_descriptions.push(format!("type:{}", mixdog_js::value_to_string(kind)));
        }
    }
    // The per-action input rules ride on the merged `input` field.
    let contract = action_input_contract(schema);
    if !contract.is_empty()
        && let Some(Value::Object(input)) = properties.get("input").filter(|input| truthy(input))
    {
        let mut input = input.clone();
        input.insert("description".into(), Value::String(contract));
        properties.insert("input".into(), Value::Object(input));
    }
    let own_description = map.get("description").filter(|d| truthy(d)).cloned();
    let mut parts: Vec<String> = Vec::new();
    let mut used = 0usize;
    for (i, branch) in branch_descriptions.iter().enumerate() {
        let value = format!("(variant {}: {branch})", i + 1);
        let separator = usize::from(!parts.is_empty());
        if used + value.encode_utf16().count() + separator > 500 {
            break;
        }
        used += value.encode_utf16().count() + usize::from(!parts.is_empty());
        parts.push(value);
    }
    let addition = parts.join(" ");
    let description = if addition.is_empty() {
        own_description
    } else {
        Some(Value::String(match own_description {
            Some(own) => format!("{} {addition}", mixdog_js::value_to_string(&own)),
            None => addition,
        }))
    };
    let mut out = Map::new();
    out.insert("type".into(), json!("object"));
    if let Some(description) = description {
        out.insert("description".into(), description);
    }
    out.insert("properties".into(), Value::Object(js_ordered_map(properties)));
    if !required.is_empty() {
        out.insert("required".into(), Value::Array(required));
    }
    if map.get("additionalProperties") == Some(&Value::Bool(false)) {
        out.insert("additionalProperties".into(), Value::Bool(false));
    }
    Value::Object(out)
}

/// The Messages `input_schema` of a tool (`anthropicInputSchema`): the flattened schema, lowered
/// to 2020-12 with an object root when it is not valid as written; `Err` when it is broken even
/// then. First-party Anthropic (`anthropic`, `anthropic-oauth`, the only providers this body
/// serves) takes the nested per-action input alternatives a tool registered
/// (`actionInputUnionFor`); a gateway on the same wire would keep the advertised flat schema.
fn input_schema(tool: &ToolDefinition, native: bool) -> Result<Value, Problem> {
    let advertised = if native { action_input_union_for(&tool.input_schema) } else { tool.input_schema.clone() };
    wire_input_schema(&sanitize_input_schema(&advertised), Rule::Anthropic)
}

/// `ANTHROPIC_NATIVE_PROVIDERS`: the providers whose Messages wire takes the nested per-action
/// input alternatives; a gateway on the same wire keeps the advertised flat schema.
fn native_provider(provider: &str) -> bool {
    matches!(provider, "anthropic" | "anthropic-oauth")
}

/// Why the Messages wire leaves `tool` out of a request (`anthropicToolExclusion`), or `None`
/// when it is sent. Reports nothing.
pub fn anthropic_tool_exclusion(tool: &ToolDefinition, provider: &str) -> Option<ToolExclusion> {
    input_schema(tool, native_provider(provider))
        .err()
        .map(|problem| exclusion(&tool.name, 0, problem, &format!("[{provider}] tool")))
}

/// A Messages endpoint rejects the whole request for one invalid `input_schema`, so a tool that is
/// broken even after lowering is reported (`excluded`) and left out (`toAnthropicTools`).
pub(crate) fn wire_tools(
    tools: &[ToolDefinition],
    provider: &str,
    eager: bool,
    excluded: &mut dyn FnMut(ToolExclusion),
) -> Vec<Value> {
    let source = format!("[{provider}] tool");
    tools
        .iter()
        .enumerate()
        .filter_map(|(index, tool)| {
            let schema = match input_schema(tool, native_provider(provider)) {
                Ok(schema) => schema,
                Err(problem) => {
                    excluded(exclusion(&tool.name, index, problem, &source));
                    return None;
                }
            };
            let mut entry = json!({
                "name": tool.name,
                "description": tool.description,
                "input_schema": schema,
            });
            if tool.defer_loading {
                entry["defer_loading"] = Value::Bool(true);
            }
            if eager {
                entry["eager_input_streaming"] = Value::Bool(true);
            }
            Some(entry)
        })
        .collect()
}

/// `none` keeps the tool definitions (and the cached prefix) while forbidding
/// tool use; forced `any`/`tool` is invalid while thinking is on.
fn tool_choice(choice: Option<&str>, thinking: bool, disable_parallel: bool) -> Option<Value> {
    let mut choice: Option<Value> = match choice {
        Some("none") => Some(json!({ "type": "none" })),
        Some("auto") => Some(json!({ "type": "auto" })),
        Some("required" | "any") => Some(json!({ "type": "any" })),
        Some(name) if !name.is_empty() => Some(json!({ "type": "tool", "name": name })),
        _ => None,
    };
    let kind = |c: &Option<Value>| c.as_ref().and_then(|c| c.get("type")).and_then(Value::as_str).map(str::to_owned);
    if thinking && matches!(kind(&choice).as_deref(), Some("any" | "tool")) {
        choice = None;
    }
    if disable_parallel && kind(&choice).as_deref() != Some("none") {
        let mut next = choice.unwrap_or_else(|| json!({ "type": "auto" }));
        next["disable_parallel_tool_use"] = Value::Bool(true);
        choice = Some(next);
    }
    choice
}

// ---------------------------------------------------------------------------
// max_tokens and reasoning
// ---------------------------------------------------------------------------

fn max_tokens(cfg: &BodyConfig<'_>, request: &ModelRequest) -> u32 {
    let options = &request.options;
    if let Some(over) = options.max_output_tokens_override.filter(|v| *v > 0) {
        return over;
    }
    let declared = options
        .model_max_output_tokens
        .filter(|v| *v > 0)
        .or_else(|| cfg.caps.and_then(|c| c.max_output_tokens).filter(|v| *v > 0));
    match (cfg.max_output_tokens, declared) {
        (Some(configured), Some(declared)) => configured.min(declared),
        (Some(configured), None) => configured,
        (None, Some(declared)) => declared.min(MAX_TOKENS_SAFETY_CAP),
        (None, None) => MAX_TOKENS_FLOOR,
    }
}

fn clamp_thinking_budget(desired: u64, max_tokens: u32) -> Option<u64> {
    let ceiling = u64::from(max_tokens).checked_sub(MIN_THINKING_BUDGET)?;
    if desired == 0 || ceiling < MIN_THINKING_BUDGET {
        return None;
    }
    Some(desired.min(ceiling).max(MIN_THINKING_BUDGET))
}

fn legacy_effort_budget(level: &str) -> Option<u64> {
    match level {
        "low" => Some(1024),
        "medium" => Some(4096),
        "high" => Some(16384),
        "xhigh" | "max" => Some(32768),
        _ => None,
    }
}

fn normalize_effort(raw: &str, caps: &ModelCaps) -> Option<&'static str> {
    let mut level = raw.trim().to_lowercase();
    if level == "extra-high" || level == "very-high" {
        level = "xhigh".into();
    }
    if level == "xhigh" && !caps.has_level("xhigh") {
        return Some("high");
    }
    if level == "max" && !(caps.has_level("max") || caps.has_level("xhigh")) {
        return Some("high");
    }
    ["low", "medium", "high", "xhigh", "max"]
        .into_iter()
        .find(|known| *known == level)
}

#[derive(Default)]
struct Reasoning {
    output_config: Option<Value>,
    thinking: Option<Value>,
    effort_beta: bool,
    display_updates: bool,
}

fn manual_budget(request: &ModelRequest) -> Option<u64> {
    request
        .options
        .model_parameters
        .as_ref()
        .and_then(|p| p.get("thinkingBudgetTokens"))
        .and_then(Value::as_u64)
        .filter(|b| *b > 0)
}

/// `effort` is the turn's effort: the request's, or the projection's initial
/// one when updates carry the changes after it.
fn reasoning(
    cfg: &BodyConfig<'_>,
    request: &ModelRequest,
    effort: Option<&str>,
    max_tokens: u32,
) -> Result<Reasoning, ProviderError> {
    let Some(caps) = cfg.caps else {
        return Ok(Reasoning::default());
    };
    if let Some(budget) = manual_budget(request) {
        if !caps.manual_thinking {
            return Err(local_error(format!(
                "{} does not support thinkingBudgetTokens; use effort with adaptive thinking instead.",
                request.model
            )));
        }
        let thinking = clamp_thinking_budget(budget, max_tokens)
            .map(|b| json!({ "type": "enabled", "budget_tokens": b }));
        return Ok(Reasoning {
            thinking,
            ..Reasoning::default()
        });
    }
    let effort = effort.and_then(|raw| normalize_effort(raw, caps));
    if caps.adaptive_thinking && caps.supports_effort() {
        let display_updates =
            (cfg.flavor == Flavor::OAuth || cfg.beta_headers) && caps.thinking_display_updates;
        let thinking = if display_updates {
            json!({ "type": "adaptive", "display": "updates" })
        } else {
            json!({ "type": "adaptive" })
        };
        return Ok(Reasoning {
            output_config: effort.map(|level| json!({ "effort": level })),
            thinking: Some(thinking),
            effort_beta: true,
            display_updates,
        });
    }
    let Some(level) = effort else {
        return Ok(Reasoning::default());
    };
    if !caps.manual_thinking {
        return Err(local_error(format!(
            "{} does not support thinkingBudgetTokens; use effort with adaptive thinking instead.",
            request.model
        )));
    }
    let thinking = legacy_effort_budget(level)
        .and_then(|b| clamp_thinking_budget(b, max_tokens))
        .map(|b| json!({ "type": "enabled", "budget_tokens": b }));
    Ok(Reasoning {
        thinking,
        ..Reasoning::default()
    })
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

pub(crate) fn build_body(cfg: &BodyConfig<'_>, request: &ModelRequest) -> Result<BuiltBody, ProviderError> {
    let parameters = request.options.model_parameters.as_ref();
    let cache = cfg.cache.with_overrides(parameters).ordered();
    let system = system_blocks(cfg.flavor, &system_items(request)?, &cache);
    let reserved = system.iter().filter(|b| b.get("cache_control").is_some()).count();

    let available: HashSet<String> = request.tools.iter().map(|t| t.name.trim().to_owned()).collect();
    let context = LowerContext {
        owner: cfg.owner,
        own_provider: cfg.provider_name,
        available_tools: &available,
    };
    let updates = request.options.effort_projection.as_ref().filter(|_| {
        effort_updates::enabled(
            cfg.provider_name,
            &request.model,
            &Gate {
                official_url: cfg.official_url,
                manual_budget: manual_budget(request).is_some(),
                enabled: parameters.and_then(|p| p.get("effortConfigurationEnabled")) != Some(&Value::Bool(false)),
                beta_headers: cfg.beta_headers,
            },
        )
    });
    // The tail reminder rides the request apart from the history: the history is lowered and marked without it,
    // and it is placed afterwards (turn-scoped on a model that takes `clear_at` messages, else legacy).
    let (history, reminder) = split_tail_reminder(&request.messages);
    let turn_scoped = cfg.first_party && turn_scoped_model(&request.model);
    let lower = |source: &[Message]| {
        let lowered = match updates {
            Some(projection) => {
                let kept: BTreeMap<usize, String> = projection
                    .updates
                    .iter()
                    .filter(|(index, _)| **index < source.len())
                    .map(|(index, effort)| (*index, effort.clone()))
                    .collect();
                lower_with_updates(source, &kept, &context)
            }
            None if turn_scoped => turn_scoped_layout(lower_messages(source, &context)),
            None => lower_messages(source, &context),
        };
        if turn_scoped { with_turn_reminders(lowered) } else { lowered }
    };
    let mut messages = lower(history);
    if let Some(ttl) = cache.messages
        && reserved < MAX_CACHE_BREAKPOINTS
    {
        match request.options.shared_cache_prefix_count.filter(|count| *count > 0) {
            None => mark_message_tail(&mut messages, ttl),
            Some(count) => {
                let prefix = history.get(..count).map(&lower);
                mark_shared_prefix(&mut messages, prefix, ttl);
            }
        }
    }
    let messages = if turn_scoped { append_turn_reminder(messages, &reminder) } else { append_tail_reminder(messages, &reminder) };
    let turn_scoped_system = messages.iter().any(|m| m.clear_at);

    let max_tokens = max_tokens(cfg, request);
    let turn_effort = match updates {
        Some(projection) => Some(projection.initial_effort.as_str()),
        None => request.options.effort.as_deref(),
    };
    let reasoning = reasoning(cfg, request, turn_effort, max_tokens)?;
    let disable_parallel = parameters
        .and_then(|p| p.get("disableParallelToolUse"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tools = wire_tools(&request.tools, cfg.provider_name, cfg.first_party, &mut |excluded| {
        report_exclusion(&request.options, excluded)
    });
    let choice = if tools.is_empty() {
        None
    } else {
        tool_choice(
            request.options.tool_choice.as_deref(),
            reasoning.thinking.is_some(),
            disable_parallel,
        )
    };
    let fast = request.options.fast
        && cfg.caps.is_some_and(|c| c.fast_mode)
        && cfg.fast_mode.available(super::fast_mode::now_ms());

    let messages_json = Value::Array(messages.iter().map(WireMessage::to_json).collect());
    let fallback = server_fallback(cfg, &request.model, parameters);
    let mut body = Map::new();
    body.insert("model".into(), Value::String(request.model.clone()));
    body.insert("max_tokens".into(), json!(max_tokens));
    // OAuth names `messages` and `stream` before `system`; the API-key wire
    // names `system` first and `stream` last.
    match cfg.flavor {
        Flavor::ApiKey => {
            if !system.is_empty() {
                body.insert("system".into(), Value::Array(system));
            }
            body.insert("messages".into(), messages_json);
            if fallback {
                body.insert("fallbacks".into(), json!("default"));
            }
        }
        Flavor::OAuth => {
            body.insert("messages".into(), messages_json);
            body.insert("stream".into(), Value::Bool(true));
            if fallback {
                body.insert("fallbacks".into(), json!("default"));
            }
            if !system.is_empty() {
                body.insert("system".into(), Value::Array(system));
            }
        }
    }
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
    }
    if let Some(choice) = choice {
        body.insert("tool_choice".into(), choice);
    }
    if let Some(output_config) = reasoning.output_config {
        body.insert("output_config".into(), output_config);
    }
    if let Some(thinking) = reasoning.thinking {
        body.insert("thinking".into(), thinking);
    }
    if fast {
        body.insert("speed".into(), json!("fast"));
    }
    if cfg.flavor == Flavor::ApiKey {
        body.insert("stream".into(), Value::Bool(true));
    }
    let bytes = serde_json::to_vec(&Value::Object(body))
        .map_err(|e| local_error(format!("request body is not serialisable: {e}")))?;
    Ok(BuiltBody {
        bytes,
        betas: BetaFeatures {
            fast_mode: fast,
            tool_search: request.tools.iter().any(|t| t.defer_loading),
            server_fallback: fallback,
            effort: reasoning.effort_beta,
            thinking_display_updates: reasoning.display_updates,
            turn_scoped_system,
            mid_conversation_effort: updates.is_some(),
        },
    })
}
