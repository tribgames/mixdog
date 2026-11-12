//! `ModelRequest` → the Gemini-shaped request object (`contents`,
//! `systemInstruction`, `tools`, `toolConfig`, `generationConfig`) shared by
//! the Gemini API, Vertex AI and Antigravity. The three differ only in the
//! [`Dialect`] flags.

use std::collections::HashMap;

use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DeliveryState;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::ErrorKind;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::MessageSource;
use mixdog_core_api::domain::provider::ModelRequest;
use mixdog_core_api::domain::provider::ProviderError;
use mixdog_core_api::domain::provider::RequestOptions;
use mixdog_core_api::domain::provider::Role;
use mixdog_core_api::domain::provider::Temperature;
use mixdog_protocol::ProviderId;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use crate::providers::file_text::{FileKind, file_fallback_text, file_kind};

use super::redirect::ignores_sampling;
use super::tool_accept;
use super::traits::ModelTraits;
use crate::providers::compat::schema::report_exclusion;
use super::traits::ThinkingControl;

/// A synthetic signature Google documents as the escape hatch for a history
/// that has no real one for the active turn's first call.
const SIGNATURE_SENTINEL: &str = "skip_thought_signature_validator";
const THINKING_LEVELS: [&str; 4] = ["minimal", "low", "medium", "high"];

/// What differs between the three Gemini-shaped endpoints.
#[derive(Clone, Debug)]
pub struct Dialect {
    /// Owner of the replay envelopes this provider writes and reads.
    pub owner: ProviderId,
    /// `systemInstruction.role`; Vertex accepts only a bare `parts` object.
    pub system_role: Option<&'static str>,
    /// Vertex rejects `functionCall.id` / `functionResponse.id`.
    pub function_ids: bool,
    /// The endpoint also serves other model families, which reject the
    /// Gemini-only fields (thought summaries, output cap, signatures).
    pub family_gated: bool,
    /// A replay is bound to the model that produced it.
    pub replay_same_model: bool,
    /// `functionCallingConfig.mode` when the request names no tool choice.
    pub default_tool_mode: Option<&'static str>,
    /// The direct Gemini API drops `temperature` for the models that ignore it (`omitIgnoredSampling`).
    pub omit_ignored_sampling: bool,
}

pub(super) fn invalid(message: impl Into<String>) -> ProviderError {
    let mut err = ProviderError::new(ErrorKind::InvalidRequest, DeliveryState::NotSent);
    err.message = message.into();
    err
}

fn text_of(content: &Content) -> String {
    match content {
        Content::Text(text) => text.clone(),
        Content::Parts(parts) => parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t, _) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    }
}

fn file_part(filename: Option<&str>, mime_type: &str, data: &str) -> Value {
    match file_kind(mime_type, data, filename) {
        FileKind::Pdf => json!({ "inlineData": { "mimeType": "application/pdf", "data": data } }),
        _ => json!({ "text": file_fallback_text(filename, mime_type, data) }),
    }
}

fn media_part(part: &ContentPart) -> Result<Option<Value>, ProviderError> {
    Ok(Some(match part {
        ContentPart::Text(text, _) => json!({ "text": text }),
        ContentPart::Image(ImageSource::Base64 { data, mime_type }) => {
            json!({ "inlineData": { "mimeType": mime_type, "data": data } })
        }
        ContentPart::Image(ImageSource::Url(uri)) | ContentPart::Image(ImageSource::FileId(uri)) => {
            json!({ "fileData": { "fileUri": uri } })
        }
        // Only a PDF rides as `inlineData`; any other file is its text or its description (`normalizeContentForGeminiParts`).
        ContentPart::File {
            source: mixdog_core_api::domain::provider::BinarySource::Base64(data),
            mime_type,
            filename,
            ..
        } => file_part(filename.as_deref(), mime_type, data),
        ContentPart::File {
            source: mixdog_core_api::domain::provider::BinarySource::AttachmentRef(_),
            ..
        } => return Err(invalid("an attachment reference must be resolved before the request is encoded")),
        ContentPart::Document { source, title } => match source {
            DocumentSource::Base64 { media_type, data } => file_part(title.as_deref(), media_type, data),
            DocumentSource::Text { data, .. } => json!({ "text": data }),
            DocumentSource::Content(value) => json!({ "text": value.to_string() }),
        },
    }))
}

