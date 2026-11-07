//! The prompt-cache warmer's view of a turn start (`noteTurnForCacheWarm`,
//! `manager/ask-session.mjs:195-201`, called at `:313` when the ask claims the turn; the entry is
//! ended by `endCacheWarmTurn` at `:353` and in the `finally` at `:386`).
//!
//! The actor tells the port each turn's provenance as `cacheWarmTurnKind`'s `input` reads it:
//! `promptSource` / `promptOrigin` from the input row's meta (`turnPromptSourceFor`,
//! `ask-turn-execute.mjs:27-34`, spread into the row at `ask-turn-prepare.mjs:223-225`) and the
//! retry flags of the submission. The guard the port returns ends the warmer's turn when it is
//! dropped, whichever way the turn ends.

use std::sync::Arc;

use mixdog_core_api::ids::ThreadId;
use mixdog_protocol::SubmitOptions;
use serde_json::Map;
use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::run::InputState;
use super::run::ModelContext;

/// `noteCacheWarmTurn(sessionId, cacheWarmTurnKind(input, messages))` over the production warmer.
pub trait TurnWarmth: Send + Sync {
    /// The turn of `thread` opened; dropping the guard is `endCacheWarmTurn`. `messages` are the
    /// session's model messages as the turn found them, read only for a retry
    /// (`cacheWarmTurnKind(input, claimed.preSession?.messages)`).
    fn begin(&self, thread: &ThreadId, input: &Value, messages: Option<&Value>) -> Box<dyn Send>;
}

/// One turn's note to the warmer, made in the run's task: a retry first reads the failed turn's
/// message through the run's own model-context read (`ModelContext::read`, the rows before the
/// input row, once the input is durable), as Node's `failedTurnProvenance(preSession.messages, input)`
/// does (`ask-session.mjs:198-201`; the stored `meta.source` / `meta.origin` / `meta.provenance` of
/// that message, `cache-warm.mjs:541-557`). No second store: the provenance is the failed message's own meta.
pub(crate) struct WarmNote {
    pub port: Arc<dyn TurnWarmth>,
    pub thread: ThreadId,
    pub input: Value,
    pub ready: watch::Receiver<InputState>,
    pub context: ModelContext,
    pub cancel: CancellationToken,
}

impl WarmNote {
    pub(crate) async fn begin(mut self) -> Box<dyn Send> {
        let retry = self.input.get("retryFailedTurn") == Some(&Value::Bool(true)) || self.input.get("retryTurnId").is_some();
        let messages = if retry { self.failed_context().await } else { None };
        self.port.begin(&self.thread, &self.input, messages.as_ref())
    }

    /// The model messages before the input row; `None` when they cannot be read, which Node's
    /// `failedTurnProvenance` also answers (null: the retry is a continuation).
    async fn failed_context(&mut self) -> Option<Value> {
        let durable = tokio::select! {
            () = self.cancel.cancelled() => return None,
            state = self.ready.wait_for(|state| *state != InputState::Pending) => matches!(state, Ok(state) if *state == InputState::Durable),
        };
        if !durable {
            return None;
        }
        match self.context.read().await {
            Ok(rows) => Some(Value::Array(rows.into_iter().map(|(_, message)| message).collect())),
            Err(error) => {
                tracing::warn!("{}: the failed turn's messages could not be read for the cache warmer: {error:?}", self.thread.as_str());
                None
            }
        }
    }
}

/// The `input` of `cacheWarmTurnKind` for a turn: `promptSource`, `promptOrigin`,
/// `retryFailedTurn` and `retryTurnId`. The failed turn's stored provenance
/// (`failedTurnProvenance`, `ask-session.mjs:199`) is not looked up: a retry reads as a
/// continuation unless its own row says otherwise.
pub fn warm_input(options: Option<&SubmitOptions>, row: &Value) -> Value {
    let mut input = Map::new();
    if let Some(source) = row.pointer("/meta/source").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        input.insert("promptSource".into(), Value::String(source.to_owned()));
    }
    if let Some(origin) = row.pointer("/meta/origin").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        input.insert("promptOrigin".into(), Value::String(origin.to_owned()));
    }
    if let Some(options) = options {
        if options.retry_failed_turn == Some(true) {
            input.insert("retryFailedTurn".into(), Value::Bool(true));
        }
        if let Some(id) = options.retry_turn_id.as_ref().filter(|id| !id.is_empty()) {
            input.insert("retryTurnId".into(), Value::String(id.clone()));
        }
    }
    Value::Object(input)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_input_carries_the_rows_provenance_and_the_retry_flags() {
        let row = json!({ "role": "user", "meta": { "source": "task-notification", "origin": "channel" } });
        assert_eq!(warm_input(None, &row), json!({ "promptSource": "task-notification", "promptOrigin": "channel" }));
        assert_eq!(warm_input(None, &json!({ "role": "user" })), json!({}));
        let retry = SubmitOptions { retry_failed_turn: Some(true), retry_turn_id: Some("m1".into()), ..SubmitOptions::default() };
        assert_eq!(warm_input(Some(&retry), &json!({})), json!({ "retryFailedTurn": true, "retryTurnId": "m1" }));
    }
}
