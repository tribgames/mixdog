//! The model proxy (DS §12.4): a server core runs its model calls on a PC with that PC's accounts.
//! This module holds both ends over the typed wire (`mixdog_app_protocol::v2::model_proxy`):
//!
//! - the conversions between the wire shapes and the core-api request, event and error types;
//! - [`ProxyRunner`], the PC end (`modelProxy/run`): looks the provider up by name and sends through
//!   the PC's own `ModelBroker`, streaming the events of every attempt;
//! - [`remote_send`] and [`ProxyListing`], the server end: the call over a [`ModelProxyTransport`],
//!   its events fed to the caller's `AttemptSink`, and the PC's model listing as a `ModelListing`.
//!
//! Retries belong to the PC's broker, once; the server end never retries a proxied send.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use mixdog_ai::admission::{AdmissionRequest, LaneKey, process_lane_settings};
use mixdog_ai::broker::{AttemptSink, ModelBroker, ModelProxyTransport, ProxyError, SendError, SendRequest};
use mixdog_ai::registry::providers::ProviderRegistry;
use mixdog_ai::service::model_proxy::{redacted_text, without_attachment_references};
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, MODEL_PROXY_INLINE_MAX_BYTES, ReadError, inline_attachments};
use mixdog_app_protocol::v2::model_proxy as w;
use mixdog_core_api::domain::keepalive::TransportKind;
use mixdog_core_api::domain::provider as p;
use mixdog_core_api::ids::{ThreadId, TurnId};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

const MAX_ERROR_TEXT: usize = 16 * 1024;

/// A wire request that cannot be run.
#[derive(Debug, PartialEq)]
pub struct Invalid(pub String);

// -- request: typed → wire ------------------------------------------------------------------

fn replay_out(r: &p::ProviderReplay) -> w::ProxyReplay {
    w::ProxyReplay { owner: r.owner.to_string(), items: r.items.clone() }
}

fn tool_call_out(c: &p::ToolCall) -> w::ProxyToolCall {
    w::ProxyToolCall { id: c.id.clone(), name: c.name.clone(), arguments: c.arguments.clone(), native_type: c.native_type.clone() }
}

fn tool_call_in(c: w::ProxyToolCall) -> p::ToolCall {
    p::ToolCall { id: c.id, name: c.name, arguments: c.arguments, native_type: c.native_type }
}

fn progress_out(kind: p::ProgressKind) -> w::ProxyProgress {
    match kind {
        p::ProgressKind::Semantic => w::ProxyProgress::Semantic,
        p::ProgressKind::Reasoning => w::ProxyProgress::Reasoning,
        p::ProgressKind::Text => w::ProxyProgress::Text,
        p::ProgressKind::Tool => w::ProxyProgress::Tool,
    }
}

fn progress_in(kind: w::ProxyProgress) -> p::ProgressKind {
    match kind {
        w::ProxyProgress::Semantic => p::ProgressKind::Semantic,
        w::ProxyProgress::Reasoning => p::ProgressKind::Reasoning,
        w::ProxyProgress::Text => p::ProgressKind::Text,
        w::ProxyProgress::Tool => p::ProgressKind::Tool,
    }
}

fn phase_out(ph: p::Phase) -> w::ProxyPhase {
    match ph {
        p::Phase::Commentary => w::ProxyPhase::Commentary,
        p::Phase::FinalAnswer => w::ProxyPhase::FinalAnswer,
    }
}

fn part_out(part: &p::ContentPart) -> w::ProxyPart {
    match part {
        p::ContentPart::Text(text, _) => w::ProxyPart::Text { text: text.clone() },
        p::ContentPart::Image(source) => w::ProxyPart::Image {
            source: match source {
                p::ImageSource::Base64 { data, mime_type } => w::ProxyImage::Base64 { data: data.clone(), mime_type: mime_type.clone() },
                p::ImageSource::Url(url) => w::ProxyImage::Url { url: url.clone() },
                p::ImageSource::FileId(id) => w::ProxyImage::FileId { id: id.clone() },
            },
        },
        p::ContentPart::File { source, mime_type, filename, .. } => w::ProxyPart::File {
            source: match source {
                p::BinarySource::Base64(data) => w::ProxyBinary::Base64 { data: data.clone() },
                // A reference past the sender's inline budget (or unreadable) stays a reference.
                p::BinarySource::AttachmentRef(_) => w::ProxyBinary::Unavailable,
            },
            mime_type: mime_type.clone(),
            filename: filename.clone(),
        },
        p::ContentPart::Document { source, title } => w::ProxyPart::Document {
            source: match source {
                p::DocumentSource::Base64 { media_type, data } => w::ProxyDocument::Base64 { media_type: media_type.clone(), data: data.clone() },
                p::DocumentSource::Text { media_type, data } => w::ProxyDocument::Text { media_type: media_type.clone(), data: data.clone() },
                p::DocumentSource::Content(content) => w::ProxyDocument::Content { content: content.clone() },
            },
            title: title.clone(),
        },
    }
}

fn message_out(m: &p::Message) -> w::ProxyMessage {
    w::ProxyMessage {
        role: match m.role {
            p::Role::System => w::ProxyRole::System,
            p::Role::User => w::ProxyRole::User,
            p::Role::Assistant => w::ProxyRole::Assistant,
            p::Role::Tool => w::ProxyRole::Tool,
            p::Role::Developer => w::ProxyRole::Developer,
        },
        content: match &m.content {
            p::Content::Text(t) => w::ProxyContent::Text(t.clone()),
            p::Content::Parts(parts) => w::ProxyContent::Parts(parts.iter().map(part_out).collect()),
        },
        cache_tier: m.cache_tier.map(|t| match t {
            p::CacheTier::Tier3 => w::ProxyCacheTier::Tier3,
            p::CacheTier::Env => w::ProxyCacheTier::Env,
        }),
        tool_calls: m.tool_calls.iter().map(tool_call_out).collect(),
        tool_call_id: m.tool_call_id.clone(),
        is_error: m.is_error,
        phase: m.phase.map(phase_out),
        thinking_blocks: m.thinking_blocks.clone(),
        assistant_blocks: m.assistant_blocks.clone(),
        native_tool_search: m.native_tool_search.clone(),
        source: m.source.map(|s| match s {
            p::MessageSource::Steering => w::ProxyMessageSource::Steering,
            p::MessageSource::StreamCutRecovery => w::ProxyMessageSource::StreamCutRecovery,
            p::MessageSource::TailReminder => w::ProxyMessageSource::TailReminder,
        }),
        turn_reminder: m.turn_reminder.clone(),
        provider_replay: m.provider_replay().iter().map(replay_out).collect(),
    }
}