fn content_parts(content: &Content) -> Result<Vec<Value>, ProviderError> {
    match content {
        Content::Text(text) if text.is_empty() => Ok(Vec::new()),
        Content::Text(text) => Ok(vec![json!({ "text": text })]),
        Content::Parts(parts) => {
            let mut out = Vec::new();
            for part in parts {
                if let ContentPart::Text(t, _) = part
                    && t.is_empty()
                {
                    continue;
                }
                out.extend(media_part(part)?);
            }
            Ok(out)
        }
    }
}

fn strip_ids(parts: &mut [Value]) {
    for part in parts {
        for key in ["functionCall", "functionResponse"] {
            if let Some(map) = part.get_mut(key).and_then(Value::as_object_mut) {
                map.shift_remove("id");
            }
        }
    }
}

/// The recorded model parts of an assistant turn, unless another model
/// family (or, where replays are model-bound, another model) produced them.
fn replayed_parts(message: &Message, dialect: &Dialect, model: &str, traits: &dyn ModelTraits) -> Option<Vec<Value>> {
    let replay = message.replay_for(&dialect.owner).next()?;
    let parts = replay.items.get("parts")?.as_array()?.clone();
    if let Some(recorded) = replay.items.get("model").and_then(Value::as_str)
        && !recorded.is_empty()
        && (traits.is_gemini_family(recorded) != traits.is_gemini_family(model)
            || (dialect.replay_same_model && recorded != model))
    {
        return None;
    }
    (!parts.is_empty()).then_some(parts)
}

/// The recorded parts of an assistant turn on Antigravity (`signatureSafeMessages`, antigravity-request.mjs:139-163):
/// only a replay the same family (Claude or not) recorded is this route's (`replayFamilyMatches`).
fn antigravity_own_parts(message: &Message, dialect: &Dialect, model: &str) -> Option<Vec<Value>> {
    let replay = message.replay_for(&dialect.owner).next()?;
    if let Some(recorded) = replay.items.get("model").and_then(Value::as_str)
        && !recorded.is_empty()
        && antigravity_claude(recorded) != antigravity_claude(model)
    {
        return None;
    }
    let parts = replay.items.get("parts")?.as_array()?.clone();
    (!parts.is_empty()).then_some(parts)
}

fn is_thought(part: &Value) -> bool {
    part.get("thought") == Some(&Value::Bool(true))
}

/// `hasOwnClaudeSignature`: a signature this route recorded (the validator-bypass sentinel is Gemini's, not Claude's).
fn own_claude_signature(part: &Value) -> bool {
    part.get("thoughtSignature").and_then(Value::as_str).is_some_and(|s| !s.is_empty() && s != SIGNATURE_SENTINEL)
}

/// `coalesceClaudeThoughts`: each run of thought deltas becomes one block that ends at its signature.
fn coalesce_claude_thoughts(parts: Vec<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut open: Option<Map<String, Value>> = None;
    for part in parts {
        let Some(map) = part.as_object().filter(|_| is_thought(&part)) else {
            out.extend(open.take().map(Value::Object));
            out.push(part);
            continue;
        };
        let text = map.get("text").and_then(Value::as_str).unwrap_or_default().to_owned();
        let mut block = match open.take() {
            // `{ ...open, ...part, text: open.text + partText }`
            Some(mut block) => {
                let joined = format!("{}{text}", block.get("text").and_then(Value::as_str).unwrap_or_default());
                block.extend(map.clone());
                block.insert("text".into(), joined.into());
                block
            }
            None => {
                let mut block = map.clone();
                block.insert("text".into(), text.into());
                block
            }
        };
        if map.get("thoughtSignature").is_some_and(Value::is_string) {
            out.push(Value::Object(std::mem::take(&mut block)));
        } else {
            open = Some(block);
        }
    }
    out.extend(open.map(Value::Object));
    out
}

/// `claudeReplayParts` (antigravity-request.mjs:117-127): only a signature this route recorded is replayed, the empty
/// text parts around calls go, thought runs are rejoined, and a thought block left unsigned is dropped.
fn claude_replay_parts(parts: Vec<Value>, own: bool) -> Vec<Value> {
    let signed = parts.into_iter().map(|mut part| {
        let keep = own && own_claude_signature(&part);
        if let Some(map) = part.as_object_mut()
            && map.contains_key("thoughtSignature")
            && !keep
        {
            map.shift_remove("thoughtSignature");
        }
        part
    });
    // `isEmptyPlainTextPart`: the Claude bridge rejects an empty text part on replay.
    let kept = signed
        .filter(|part| !(part.get("text").and_then(Value::as_str) == Some("") && !is_thought(part) && !part.get("thoughtSignature").is_some_and(Value::is_string)))
        .collect();
    coalesce_claude_thoughts(kept).into_iter().filter(|part| !is_thought(part) || own_claude_signature(part)).collect()
}

