//! The fresh-context rebuild: protected prefix, the handoff summary (or the
//! previous one), a stable acknowledgement and the volatile tail, within the
//! compact budget. Rule-only when no handoff text is given.

use async_trait::async_trait;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::Role;
use serde_json::Value as JsonValue;
use sha2::Digest;
use sha2::Sha256;

use super::execution_tail::MessageRows;
use super::execution_tail::TailContext;
use super::execution_tail::TailOptions;
use super::execution_tail::build_execution_tail;
use super::messages::context_ack_message;
use super::messages::is_protected_context_ack;
use super::messages::latest_actual_user_instruction_index;
use super::messages::pending_task_notification_indexes;
use super::messages::split_protected_context;
use crate::message::AgentMessage;
use crate::message::Source;
use crate::project::is_summary_message;
use crate::repair::sanitize_tool_pairs;

pub const SUMMARY_PREFIX: &str = "A previous model worked on this task and produced the compacted handoff summary below. Build on the work already done and avoid duplicating it. The summary covers the session; retained requests and execution records follow it. Actual tool outcomes take precedence over plans or older claims in the summary.";
pub const LATEST_TURN_EXCEEDS_CONTEXT: &str = "LATEST_TURN_EXCEEDS_CONTEXT";

/// Floor for the reserve-adjusted compact budget.
const MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS: u64 = 1024;
const ACTIVE_TURN_CONTINUATION_TEXT: [&str; 8] = [
    "<system-reminder>",
    crate::project::ACTIVE_TURN_CONTINUATION_ANCHOR,
    "The latest real user request or task notification was already in progress when Compact ran.",
    "The handoff and retained execution records above describe progress so far. A plan is not evidence that a tool succeeded; use the recorded outcomes.",
    "Continue from that state without repeating progress messages or completed tool calls.",
    "Use tools only for incomplete or failed work, or to recover missing evidence from an execution archive.",
    "</active-turn-continuation>",
    "</system-reminder>",
];

/// What the attachment store knows about a message's media.
#[async_trait]
pub trait AttachmentSeam: Send + Sync {
    /// The message with its attachments carried by reference (this writes stored copies, so it
    /// is asynchronous; the two questions below read the message alone).
    async fn reference_media(&self, message: &AgentMessage) -> AgentMessage;
    fn has_referencable_media(&self, message: &AgentMessage) -> bool;
    /// Tokens the message's attachments alone cost.
    fn attachment_tokens(&self, message: &AgentMessage) -> u64;
    /// `referenceOversizedAttachments`: the transcript with the user messages whose attachments
    /// would crowd `context_window` carried by reference; `None` when nothing is rewritten.
    async fn preflight(&self, messages: &[AgentMessage], context_window: u64, native_pdf: bool) -> Option<Preflight> {
        let _ = (messages, context_window, native_pdf);
        None
    }
}

/// What an attachment preflight rewrote (`referenceOversizedAttachments`' result).
#[derive(Clone, Debug, PartialEq)]
pub struct Preflight {
    pub messages: Vec<AgentMessage>,
    pub referenced_messages: usize,
    pub inline_tokens_before: u64,
    pub budget_tokens: u64,
}

pub struct FreshContext<'a> {
    pub tail: TailContext<'a>,
    pub attachments: &'a dyn AttachmentSeam,
}

#[derive(Clone, Debug, Default)]
pub struct FreshOptions {
    pub reserve_tokens: u64,
    /// The hard window the soft target may widen toward.
    pub max_budget_tokens: u64,
    pub context_window: u64,
    pub handoff_token_cap: Option<u64>,
    pub handoff_text: String,
    pub active_turn: bool,
    pub reference_latest_attachments: bool,
    /// Compact even when the transcript already fits.
    pub force: bool,
    pub preview: bool,
    pub preview_summary: bool,
}

#[derive(Debug)]
pub enum FreshError {
    /// The latest turn alone does not fit the model (`LATEST_TURN_EXCEEDS_CONTEXT`).
    LatestTurnExceeds(String),
    Failed(String),
}

impl FreshError {
    pub fn message(&self) -> &str {
        match self {
            Self::LatestTurnExceeds(text) | Self::Failed(text) => text,
        }
    }
}

