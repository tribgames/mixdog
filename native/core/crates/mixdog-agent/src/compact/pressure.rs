//! The context-pressure state of a session (`loop/compact-policy.mjs`, and the checkpoint
//! restore in `manager/turn-checkpoint-context.mjs`): the usage snapshot and the provider
//! baseline that later pressure checks add growth estimates to.
//!
//! Node mutates the session object; here every operation is a pure function from the session
//! header (its fields under Node's own names) to a [`HeaderPatch`], which the store applies as
//! one header change: `unset` keys are removed first, then `set` is merged.

use std::sync::LazyLock;

use mixdog_core_api::domain::provider::Role;
use mixdog_js::JsRegex;
use mixdog_js::math::round;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::estimate::IMAGE_TOKEN_ALLOWANCE;
use super::estimate::MessageMeter;
use super::execution_tail::MessageRows;
use super::tool_schema::RequestTools;
use super::tool_schema::estimate_request_reserve_tokens;
use super::tool_schema::tool_schema_signature;
use crate::message::AgentMessage;

mod rows;
mod status;

pub use rows::AttachmentBytes;
pub use status::After;
pub use status::COMPACT_NO_WINDOW;
pub use status::CompactionPlan;
pub use status::Route;
pub use status::StatusInput;
pub use status::compaction_plan;
pub use status::context_status;
pub use status::forced_target_budget;
pub use status::summarize_messages;
pub use rows::BlobError;
pub(crate) use rows::node_base64;
pub use rows::{clean_image_mime, image_descriptor, image_identity};
pub use rows::restore_turn_checkpoint_context_state_rows;
pub use rows::rows_exact_signature;
pub use rows::rows_shape_signature;

/// A session header: its fields under Node's names.
pub type Header = Map<String, Value>;

const CONTEXT_USAGE_SNAPSHOT_VERSION: u64 = 1;
const TURN_CONTEXT_STATE_VERSION: u64 = 1;

/// One atomic header change.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HeaderPatch {
    pub set: Header,
    pub unset: Vec<String>,
}

impl HeaderPatch {
    fn put(&mut self, key: &str, value: Value) {
        self.unset.retain(|k| k != key);
        self.set.insert(key.to_owned(), value);
    }

    fn remove(&mut self, key: &str) {
        self.set.shift_remove(key);
        if !self.unset.iter().any(|k| k == key) {
            self.unset.push(key.to_owned());
        }
    }

    /// The header after this change.
    pub fn apply(&self, header: &mut Header) {
        for key in &self.unset {
            header.shift_remove(key);
        }
        for (key, value) in &self.set {
            header.insert(key.clone(), value.clone());
        }
    }
}