fn model_content(
    message: &Message,
    dialect: &Dialect,
    model: &str,
    traits: &dyn ModelTraits,
) -> Result<Option<Value>, ProviderError> {
    let own = if dialect.family_gated { antigravity_own_parts(message, dialect, model) } else { replayed_parts(message, dialect, model, traits) };
    let recorded = own.is_some();
    let mut parts = if let Some(parts) = own {
        parts
    } else {
        let mut parts = content_parts(&message.content)?;
        for call in &message.tool_calls {
            let mut function_call = json!({ "name": call.name, "args": call.arguments });
            if !call.id.is_empty() {
                function_call["id"] = json!(call.id);
            }
            parts.push(json!({ "functionCall": function_call }));
        }
        parts
    };
    if dialect.family_gated {
        if antigravity_claude(model) {
            // A turn that held only empty or dropped parts is omitted, not sent as `parts: []`.
            parts = claude_replay_parts(parts, recorded);
        }
        // Signatures this route recorded are kept; a thought or signed part with no recorded signature carries
        // the recovery sentinel, and a missing one is never made up.
        for part in &mut parts {
            let signed = part.get("thoughtSignature").is_some_and(Value::is_string);
            if (is_thought(part) || signed)
                && (!recorded || !part.get("thoughtSignature").and_then(Value::as_str).is_some_and(|s| !s.is_empty()))
            {
                part["thoughtSignature"] = json!(SIGNATURE_SENTINEL);
            }
        }
    }
    if !dialect.function_ids {
        strip_ids(&mut parts);
    }
    Ok((!parts.is_empty()).then(|| json!({ "role": "model", "parts": parts })))
}

fn is_tool_result_turn(content: &Value) -> bool {
    content["role"] == "user"
        && content["parts"].as_array().is_some_and(|parts| parts.iter().any(|p| p.get("functionResponse").is_some_and(|r| !r.is_null())))
}

fn has_signed_thinking(content: &Value) -> bool {
    content["parts"].as_array().is_some_and(|parts| parts.iter().any(|p| is_thought(p) && own_claude_signature(p)))
}

/// `closeUnthoughtToolLoop` (antigravity-request.mjs:180-208): with thinking on, a tool loop whose turn did not open
/// with signed thinking is closed on the wire: the closed part loses its thinking, a model reply acknowledges the
/// results and a user nudge opens a fresh turn, after the results of the turn's last unthought model message.
fn close_unthought_tool_loop(contents: Vec<Value>) -> Vec<Value> {
    if !contents.last().is_some_and(is_tool_result_turn) {
        return contents;
    }
    let start = contents.iter().rposition(|c| c["role"] == "user" && !is_tool_result_turn(c)).map_or(0, |p| p + 1);
    let models: Vec<usize> = (start..contents.len()).filter(|i| contents[*i]["role"] == "model").collect();
    let Some(&first) = models.first() else { return contents };
    if has_signed_thinking(&contents[first]) {
        return contents;
    }
    let unthought = models.iter().rev().copied().find(|i| !has_signed_thinking(&contents[*i])).unwrap_or(first);
    let mut cut = unthought + 1;
    let mut results = 0;
    while contents.get(cut).is_some_and(is_tool_result_turn) {
        results += contents[cut]["parts"].as_array().map_or(0, |p| p.iter().filter(|x| x.get("functionResponse").is_some_and(|r| !r.is_null())).count());
        cut += 1;
    }
    if results == 0 {
        return contents;
    }
    let mut rest = contents;
    let tail = rest.split_off(cut);
    let mut out: Vec<Value> = rest
        .into_iter()
        .filter_map(|mut content| {
            if content["role"] != "model" {
                return Some(content);
            }
            let parts: Vec<Value> = content["parts"].as_array().cloned().unwrap_or_default().into_iter().filter(|p| !is_thought(p)).collect();
            (!parts.is_empty()).then(|| {
                content["parts"] = Value::Array(parts);
                content
            })
        })
        .collect();
    let ack = if results == 1 { "[Tool result received.]".to_owned() } else { format!("[{results} tool results received.]") };
    out.push(json!({ "role": "model", "parts": [{ "text": ack }] }));
    out.push(json!({ "role": "user", "parts": [{ "text": "[Continue.]" }] }));
    out.extend(tail);
    out
}