fn options_out(o: &p::RequestOptions) -> w::ProxyOptions {
    w::ProxyOptions {
        session_id: o.session_id.clone(),
        effort: o.effort.clone(),
        max_output_tokens_override: o.max_output_tokens_override,
        fast: o.fast,
        tool_choice: o.tool_choice.clone(),
        verbosity: o.verbosity.clone(),
        request_kind: o.request_kind.clone(),
        iteration: o.iteration,
        prompt_cache_key: o.prompt_cache_key.clone(),
        prompt_cache_scope: o.prompt_cache_scope.clone(),
        xai_responses_cache_scope: o.xai_responses_cache_scope.clone(),
        model_parameters: o.model_parameters.clone(),
        thread: o.thread.as_ref().map(|t| w::ProxyThread { id: t.id.to_string(), window: t.window, turn: t.turn.as_ref().map(ToString::to_string) }),
        parent_session_id: o.parent_session_id.clone(),
        parallel_tool_calls: o.parallel_tool_calls,
        temperature: o.temperature.map(p::Temperature::get),
        effort_projection: o.effort_projection.as_ref().map(|e| w::ProxyEffortProjection {
            initial_effort: e.initial_effort.clone(),
            updates: e.updates.iter().map(|(i, v)| (u32::try_from(*i).unwrap_or(u32::MAX), v.clone())).collect(),
        }),
        hosted_tools: o
            .hosted_tools
            .iter()
            .map(|p::HostedTool::WebSearch(s)| w::ProxyHostedTool::WebSearch {
                tool_type: s.tool_type.clone(),
                allowed_domains: s.allowed_domains.clone(),
                user_location: s.user_location.as_ref().map(|l| w::ProxyLocation {
                    country: l.country.clone(),
                    region: l.region.clone(),
                    city: l.city.clone(),
                    timezone: l.timezone.clone(),
                }),
                max_uses: s.max_uses,
                context_size: s.context_size.clone(),
                include_sources: s.include_sources,
            })
            .collect(),
        shared_cache_prefix_count: o.shared_cache_prefix_count.map(|n| u32::try_from(n).unwrap_or(u32::MAX)),
        provider_state: o.provider_state.as_ref().map(p::ProviderState::to_json),
    }
}

pub fn request_out(r: &p::ModelRequest) -> w::ProxyRequest {
    w::ProxyRequest {
        model: r.model.clone(),
        messages: r.messages.iter().map(message_out).collect(),
        tools: r
            .tools
            .iter()
            .map(|t| w::ProxyTool { name: t.name.clone(), description: t.description.clone(), input_schema: t.input_schema.clone(), defer_loading: t.defer_loading })
            .collect(),
        options: options_out(&r.options),
    }
}

// -- request: wire → typed (the PC side) ----------------------------------------------------

/// `[attachment unavailable: <name>]`, the text a stored attachment missing here lowers to
/// (model-proxy-host.ts `unavailableAttachment`).
fn unavailable_text(filename: Option<&str>, mime_type: &str) -> String {
    let name = filename.map(|f| f.rsplit(['/', '\\']).next().unwrap_or("")).unwrap_or("");
    let label = [name, mime_type, "file"].into_iter().find(|v| !v.is_empty()).unwrap_or("file");
    let label: String = label.chars().map(|c| if c.is_control() || c == ']' { '_' } else { c }).collect();
    format!("[attachment unavailable: {}]", label.chars().take(200).collect::<String>())
}

/// A free-form JSON field with every attachment reference lowered to its "unavailable" text.
fn plain_json(value: Value) -> Result<Value, Invalid> {
    without_attachment_references(&value, 0).map_err(|r| Invalid(r.message))
}

fn part_in(part: w::ProxyPart) -> Result<p::ContentPart, Invalid> {
    Ok(match part {
        w::ProxyPart::Text { text } => p::ContentPart::Text(text, None),
        w::ProxyPart::Image { source } => p::ContentPart::Image(match source {
            w::ProxyImage::Base64 { data, mime_type } => p::ImageSource::Base64 { data, mime_type },
            w::ProxyImage::Url { url } => p::ImageSource::Url(url),
            w::ProxyImage::FileId { id } => p::ImageSource::FileId(id),
        }),
        w::ProxyPart::File { source: w::ProxyBinary::Unavailable, mime_type, filename } => {
            p::ContentPart::Text(unavailable_text(filename.as_deref(), &mime_type), None)
        }
        w::ProxyPart::File { source: w::ProxyBinary::Base64 { data }, mime_type, filename } => {
            p::ContentPart::File { source: p::BinarySource::Base64(data), mime_type, filename, text: None }
        }
        w::ProxyPart::Document { source, title } => p::ContentPart::Document {
            source: match source {
                w::ProxyDocument::Base64 { media_type, data } => p::DocumentSource::Base64 { media_type, data },
                w::ProxyDocument::Text { media_type, data } => p::DocumentSource::Text { media_type, data },
                w::ProxyDocument::Content { content } => p::DocumentSource::Content(plain_json(content)?),
            },
            title,
        },
    })
}

fn message_in(m: w::ProxyMessage) -> Result<p::Message, Invalid> {
    let content = match m.content {
        w::ProxyContent::Text(t) => p::Content::Text(t),
        w::ProxyContent::Parts(parts) => p::Content::Parts(parts.into_iter().map(part_in).collect::<Result<_, _>>()?),
    };
    let role = match m.role {
        w::ProxyRole::System => p::Role::System,
        w::ProxyRole::User => p::Role::User,
        w::ProxyRole::Assistant => p::Role::Assistant,
        w::ProxyRole::Tool => p::Role::Tool,
        w::ProxyRole::Developer => p::Role::Developer,
    };
    let mut out = p::Message::new(role, content);
    out.cache_tier = m.cache_tier.map(|t| match t {
        w::ProxyCacheTier::Tier3 => p::CacheTier::Tier3,
        w::ProxyCacheTier::Env => p::CacheTier::Env,
    });
    out.tool_calls = m
        .tool_calls
        .into_iter()
        .map(|c| Ok(p::ToolCall { id: c.id, name: c.name, arguments: plain_json(c.arguments)?, native_type: c.native_type }))
        .collect::<Result<_, Invalid>>()?;
    out.tool_call_id = m.tool_call_id;
    out.is_error = m.is_error;
    out.phase = m.phase.map(|ph| match ph {
        w::ProxyPhase::Commentary => p::Phase::Commentary,
        w::ProxyPhase::FinalAnswer => p::Phase::FinalAnswer,
    });
    out.thinking_blocks = m.thinking_blocks.map(plain_json).transpose()?;
    out.assistant_blocks = m.assistant_blocks.map(plain_json).transpose()?;
    out.native_tool_search = m.native_tool_search.map(plain_json).transpose()?;
    out.source = m.source.map(|s| match s {
        w::ProxyMessageSource::Steering => p::MessageSource::Steering,
        w::ProxyMessageSource::StreamCutRecovery => p::MessageSource::StreamCutRecovery,
        w::ProxyMessageSource::TailReminder => p::MessageSource::TailReminder,
    });
    out.turn_reminder = m.turn_reminder;
    for r in m.provider_replay {
        out.push_replay(p::ProviderReplay { owner: r.owner.as_str().into(), items: plain_json(r.items)? });
    }
    Ok(out)
}