// --- JS coercions ---------------------------------------------------------

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a || b`.
fn or<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    if truthy(a) { a } else { b }
}

/// `a || null`.
fn or_null(a: Option<&Value>) -> Value {
    if truthy(a) { a.cloned().unwrap_or(Value::Null) } else { Value::Null }
}

/// `Number(value)`.
fn number(value: Option<&Value>) -> f64 {
    mixdog_js::to_number_of(value)
}

/// `Number(value) || 0`.
fn number_or_zero(value: Option<&Value>) -> f64 {
    let n = number(value);
    if n.is_nan() { 0.0 } else { n }
}

/// `Math.max(0, Math.round(Number(value) || 0))`.
fn rounded_count(value: Option<&Value>) -> f64 {
    round(number_or_zero(value)).max(0.0)
}

/// `positiveInt(value)`.
fn positive_int(value: Option<&Value>) -> Option<f64> {
    let floored = number(value).floor();
    (floored.is_finite() && floored >= 1.0).then_some(floored)
}

fn int_or_null(value: Option<f64>) -> Value {
    value.map_or(Value::Null, mixdog_js::json_number)
}

/// `String(value || '')`.
fn string_or_empty(value: Option<&Value>) -> String {
    if truthy(value) { value.map(mixdog_js::value_to_string).unwrap_or_default() } else { String::new() }
}

fn num(value: f64) -> Value {
    mixdog_js::json_number(value)
}

// --- Transcript signatures --------------------------------------------------

/// One image of a message as Node's media normalizer describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct ImageDescriptor {
    /// Hash of what the image is (inline bytes, url, file id, attachment reference).
    pub identity: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub detail: String,
}

impl ImageDescriptor {
    /// `imageDescriptorAllowance`: pixels bill as `w*h/750`, capped at the vision ceiling.
    fn allowance(&self) -> u64 {
        match (self.width, self.height) {
            (Some(w), Some(h)) if w != 0.0 && h != 0.0 => IMAGE_TOKEN_ALLOWANCE.min((w * h / 750.0).ceil() as u64),
            _ => IMAGE_TOKEN_ALLOWANCE,
        }
    }

    fn json(&self) -> Value {
        json!({
            "identity": self.identity,
            "width": int_or_null(self.width),
            "height": int_or_null(self.height),
            "detail": self.detail,
        })
    }
}

/// Describes the images of a message (its content parts and the native blocks it replays);
/// implemented by the owner of the attachment store, which alone knows the image forms.
pub trait ImageIdentities: Send + Sync {
    fn images(&self, message: &AgentMessage) -> Vec<ImageDescriptor>;
}

static STORED_MEDIA_PLACEHOLDER: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\[(?:Image|File) omitted from stored history[^\]]*\]", "g"));

/// `text.replace(/\[(?:Image|File) omitted from stored history[^\]]*\]/g, ' ')
/// .replace(/\s+/g, ' ').trim()`, and how many placeholders it replaced.
fn shape_text(text: &str) -> (String, u64) {
    let mut placeholders = 0;
    let mut replaced = String::with_capacity(text.len());
    let mut from = 0;
    for found in STORED_MEDIA_PLACEHOLDER.find_iter(text) {
        replaced.push_str(&text[from..found.start]);
        replaced.push(' ');
        from = found.end;
        placeholders += 1;
    }
    replaced.push_str(&text[from..]);
    let mut out = String::with_capacity(replaced.len());
    let mut pending_space = false;
    for c in replaced.chars() {
        if mixdog_js::is_js_space(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    (out, placeholders)
}

fn role_name(message: &AgentMessage) -> &'static str {
    match message.role() {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::Developer => "developer",
    }
}

/// sha256 over `JSON(identity) + '\0'` of each message identity, in order (hex).
fn digest_identities(identities: impl Iterator<Item = Value>) -> String {
    let mut hash = Sha256::new();
    for identity in identities {
        hash.update(mixdog_js::json_stringify(&identity).as_bytes());
        hash.update([0u8]);
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// `contextMessagesSignature` / `contextMessagesShapeSignature`: sha256 over
/// `JSON(identity(message)) + '\0'` for each message of the slice, in order.
pub struct TranscriptSigner<'a> {
    pub meter: &'a MessageMeter<'a>,
    pub images: &'a dyn ImageIdentities,
    /// The stored row of a message (the snapshot's tail id is read from it).
    pub rows: &'a dyn MessageRows,
}

impl TranscriptSigner<'_> {
    fn digest(messages: &[AgentMessage], identity: impl Fn(&AgentMessage) -> Value) -> String {
        digest_identities(messages.iter().map(identity))
    }

    /// The signature of `messages` as they are, images included.
    pub fn exact(&self, messages: &[AgentMessage]) -> String {
        Self::digest(messages, |m| {
            let images = self.images.images(m);
            let allowance: u64 = images.iter().map(ImageDescriptor::allowance).sum();
            json!([
                role_name(m),
                m.tool_call_id().unwrap_or_default(),
                self.meter.estimate_text(m),
                allowance,
                images.iter().map(ImageDescriptor::json).collect::<Vec<_>>(),
            ])
        })
    }

    /// The signature that survives the disk round trip: media reduced to a count, whitespace
    /// collapsed.
    pub fn shape(&self, messages: &[AgentMessage]) -> String {
        Self::digest(messages, |m| {
            let (text, placeholders) = shape_text(&self.meter.estimate_text(m));
            json!([role_name(m), m.tool_call_id().unwrap_or_default(), text, self.images.images(m).len() as u64 + placeholders])
        })
    }
}

impl TranscriptSigner<'_> {
    /// `contextUsageSnapshotTail`: the last message's role and `uuid || id || toolCallId`. An
    /// agent message carries no `uuid` or `id`; they are read from the row the store holds for
    /// it, and a message with no stored row has none.
    fn snapshot_tail(&self, messages: &[AgentMessage]) -> (&'static str, String) {
        messages.last().map_or(("", String::new()), |m| {
            let row = self.rows.row(m);
            let id = or(or(row.get("uuid"), row.get("id")), row.get("toolCallId"));
            (role_name(m), string_or_empty(id))
        })
    }
}

