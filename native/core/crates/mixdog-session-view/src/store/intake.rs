//! The prompt surface of the store: submit, steer, abort, restoreQueued and the answers to tool approvals (`session-api/intake.mjs`,
//! `intake/submission.mjs`, `intake/abort.mjs`). The core owns the queue, the idle auto-clear and the hand-back of an interrupted
//! prompt (`turn/start` queues while a turn runs, `turn/interrupt` decides between a stop and the hand-back of a queued submission,
//! `thread/queue/delete` restores), so each call here is one request with the Node intake's options mapped to its params.

use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use mixdog_app_server_client::CallOptions;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::SessionStore;
use super::StoreError;
use crate::state::approval_surface;

/// What `turn/start` made of a prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnStart {
    /// The prompt began a turn.
    Started { turn_id: String },
    /// A turn, a command or an auto-clear was running: the prompt waits in the queue.
    Queued { queued_id: String },
}

/// An accepted submission: the id it travels under (the one `abort` and the queue name it by) and where the core put it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Submitted {
    pub submission_id: String,
    pub turn: TurnStart,
}

/// The `SubmitOptions` keys that pass through from the caller's options (`SUBMIT_OPTION_KEYS` of the desktop's service route); the
/// caller's `id` is `clientSubmissionId`, and the fields the host stamps are not the caller's to send.
const SUBMIT_OPTION_KEYS: [&str; 9] =
    ["submittedAt", "goalCommand", "retryFailedTurn", "retryTurnId", "retryAttemptId", "priority", "pastedImages", "pastedTexts", "kickoff"];

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
}