fn options_in(o: w::ProxyOptions) -> Result<p::RequestOptions, Invalid> {
    Ok(p::RequestOptions {
        session_id: o.session_id,
        // The connection scope and the model's output ceiling are this PC's to derive.
        transport_scope: None,
        effort: o.effort,
        model_max_output_tokens: None,
        // The proxy wire does not carry the session's wire pin (Node's `options.session.wireRoute`): this PC's
        // gateway routes the model afresh.
        wire_pin: None,
        max_output_tokens_override: o.max_output_tokens_override,
        fast: o.fast,
        tool_choice: o.tool_choice,
        verbosity: o.verbosity,
        request_kind: o.request_kind,
        iteration: o.iteration,
        prompt_cache_key: o.prompt_cache_key,
        prompt_cache_scope: o.prompt_cache_scope,
        xai_responses_cache_scope: o.xai_responses_cache_scope,
        model_parameters: o.model_parameters,
        thread: o.thread.map(|t| p::RequestThread { id: ThreadId::from(t.id.as_str()), window: t.window, turn: t.turn.map(|t| TurnId::from(t.as_str())), turn_started_at_ms: None }),
        parent_session_id: o.parent_session_id,
        parallel_tool_calls: o.parallel_tool_calls,
        temperature: match o.temperature {
            None => None,
            Some(t) => Some(p::Temperature::new(t).ok_or_else(|| Invalid(format!("invalid temperature {t}")))?),
        },
        effort_projection: o.effort_projection.map(|e| p::EffortProjection {
            initial_effort: e.initial_effort,
            updates: e.updates.into_iter().map(|(i, v)| (i as usize, v)).collect(),
        }),
        hosted_tools: o
            .hosted_tools
            .into_iter()
            .map(|w::ProxyHostedTool::WebSearch { tool_type, allowed_domains, user_location, max_uses, context_size, include_sources }| {
                p::HostedTool::WebSearch(p::HostedWebSearch {
                    tool_type,
                    allowed_domains,
                    user_location: user_location.map(|l| p::UserLocation { country: l.country, region: l.region, city: l.city, timezone: l.timezone }),
                    max_uses,
                    context_size,
                    include_sources,
                })
            })
            .collect(),
        shared_cache_prefix_count: o.shared_cache_prefix_count.map(|n| n as usize),
        provider_state: match o.provider_state {
            None => None,
            Some(v) => Some(serde_json::from_value(v).map_err(|e| Invalid(format!("invalid providerState: {e}")))?),
        },
        // A group names the loop's own retries on this PC; a remote request carries none.
        send_group: None,
        usage_session_id: None,
        source_type: None,
        // The remote adapter's exclusions are the remote PC's to record.
        on_tool_excluded: None,
    })
}

pub fn request_in(r: w::ProxyRequest) -> Result<p::ModelRequest, Invalid> {
    Ok(p::ModelRequest {
        model: r.model,
        messages: r.messages.into_iter().map(message_in).collect::<Result<_, _>>()?,
        tools: r
            .tools
            .into_iter()
            .map(|t| p::ToolDefinition { name: t.name, description: t.description, input_schema: t.input_schema, defer_loading: t.defer_loading, freeform: None })
            .collect(),
        options: options_in(r.options)?,
    })
}

// -- events ---------------------------------------------------------------------------------

fn usage_out(u: &p::Usage) -> w::ProxyUsage {
    w::ProxyUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: u.cache_write_tokens,
        cache_write_1h_tokens: u.cache_write_1h_tokens,
        reasoning_tokens: u.reasoning_tokens,
        reasoning_incomplete: u.reasoning_incomplete,
        raw: u.raw.clone(),
        cost_ticks: u.cost.map(|c| c.0),
    }
}

fn usage_in(u: w::ProxyUsage) -> p::Usage {
    p::Usage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_tokens,
        cache_write_tokens: u.cache_write_tokens,
        cache_write_1h_tokens: u.cache_write_1h_tokens,
        reasoning_tokens: u.reasoning_tokens,
        reasoning_incomplete: u.reasoning_incomplete,
        raw: u.raw,
        cost: u.cost_ticks.map(p::UsdTicks),
    }
}

pub fn event_out(e: &p::StreamEvent) -> w::ProxyEvent {
    use p::StreamEvent as E;
    match e {
        E::ItemStart { kind, phase } => w::ProxyEvent::ItemStart {
            item: match kind {
                p::ItemKind::Text => w::ProxyItemKind::Text,
                p::ItemKind::Reasoning => w::ProxyItemKind::Reasoning,
                p::ItemKind::Tool => w::ProxyItemKind::Tool,
            },
            phase: phase.map(phase_out),
        },
        E::TextDelta(text) => w::ProxyEvent::TextDelta { text: text.clone() },
        E::ReasoningDelta(text) => w::ProxyEvent::ReasoningDelta { text: text.clone() },
        E::ReasoningReplay(r) => w::ProxyEvent::ReasoningReplay { replay: replay_out(r) },
        E::ToolCallStart { id, name } => w::ProxyEvent::ToolCallStart { id: id.clone(), name: name.clone() },
        E::ToolCallArgsDelta { id, delta } => w::ProxyEvent::ToolCallArgsDelta { id: id.clone(), delta: delta.clone() },
        E::ToolCallDone(call) => w::ProxyEvent::ToolCallDone { call: tool_call_out(call) },
        E::Usage(u) => w::ProxyEvent::Usage { usage: usage_out(u) },
        E::Refusal(text) => w::ProxyEvent::Refusal { text: text.clone() },
        E::Citation(value) => w::ProxyEvent::Citation { value: value.clone() },
        E::ServerToolBlock(value) => w::ProxyEvent::ServerToolBlock { value: value.clone() },
        E::ProviderKeepalive => w::ProxyEvent::ProviderKeepalive,
        E::Progress(kind) => w::ProxyEvent::Progress { kind: progress_out(*kind) },
        E::ChunkProgress(kind) => w::ProxyEvent::ChunkProgress { kind: kind.map(progress_out) },
        E::FinalContent(text) => w::ProxyEvent::FinalContent { text: text.clone() },
        E::ReturnedCalls(calls) => w::ProxyEvent::ReturnedCalls { calls: calls.iter().map(tool_call_out).collect() },
        E::ThinkingBlocks(value) => w::ProxyEvent::ThinkingBlocks { value: value.clone() },
        E::ProviderState(state) => w::ProxyEvent::ProviderState { state: state.to_json() },
        E::Notice { message, warn } => w::ProxyEvent::Notice { message: message.clone(), warn: *warn },
        E::ServedModel(model) => w::ProxyEvent::ServedModel { model: model.clone() },
        E::ProviderMetadata(value) => w::ProxyEvent::ProviderMetadata { value: value.clone() },
        E::ResponseId(id) => w::ProxyEvent::ResponseId { id: id.clone() },
        E::AccountRouting(r) => w::ProxyEvent::AccountRouting {
            provider: r.provider.clone(),
            account_id: r.account_id.clone(),
            session_account_id: r.session_account_id.clone(),
        },
        E::AccountStage(p::AccountStage::Switching { message }) => w::ProxyEvent::AccountSwitching { message: message.clone() },
        E::AccountStage(p::AccountStage::Changed { provider, account_id, at }) => {
            w::ProxyEvent::AccountChanged { provider: provider.clone(), account_id: account_id.clone(), at: *at }
        }
        E::WireRerouted(route) => w::ProxyEvent::WireRerouted { route: route.clone() },
        E::Completed { stop, pricing_model, request_ms } => w::ProxyEvent::Completed {
            pricing_model: pricing_model.clone(),
            request_ms: *request_ms,
            stop: stop.as_ref().map(|s| match s {
                p::StopReason::EndTurn => w::ProxyStop::EndTurn,
                p::StopReason::ToolUse => w::ProxyStop::ToolUse,
                p::StopReason::MaxTokens => w::ProxyStop::MaxTokens,
                p::StopReason::StopSequence => w::ProxyStop::StopSequence,
                p::StopReason::ContentFilter => w::ProxyStop::ContentFilter,
                p::StopReason::Refusal => w::ProxyStop::Refusal,
                p::StopReason::ContinueTurn => w::ProxyStop::ContinueTurn,
                p::StopReason::Other(v) => w::ProxyStop::Other { value: v.clone() },
            }),
        },
    }
}