// --- The usage snapshot -----------------------------------------------------

/// The options of `recordContextUsageSnapshot`.
pub struct UsageSnapshotArgs<'a> {
    /// `usedTokens` (NaN when the caller had none).
    pub used_tokens: f64,
    /// `messageTokensEst`: absent or null reads as 0, as `Number(null)` does; a value that is
    /// not a number is replaced by the messages' estimate.
    pub message_tokens_est: Option<f64>,
    pub source: &'a str,
    /// `updatedAt`; absent, 0 or NaN is `now`.
    pub updated_at: Option<f64>,
    /// `Date.now()`.
    pub now: f64,
}

/// `recordContextUsageSnapshot(session, policy, {...})`: `None` when it records nothing.
pub fn record_context_usage_snapshot(
    header: &Header,
    policy: &Header,
    messages: &[AgentMessage],
    signer: &TranscriptSigner<'_>,
    args: &UsageSnapshotArgs<'_>,
) -> Option<HeaderPatch> {
    let used = args.used_tokens;
    if !used.is_finite() || used < 0.0 {
        return None;
    }
    let estimate = match args.message_tokens_est {
        None => 0.0,
        Some(n) if n.is_finite() => round(n).max(0.0),
        Some(_) => signer.meter.messages(messages) as f64,
    };
    let (tail_role, tail_id) = signer.snapshot_tail(messages);
    let limit = positive_int(or(policy.get("triggerTokens"), policy.get("boundaryTokens")));
    let updated_at = if args.updated_at.is_some_and(|u| u != 0.0 && !u.is_nan()) { args.updated_at.unwrap() } else { args.now };
    let snapshot = json!({
        "version": CONTEXT_USAGE_SNAPSHOT_VERSION,
        "source": if args.source.is_empty() { "estimated" } else { args.source },
        "usedTokens": num(round(used).max(0.0)),
        "limitTokens": int_or_null(limit),
        "messageTokensEst": num(estimate),
        "messageCount": messages.len(),
        "messagesSignature": signer.exact(messages),
        "tailRole": tail_role,
        "tailId": tail_id,
        "usageMetricsTurnId": string_or_empty(header.get("usageMetricsTurnId")),
        "usageMetricsEpoch": num(number_or_zero(header.get("usageMetricsEpoch"))),
        "toolSchemaSignature": or_null(policy.get("toolSchemaSignature")),
        "provider": or_null(or(header.get("provider"), policy.get("provider"))),
        "model": or_null(header.get("model")),
        "contextWindow": int_or_null(positive_int(or(policy.get("contextWindow"), header.get("contextWindow")))),
        "boundaryTokens": int_or_null(positive_int(policy.get("boundaryTokens"))),
        "triggerTokens": int_or_null(limit),
        "updatedAt": num(round(updated_at).max(0.0)),
    });
    let mut patch = HeaderPatch::default();
    patch.put("contextUsageSnapshot", snapshot);
    Some(patch)
}

/// `invalidateContextUsageSnapshot`.
pub fn invalidate_context_usage_snapshot() -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    patch.remove("contextUsageSnapshot");
    patch
}

// --- The provider baseline ----------------------------------------------------