/// Used when the gateway declared no output limit for a Claude id (`CLAUDE_MAX_OUTPUT_TOKENS`).
const CLAUDE_MAX_OUTPUT_TOKENS: u32 = 64_000;

/// `claudeGatewayLevel`: Google's ThinkingLevel enum tops out at `high`.
fn claude_gateway_level(value: &str) -> Option<&'static str> {
    match value.to_lowercase().as_str() {
        "xhigh" | "max" | "ultra" | "high" => Some("high"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        _ => None,
    }
}

/// `claudeThinkingConfig` (antigravity-request.mjs:228-243): an explicit token budget as-is, else the effort as
/// `thinkingLevel`; thoughts always included.
fn claude_thinking_config(options: &RequestOptions, cap: u32) -> Result<Map<String, Value>, ProviderError> {
    let mut config = Map::new();
    config.insert("includeThoughts".into(), json!(true));
    let budget = param(options, "thinkingBudget").or_else(|| param(options, "thinkingBudgetTokens"));
    let Some(budget) = budget else {
        let level = match param(options, "thinkingLevel") {
            Some(value) => value.as_str().and_then(claude_gateway_level),
            None => options.effort.as_deref().and_then(claude_gateway_level),
        };
        if let Some(level) = level {
            config.insert("thinkingLevel".into(), json!(level));
        }
        return Ok(config);
    };
    let value = match budget {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => mixdog_js::string_to_number(s),
        _ => f64::NAN,
    };
    if value.fract() != 0.0 || !value.is_finite() || value < 1024.0 || value >= f64::from(cap) {
        return Err(invalid(format!("Antigravity Claude thinkingBudget must be an integer from 1024 to {}.", cap - 1)));
    }
    config.insert("thinkingBudget".into(), json!(value as u64));
    Ok(config)
}

/// The `functionCall` object the request replays for each tool-call id, so
/// the matching result names exactly that call (and carries no id when the
/// recorded part had none).
fn replayed_calls(parts: &[Value], message: &Message, stamp_ids: bool) -> HashMap<String, Value> {
    let calls: Vec<&Value> = parts.iter().filter_map(|p| p.get("functionCall")).collect();
    let mut out = HashMap::new();
    for (index, tc) in message.tool_calls.iter().enumerate() {
        if tc.id.is_empty() {
            continue;
        }
        let found = if calls.len() == message.tool_calls.len() {
            calls.get(index).copied()
        } else {
            calls.iter().copied().find(|c| c.get("id").and_then(Value::as_str) == Some(tc.id.as_str()))
        };
        if let Some(call) = found {
            let mut call = call.clone();
            if stamp_ids {
                call["id"] = json!(tc.id);
            }
            out.insert(tc.id.clone(), call);
        }
    }
    out
}

fn tool_result_parts(
    message: &Message,
    names: &HashMap<String, String>,
    calls: &HashMap<String, Value>,
    function_ids: bool,
) -> Result<Vec<Value>, ProviderError> {
    let call_id = message.tool_call_id.clone().unwrap_or_default();
    let replayed = calls.get(&call_id);
    let name = replayed
        .and_then(|c| c.get("name").and_then(Value::as_str))
        .map(str::to_owned)
        .or_else(|| names.get(&call_id).cloned())
        .unwrap_or_else(|| call_id.clone());
    let media: Vec<Value> = match &message.content {
        Content::Parts(parts) => {
            let mut out = Vec::new();
            for part in parts.iter().filter(|p| !matches!(p, ContentPart::Text(_, _))) {
                out.extend(media_part(part)?);
            }
            out
        }
        Content::Text(_) => Vec::new(),
    };
    let text = text_of(&message.content);
    let text = if text.is_empty() && !media.is_empty() {
        "[tool result included media content]".to_owned()
    } else {
        text
    };
    let key = if message.is_error { "error" } else { "result" };
    let mut response = json!({ "name": name, "response": { key: text } });
    let id = match replayed {
        Some(call) => call.get("id").and_then(Value::as_str).map(str::to_owned),
        None => (!call_id.is_empty()).then_some(call_id),
    };
    if function_ids && let Some(id) = id {
        response["id"] = json!(id);
    }
    let mut out = vec![json!({ "functionResponse": response })];
    out.extend(media);
    Ok(out)
}