/// What an incoming event does to the caller's [`AttemptSink`].
#[derive(Debug, PartialEq)]
pub enum Incoming {
    Event(p::StreamEvent),
    Discard,
    Abandoned(p::Usage, Option<String>),
}

pub fn event_in(e: w::ProxyEvent) -> Result<Incoming, String> {
    use p::StreamEvent as E;
    Ok(Incoming::Event(match e {
        w::ProxyEvent::ItemStart { item, phase } => E::ItemStart {
            kind: match item {
                w::ProxyItemKind::Text => p::ItemKind::Text,
                w::ProxyItemKind::Reasoning => p::ItemKind::Reasoning,
                w::ProxyItemKind::Tool => p::ItemKind::Tool,
            },
            phase: phase.map(|ph| match ph {
                w::ProxyPhase::Commentary => p::Phase::Commentary,
                w::ProxyPhase::FinalAnswer => p::Phase::FinalAnswer,
            }),
        },
        w::ProxyEvent::TextDelta { text } => E::TextDelta(text),
        w::ProxyEvent::ReasoningDelta { text } => E::ReasoningDelta(text),
        w::ProxyEvent::ReasoningReplay { replay } => E::ReasoningReplay(p::ProviderReplay { owner: replay.owner.as_str().into(), items: replay.items }),
        w::ProxyEvent::ToolCallStart { id, name } => E::ToolCallStart { id, name },
        w::ProxyEvent::ToolCallArgsDelta { id, delta } => E::ToolCallArgsDelta { id, delta },
        w::ProxyEvent::ToolCallDone { call } => E::ToolCallDone(tool_call_in(call)),
        w::ProxyEvent::Usage { usage } => E::Usage(usage_in(usage)),
        w::ProxyEvent::Refusal { text } => E::Refusal(text),
        w::ProxyEvent::Citation { value } => E::Citation(value),
        w::ProxyEvent::ServerToolBlock { value } => E::ServerToolBlock(value),
        w::ProxyEvent::ProviderKeepalive => E::ProviderKeepalive,
        w::ProxyEvent::Progress { kind } => E::Progress(progress_in(kind)),
        w::ProxyEvent::ChunkProgress { kind } => E::ChunkProgress(kind.map(progress_in)),
        w::ProxyEvent::FinalContent { text } => E::FinalContent(text),
        w::ProxyEvent::ReturnedCalls { calls } => E::ReturnedCalls(calls.into_iter().map(tool_call_in).collect()),
        w::ProxyEvent::ThinkingBlocks { value } => E::ThinkingBlocks(value),
        w::ProxyEvent::ProviderState { state } => E::ProviderState(serde_json::from_value(state).map_err(|e| format!("invalid providerState: {e}"))?),
        w::ProxyEvent::Notice { message, warn } => E::Notice { message, warn },
        w::ProxyEvent::ServedModel { model } => E::ServedModel(model),
        w::ProxyEvent::ProviderMetadata { value } => E::ProviderMetadata(value),
        w::ProxyEvent::ResponseId { id } => E::ResponseId(id),
        w::ProxyEvent::AccountRouting { provider, account_id, session_account_id } => {
            E::AccountRouting(p::AccountRouting { provider, account_id, session_account_id })
        }
        w::ProxyEvent::AccountSwitching { message } => E::AccountStage(p::AccountStage::Switching { message }),
        w::ProxyEvent::AccountChanged { provider, account_id, at } => E::AccountStage(p::AccountStage::Changed { provider, account_id, at }),
        w::ProxyEvent::WireRerouted { route } => E::WireRerouted(route),
        w::ProxyEvent::Completed { stop, pricing_model, request_ms } => E::Completed {
            pricing_model,
            request_ms,
            stop: stop.map(|s| match s {
                w::ProxyStop::EndTurn => p::StopReason::EndTurn,
                w::ProxyStop::ToolUse => p::StopReason::ToolUse,
                w::ProxyStop::MaxTokens => p::StopReason::MaxTokens,
                w::ProxyStop::StopSequence => p::StopReason::StopSequence,
                w::ProxyStop::ContentFilter => p::StopReason::ContentFilter,
                w::ProxyStop::Refusal => p::StopReason::Refusal,
                w::ProxyStop::ContinueTurn => p::StopReason::ContinueTurn,
                w::ProxyStop::Other { value } => p::StopReason::Other(value),
            }),
        },
        w::ProxyEvent::AttemptDiscarded => return Ok(Incoming::Discard),
        w::ProxyEvent::AttemptAbandoned { usage, model } => return Ok(Incoming::Abandoned(usage_in(usage), model)),
    }))
}

// -- failures -------------------------------------------------------------------------------

macro_rules! kinds {
    ($($v:ident),*) => {
        fn kind_out(k: p::ErrorKind) -> w::ProxyErrorKind { match k { $(p::ErrorKind::$v => w::ProxyErrorKind::$v),* } }
        fn kind_in(k: w::ProxyErrorKind) -> p::ErrorKind { match k { $(w::ProxyErrorKind::$v => p::ErrorKind::$v),* } }
    };
}
kinds!(
    Overloaded, RateLimited, QuotaExhausted, Entitlement, Billing, Auth, Permission, ContextOverflow, RequestTooLarge, Policy,
    ServiceTierUnavailable, InvalidRequest, ImageRejected, ReplayRejected, ToolSchemaRejected, Transient, Unknown
);