/// `providerPressureTokens`: what the provider billed for the prompt and its reply.
/// `input_excludes_cache` is the provider's usage convention (`providerInputExcludesCache`).
fn provider_pressure_tokens(usage: &Value, input_excludes_cache: bool) -> f64 {
    if !usage.is_object() && !usage.is_array() {
        return 0.0;
    }
    let field = |name: &str| usage.get(name);
    let non_negative = |name: &str| number_or_zero(field(name)).max(0.0);
    let context_input = non_negative("contextInputTokens");
    let input = if context_input != 0.0 { context_input } else { non_negative("inputTokens") };
    let cached_read = non_negative("cachedTokens");
    let cache_write = non_negative("cacheWriteTokens");
    let explicit_prompt = if context_input != 0.0 { context_input } else { non_negative("promptTokens") };
    let normalized_prompt = if input_excludes_cache { input + cached_read + cache_write } else { input };
    let prompt = explicit_prompt.max(normalized_prompt);
    let output = non_negative("outputTokens");
    if prompt <= 0.0 {
        // A provider that reports checkpoint occupancy (prompt and response together).
        let occupancy = number(field("contextTokens"));
        if occupancy.is_finite() && occupancy > 0.0 {
            return round(occupancy);
        }
    }
    round(prompt + output).max(0.0)
}

/// How a baseline is taken.
pub struct BaselineArgs<'a> {
    /// `'request'` when the usage arrived before the reply was appended, else complete.
    pub boundary: &'a str,
    /// The tools the request carried, with the provider-native prefix the run host exposed.
    pub send_tools: RequestTools<'a>,
    /// `providerInputExcludesCache(session.provider)`.
    pub input_excludes_cache: bool,
    /// `providerTokenCalibration(session.provider)`.
    pub token_calibration: f64,
    /// `Date.now()`.
    pub now: f64,
}

/// `recordProviderContextBaseline(session, messages, usage, {...})`: `None` when the usage
/// carries no reading.
pub fn record_provider_context_baseline(
    header: &Header,
    messages: &[AgentMessage],
    usage: &Value,
    signer: &TranscriptSigner<'_>,
    args: &BaselineArgs<'_>,
) -> Option<HeaderPatch> {
    let tokens = provider_pressure_tokens(usage, args.input_excludes_cache);
    if tokens == 0.0 {
        return None;
    }
    let mut patch = HeaderPatch::default();
    patch.remove("contextUsageSnapshot");
    patch.put("contextPressureBaselineTokens", num(tokens));
    patch.put("contextPressureBaselineOutputTokens", num(rounded_count(usage.get("outputTokens"))));
    patch.put("contextPressureBaselineMessageCount", messages.len().into());
    patch.put("contextPressureBaselinePrefixSignature", signer.exact(messages).into());
    patch.put("contextPressureBaselineShapeSignature", signer.shape(messages).into());
    patch.put("contextPressureBaselineProvider", or_null(header.get("provider")));
    patch.put("contextPressureBaselineModel", or_null(header.get("model")));
    patch.put("contextPressureBaselineToolSignature", tool_schema_signature(&args.send_tools).into());
    let reserve = estimate_request_reserve_tokens(&args.send_tools) as f64 * args.token_calibration;
    patch.put("contextPressureBaselineRequestReserveTokens", num(round(reserve).max(0.0)));
    patch.put("contextPressureBaselineBoundary", if args.boundary == "request" { "request" } else { "complete" }.into());
    patch.put("contextPressureBaselineUpdatedAt", num(args.now));
    patch.put("lastContextTokensStaleAfterCompact", false.into());
    patch.put("contextPressureBaselineSource", "provider".into());
    patch.remove("contextPressureUnanchoredAfterRestart");
    patch.remove("contextPressureUnanchoredReason");
    Some(patch)
}

/// `invalidateProviderContextBaseline`: a changed transcript cannot reuse usage measured
/// against its old prefix.
pub fn invalidate_provider_context_baseline() -> HeaderPatch {
    let mut patch = HeaderPatch::default();
    for key in [
        "contextPressureBaselineTokens",
        "contextPressureBaselineOutputTokens",
        "contextPressureBaselineMessageCount",
        "contextPressureBaselineBoundary",
        "contextPressureBaselinePrefixSignature",
        "contextPressureBaselineShapeSignature",
        "contextPressureBaselineProvider",
        "contextPressureBaselineModel",
        "contextPressureBaselineToolSignature",
        "contextPressureBaselineRequestReserveTokens",
        "contextPressureBaselineUpdatedAt",
        "contextPressureBaselineSource",
    ] {
        patch.put(key, Value::Null);
    }
    patch.put("lastContextTokensStaleAfterCompact", true.into());
    patch.remove("contextPressureUnanchoredAfterRestart");
    patch.remove("contextPressureUnanchoredReason");
    patch
}