fn contents(request: &ModelRequest, dialect: &Dialect, traits: &dyn ModelTraits) -> Result<Vec<Value>, ProviderError> {
    let family = traits.is_gemini_family(&request.model);
    let chat: Vec<&Message> = request.messages.iter().filter(|m| m.role != Role::System).collect();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut calls: HashMap<String, Value> = HashMap::new();
    let mut assistant: HashMap<usize, Option<Value>> = HashMap::new();
    for (i, message) in chat.iter().enumerate() {
        if message.role != Role::Assistant || message.tool_calls.is_empty() {
            continue;
        }
        for tc in &message.tool_calls {
            if !tc.id.is_empty() {
                names.insert(tc.id.clone(), tc.name.clone());
            }
        }
        let content = model_content(message, dialect, &request.model, traits)?;
        if let Some(content) = &content {
            let parts = content["parts"].as_array().cloned().unwrap_or_default();
            calls.extend(replayed_calls(&parts, message, !family));
        }
        assistant.insert(i, content);
    }
    let mut out: Vec<Value> = Vec::new();
    let mut tool_turn: Option<usize> = None;
    for (i, message) in chat.iter().enumerate() {
        if message.role == Role::Tool {
            let parts = tool_result_parts(message, &names, &calls, dialect.function_ids)?;
            let turn = *tool_turn.get_or_insert_with(|| {
                out.push(json!({ "role": "user", "parts": [] }));
                out.len() - 1
            });
            // Every functionResponse first, then the media the results carried.
            let slots = out[turn]["parts"].as_array_mut().expect("parts array");
            let at = slots.iter().take_while(|p| p.get("functionResponse").is_some()).count();
            let mut parts = parts.into_iter();
            if let Some(response) = parts.next() {
                slots.insert(at, response);
            }
            slots.extend(parts);
            continue;
        }
        tool_turn = None;
        let content = match message.role {
            Role::Assistant => match assistant.remove(&i) {
                Some(content) => content,
                None => model_content(message, dialect, &request.model, traits)?,
            },
            _ => {
                let parts = content_parts(&message.content)?;
                (!parts.is_empty()).then(|| json!({ "role": "user", "parts": parts }))
            }
        };
        out.extend(content);
    }
    if !dialect.family_gated || family {
        ensure_signatures(&mut out);
    }
    Ok(out)
}

/// Every model step of the active turn must open its first call with a
/// signature; a history without a real one gets the documented sentinel.
fn ensure_signatures(contents: &mut [Value]) {
    let has = |content: &Value, key: &str| {
        content["parts"].as_array().is_some_and(|p| p.iter().any(|x| x.get(key).is_some()))
    };
    let start = contents
        .iter()
        .rposition(|c| c["role"] == "user" && c["parts"].as_array().is_some_and(|p| !p.is_empty()) && !has(c, "functionResponse"))
        .unwrap_or(0);
    for content in contents.iter_mut().skip(start) {
        if content["role"] != "model" {
            continue;
        }
        let Some(parts) = content["parts"].as_array_mut() else {
            continue;
        };
        let Some(first) = parts.iter_mut().find(|p| p.get("functionCall").is_some()) else {
            continue;
        };
        let signed = ["thoughtSignature", "thought_signature"]
            .iter()
            .any(|k| first.get(*k).and_then(Value::as_str).is_some_and(|s| !s.is_empty()));
        if !signed {
            first["thoughtSignature"] = json!(SIGNATURE_SENTINEL);
        }
    }
}

fn param<'a>(options: &'a RequestOptions, key: &str) -> Option<&'a Value> {
    options.model_parameters.as_ref()?.get(key).filter(|v| !v.is_null())
}