impl From<String> for FreshError {
    fn from(text: String) -> Self {
        Self::Failed(text)
    }
}

impl From<&str> for FreshError {
    fn from(text: &str) -> Self {
        Self::Failed(text.to_owned())
    }
}

#[derive(Debug)]
pub struct FreshResult {
    pub messages: Vec<AgentMessage>,
    /// False when the transcript already fit and was only sanitized.
    pub fresh_context: bool,
}

/// The budget less the request reserve, floored so a huge tool surface cannot
/// leave a degenerate target.
pub fn effective_budget(budget_tokens: u64, reserve_tokens: u64) -> Result<u64, FreshError> {
    if budget_tokens == 0 {
        return Err("compact: budgetTokens must be > 0".into());
    }
    if reserve_tokens == 0 {
        return Ok(budget_tokens);
    }
    let remaining = budget_tokens.saturating_sub(reserve_tokens);
    if remaining >= MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS {
        return Ok(remaining);
    }
    Ok(1.max(budget_tokens.min(MIN_EFFECTIVE_COMPACT_BUDGET_TOKENS)))
}

/// Dropped tool-result stubs that point at an id no longer in the transcript
/// go back to the missing-result stub.
pub fn reconcile_dedup_stubs(messages: Vec<AgentMessage>) -> Vec<AgentMessage> {
    let present: std::collections::HashSet<String> = messages
        .iter()
        .filter(|m| m.role() == Role::Tool)
        .filter_map(|m| m.tool_call_id().map(str::to_owned))
        .collect();
    messages
        .into_iter()
        .map(|mut m| {
            if m.role() != Role::Tool {
                return m;
            }
            let Content::Text(text) = &m.message.content else {
                return m;
            };
            if let Some(rest) = text.strip_prefix("[duplicate-of tool_use_id=")
                && let Some(end) = rest.find(']')
                && !rest[..end].is_empty()
                && !present.contains(&rest[..end])
            {
                m.message.content = Content::Text("[Older tool result unavailable after context compaction]".to_owned());
            }
            m
        })
        .collect()
}

fn sanitized(messages: &[AgentMessage]) -> Vec<AgentMessage> {
    reconcile_dedup_stubs(sanitize_tool_pairs(messages))
}

pub(super) struct Source_ {
    pub(super) protected_prefix: Vec<AgentMessage>,
    pub(super) previous_summary: Option<AgentMessage>,
    pub(super) previous_ack: Option<AgentMessage>,
    pub(super) live: Vec<AgentMessage>,
}

pub(super) async fn split_fresh_source(ctx: &FreshContext<'_>, messages: &[AgentMessage]) -> Source_ {
    let redacted = super::redact::redact_tool_call_secrets(&sanitized(messages));
    let split = split_protected_context(&redacted);
    // A recovery reminder right after the system prompt reads as protected
    // prefix and would outlive every pass; it belongs to the conversation.
    let is_recovery = |m: &AgentMessage| m.source == Some(Source::CompactExecutionRecovery);
    let protected_prefix: Vec<AgentMessage> =
        split.protected_prefix.iter().filter(|m| !is_recovery(m)).cloned().collect();
    let mut conversation: Vec<AgentMessage> =
        split.protected_prefix.iter().filter(|m| is_recovery(m)).cloned().collect();
    conversation.extend(split.conversation);
    let mut previous_summary = None;
    let mut previous_ack = None;
    for index in (0..conversation.len()).rev() {
        if is_summary_message(&conversation[index]) {
            previous_summary = Some(conversation[index].clone());
            if conversation.get(index + 1).is_some_and(is_protected_context_ack) {
                previous_ack = Some(conversation[index + 1].clone());
            }
            break;
        }
    }
    let latest_user = latest_actual_user_instruction_index(&conversation);
    // Older requests carry their attachments by reference from here on.
    let mut live = Vec::with_capacity(conversation.len());
    for (index, m) in conversation.iter().enumerate() {
        let kept = if Some(index) == latest_user { m.clone() } else { ctx.attachments.reference_media(m).await };
        if !is_summary_message(&kept) {
            live.push(kept);
        }
    }
    Source_ { protected_prefix, previous_summary, previous_ack, live }
}