// --- The checkpoint restore -------------------------------------------------

/// `nonNegativeCount`.
fn non_negative_count(value: Option<&Value>) -> Option<usize> {
    match value {
        None | Some(Value::Null) => return None,
        Some(Value::String(s)) if s.is_empty() => return None,
        _ => {}
    }
    let n = number(value);
    (n.fract() == 0.0 && n.is_finite() && n >= 0.0).then_some(n as usize)
}

/// `checkpointContextSliceMatches`.
fn slice_matches<M, E>(messages: &[M], state: &Value, exact: &dyn Fn(&[M]) -> Result<String, E>) -> Result<bool, E> {
    let (Some(committed), Some(turn)) =
        (non_negative_count(state.get("committedPrefixCount")), non_negative_count(state.get("turnMessageCount")))
    else {
        return Ok(false);
    };
    if committed + turn > messages.len() {
        return Ok(false);
    }
    if exact(&messages[..committed])? != string_or_empty(state.get("committedPrefixSignature")) {
        return Ok(false);
    }
    Ok(exact(&messages[committed..committed + turn])? == string_or_empty(state.get("turnPrefixSignature")))
}

/// `legacyProviderBaselineMatches`.
fn legacy_baseline_matches<M, E>(
    header: &Header,
    messages: &[M],
    exact: &dyn Fn(&[M]) -> Result<String, E>,
) -> Result<bool, E> {
    match non_negative_count(header.get("contextPressureBaselineMessageCount")) {
        Some(count) if count <= messages.len() => {
            Ok(string_or_empty(header.get("contextPressureBaselinePrefixSignature")) == exact(&messages[..count])?)
        }
        _ => Ok(false),
    }
}

/// `markUnanchoredContext`: a retained reading that no longer describes the transcript.
pub fn mark_unanchored_context(header: &Header) -> Option<HeaderPatch> {
    let snapshot_used = header.get("contextUsageSnapshot").and_then(|s| s.get("usedTokens"));
    let retained = [header.get("contextPressureBaselineTokens"), snapshot_used, header.get("lastContextTokens")]
        .into_iter()
        .map(number_or_zero)
        .find(|n| *n != 0.0)
        .unwrap_or(0.0);
    if retained <= 0.0 {
        return None;
    }
    let mut patch = HeaderPatch::default();
    patch.put("contextPressureUnanchoredAfterRestart", true.into());
    patch.put("contextPressureUnanchoredReason", "checkpoint_context_mismatch".into());
    Some(patch)
}

/// The outcome of `restoreTurnCheckpointContextState`.
#[derive(Clone, Debug, PartialEq)]
pub struct Restored {
    /// Whether the session's pressure reading is anchored to its transcript.
    pub anchored: bool,
    pub patch: HeaderPatch,
}

/// `restoreTurnCheckpointContextState(session, checkpoint)`: rebuilds the provider baseline
/// from the journal's `contextState`. `now` is `Date.now()`.
pub fn restore_turn_checkpoint_context_state(
    header: &Header,
    messages: &[AgentMessage],
    checkpoint: &Value,
    signer: &TranscriptSigner<'_>,
    now: f64,
) -> Restored {
    match restore_with(header, messages, checkpoint, &|slice| Ok::<_, std::convert::Infallible>(signer.exact(slice)), now) {
        Ok(restored) => restored,
        Err(never) => match never {},
    }
}