fn millis(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// The failure of a call; credential-shaped text in the message and code is redacted and nothing
/// else of this PC leaves it.
pub fn failure_out(e: &p::ProviderError, outcome: w::ProxyOutcome) -> w::ProxyFailure {
    use p::TransportFault as F;
    w::ProxyFailure {
        outcome,
        kind: kind_out(e.kind),
        code: e.code.as_deref().map(|c| redacted_text(c, MAX_ERROR_TEXT)),
        status: e.status,
        retry_after_ms: e.retry_after.map(|d| d.as_millis() as u64),
        reset_at_ms: e.reset_at.and_then(millis),
        quota_scope: e.quota_scope.map(|s| match s {
            p::QuotaScope::Minute => w::ProxyQuotaScope::Minute,
            p::QuotaScope::Day => w::ProxyQuotaScope::Day,
            p::QuotaScope::Plan => w::ProxyQuotaScope::Plan,
        }),
        reauth_required: e.reauth_required,
        should_retry: e.should_retry,
        text_emitted: e.exposure.text_emitted,
        tool_dispatched: e.exposure.tool_dispatched,
        tool_input_cut: e.exposure.tool_input_cut,
        delivery: match e.delivery {
            p::DeliveryState::NotSent => w::ProxyDelivery::NotSent,
            p::DeliveryState::Ambiguous => w::ProxyDelivery::Ambiguous,
            p::DeliveryState::Accepted => w::ProxyDelivery::Accepted,
        },
        transport: e.transport.as_ref().map(|f| match f {
            F::Connect { os_code } => w::ProxyFault::Connect { os_code: *os_code },
            F::Dns => w::ProxyFault::Dns,
            F::Reset => w::ProxyFault::Reset,
            F::Closed => w::ProxyFault::Closed,
            F::Tls => w::ProxyFault::Tls,
            F::H2GoAway { code } => w::ProxyFault::H2GoAway { code: *code },
            F::H2RstStream { code } => w::ProxyFault::H2RstStream { code: *code },
            F::WsClose { code } => w::ProxyFault::WsClose { code: *code },
            F::KeepaliveExpired { transport } => w::ProxyFault::KeepaliveExpired {
                transport: match transport {
                    TransportKind::Http1 => w::ProxyTransportKind::Http1,
                    TransportKind::Http2 => w::ProxyTransportKind::Http2,
                    TransportKind::WebSocket => w::ProxyTransportKind::WebSocket,
                },
            },
            F::TruncatedStream => w::ProxyFault::TruncatedStream,
            F::Io { os_code } => w::ProxyFault::Io { os_code: *os_code },
        }),
        message: redacted_text(&e.message, MAX_ERROR_TEXT),
        partial_usage: e.partial_usage.as_deref().map(usage_out),
        partial_model: e.partial_model.as_deref().map(str::to_owned),
        verification_url: e.verification_url.as_deref().map(str::to_owned),
        rejected_tool: e.rejected_tool.as_deref().map(str::to_owned),
        account_blocked: e.account_blocked,
        unsafe_to_retry: e.unsafe_to_retry,
        quota_limit: e.quota_limit.as_deref().map(str::to_owned),
        notices: e.notices.iter().map(|(message, warn)| w::ProxyNotice { message: message.clone(), warn: *warn }).collect(),
    }
}

pub fn failure_in(f: w::ProxyFailure) -> Result<(p::ProviderError, w::ProxyOutcome), String> {
    use p::TransportFault as F;
    let mut e = p::ProviderError::new(
        kind_in(f.kind),
        match f.delivery {
            w::ProxyDelivery::NotSent => p::DeliveryState::NotSent,
            w::ProxyDelivery::Ambiguous => p::DeliveryState::Ambiguous,
            w::ProxyDelivery::Accepted => p::DeliveryState::Accepted,
        },
    );
    e.code = f.code;
    e.status = f.status;
    e.retry_after = f.retry_after_ms.map(Duration::from_millis);
    e.reset_at = f.reset_at_ms.map(|ms| UNIX_EPOCH + Duration::from_millis(ms));
    e.quota_scope = f.quota_scope.map(|s| match s {
        w::ProxyQuotaScope::Minute => p::QuotaScope::Minute,
        w::ProxyQuotaScope::Day => p::QuotaScope::Day,
        w::ProxyQuotaScope::Plan => p::QuotaScope::Plan,
    });
    e.reauth_required = f.reauth_required;
    e.should_retry = f.should_retry;
    e.exposure = p::Exposure { text_emitted: f.text_emitted, tool_dispatched: f.tool_dispatched, tool_input_cut: f.tool_input_cut };
    e.transport = f.transport.map(|t| match t {
        w::ProxyFault::Connect { os_code } => F::Connect { os_code },
        w::ProxyFault::Dns => F::Dns,
        w::ProxyFault::Reset => F::Reset,
        w::ProxyFault::Closed => F::Closed,
        w::ProxyFault::Tls => F::Tls,
        w::ProxyFault::H2GoAway { code } => F::H2GoAway { code },
        w::ProxyFault::H2RstStream { code } => F::H2RstStream { code },
        w::ProxyFault::WsClose { code } => F::WsClose { code },
        w::ProxyFault::KeepaliveExpired { transport } => F::KeepaliveExpired {
            transport: match transport {
                w::ProxyTransportKind::Http1 => TransportKind::Http1,
                w::ProxyTransportKind::Http2 => TransportKind::Http2,
                w::ProxyTransportKind::WebSocket => TransportKind::WebSocket,
            },
        },
        w::ProxyFault::TruncatedStream => F::TruncatedStream,
        w::ProxyFault::Io { os_code } => F::Io { os_code },
    });
    e.message = f.message;
    e.partial_usage = f.partial_usage.map(|u| Box::new(usage_in(u)));
    e.partial_model = f.partial_model.map(String::into_boxed_str);
    e.verification_url = f.verification_url.map(String::into_boxed_str);
    e.rejected_tool = f.rejected_tool.map(String::into_boxed_str);
    e.account_blocked = f.account_blocked;
    e.unsafe_to_retry = f.unsafe_to_retry;
    e.quota_limit = f.quota_limit.map(String::into_boxed_str);
    e.notices = f.notices.into_iter().map(|n| (n.message, n.warn)).collect();
    Ok((e, f.outcome))
}

// -- models ---------------------------------------------------------------------------------

fn picker_out(p: &p::PickerFields) -> w::ProxyPicker {
    w::ProxyPicker {
        release_date: p.release_date.clone(),
        access_programs: p.access_programs.clone(),
        model_parameter_options: p
            .model_parameter_options
            .iter()
            .map(|o| w::ProxyParameterOption {
                id: o.id.clone(),
                label: o.label.clone(),
                kind: o.kind.clone(),
                options: o.options.iter().map(|v| w::ProxyParameterValue { value: v.value.clone(), label: v.label.clone(), context_window: v.context_window }).collect(),
            })
            .collect(),
        parameter_variants: p.parameter_variants.clone(),
        fast_efforts: p.fast_efforts.clone(),
        service_tiers: p.service_tiers.iter().map(|t| w::ProxyServiceTier { id: t.id.clone(), name: t.name.clone(), description: t.description.clone() }).collect(),
        additional_speed_tiers: p.additional_speed_tiers.clone(),
        reasoning_options: p.reasoning_options.iter().map(|r| w::ProxyReasoningOption { kind: r.kind.clone(), values: r.values.clone() }).collect(),
        custom_reasoning: p.custom_reasoning.as_ref().map(|c| w::ProxyCustomReasoning { wire_format: c.wire_format.clone(), wire_values: c.wire_values.clone(), replay: c.replay }),
        tier: p.tier.clone(),
        latest: p.latest,
        description: p.description.clone(),
        default_service_tier: p.default_service_tier.clone(),
        default_model_parameters: p.default_model_parameters.clone(),
        default_fast: p.default_fast,
        supports_max_mode: p.supports_max_mode,
    }
}

fn picker_in(p: w::ProxyPicker) -> p::PickerFields {
    p::PickerFields {
        release_date: p.release_date,
        access_programs: p.access_programs,
        model_parameter_options: p
            .model_parameter_options
            .into_iter()
            .map(|o| p::ParameterOption {
                id: o.id,
                label: o.label,
                kind: o.kind,
                options: o.options.into_iter().map(|v| p::ParameterValue { value: v.value, label: v.label, context_window: v.context_window }).collect(),
            })
            .collect(),
        parameter_variants: p.parameter_variants,
        fast_efforts: p.fast_efforts,
        service_tiers: p.service_tiers.into_iter().map(|t| p::ServiceTier { id: t.id, name: t.name, description: t.description }).collect(),
        additional_speed_tiers: p.additional_speed_tiers,
        reasoning_options: p.reasoning_options.into_iter().map(|r| p::ReasoningOption { kind: r.kind, values: r.values }).collect(),
        custom_reasoning: p.custom_reasoning.map(|c| p::CustomReasoning { wire_format: c.wire_format, wire_values: c.wire_values, replay: c.replay }),
        tier: p.tier,
        latest: p.latest,
        description: p.description,
        default_service_tier: p.default_service_tier,
        default_model_parameters: p.default_model_parameters,
        default_fast: p.default_fast,
        supports_max_mode: p.supports_max_mode,
    }
}
pub fn model_out(m: &p::ModelRecord) -> w::ProxyModel {
    w::ProxyModel {
        id: m.id.clone(),
        display_name: m.display_name.clone(),
        name: m.name.clone(),
        provider_name: m.provider_name.clone(),
        manual: m.manual,
        supports_reasoning_effort_updates: m.supports_reasoning_effort_updates,
        supports_prompt_caching: m.supports_prompt_caching,
        reasoning_content_field: m.reasoning_content_field.clone(),
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        runtime_context_window: m.runtime_context_window,
        max_output_tokens: m.max_output_tokens,
        input_cost_per_m: m.input_cost_per_m.filter(|v| v.is_finite()),
        output_cost_per_m: m.output_cost_per_m.filter(|v| v.is_finite()),
        cache_read_cost_per_m: m.cache_read_cost_per_m.filter(|v| v.is_finite()),
        cache_write_cost_per_m: m.cache_write_cost_per_m.filter(|v| v.is_finite()),
        supports_reasoning: m.supports_reasoning,
        reasoning_levels: m.reasoning_levels.clone(),
        default_reasoning_level: m.default_reasoning_level.clone(),
        supports_images: m.supports_images,
        hidden: m.hidden,
        raw: m.raw.clone(),
        mode: m.mode.clone(),
        created: m.created,
        alias_target: m.alias_target.clone(),
        wire: m.wire.as_ref().map(wire_out),
        picker: picker_out(&m.picker),
        first_response_budget: None,
    }
}

/// A row of the PC's catalog as the remote catalog lists it (it enriches the row itself).
pub fn catalog_model_out(m: &mixdog_ai::catalog::ModelRecord) -> w::ProxyModel {
    use mixdog_ai::catalog::Capability;
    let tri = |c: Capability| match c {
        Capability::Yes => Some(true),
        Capability::No => Some(false),
        Capability::Unknown => None,
    };
    w::ProxyModel {
        id: m.id.clone(),
        display_name: m.display_name.clone(),
        name: m.name.clone(),
        provider_name: m.provider_name.clone(),
        manual: m.manual,
        supports_reasoning_effort_updates: m.supports_reasoning_effort_updates,
        supports_prompt_caching: tri(m.prompt_caching),
        reasoning_content_field: m.reasoning_content_field.clone(),
        context_window: m.context_window,
        max_context_window: m.max_context_window,
        runtime_context_window: m.runtime_context_window,
        max_output_tokens: m.output_tokens,
        input_cost_per_m: m.rates.input.filter(|v| v.is_finite()),
        output_cost_per_m: m.rates.output.filter(|v| v.is_finite()),
        cache_read_cost_per_m: m.rates.cache_read.filter(|v| v.is_finite()),
        cache_write_cost_per_m: m.rates.cache_write.filter(|v| v.is_finite()),
        supports_reasoning: tri(m.reasoning),
        reasoning_levels: m.reasoning_efforts.clone(),
        default_reasoning_level: m.default_effort.clone(),
        supports_images: tri(m.vision),
        hidden: m.hidden,
        raw: None,
        mode: m.mode.clone(),
        created: m.created,
        alias_target: m.alias_target.clone(),
        wire: m.wire.as_ref().map(wire_out),
        picker: picker_out(&m.picker),
        first_response_budget: None,
    }
}

pub fn model_in(m: w::ProxyModel) -> p::ModelRecord {
    let mut out = p::ModelRecord::new(m.id);
    out.display_name = m.display_name;
    out.name = m.name;
    out.provider_name = m.provider_name;
    out.manual = m.manual;
    out.supports_reasoning_effort_updates = m.supports_reasoning_effort_updates;
    out.supports_prompt_caching = m.supports_prompt_caching;
    out.reasoning_content_field = m.reasoning_content_field;
    out.context_window = m.context_window;
    out.max_context_window = m.max_context_window;
    out.runtime_context_window = m.runtime_context_window;
    out.max_output_tokens = m.max_output_tokens;
    out.input_cost_per_m = m.input_cost_per_m;
    out.output_cost_per_m = m.output_cost_per_m;
    out.cache_read_cost_per_m = m.cache_read_cost_per_m;
    out.cache_write_cost_per_m = m.cache_write_cost_per_m;
    out.supports_reasoning = m.supports_reasoning;
    out.reasoning_levels = m.reasoning_levels;
    out.default_reasoning_level = m.default_reasoning_level;
    out.supports_images = m.supports_images;
    out.hidden = m.hidden;
    out.raw = m.raw;
    out.mode = m.mode;
    out.created = m.created;
    out.alias_target = m.alias_target;
    out.wire = m.wire.map(wire_in);
    out.picker = picker_in(m.picker);
    out
}

fn wire_out(w: &p::WireIds) -> w::ProxyWireIds {
    match w {
        p::WireIds::One(id) => w::ProxyWireIds::One(id.clone()),
        p::WireIds::Tiers(tiers) => w::ProxyWireIds::Tiers(tiers.clone()),
    }
}

fn wire_in(w: w::ProxyWireIds) -> p::WireIds {
    match w {
        w::ProxyWireIds::One(id) => p::WireIds::One(id),
        w::ProxyWireIds::Tiers(tiers) => p::WireIds::Tiers(tiers),
    }
}

// -- the PC end -----------------------------------------------------------------------------

/// The PC's providers by name (`ProviderRegistry::get`).
#[async_trait]
pub trait ProviderLookup: Send + Sync {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>>;
}

#[async_trait]
impl ProviderLookup for ProviderRegistry {
    async fn adapter(&self, name: &str) -> Option<Arc<dyn p::ProviderAdapter>> {
        self.get(name).await
    }
}

/// Where the events of a running call go: `modelProxy/run/event` on the connection that asked.
pub trait ProxyEvents: Send + Sync {
    fn emit(&self, event: w::ProxyEvent);
}

/// `quotaUsable`: a forced usage reading per account, decided by
/// `mixdog_ai::service::quota_usable` (the usage service takes the readings). `Err` is a
/// measurement that failed (Node's rejected `measureProviderQuota`): the call fails with its message.
#[async_trait]
pub trait QuotaProbe: Send + Sync {
    async fn usable(&self, provider: &str, model: &str) -> Result<bool, String>;
}

/// `resolveWireRoute`: the PC adapter's wire for a model (its config and roster decide). `None`
/// for an adapter with a single wire (Node: no `resolveWireRoute` method) or a model no offered wire serves.
#[async_trait]
pub trait WireRouter: Send + Sync {
    async fn route(&self, adapter: &dyn p::ProviderAdapter, model: &str, context: w::ProxyRouteContext) -> Result<Option<w::ProxyWireRoute>, p::ProviderError>;
}

/// `providerConfig`: the PC's registry as `mixdog_ai::service::model_proxy::public_provider_config`
/// projects it, and whether the registry is loaded. `Err` is a registry that could not be loaded
/// (the call fails with its message).
#[async_trait]
pub trait ProviderConfigSource: Send + Sync {
    async fn public(&self) -> Result<(Vec<(String, w::ProxyProviderInfo)>, bool), String>;
}

pub struct ProxyRunner {
    pub providers: Arc<dyn ProviderLookup>,
    pub broker: Arc<ModelBroker>,
    pub quota: Arc<dyn QuotaProbe>,
    pub wire: Arc<dyn WireRouter>,
    pub config: Arc<dyn ProviderConfigSource>,
    /// The PC's catalog: listModels answers from its snapshot; refresh re-reads it first.
    pub catalog: Arc<mixdog_ai::catalog::CatalogService>,
}

struct EventSink<'a>(&'a dyn ProxyEvents);