fn thinking_config(
    request: &ModelRequest,
    traits: &dyn ModelTraits,
    include_thoughts: Option<bool>,
) -> Result<Option<Value>, ProviderError> {
    let options = &request.options;
    let model = &request.model;
    let budget = match param(options, "thinkingBudget") {
        None => None,
        Some(v) => Some(v.as_i64().filter(|b| *b >= -1).ok_or_else(|| {
            invalid("thinkingBudget must be -1 (dynamic), 0, or a positive integer.")
        })?),
    };
    let control = traits.thinking(model);
    let norm = |s: &str| s.trim().to_lowercase();
    let explicit = param(options, "thinkingLevel").and_then(Value::as_str).map(norm).filter(|s| !s.is_empty());
    let level = explicit
        .clone()
        .or_else(|| if budget.is_none() { options.effort.as_deref().map(norm) } else { None })
        .filter(|s| !s.is_empty());
    let mut config = Map::new();
    let thoughts = param(options, "includeThoughts").and_then(Value::as_bool).or(include_thoughts);
    if let Some(thoughts) = thoughts {
        config.insert("includeThoughts".into(), json!(thoughts));
    }
    if level.is_some() && budget.is_some() {
        return Err(invalid("Choose thinkingLevel/effort or thinkingBudget, not both."));
    }
    match (&control, &level) {
        (ThinkingControl::Budget(spec), Some(level)) => {
            if explicit.is_some() {
                return Err(invalid(format!(
                    "{model} ({}) does not support thinkingLevel; use thinkingBudget.",
                    spec.name
                )));
            }
            let Some((_, value)) = spec.efforts.iter().find(|(name, _)| name == level) else {
                let known: Vec<&str> = spec.efforts.iter().map(|(n, _)| n.as_str()).collect();
                return Err(invalid(format!(
                    "{model} supports thinking levels {}; received {level}.",
                    known.join(", ")
                )));
            };
            config.insert("thinkingBudget".into(), json!(value));
        }
        (_, Some(level)) => {
            let supported: Vec<String> = match &control {
                ThinkingControl::Levels(levels) => levels.clone(),
                _ => THINKING_LEVELS.iter().map(|s| (*s).to_owned()).collect(),
            };
            if !supported.contains(level) {
                return Err(invalid(format!(
                    "{model} supports thinking levels {}; received {level}.",
                    supported.join(", ")
                )));
            }
            config.insert("thinkingLevel".into(), json!(level));
        }
        _ => {}
    }
    if let Some(budget) = budget {
        if let ThinkingControl::Budget(spec) = &control
            && budget != -1
        {
            if budget == 0 && !spec.can_disable {
                return Err(invalid(format!(
                    "{model} ({}) cannot disable thinking; thinkingBudget 0 is not allowed.",
                    spec.name
                )));
            }
            if budget != 0 && (budget < spec.min || budget > spec.max) {
                return Err(invalid(format!(
                    "{model} ({}) thinkingBudget must be -1, {}{}–{}; received {budget}.",
                    spec.name,
                    if spec.can_disable { "0, or " } else { "" },
                    spec.min,
                    spec.max
                )));
            }
        }
        config.insert("thinkingBudget".into(), json!(budget));
    }
    Ok((!config.is_empty()).then_some(Value::Object(config)))
}

fn max_output_tokens(options: &RequestOptions) -> Option<u32> {
    match (options.max_output_tokens_override, options.model_max_output_tokens) {
        (Some(requested), Some(ceiling)) => Some(requested.min(ceiling)),
        (requested, ceiling) => requested.or(ceiling),
    }
}

fn tool_config(options: &RequestOptions, default_mode: Option<&str>) -> Option<Value> {
    let config = |mode: &str| json!({ "functionCallingConfig": { "mode": mode } });
    match options.tool_choice.as_deref() {
        Some("auto") => Some(config("AUTO")),
        Some("required") => Some(config("ANY")),
        Some("none") => Some(config("NONE")),
        Some(name) if !name.is_empty() => Some(json!({
            "functionCallingConfig": { "mode": "ANY", "allowedFunctionNames": [name] }
        })),
        _ => default_mode.map(config),
    }
}

/// `isAntigravityClaude`: a Claude model served through the Antigravity gateway.
pub fn antigravity_claude(model: &str) -> bool {
    model.as_bytes().get(..7).is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"claude-"))
}