/// The restore over any message form: `exact` signs a slice of `messages` the way
/// `contextMessagesSignature` does.
fn restore_with<M, E>(
    header: &Header,
    messages: &[M],
    checkpoint: &Value,
    exact: &dyn Fn(&[M]) -> Result<String, E>,
    now: f64,
) -> Result<Restored, E> {
    let state = checkpoint.get("contextState").filter(|s| truthy(Some(s)));
    let raw_used = number(state.and_then(|s| s.get("usedTokens")));
    let mut usable = None;
    if let Some(s) = state {
        if s.get("version").and_then(Value::as_u64) == Some(TURN_CONTEXT_STATE_VERSION)
            && raw_used.is_finite()
            && raw_used >= 0.0
            && string_or_empty(s.get("provider")) == string_or_empty(header.get("provider"))
            && string_or_empty(s.get("model")) == string_or_empty(header.get("model"))
            && slice_matches(messages, s, exact)?
        {
            usable = Some(s);
        }
    }
    let Some(state) = usable else {
        if legacy_baseline_matches(header, messages, exact)? {
            let mut patch = HeaderPatch::default();
            patch.remove("contextPressureUnanchoredAfterRestart");
            patch.remove("contextPressureUnanchoredReason");
            return Ok(Restored { anchored: true, patch });
        }
        return Ok(Restored { anchored: false, patch: mark_unanchored_context(header).unwrap_or_default() });
    };

    let count = non_negative_count(state.get("committedPrefixCount")).unwrap_or(0)
        + non_negative_count(state.get("turnMessageCount")).unwrap_or(0);
    let used = round(raw_used).max(0.0);
    let output = rounded_count(state.get("outputTokens"));
    let prefix_signature = exact(&messages[..count])?;
    let updated_at = round(if number_or_zero(state.get("updatedAt")) != 0.0 { number_or_zero(state.get("updatedAt")) } else { now }).max(0.0);
    let post_compact = state.get("kind").and_then(Value::as_str) == Some("post_compact");

    let mut patch = HeaderPatch::default();
    patch.put("contextPressureBaselineTokens", num(used));
    patch.put("contextPressureBaselineOutputTokens", num(output));
    patch.put("contextPressureBaselineMessageCount", count.into());
    patch.put("contextPressureBaselinePrefixSignature", prefix_signature.clone().into());
    patch.put("contextPressureBaselineProvider", or_null(header.get("provider")));
    patch.put("contextPressureBaselineModel", or_null(header.get("model")));
    patch.put("contextPressureBaselineToolSignature", or_null(state.get("toolSchemaSignature")));
    patch.put("contextPressureBaselineRequestReserveTokens", num(rounded_count(state.get("requestReserveTokens"))));
    let request = state.get("boundary").and_then(Value::as_str) == Some("request");
    patch.put("contextPressureBaselineBoundary", if request { "request" } else { "complete" }.into());
    patch.put("contextPressureBaselineUpdatedAt", num(updated_at));
    patch.put("contextPressureBaselineSource", if post_compact { "checkpoint_post_compact" } else { "checkpoint_provider" }.into());
    let input = number(state.get("inputTokens"));
    let last_context_tokens = if post_compact {
        0.0
    } else if input > 0.0 {
        input
    } else {
        (used - output).max(0.0)
    };
    patch.put("lastContextTokens", num(last_context_tokens));
    patch.put("lastContextTokensUpdatedAt", num(updated_at));
    // Usable by compaction; its source tells it from a measured prompt in the display lane.
    patch.put("lastContextTokensStaleAfterCompact", false.into());
    if let Some(snapshot) = state.get("usageSnapshot").filter(|s| truthy(Some(s))) {
        if post_compact {
            let mut restored = snapshot.as_object().cloned().unwrap_or_default();
            restored.insert("usedTokens".into(), num(used));
            restored.insert("messageCount".into(), count.into());
            restored.insert("messagesSignature".into(), prefix_signature.into());
            patch.put("contextUsageSnapshot", Value::Object(restored));
            if truthy(snapshot.get("usageMetricsTurnId")) {
                patch.put("usageMetricsTurnId", snapshot["usageMetricsTurnId"].clone());
            }
            let epoch = number(snapshot.get("usageMetricsEpoch"));
            if epoch.is_finite() {
                patch.put("usageMetricsEpoch", num(epoch));
            }
        }
    }
    if let Some(saved) = state.get("compaction").and_then(Value::as_object) {
        let mut merged = header.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, value) in saved {
            merged.insert(key.clone(), value.clone());
        }
        patch.put("compaction", Value::Object(merged));
    }
    patch.remove("contextPressureUnanchoredAfterRestart");
    patch.remove("contextPressureUnanchoredReason");
    Ok(Restored { anchored: true, patch })
}