fn sha16(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    }
}

/// `messages=N sha256=… roles=…`: the header names the history the summary
/// replaced.
pub(super) fn compact_header(rows: &dyn MessageRows, old_history: &[AgentMessage]) -> String {
    let rows: Vec<JsonValue> = old_history.iter().map(|m| rows.row(m)).collect();
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for m in old_history {
        let role = role_name(m.role());
        match counts.iter_mut().find(|(r, _)| *r == role) {
            Some((_, n)) => *n += 1,
            None => counts.push((role, 1)),
        }
    }
    let roles = counts.iter().map(|(r, n)| format!("{r}:{n}")).collect::<Vec<_>>().join(", ");
    let roles = if roles.is_empty() { "none".to_owned() } else { roles };
    format!(
        "{SUMMARY_PREFIX}\nmessages={} sha256={} roles={roles}",
        old_history.len(),
        sha16(&mixdog_js::json_stringify(&JsonValue::Array(rows)))
    )
}

pub fn make_summary_message(content: String) -> AgentMessage {
    AgentMessage::sourced(Source::CompactSummary, content)
}

/// A memory digest's blocks start with one of these labels; they are kept
/// whole and joined by blank lines.
fn split_memory_handoff_root_blocks(text: &str) -> (String, Vec<String>) {
    static HEADER: std::sync::LazyLock<mixdog_js::JsRegex> = std::sync::LazyLock::new(|| {
        mixdog_js::JsRegex::new_static(
            r"^# (?:chunk \d+ root=\d+(?: category=\S+)?|raw_pending \d+ id=\d+|raw_terminal \d+ id=\d+)[ \t]*$",
            "m",
        )
    });
    if mixdog_js::js_trim(text).is_empty() {
        return (String::new(), Vec::new());
    }
    let starts: Vec<usize> = HEADER.find_iter(text).map(|m| m.start).collect();
    if starts.is_empty() {
        return (mixdog_js::js_trim(text).to_owned(), Vec::new());
    }
    let preamble = mixdog_js::js_trim(&text[..starts[0]]).to_owned();
    let blocks = starts
        .iter()
        .enumerate()
        .map(|(i, start)| {
            let end = starts.get(i + 1).copied().unwrap_or(text.len());
            mixdog_js::js_trim(&text[*start..end]).to_owned()
        })
        .filter(|b| !b.is_empty())
        .collect();
    (preamble, blocks)
}

/// The summary message for a handoff; the compact budget is applied around
/// it, so every block and line of the handoff is kept.
fn fresh_context_summary_message(ctx: &FreshContext<'_>, old_history: &[AgentMessage], handoff: &str) -> AgentMessage {
    let handoff = mixdog_js::js_trim(handoff);
    let header = compact_header(ctx.tail.rows, old_history);
    if handoff.is_empty() {
        return make_summary_message(header);
    }
    let (preamble, blocks) = split_memory_handoff_root_blocks(handoff);
    let body = if blocks.is_empty() {
        handoff.to_owned()
    } else {
        std::iter::once(preamble).filter(|p| !p.is_empty()).chain(blocks).collect::<Vec<_>>().join("\n\n")
    };
    make_summary_message(format!("{header}\n\n{body}"))
}

fn active_turn_continuation(messages: &[AgentMessage]) -> Option<AgentMessage> {
    let latest = latest_actual_user_instruction_index(messages);
    let pending = pending_task_notification_indexes(messages).last().copied();
    let input = latest.max(pending)?;
    let after = &messages[input + 1..];
    let existing = |m: &AgentMessage| {
        m.role() == Role::User
            && (m.source == Some(Source::ActiveTurnContinuation)
                || matches!(&m.message.content, Content::Text(t) if t.contains(crate::project::ACTIVE_TURN_CONTINUATION_ANCHOR)))
    };
    let activity = |m: &AgentMessage| {
        m.role() == Role::Tool || (m.role() == Role::Assistant && !is_protected_context_ack(m))
    };
    if !after.iter().any(existing) && !after.iter().any(activity) {
        return None;
    }
    Some(AgentMessage::sourced(Source::ActiveTurnContinuation, ACTIVE_TURN_CONTINUATION_TEXT.join("\n")))
}

