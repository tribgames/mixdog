//! `provider-prefix-guard.mjs`: the fingerprint of what a provider request carries (each message, the request prefix: provider,
//! model and the tool lists) and how the next request differs from the one the session last settled on. A rewrite intent (a
//! compaction, or a transcript the run rebuilt or took from another writer) accepts a rewritten prefix (an intentional break);
//! outside one a rewritten or shrunk history is an unexpected break, and a changed request prefix is an intentional
//! `request_configuration` break. Every break is handed to the cache-break trace.
//!
//! An unexpected break refuses the send, as Node's guard throws `ProviderPrefixMutationError` after tracing it (the loop,
//! `send.rs` `prepare_prefix_guard`).

use serde_json::Map;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::ToolDefinition;

const COMPACTION_INTENTS: [&str; 4] = ["automatic_compaction", "deferred_body_compaction", "manual_compaction", "post_turn_compaction"];

/// The intent of a rewrite that is no compaction: a repaired transcript, a history reloaded from the store, an attachment
/// moved to a reference, rejected thinking dropped.
pub(crate) const TRANSCRIPT_REBUILD: &str = "transcript_rebuild";

/// Whether a send tagged `intent` carries a history the run rewrote on purpose.
pub(crate) fn is_rewrite_intent(intent: &str) -> bool {
    intent == TRANSCRIPT_REBUILD || COMPACTION_INTENTS.contains(&intent)
}

/// The fingerprint of one request (`snapshot`).
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Snapshot {
    pub message_hashes: Vec<String>,
    pub request_prefix_hash: String,
    pub provider: String,
    pub model: String,
    pub tool_schema_hash: String,
    pub native_tool_schema_hash: String,
}

/// What the comparison is told about the request (`options`).
pub struct GuardOptions<'a> {
    pub provider: &'a str,
    pub model: &'a str,
    pub intent: Option<&'a str>,
    /// `mutationSource`: the source an unexpected break is told under, when the caller names one.
    pub mutation_source: Option<&'a str>,
}

fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn is_anthropic(provider: &str) -> bool {
    provider.eq_ignore_ascii_case("anthropic") || provider.eq_ignore_ascii_case("anthropic-oauth")
}

/// `snapshot(messages, { tools, nativeTools }, options)`: each message's digest, and the request prefix's. An Anthropic
/// request leaves its deferred tools out of the prefix (they load later without moving the cache).
/// The digests cover what a provider is sent (the values' `Debug` form): the core's wire values are not Node's JSON, so a
/// digest is compared with the core's own digests only. A message's id and the stored places of its parts are no part of
/// any wire body and are left out, as Node's `messageDigest` leaves `meta.transcript.messageId` out: a message the run
/// made has no id until its row is stored, so the same message read back from its row would look rewritten.
pub fn snapshot<N: std::fmt::Debug>(messages: &[Message], tools: &[ToolDefinition], native: &[N], provider: &str, model: &str) -> Snapshot {
    let anthropic = is_anthropic(provider);
    let relevant: Vec<&ToolDefinition> = tools.iter().filter(|tool| !anthropic || !tool.defer_loading).collect();
    let tools_text = format!("{relevant:?}");
    let native_text = format!("{native:?}");
    let sent = |m: &Message| {
        let mut m = m.clone();
        m.message_id = None;
        m.stored_parts = Vec::new();
        digest(&format!("{m:?}"))
    };
    Snapshot {
        message_hashes: messages.iter().map(sent).collect(),
        request_prefix_hash: digest(&format!("{provider}\u{0}{model}\u{0}{tools_text}\u{0}{native_text}")),
        provider: provider.to_owned(),
        model: model.to_owned(),
        tool_schema_hash: digest(&tools_text),
        native_tool_schema_hash: digest(&native_text),
    }
}

fn first_changed_message_index(previous: &[String], next: &[String]) -> Option<usize> {
    let limit = previous.len().min(next.len());
    (0..limit).find(|&i| previous[i] != next[i]).or((next.len() < previous.len()).then_some(next.len()))
}

fn request_prefix_change_reason(previous: &Snapshot, next: &Snapshot) -> &'static str {
    if previous.provider != next.provider {
        "provider_changed"
    } else if previous.model != next.model {
        "model_changed"
    } else if previous.tool_schema_hash != next.tool_schema_hash {
        "tool_schema_changed"
    } else if previous.native_tool_schema_hash != next.native_tool_schema_hash {
        "native_tool_schema_changed"
    } else {
        "request_properties_changed"
    }
}

fn text_or_null(value: Option<&str>) -> Value {
    value.filter(|v| !v.is_empty()).map_or(Value::Null, |v| json!(v))
}