/// `promptContentText` of the parts that are not media references.
fn parts_text(parts: &[Value]) -> String {
    parts
        .iter()
        .filter(|part| {
            !(part["type"] == "text"
                && part.get("attachmentReference").is_some_and(|reference| !reference.is_null() && reference != &Value::Bool(false))
                && part["text"].is_string())
        })
        .map(|part| match part {
            Value::String(text) => text.clone(),
            part if part["type"] == "text" => part["text"].as_str().unwrap_or_default().to_owned(),
            part if part["type"] == "image" => "[Image]".to_owned(),
            part if part["type"] == "file" => "[File]".to_owned(),
            part => part["text"].as_str().unwrap_or_default().to_owned(),
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `promptDisplayText`: the options' own display text when it has any, else the words of the prompt.
fn display_text(prompt: &Value, options: &Value) -> String {
    if let Some(text) = options["displayText"].as_str().filter(|text| !text.trim().is_empty()) {
        return text.to_owned();
    }
    match prompt {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts_text(parts),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// The `options` of the turn input of a submission.
fn submit_options(options: &Value, submission_id: &str, display: &str) -> Value {
    let mut sent = Map::new();
    for key in SUBMIT_OPTION_KEYS {
        if let Some(value) = options.get(key).filter(|value| !value.is_null()) {
            sent.insert(key.to_owned(), value.clone());
        }
    }
    sent.entry("submittedAt".to_owned()).or_insert_with(|| json!(now_ms()));
    sent.insert("clientSubmissionId".to_owned(), json!(submission_id));
    sent.insert("displayText".to_owned(), json!(display));
    Value::Object(sent)
}

fn turn_start_of(reply: &Value) -> Result<TurnStart, StoreError> {
    let text = |key: &str| reply[key].as_str().map(str::to_owned);
    match reply["kind"].as_str() {
        Some("started") => text("turnId").map(|turn_id| TurnStart::Started { turn_id }),
        Some("queued") => text("queuedId").map(|queued_id| TurnStart::Queued { queued_id }),
        _ => None,
    }
    .ok_or_else(|| StoreError::Protocol("turn/start answered with neither a turn nor a queue entry".to_owned()))
}

/// A request id or a card id as text (`String(id)`).
fn id_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

impl SessionStore {
    fn require_thread(&self) -> Result<String, StoreError> {
        self.inner.thread_id().ok_or(StoreError::NoSession)
    }

    /// Submits a prompt (`submit` / `submitAsync`): a string or the parts of a prompt with `options` (`id`, `displayText`, `priority`,
    /// `kickoff`, `pastedImages`, `pastedTexts`, `goalCommand`, retry fields). `None`: nothing was submitted, the prompt has no words
    /// (the Node intake's `false`). The reply says whether the prompt began a turn or waits in the queue; the call answers once the
    /// core holds it either way.
    pub async fn submit(&self, prompt: &Value, options: &Value) -> Result<Option<Submitted>, StoreError> {
        let thread = self.require_thread()?;
        let display = display_text(prompt, options);
        if display.trim().is_empty() {
            return Ok(None);
        }
        // Always a submission id, so a retried call or a second path dedupes instead of booking the prompt twice.
        let submission_id = options["id"]
            .as_str()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map_or_else(|| format!("sub-{}-{}", now_ms(), self.inner.submissions.fetch_add(1, Ordering::AcqRel) + 1), str::to_owned);
        let params = json!({
            "threadId": thread,
            "input": { "prompt": prompt, "options": submit_options(options, &submission_id, &display) },
        });
        let reply = self.inner.client.call_raw("turn/start", params, CallOptions::default()).await?;
        Ok(Some(Submitted { submission_id, turn: turn_start_of(&reply)? }))
    }

    /// Steers the running turn with the queued prompt `queued_id` (`prioritizeQueued`).
    pub async fn steer(&self, queued_id: &str) -> Result<Value, StoreError> {
        let thread = self.require_thread()?;
        Ok(self.inner.client.call_raw("turn/steer", json!({ "threadId": thread, "queuedId": queued_id }), CallOptions::default()).await?)
    }

    /// Esc (`abort` / `abortAsync`). While idle a queued submission named by `options.submissionId` is handed back to the draft; during
    /// a turn the turn is cancelled and, unless a steering prompt is queued, the interrupted prompt is handed back (`options.restorePrompt`
    /// false keeps it). The core decides both and answers what `abort` answered: `aborted`, `restoreText`, the pasted attachments, the
    /// notice and the restored submission ids.
    pub async fn abort(&self, options: &Value) -> Result<Value, StoreError> {
        let thread = self.require_thread()?;
        let mut params = Map::new();
        params.insert("threadId".to_owned(), json!(thread));
        if let Some(restore) = options["restorePrompt"].as_bool() {
            params.insert("restorePrompt".to_owned(), json!(restore));
        }
        if let Some(id) = options["submissionId"].as_str().map(str::trim).filter(|id| !id.is_empty()) {
            params.insert("submissionId".to_owned(), json!(id));
        }
        Ok(self.inner.client.call_raw("turn/interrupt", Value::Object(params), CallOptions::default()).await?)
    }

    /// Hands queued submissions back to the composer (`restoreQueued`): every entry, or the one `queued_id` names. `current_text` is the
    /// composer's text, which the answer's `text` ends with.
    pub async fn restore_queued(&self, current_text: &str, queued_id: Option<&str>) -> Result<Value, StoreError> {
        let thread = self.require_thread()?;
        let mut params = Map::new();
        params.insert("threadId".to_owned(), json!(thread));
        params.insert("restore".to_owned(), json!(true));
        params.insert("currentText".to_owned(), json!(current_text));
        if let Some(id) = queued_id.filter(|id| !id.is_empty()) {
            params.insert("queuedId".to_owned(), json!(id));
        }
        Ok(self.inner.client.call_raw("thread/queue/delete", Value::Object(params), CallOptions::default()).await?)
    }

    /// Answers the pending approval or question the card `card_id` shows (`resolveToolApproval`): `decision` is the card's answer
    /// (`{ approved, reason, answers }`). `true` when this answer settled it, `false` when it was settled already or no such request is
    /// pending on this session.
    pub async fn resolve_tool_approval(&self, card_id: &str, decision: &Value) -> Result<bool, StoreError> {
        let thread = self.require_thread()?;
        let asked = self
            .inner
            .client
            .pending_server_requests()
            .into_iter()
            .filter_map(|request| {
                let surface = approval_surface(&request);
                serde_json::to_value(&request).ok().map(|wire| (surface, wire))
            })
            .find(|(surface, wire)| {
                surface.as_deref() == Some(thread.as_str()) && (id_text(&wire["id"]) == card_id || wire["params"]["card"]["id"].as_str() == Some(card_id))
            });
        let Some((_, wire)) = asked else { return Ok(false) };
        let mut answer = decision.as_object().cloned().unwrap_or_default();
        answer.remove("device");
        let owner = wire["params"]["threadId"].as_str().map_or(thread, str::to_owned);
        let params = json!({ "threadId": owner, "approvalId": id_text(&wire["id"]), "result": answer });
        let reply = self.inner.client.call_raw("thread/approval/answer", params, CallOptions::default()).await?;
        Ok(reply["accepted"] == true)
    }

    /// Allows or denies the pending approval `request_id` (the card's id) with the answers the card gives on Enter and on dismiss.
    pub async fn respond_approval(&self, request_id: &str, allow: bool) -> Result<bool, StoreError> {
        let decision =
            if allow { json!({ "approved": true, "reason": "answered by user" }) } else { json!({ "approved": false, "reason": "dismissed by user" }) };
        self.resolve_tool_approval(request_id, &decision).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_display_text_is_the_options_or_the_words_of_the_prompt() {
        assert_eq!(display_text(&json!("hi"), &json!({})), "hi");
        assert_eq!(display_text(&json!("hi"), &json!({ "displayText": "shown" })), "shown");
        assert_eq!(display_text(&json!("hi"), &json!({ "displayText": "  " })), "hi");
        let parts = json!([
            { "type": "text", "text": "look" },
            { "type": "image" },
            { "type": "text", "text": "ref", "attachmentReference": true },
            { "type": "file" },
        ]);
        assert_eq!(display_text(&parts, &json!({})), "look\n[Image]\n[File]");
        assert_eq!(display_text(&json!([]), &json!({})), "");
    }

    #[test]
    fn the_submit_options_are_the_protocols_and_carry_the_submission_id() {
        let options = json!({ "id": "x", "mode": "prompt", "priority": "now", "kickoff": true, "device": "d", "submittedAt": 5 });
        assert_eq!(
            submit_options(&options, "x", "hi"),
            json!({ "submittedAt": 5, "priority": "now", "kickoff": true, "clientSubmissionId": "x", "displayText": "hi" })
        );
        assert!(submit_options(&json!({}), "y", "hi")["submittedAt"].is_i64());
    }

    #[test]
    fn a_turn_start_reply_is_a_turn_or_a_queue_entry() {
        assert_eq!(turn_start_of(&json!({ "kind": "started", "turnId": "t1" })).ok(), Some(TurnStart::Started { turn_id: "t1".to_owned() }));
        assert_eq!(turn_start_of(&json!({ "kind": "queued", "queuedId": "q1" })).ok(), Some(TurnStart::Queued { queued_id: "q1".to_owned() }));
        assert!(turn_start_of(&json!({})).is_err());
    }
}
