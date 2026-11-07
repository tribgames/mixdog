//! A retried failed turn (`ask-turn-execute.mjs` `retainedUserTurn`, `agent-listing-notice.mjs:87`
//! `withAgentListingNotice`): the failed turn's own message is resubmitted over the history before it, as it is, until
//! the agents enabled now differ from what the conversation was told. Then its runtime context is replaced by the agent
//! list reminder (an intact one is stripped first, `stripRuntimeUserContext`, and its prefix and suffix put back before
//! the new reminder; a stale one is left as it is). Only its settings notice is acknowledged (`noticeRevision`, `ask-turn-execute.mjs:63`); every other reminder
//! stays pending for the turn after.

use mixdog_core_session::session::prompt_notice::Revisions;
use mixdog_store::schema::record::Header;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::listing;
use super::listing::AgentEntry;

/// The input row is a failed message resent as it is: the actor stamps the completions it recorded.
pub fn is_retained(body: &Value) -> bool {
    body.pointer("/meta/transcript/previousCompletions").is_some()
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::String(text) => !text.is_empty(),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        _ => true,
    }
}

fn text_block(text: &str) -> Vec<Value> {
    if text.is_empty() { Vec::new() } else { vec![json!({ "type": "text", "text": text })] }
}

/// `stripRuntimeUserContext(message)`: the content without the producer's own prefix and suffix, or `None` when there is
/// no context or its boundaries are stale.
fn stripped(content: &Value, role: Option<&Value>, context: Option<&Value>) -> Option<Value> {
    if role.and_then(Value::as_str) != Some("user") {
        return None;
    }
    let context = context?;
    let (prefix, suffix) = (context.get("prefix")?.as_str()?, context.get("suffix")?.as_str()?);
    match content {
        Value::String(text) => {
            if text.len() < prefix.len() + suffix.len() || !text.starts_with(prefix) || !text.ends_with(suffix) {
                return None;
            }
            Some(Value::String(text[prefix.len()..text.len() - suffix.len()].to_owned()))
        }
        Value::Array(parts) => {
            let block = |part: Option<&Value>, want: &str| part.is_some_and(|part| part.get("type").and_then(Value::as_str) == Some("text") && part.get("text").and_then(Value::as_str) == Some(want));
            if (!prefix.is_empty() && !block(parts.first(), prefix)) || (!suffix.is_empty() && !block(parts.last(), suffix)) || parts.len() < usize::from(!prefix.is_empty()) + usize::from(!suffix.is_empty()) {
                return None;
            }
            Some(Value::Array(parts[usize::from(!prefix.is_empty())..parts.len() - usize::from(!suffix.is_empty())].to_vec()))
        }
        _ => None,
    }
}

/// `withAgentListingNotice(session, index, message, current)`, and the revisions the retried turn acknowledges (the
/// settings notice the message carried). `prior` is the history before the message; `current` the agents enabled now.
pub fn resubmit(message: &Value, header: &Header, prior: &[Value], current: Option<&[AgentEntry]>) -> Result<(Value, Revisions), String> {
    let settings = message.pointer("/meta/promptSettingsNoticeRevision").filter(|revision| truthy(revision)).and_then(Value::as_i64);
    let revisions = Revisions { settings, ..Revisions::default() };
    // The conversation as it stands, the message included: what it was told counts.
    let mut held = prior.to_vec();
    held.push(message.clone());
    let Some(notice) = listing::notice(header, &held, current) else { return Ok((message.clone(), revisions)) };
    let net = listing::notice(header, prior, current);

    let mut meta: Map<String, Value> = message.get("meta").and_then(Value::as_object).cloned().unwrap_or_default();
    meta.shift_remove("agentListing");
    let content = message.get("content").ok_or_else(|| "the retained message has no content".to_owned())?;
    // `owned` is read off the stripped message's meta: an intact context comes off it, so the message's own prefix and
    // suffix are put back around the stripped content; a stale one stays in the meta, so nothing is owned.
    let (inner, prefix, owned_suffix) = match stripped(content, message.get("role"), meta.get("runtimeUserContext")) {
        Some(inner) => {
            let own = |key: &str| meta.get("runtimeUserContext").and_then(|context| context.get(key)).and_then(Value::as_str).unwrap_or_default().to_owned();
            let owned = (inner, own("prefix"), own("suffix"));
            meta.shift_remove("runtimeUserContext");
            owned
        }
        None => (content.clone(), String::new(), String::new()),
    };
    let suffix = format!("{owned_suffix}\n\n{}", notice.content);
    let content = match inner {
        Value::String(text) => Value::String(format!("{prefix}{text}{suffix}")),
        Value::Array(parts) => Value::Array(text_block(&prefix).into_iter().chain(parts).chain(text_block(&suffix)).collect()),
        other => Value::String(format!("{prefix}{}{suffix}", mixdog_js::value_to_string(&other))),
    };
    if let Some(net) = net {
        meta.insert("agentListing".into(), net.meta);
    }
    meta.insert("runtimeUserContext".into(), json!({ "prefix": prefix, "suffix": suffix }));
    let mut resent = message.clone();
    resent["content"] = content;
    resent["meta"] = Value::Object(meta);
    Ok((resent, revisions))
}