struct Tail {
    latest_user: Option<AgentMessage>,
    turn_input: bool,
    volatile: Vec<AgentMessage>,
}

struct Layout {
    summary: Option<AgentMessage>,
    tail: Tail,
    stable_head: Vec<AgentMessage>,
    mandatory_cost: u64,
}

async fn fresh_tail(
    ctx: &FreshContext<'_>,
    source: &Source_,
    budget_tokens: u64,
    preserve_conversation: bool,
    opts: &FreshOptions,
) -> Result<Tail, FreshError> {
    let execution = build_execution_tail(
        &ctx.tail,
        &source.live,
        &TailOptions {
            context_window: if opts.context_window > 0 { opts.context_window } else { budget_tokens },
            preserve_conversation,
        },
    )
    .await?;
    let latest_user = latest_actual_user_instruction_index(&source.live).map(|i| source.live[i].clone());
    let turn_input = latest_user.is_some() || !pending_task_notification_indexes(&source.live).is_empty();
    let continuation = if turn_input && opts.active_turn { active_turn_continuation(&source.live) } else { None };
    let mut volatile = execution.messages;
    volatile.extend(continuation);
    Ok(Tail { latest_user, turn_input, volatile })
}

async fn fresh_layout(
    ctx: &FreshContext<'_>,
    source: &Source_,
    budget_tokens: u64,
    opts: &FreshOptions,
) -> Result<Layout, FreshError> {
    let handoff = mixdog_js::js_trim(&opts.handoff_text);
    // The preview carries the real summary envelope but no invented AI text.
    let replace_conversation = !handoff.is_empty() || (opts.preview && opts.preview_summary);
    let summary = if replace_conversation {
        Some(fresh_context_summary_message(ctx, &source.live, handoff))
    } else {
        source.previous_summary.clone()
    };
    let tail = fresh_tail(ctx, source, budget_tokens, !replace_conversation, opts).await?;
    // Every pass rebuilds the ack; it keeps the previous ack's id so the
    // archive does not count an unchanged ack as dropped.
    let stable_ack = if tail.turn_input && summary.is_some() {
        let mut ack = context_ack_message();
        if let Some(id) = source.previous_ack.as_ref().and_then(|a| a.message_id.clone())
            && !tail.volatile.iter().any(|m| m.message_id.as_deref() == Some(id.as_str()))
        {
            ack.message_id = Some(id);
        }
        Some(ack)
    } else {
        None
    };
    let mut stable_head = source.protected_prefix.clone();
    stable_head.extend(summary.clone());
    stable_head.extend(stable_ack.clone());
    let mut mandatory = source.protected_prefix.clone();
    mandatory.extend(stable_ack);
    mandatory.extend(tail.volatile.iter().cloned());
    let mandatory_cost = ctx.tail.meter.messages(&mandatory);
    Ok(Layout { summary, tail, stable_head, mandatory_cost })
}

/// The compact budget: the soft target, widened toward the model window when
/// the mandatory context and the handoff need more.
fn fresh_budget(
    ctx: &FreshContext<'_>,
    target: u64,
    budget_tokens: u64,
    layout: &Layout,
    opts: &FreshOptions,
) -> Result<u64, FreshError> {
    if opts.max_budget_tokens <= budget_tokens {
        return Ok(target);
    }
    let required = layout.mandatory_cost
        + layout.summary.as_ref().map_or(0, |s| ctx.tail.meter.message(s));
    Ok(effective_budget(opts.max_budget_tokens, opts.reserve_tokens)?.min(target.max(required)))
}

fn mandatory_overflows(budget: u64, cost: u64, summary: &Option<AgentMessage>) -> bool {
    cost > budget || (summary.is_some() && cost == budget)
}