impl AttemptSink for EventSink<'_> {
    fn event(&mut self, event: p::StreamEvent) {
        self.0.emit(event_out(&event));
    }
    fn discard(&mut self) {
        self.0.emit(w::ProxyEvent::AttemptDiscarded);
    }
    fn abandoned(&mut self, usage: &p::Usage, model: Option<&str>) {
        self.0.emit(w::ProxyEvent::AttemptAbandoned { usage: usage_out(usage), model: model.map(str::to_owned) });
    }
}

fn refusal(code: &str, message: String, kind: p::ErrorKind) -> w::ProxyFailure {
    let mut error = p::ProviderError::new(kind, p::DeliveryState::NotSent);
    error.code = Some(code.to_owned());
    error.message = message;
    failure_out(&error, w::ProxyOutcome::Provider)
}

/// A call that failed with a plain `Error` (no code, no status): the record Node answers with.
fn plain_failure(message: String) -> w::ProxyFailure {
    let mut error = p::ProviderError::new(p::ErrorKind::Unknown, p::DeliveryState::NotSent);
    error.message = message;
    failure_out(&error, w::ProxyOutcome::Provider)
}

/// `cancelledError()` (model-proxy-host.ts): the abort of a call the server gave up.
fn cancelled_failure() -> w::ProxyFailure {
    let mut error = p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::Ambiguous);
    error.message = "The remote session cancelled the model call.".into();
    failure_out(&error, w::ProxyOutcome::Provider)
}