/// `prepareProviderPrefixGuard(previous, …)` over the next request's snapshot: the break it makes, as the details handed to
/// `onCacheBreak`; `None` when the request continues the previous one (or there is none).
pub fn compare(previous: Option<&Snapshot>, next: &Snapshot, options: &GuardOptions<'_>) -> Option<Map<String, Value>> {
    let previous = previous?;
    let (previous_hashes, next_hashes) = (&previous.message_hashes, &next.message_hashes);
    let changed = first_changed_message_index(previous_hashes, next_hashes);
    let request_prefix_changed = previous.request_prefix_hash != next.request_prefix_hash;
    let base = |classification: &str, reason: &str, source: Value, index: Option<usize>, previous_hash: Value, next_hash: Value, prefix_changed: bool| {
        let mut details = Map::new();
        details.insert("classification".into(), json!(classification));
        details.insert("reason".into(), json!(reason));
        details.insert("source".into(), source);
        details.insert("provider".into(), text_or_null(Some(options.provider)));
        details.insert("model".into(), text_or_null(Some(options.model)));
        details.insert("index".into(), index.map_or(Value::Null, |i| json!(i)));
        details.insert("previousCount".into(), json!(previous_hashes.len()));
        details.insert("nextCount".into(), json!(next_hashes.len()));
        details.insert("previousHash".into(), previous_hash);
        details.insert("nextHash".into(), next_hash);
        details.insert("previousRequestPrefixHash".into(), json!(previous.request_prefix_hash));
        details.insert("nextRequestPrefixHash".into(), json!(next.request_prefix_hash));
        details.insert("requestPrefixChanged".into(), json!(prefix_changed));
        details
    };
    let hash_at = |hashes: &[String], index: Option<usize>| index.and_then(|i| hashes.get(i)).map_or(Value::Null, |h| json!(h));
    if let Some(intent) = options.intent.filter(|intent| is_rewrite_intent(intent)) {
        if changed.is_none() && !request_prefix_changed {
            return None;
        }
        return Some(base(
            "intentional",
            intent,
            json!(if intent == TRANSCRIPT_REBUILD { TRANSCRIPT_REBUILD } else { "compaction" }),
            changed,
            hash_at(previous_hashes, changed),
            hash_at(next_hashes, changed),
            request_prefix_changed,
        ));
    }
    let mutation = |kind: &str, index: usize, previous_hash: Value, next_hash: Value| {
        let mut details = base("unexpected", kind, text_or_null(options.mutation_source), Some(index), previous_hash, next_hash, request_prefix_changed);
        // `mutationDetails` names the kind beside the reason.
        details.insert("kind".into(), json!(kind));
        details
    };
    if next_hashes.len() < previous_hashes.len() {
        let index = next_hashes.len();
        return Some(mutation("history_shrink", index, hash_at(previous_hashes, Some(index)), Value::Null));
    }
    if let Some(index) = changed {
        return Some(mutation("message_prefix", index, hash_at(previous_hashes, Some(index)), hash_at(next_hashes, Some(index))));
    }
    if request_prefix_changed {
        return Some(base("intentional", request_prefix_change_reason(previous, next), json!("request_configuration"), None, Value::Null, Value::Null, true));
    }
    None
}

/// The key one break is traced under once per turn (`cacheBreakTracer`).
pub fn trace_key(details: &Map<String, Value>) -> String {
    let part = |key: &str| match details.get(key) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    };
    ["classification", "reason", "index", "previousHash", "nextHash", "previousRequestPrefixHash", "nextRequestPrefixHash"].map(part).join("|")
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::provider::Content;
    use mixdog_core_api::domain::provider::Role;

    use super::*;

    /// The turn that sent a message it had just made knows it by its place (`#2`); the next turn reads it back from its
    /// stored row under the id the row was given. The provider is sent the same message both times.
    #[test]
    fn a_message_read_back_under_its_stored_id_is_the_message_that_was_sent() {
        let sent_as = |id: &str, text: &str| {
            let mut message = Message::new(Role::Assistant, Content::Text(text.into()));
            message.message_id = Some(id.into());
            snapshot::<()>(&[message], &[], &[], "anthropic", "m")
        };
        let options = GuardOptions { provider: "anthropic", model: "m", intent: None, mutation_source: None };
        assert_eq!(compare(Some(&sent_as("#2", "looking")), &sent_as("msg_1", "looking"), &options), None);
        let rewritten = compare(Some(&sent_as("#2", "looking")), &sent_as("#2", "looked"), &options).expect("another text is another message");
        assert_eq!(rewritten["reason"], "message_prefix");
    }
}