/// The Gemini-shaped request object for `request`.
pub fn build_request(
    request: &ModelRequest,
    dialect: &Dialect,
    traits: &dyn ModelTraits,
) -> Result<Value, ProviderError> {
    let family = traits.is_gemini_family(&request.model);
    let gemini_fields = !dialect.family_gated || family;
    let mut contents = contents(request, dialect, traits)?;
    if contents.is_empty() {
        return Err(invalid("No messages to send"));
    }
    // A Claude model behind Antigravity: its own output cap and thinking config, and with thinking on, an unthought
    // tool loop closed on the wire (`buildAntigravityRequest`, antigravity-request.mjs:236-252). The tail reminder is
    // not history: the closure sees the real tail and the reminder stays last.
    let claude = dialect.family_gated && antigravity_claude(&request.model);
    let claude_generation = if claude {
        let cap = request.options.model_max_output_tokens.filter(|n| *n > 0).unwrap_or(CLAUDE_MAX_OUTPUT_TOKENS);
        let thinking = claude_thinking_config(&request.options, cap)?;
        let thinks = thinking.contains_key("thinkingLevel")
            || thinking.contains_key("thinkingBudget")
            || request.model.len().checked_sub(9).and_then(|at| request.model.get(at..)).is_some_and(|tail| tail.eq_ignore_ascii_case("-thinking"));
        if thinks {
            let reminder = request
                .messages
                .last()
                .is_some_and(|m| m.role == Role::User && m.source == Some(MessageSource::TailReminder) && !text_of(&m.content).is_empty())
                .then(|| contents.pop())
                .flatten();
            contents = close_unthought_tool_loop(contents);
            contents.extend(reminder);
        }
        let mut generation = Map::new();
        generation.insert("maxOutputTokens".into(), json!(cap));
        generation.insert("thinkingConfig".into(), Value::Object(thinking));
        Some(generation)
    } else {
        None
    };
    let system: Vec<String> = request
        .messages
        .iter()
        .filter(|m| m.role == Role::System)
        .map(|m| text_of(&m.content))
        .collect();
    let system = system.join("\n\n");
    let mut body = Map::new();
    body.insert("contents".into(), Value::Array(contents));
    if !system.is_empty() {
        // `role` first, as Node writes it: the body's bytes are compared.
        let mut instruction = Map::new();
        if let Some(role) = dialect.system_role {
            instruction.insert("role".into(), json!(role));
        }
        instruction.insert("parts".into(), json!([{ "text": system }]));
        body.insert("systemInstruction".into(), Value::Object(instruction));
    }
    // A Gemini endpoint rejects the whole request for one bad declaration, so a Gemini-family
    // model's tools are checked (a tool it would reject is left out and reported); a Claude model
    // behind Antigravity gets the 2020-12 schema its Anthropic bridge takes; another family behind
    // the same endpoint keeps the plain conversion (`toGeminiTools`' options).
    let mode = if dialect.family_gated && antigravity_claude(&request.model) {
        tool_accept::Declarations::ClaudeBridge
    } else if gemini_fields {
        tool_accept::Declarations::Validated
    } else {
        tool_accept::Declarations::Plain
    };
    let declarations = tool_accept::function_declarations(&request.tools, mode, &mut |excluded| {
        report_exclusion(&request.options, excluded)
    });
    // Hosted tools ahead of the one function-declaration entry (`toGeminiRequestTools`, gemini-schema.mjs:805-810); the
    // tool config only accompanies kept declarations.
    let mut tools = crate::providers::hosted::gemini_tools(&request.options);
    if !declarations.is_empty() {
        tools.push(json!({ "functionDeclarations": declarations }));
    }
    if !tools.is_empty() {
        body.insert("tools".into(), Value::Array(tools));
    }
    if !declarations.is_empty()
        && let Some(config) = tool_config(&request.options, dialect.default_tool_mode)
    {
        body.insert("toolConfig".into(), config);
    }
    if let Some(generation) = claude_generation {
        body.insert("generationConfig".into(), Value::Object(generation));
        return Ok(Value::Object(body));
    }
    let mut generation = Map::new();
    if let Some(thinking) = thinking_config(request, traits, gemini_fields.then_some(true))? {
        generation.insert("thinkingConfig".into(), thinking);
    }
    if gemini_fields && let Some(max) = max_output_tokens(&request.options) {
        generation.insert("maxOutputTokens".into(), json!(max));
    }
    if let Some(temperature) = request.options.temperature.map(Temperature::get) {
        if !(0.0..=2.0).contains(&temperature) {
            return Err(invalid("temperature must be a number between 0 and 2."));
        }
        if !(dialect.omit_ignored_sampling && ignores_sampling(&request.model)) {
            generation.insert("temperature".into(), json!(temperature));
        }
    }
    if !generation.is_empty() {
        body.insert("generationConfig".into(), Value::Object(generation));
    }
    Ok(Value::Object(body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mixdog_core_api::domain::provider::ToolCall;
    use mixdog_core_api::domain::provider::ToolDefinition;

    struct AllGemini;
    impl ModelTraits for AllGemini {
        fn is_gemini_family(&self, _: &str) -> bool {
            true
        }
        fn thinking(&self, _: &str) -> ThinkingControl {
            ThinkingControl::Unspecified
        }
    }

    fn dialect() -> Dialect {
        Dialect {
            owner: ProviderId::from("gemini"),
            system_role: Some("system"),
            function_ids: true,
            family_gated: false,
            replay_same_model: true,
            default_tool_mode: None,
            omit_ignored_sampling: false,
        }
    }

    fn msg(role: Role, text: &str) -> Message {
        Message::new(role, Content::Text(text.into()))
    }

    #[test]
    fn tool_loop_pairs_calls_results_and_signs_the_active_turn() {
        let mut call = msg(Role::Assistant, "");
        call.tool_calls.push(ToolCall {
            id: "gemini_abc".into(),
            name: "lookup".into(),
            arguments: json!({"key": "answer"}),
            native_type: None,
        });
        let mut result = msg(Role::Tool, "42");
        result.tool_call_id = Some("gemini_abc".into());
        let request = ModelRequest {
            model: "gemini-2.5-pro".into(),
            messages: vec![msg(Role::User, "Look up the answer."), call, result],
            tools: vec![ToolDefinition {
                name: "lookup".into(),
                description: "Read a value".into(),
                input_schema: json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]}),
                defer_loading: false,
                freeform: None,
            }],
            options: RequestOptions::default(),
        };
        let body = build_request(&request, &dialect(), &AllGemini).unwrap();
        assert_eq!(
            body["contents"][1]["parts"][0],
            json!({
                "functionCall": {"name": "lookup", "args": {"key": "answer"}, "id": "gemini_abc"},
                "thoughtSignature": SIGNATURE_SENTINEL
            })
        );
        assert_eq!(
            body["contents"][2],
            json!({"role": "user", "parts": [{"functionResponse": {
                "name": "lookup", "response": {"result": "42"}, "id": "gemini_abc"
            }}]})
        );
        let mut vertex = dialect();
        vertex.function_ids = false;
        let body = build_request(&request, &vertex, &AllGemini).unwrap();
        assert!(body["contents"][1]["parts"][0]["functionCall"].get("id").is_none());
        assert!(body["contents"][2]["parts"][0]["functionResponse"].get("id").is_none());
    }

    struct NoGemini;
    impl ModelTraits for NoGemini {
        fn is_gemini_family(&self, _: &str) -> bool {
            false
        }
        fn thinking(&self, _: &str) -> ThinkingControl {
            ThinkingControl::Unspecified
        }
    }

    /// One bad declaration rejects the whole request: a Gemini-family model's tool whose schema
    /// cannot be made valid is left out (the others and the tool config stay), and a model of
    /// another family behind the same endpoint keeps the plain conversion.
    #[test]
    fn a_tool_gemini_would_reject_is_left_out_of_the_request() {
        let tool = |name: &str, schema: Value| ToolDefinition {
            name: name.into(),
            description: String::new(),
            input_schema: schema,
            defer_loading: false,
            freeform: None,
        };
        let good = json!({"type":"object","properties":{"key":{"type":"string"}},"required":["key"]});
        let dangling = json!({"type":"object","properties":{"x":{"$ref":"#/$defs/missing"}}});
        let request = |tools: Vec<ToolDefinition>| ModelRequest {
            model: "some-model".into(),
            messages: vec![msg(Role::User, "hi")],
            tools,
            options: RequestOptions::default(),
        };
        let both = request(vec![tool("good", good.clone()), tool("dangling", dangling.clone())]);
        let body = build_request(&both, &dialect(), &AllGemini).unwrap();
        let names: Vec<&str> = body["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["good"]);

        let only_bad = request(vec![tool("dangling", dangling.clone())]);
        let body = build_request(&only_bad, &dialect(), &AllGemini).unwrap();
        assert!(body.get("tools").is_none() && body.get("toolConfig").is_none(), "no tool is left");

        let mut gated = dialect();
        gated.family_gated = true;
        let body = build_request(&both, &gated, &NoGemini).unwrap();
        let names: Vec<&str> = body["tools"][0]["functionDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["good", "dangling"], "another family is not validated");
    }

    #[test]
    fn thinking_and_output_cap() {
        let mut request = ModelRequest {
            model: "gemini-3-pro".into(),
            messages: vec![msg(Role::User, "hi")],
            tools: vec![],
            options: RequestOptions {
                effort: Some("High".into()),
                model_max_output_tokens: Some(8192),
                max_output_tokens_override: Some(100_000),
                ..RequestOptions::default()
            },
        };
        let body = build_request(&request, &dialect(), &AllGemini).unwrap();
        assert_eq!(
            body["generationConfig"],
            json!({"thinkingConfig": {"includeThoughts": true, "thinkingLevel": "high"}, "maxOutputTokens": 8192})
        );
        request.options.effort = Some("extreme".into());
        assert_eq!(build_request(&request, &dialect(), &AllGemini).unwrap_err().kind, ErrorKind::InvalidRequest);
    }
}