/// `isProviderAllowed` (model-proxy-host.ts): the host's saved list; `None` is every provider enabled on this PC.
fn allows(allowed: Option<&[String]>, name: &str) -> bool {
    allowed.is_none_or(|list| list.iter().any(|entry| entry == name))
}

/// `providerNotAllowed` (model-proxy-host.ts).
fn not_allowed(name: &str) -> w::ProxyFailure {
    refusal("MODEL_PROXY_PROVIDER_NOT_ALLOWED", format!("This PC does not let this server use provider \"{name}\"."), p::ErrorKind::InvalidRequest)
}

impl ProxyRunner {
    /// `modelProxy/run`: one call of a server core, on this PC's provider of the same name. `allowed` is the
    /// list the asking host may use (`ModelProxyRunParams::allowed_providers`); a provider outside it is neither
    /// named in the config answer nor reachable by any call.
    pub async fn run(&self, call: w::ProxyCall, allowed: Option<&[String]>, events: &dyn ProxyEvents, cancel: &CancellationToken) -> Result<w::ProxyAnswer, w::ProxyFailure> {
        // A call given up reads nothing of this PC's (`signal.throwIfAborted()`, model-proxy-host.ts `execute`).
        if cancel.is_cancelled() {
            return Err(cancelled_failure());
        }
        // "Restricted to the provider the daemon named": checked before the provider is looked up (host.ts:713).
        if let w::ProxyCall::QuotaUsable { provider, .. } | w::ProxyCall::ResolveWireRoute { provider, .. } | w::ProxyCall::ListModels { provider, .. } | w::ProxyCall::Send { provider, .. } = &call
            && !provider.is_empty()
            && !allows(allowed, provider)
        {
            return Err(not_allowed(provider));
        }
        match call {
            w::ProxyCall::ProviderConfig => {
                let (mut providers, ready) = self.config.public().await.map_err(plain_failure)?;
                // `publicProviderConfig`: a provider the server may not use is not even named to it.
                providers.retain(|(name, _)| allows(allowed, name));
                Ok(w::ProxyAnswer::ProviderConfig { providers, ready: Some(ready) })
            }
            w::ProxyCall::QuotaUsable { provider, model } => {
                self.adapter(&provider).await?;
                if cancel.is_cancelled() {
                    return Err(cancelled_failure());
                }
                Ok(w::ProxyAnswer::Usable { usable: self.quota.usable(&provider, &model).await.map_err(plain_failure)? })
            }
            w::ProxyCall::ResolveWireRoute { provider, model, context } => {
                let adapter = self.adapter(&provider).await?;
                if cancel.is_cancelled() {
                    return Err(cancelled_failure());
                }
                let route = self.wire.route(adapter.as_ref(), &model, context).await.map_err(|e| failure_out(&e, w::ProxyOutcome::Provider))?;
                Ok(w::ProxyAnswer::Route { route })
            }
            w::ProxyCall::ListModels { provider, refresh } => {
                self.adapter(&provider).await?;
                if refresh {
                    self.catalog.refresh().await;
                }
                let snapshot = self.catalog.snapshot();
                let id = mixdog_protocol::ProviderId::from(provider.as_str());
                let models = snapshot.models_of(&id);
                if let (true, Some(mixdog_ai::catalog::ProviderStatus::Missing { message, .. })) = (models.is_empty(), snapshot.status.get(&id)) {
                    return Err(refusal("MODEL_PROXY_LISTING_FAILED", message.clone(), p::ErrorKind::Transient));
                }
                Ok(w::ProxyAnswer::Models { models: models.iter().map(catalog_model_out).collect() })
            }
            w::ProxyCall::Send { provider, request } => {
                let adapter = self.adapter(&provider).await?;
                let request = request_in(*request).map_err(|e| refusal("MODEL_PROXY_REQUEST_INVALID", e.0, p::ErrorKind::InvalidRequest))?;
                let key = LaneKey::new(provider.as_str().into(), "default");
                let lane = self.broker.admission().lane(&key, process_lane_settings()(&key));
                let send = SendRequest { request: Arc::new(request), lane, admission: AdmissionRequest::default() };
                let mut sink = EventSink(events);
                match self.broker.send(adapter.as_ref(), send, &mut sink, cancel).await {
                    Ok(attempts) => Ok(w::ProxyAnswer::Sent { attempts }),
                    Err(SendError::Provider(e)) => Err(failure_out(&e, w::ProxyOutcome::Provider)),
                    Err(SendError::Exhausted(e)) => Err(failure_out(&e, w::ProxyOutcome::Exhausted)),
                    Err(SendError::Fallback { model, last }) => Err(failure_out(&last, w::ProxyOutcome::Fallback { model })),
                    Err(SendError::Admission(e)) => {
                        let mut error = p::ProviderError::new(p::ErrorKind::Transient, p::DeliveryState::NotSent);
                        error.message = format!("{e:?}");
                        Err(failure_out(&error, w::ProxyOutcome::Admission))
                    }
                    Err(SendError::Cancelled) => Err(cancelled_failure()),
                }
            }
        }
    }

