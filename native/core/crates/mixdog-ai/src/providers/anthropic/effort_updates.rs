//! Mid-conversation effort updates: when the effort changes inside a
//! conversation, an empty `system` message carrying `output_config.effort` is
//! lowered into the history at the point the change takes effect, and the
//! `mid-conversation-output-config` beta is sent. Whether a model takes the
//! update is data ([`FLOORS`]): the Anthropic catalogs publish no per-model
//! flag, so a measured version floor per model family stands in for it.
//!
//! The projection (where each change lands, keyed by message index) comes from
//! the session; this module only places it. An update on a tool result takes
//! effect after its whole tool batch; one on any other message, before it.

use std::collections::BTreeMap;

use mixdog_core_api::domain::provider::Message;
use mixdog_core_api::domain::provider::Role;
use serde_json::Value;
use serde_json::json;

use super::lowering::LowerContext;
use super::lowering::WireContent;
use super::lowering::WireMessage;
use super::lowering::lower_messages;

/// The beta that admits the update messages.
pub(crate) const BETA: &str = "mid-conversation-output-config-2026-07-01";

/// The first model version of a family checked on the wire (update accepted,
/// prompt cache kept); every later version of the family takes it too.
pub(crate) struct FloorRow {
    pub family: &'static str,
    pub major: u32,
    pub minor: u32,
}

pub(crate) const FLOORS: &[FloorRow] = &[
    FloorRow { family: "opus", major: 5, minor: 0 },
    FloorRow { family: "sonnet", major: 5, minor: 5 },
    FloorRow { family: "haiku", major: 5, minor: 5 },
    FloorRow { family: "fable", major: 5, minor: 1 },
    FloorRow { family: "mythos", major: 5, minor: 1 },
];

/// A family with no row takes updates on these routes only; a model that
/// rejects one surfaces as the provider error (no replay without updates).
pub(crate) const UNMEASURED_FAMILY_PROVIDERS: &[&str] = &["anthropic-oauth"];

/// The session's model key: lowercase, no snapshot date, dots as dashes.
pub(crate) fn model_key(model: &str) -> String {
    let lower = model.trim().to_lowercase();
    let stem = strip_date(&lower);
    stem.replace('.', "-")
}

fn strip_date(id: &str) -> &str {
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if let Some((stem, tail)) = id.rsplit_once('-') {
        if tail.len() == 8 && digits(tail) {
            return stem;
        }
        // `-YYYY-MM-DD`
        let mut parts = id.rsplitn(4, '-');
        if let (Some(day), Some(month), Some(year), Some(stem)) =
            (parts.next(), parts.next(), parts.next(), parts.next())
            && day.len() == 2
            && month.len() == 2
            && year.len() == 4
            && digits(day)
            && digits(month)
            && digits(year)
        {
            return stem;
        }
    }
    id
}

/// Whether the model's version takes the update on this route.
pub(crate) fn version_supported(provider: &str, model: &str) -> bool {
    let Some((family, major, minor)) = crate::claude_floors::family_version(model) else {
        return false;
    };
    if let Some(row) = FLOORS.iter().find(|row| row.family == family) {
        return crate::claude_floors::version_at_least((major, minor), (row.major, row.minor));
    }
    let first_major = FLOORS.iter().map(|row| row.major).min().unwrap_or(u32::MAX);
    UNMEASURED_FAMILY_PROVIDERS.contains(&provider) && major >= f64::from(first_major)
}

/// What else decides whether a request carries updates.
pub(crate) struct Gate {
    /// The base URL is Anthropic's own.
    pub official_url: bool,
    /// The request sets a manual thinking budget.
    pub manual_budget: bool,
    /// The caller has not switched updates off.
    pub enabled: bool,
    /// Beta headers are not suppressed for this route.
    pub beta_headers: bool,
}

pub(crate) fn enabled(provider: &str, model: &str, gate: &Gate) -> bool {
    gate.enabled
        && !gate.manual_budget
        && gate.beta_headers
        && gate.official_url
        && version_supported(provider, model)
}

/// Lowers `messages` with the update messages placed. With a projection the
/// history keeps one representation: every text content is a block list, on
/// updating and non-updating turns alike (cache markers otherwise turn a
/// string into a block list only on some turns).
pub(crate) fn lower_with_updates(
    messages: &[Message],
    updates: &BTreeMap<usize, String>,
    cx: &LowerContext<'_>,
) -> Vec<WireMessage> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut after_batch: Option<&str> = None;
    let control = |result: &mut Vec<WireMessage>, start: &mut usize, end: usize, effort: &str| {
        if *start < end {
            result.extend(lower_messages(&messages[*start..end], cx));
        }
        let mut update = WireMessage::new("system", WireContent::Blocks(Vec::new()));
        update.output_config = Some(output_config(effort));
        result.push(update);
        *start = end;
    };
    for (index, message) in messages.iter().enumerate() {
        if message.role == Role::System {
            continue;
        }
        let own = updates.get(&index).map(String::as_str);
        if message.role != Role::Tool && (own.is_some() || after_batch.is_some()) {
            let effort = own.or(after_batch).expect("one of the two is set");
            control(&mut result, &mut start, index, effort);
        }
        if message.role != Role::Tool {
            after_batch = None;
        } else if own.is_some() {
            after_batch = own;
        }
    }
    if let Some(effort) = after_batch {
        control(&mut result, &mut start, messages.len(), effort);
    }
    if start < messages.len() {
        result.extend(lower_messages(&messages[start..], cx));
    }
    canonical(result)
}

/// The turn-scoped layout (first-party route, model taking `clear_at` system
/// messages): a non-blank string content becomes one text block, so a cache
/// marker never changes a message's shape between requests.
pub(crate) fn turn_scoped_layout(messages: Vec<WireMessage>) -> Vec<WireMessage> {
    messages
        .into_iter()
        .map(|mut message| {
            if let WireContent::Text(text) = &message.content
                && !text.trim().is_empty()
            {
                message.content = WireContent::Blocks(vec![json!({ "type": "text", "text": text })]);
            }
            message
        })
        .collect()
}

fn canonical(messages: Vec<WireMessage>) -> Vec<WireMessage> {
    messages
        .into_iter()
        .map(|mut message| {
            if let WireContent::Text(text) = &message.content {
                message.content = WireContent::Blocks(vec![json!({ "type": "text", "text": text })]);
            }
            message
        })
        .collect()
}

/// The `output_config` of an update message.
pub(crate) fn output_config(effort: &str) -> Value {
    json!({ "effort": effort })
}