fn count(value: u64) -> String {
    let digits = value.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn assert_mandatory_fits(
    ctx: &FreshContext<'_>,
    budget: u64,
    cost: u64,
    summary: &Option<AgentMessage>,
    context_window: u64,
    latest_user: &Option<AgentMessage>,
) -> Result<(), FreshError> {
    if !mandatory_overflows(budget, cost, summary) {
        return Ok(());
    }
    let window = if context_window > 0 { format!("{}-token", count(context_window)) } else { "current".to_owned() };
    let attachments = latest_user.as_ref().map_or(0, |m| ctx.attachments.attachment_tokens(m));
    let cause = if attachments > 0 {
        format!("Its attachments alone are about {} tokens.", count(attachments))
    } else {
        "The latest message and protected session context (system rules, tool definitions) are that large.".to_owned()
    };
    Err(FreshError::LatestTurnExceeds(format!(
        "The latest message cannot fit this model ({LATEST_TURN_EXCEEDS_CONTEXT}): it needs about {} tokens, but the {window} window leaves {} for it. {cause} Shorten the message or move large pasted text into a file the model can read. A larger context window helps only if it holds {} tokens plus room for the answer.",
        count(cost),
        count(budget),
        count(cost),
    )))
}

/// Re-seeds the first user message with the last effort the transcript
/// recorded, so the rebuilt transcript keeps the session's effort.
fn rebase_effort(before: &[AgentMessage], mut after: Vec<AgentMessage>) -> Vec<AgentMessage> {
    let Some(last) = before.iter().rev().find_map(|m| m.effort.clone()) else {
        return after;
    };
    for m in &mut after {
        m.effort = None;
    }
    if let Some(first_user) = after.iter_mut().find(|m| m.role() == Role::User) {
        let mut seeded = last.clone();
        seeded.initial_effort = last.effort;
        first_user.effort = Some(seeded);
    }
    after
}

pub async fn fresh_context_compact_messages(
    ctx: &FreshContext<'_>,
    messages: &[AgentMessage],
    budget_tokens: u64,
    opts: &FreshOptions,
) -> Result<FreshResult, FreshError> {
    let target = effective_budget(budget_tokens, opts.reserve_tokens)?;
    let base = sanitized(messages);
    if !opts.force && ctx.tail.meter.messages(&base) <= target {
        return Ok(FreshResult { messages: base, fresh_context: false });
    }
    let mut source = split_fresh_source(ctx, &base).await;
    let mut layout = fresh_layout(ctx, &source, budget_tokens, opts).await?;
    let mut budget = fresh_budget(ctx, target, budget_tokens, &layout, opts)?;
    // The latest request is kept verbatim — except its attachments: when they
    // are what does not fit (or the provider already refused the request as
    // too long), they travel by reference instead of failing the turn.
    if (opts.reference_latest_attachments || mandatory_overflows(budget, layout.mandatory_cost, &layout.summary))
        && let Some(latest) = latest_actual_user_instruction_index(&source.live)
        && ctx.attachments.has_referencable_media(&source.live[latest])
    {
        source.live[latest] = ctx.attachments.reference_media(&source.live[latest]).await;
        layout = fresh_layout(ctx, &source, budget_tokens, opts).await?;
        budget = fresh_budget(ctx, target, budget_tokens, &layout, opts)?;
    }
    assert_mandatory_fits(ctx, budget, layout.mandatory_cost, &layout.summary, opts.context_window, &layout.tail.latest_user)?;
    let room_uncapped = budget as i64 - layout.mandatory_cost as i64;
    let room = match opts.handoff_token_cap.filter(|cap| *cap > 0) {
        Some(cap) => room_uncapped.min(cap as i64),
        None => room_uncapped,
    };
    if let Some(summary) = &layout.summary
        && ctx.tail.meter.message(summary) as i64 > room
    {
        return Err(FreshError::Failed(format!(
            "freshContextCompactMessages: complete handoff exceeds the compact budget={room}; refusing to drop older context"
        )));
    }
    let mut stable = layout.stable_head;
    stable.extend(layout.tail.volatile);
    let result = rebase_effort(&base, sanitized(&stable));
    let final_tokens = ctx.tail.meter.messages(&result);
    if final_tokens > budget {
        return Err(FreshError::Failed(format!(
            "freshContextCompactMessages: compacted result exceeds budget={budget} (result={final_tokens})"
        )));
    }
    Ok(FreshResult { messages: result, fresh_context: true })
}