    async fn adapter(&self, name: &str) -> Result<Arc<dyn p::ProviderAdapter>, w::ProxyFailure> {
        self.providers
            .adapter(name)
            .await
            .ok_or_else(|| refusal("MODEL_PROXY_PROVIDER_UNAVAILABLE", format!("Provider \"{name}\" is not enabled on this PC."), p::ErrorKind::InvalidRequest))
    }
}

// -- the server end -------------------------------------------------------------------------

fn transient(message: &str, delivery: p::DeliveryState) -> p::ProviderError {
    let mut error = p::ProviderError::new(p::ErrorKind::Transient, delivery);
    error.message = message.to_owned();
    error
}

fn execution_error(error: ProxyError) -> SendError {
    match error {
        ProxyError::Unavailable(message) => SendError::Provider(transient(&message, p::DeliveryState::NotSent)),
        ProxyError::Cancelled => SendError::Cancelled,
        ProxyError::Remote(value) => match serde_json::from_value::<w::ProxyFailure>(value.clone()).ok().map(failure_in) {
            Some(Ok((error, w::ProxyOutcome::Exhausted))) => SendError::Exhausted(error),
            Some(Ok((last, w::ProxyOutcome::Fallback { model }))) => SendError::Fallback { model, last },
            Some(Ok((error, _))) => SendError::Provider(error),
            _ => SendError::Provider(transient(&format!("model proxy call failed: {value}"), p::DeliveryState::Ambiguous)),
        },
    }
}

/// A proxied send, the server end of `ModelBroker::send`: the stored attachments the request
/// carries are inlined (newest first, under one byte budget), the call goes to the PC, and the
/// events of each attempt reach `sink`. Returns the attempts the PC's broker made.
pub async fn remote_send(
    transport: &dyn ModelProxyTransport,
    attachments: &dyn AttachmentReader,
    provider: &str,
    request: &p::ModelRequest,
    sink: &mut dyn AttemptSink,
    cancel: &CancellationToken,
) -> Result<u32, SendError> {
    let mut request = request.clone();
    inline_attachments(&mut request.messages, attachments, MODEL_PROXY_INLINE_MAX_BYTES)
        .await
        .map_err(|e| SendError::Provider(transient(&e, p::DeliveryState::NotSent)))?;
    let call = w::ProxyCall::Send { provider: provider.to_owned(), request: Box::new(request_out(&request)) };
    let call = serde_json::to_value(&call).map_err(|e| SendError::Provider(transient(&e.to_string(), p::DeliveryState::NotSent)))?;
    let mut on_event = |value: Value| {
        // An event this core cannot read is dropped: deltas are hints and the terminal event decides.
        match serde_json::from_value::<w::ProxyEvent>(value).ok().map(event_in) {
            Some(Ok(Incoming::Event(event))) => sink.event(event),
            Some(Ok(Incoming::Discard)) => sink.discard(),
            Some(Ok(Incoming::Abandoned(usage, model))) => sink.abandoned(&usage, model.as_deref()),
            _ => {}
        }
    };
    let answer = mixdog_ai::broker::execute_via_proxy(transport, call, &mut on_event, cancel).await.map_err(execution_error)?;
    match serde_json::from_value::<w::ProxyAnswer>(answer.clone()).ok() {
        Some(w::ProxyAnswer::Sent { attempts }) => Ok(attempts),
        _ => Err(SendError::Provider(transient(&format!("model proxy answered a send with {answer}"), p::DeliveryState::Ambiguous))),
    }
}

/// The PC's model listing as the remote catalog sees it (`ModelProxyProvider.listModels` /
/// `_refreshModelCache`, model-proxy-provider.mjs:159-165).
pub struct ProxyListing<T: ModelProxyTransport> {
    pub transport: T,
    pub provider: String,
}

impl<T: ModelProxyTransport> ProxyListing<T> {
    async fn ask(&self, refresh: bool) -> Result<Vec<p::ModelRecord>, p::ProviderError> {
        let call = serde_json::to_value(w::ProxyCall::ListModels { provider: self.provider.clone(), refresh })
            .map_err(|e| transient(&e.to_string(), p::DeliveryState::NotSent))?;
        let mut ignore = |_: Value| {};
        let answer = self.transport.execute(call, &mut ignore, &CancellationToken::new()).await.map_err(|e| match execution_error(e) {
            SendError::Provider(e) | SendError::Exhausted(e) => e,
            SendError::Fallback { last, .. } => last,
            _ => transient("The remote session cancelled the model call.", p::DeliveryState::NotSent),
        })?;
        match serde_json::from_value::<w::ProxyAnswer>(answer).map_err(|e| transient(&format!("model proxy answered a listing wrongly: {e}"), p::DeliveryState::Ambiguous))? {
            w::ProxyAnswer::Models { models } => Ok(models.into_iter().map(model_in).collect()),
            _ => Err(transient("model proxy answered a listing with another result", p::DeliveryState::Ambiguous)),
        }
    }

    /// `listModels`: the PC's cached catalog.
    pub async fn cached(&self) -> Result<Vec<p::ModelRecord>, p::ProviderError> {
        self.ask(false).await
    }
}

#[async_trait]
impl<T: ModelProxyTransport> p::ModelListing for ProxyListing<T> {
    /// The catalog's refresh: the PC re-reads its provider first (`_refreshModelCache`).
    async fn list_models(&self) -> Result<Vec<p::ModelRecord>, p::ProviderError> {
        self.ask(true).await
    }
}

/// The server's stored attachments (`mixdog_store::blobs::BlobStore`), read on the interactive lane.
pub struct StoreAttachments {
    pub store: mixdog_store::blobs::BlobStore,
    pub interactive: mixdog_rt::InteractiveIo,
}

#[async_trait]
impl AttachmentReader for StoreAttachments {
    /// `reference` is the 64 lowercase hex digits of the blob's SHA-256 (attachments/store.mjs).
    async fn read(&self, reference: &str) -> Result<Vec<u8>, ReadError> {
        use mixdog_store::blobs::BlobError;
        if reference.len() != 64 || !reference.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(ReadError::Other("prompt attachment reference is invalid".into()));
        }
        let digest = mixdog_store::schema::bounded::Digest::try_from(format!("sha256:{reference}")).map_err(|e| ReadError::Other(e.to_string()))?;
        let store = self.store.clone();
        let read = mixdog_core_base::support::on_lane(self.interactive, &CancellationToken::new(), move |lane| store.read(lane, &digest))
            .await
            .map_err(|e| ReadError::Other(format!("{e:?}")))?;
        match read {
            // A file of no bytes is ATTACHMENT_INVALID (`readAttachmentBuffer`, size <= 0): permanent.
            Ok(bytes) if bytes.is_empty() || bytes.len() > MODEL_PROXY_INLINE_MAX_BYTES => Err(ReadError::Permanent),
            Ok(bytes) => Ok(bytes),
            Err(BlobError::Missing { .. } | BlobError::Corrupt { .. }) => Err(ReadError::Permanent),
            Err(e) => Err(ReadError::Other(e.to_string())),
        }
    }
}

#[cfg(test)]
#[path = "model_proxy_tests.rs"]
pub(super) mod tests;
