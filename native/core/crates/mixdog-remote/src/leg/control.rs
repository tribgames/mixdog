//! Request/response envelopes between this desktop leg and the relay itself (`list-clients`,
//! `revoke-client`, `ice-servers-request`): each carries a request id the relay echoes and waits
//! at most one revoke timeout for its answer (remote-relay-control.ts).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio::sync::oneshot;

pub const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ControlError {
    #[error("Relay is not connected.")]
    NotConnected,
    #[error("Relay device request timed out.")]
    TimedOut,
    #[error("{0}")]
    Failed(String),
}

type Answer = Result<Value, ControlError>;

#[derive(Default)]
pub struct ControlRequests {
    pending: Mutex<HashMap<String, oneshot::Sender<Answer>>>,
}

impl ControlRequests {
    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<String, oneshot::Sender<Answer>>> {
        self.pending.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Sends `{type, requestId, ...payload}` through `send` and waits for the relay's answer.
    /// `send` returns false when the leg is down.
    pub async fn request(
        &self,
        kind: &str,
        payload: Map<String, Value>,
        send: impl FnOnce(Value) -> bool,
    ) -> Answer {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending().insert(request_id.clone(), tx);
        let mut envelope = json!({ "type": kind, "requestId": request_id });
        if let Some(map) = envelope.as_object_mut() {
            map.extend(payload);
        }
        if !send(envelope) {
            self.pending().remove(&request_id);
            return Err(ControlError::NotConnected);
        }
        match tokio::time::timeout(REVOKE_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(ControlError::NotConnected),
            Err(_) => {
                self.pending().remove(&request_id);
                Err(ControlError::TimedOut)
            }
        }
    }

    /// Settles the request a control answer belongs to. An answer with no waiting request is
    /// dropped. `ice-servers` resolves with the whole envelope, since a refusal carries the
    /// relay's STUN URL; a failed list or revoke rejects with the relay's error.
    pub fn settle(&self, envelope: &Value) {
        let request_id = envelope.get("requestId").and_then(Value::as_str).unwrap_or_default();
        let Some(waiting) = self.pending().remove(request_id) else { return };
        let kind = envelope.get("type").and_then(Value::as_str).unwrap_or_default();
        let answer = if kind == "ice-servers" {
            Ok(envelope.clone())
        } else if envelope.get("ok") == Some(&Value::Bool(false)) {
            let message = envelope.get("error").and_then(Value::as_str).filter(|m| !m.is_empty());
            Err(ControlError::Failed(message.unwrap_or("Relay device request failed.").to_owned()))
        } else if kind == "clients-list" {
            Ok(envelope.get("clients").cloned().unwrap_or(Value::Null))
        } else {
            Ok(envelope.get("ok").cloned().unwrap_or(Value::Null))
        };
        let _ = waiting.send(answer);
    }

    /// The leg closed: every waiting request fails.
    pub fn reject_all(&self, error: &ControlError) {
        for (_, waiting) in self.pending().drain() {
            let _ = waiting.send(Err(error.clone()));
        }
    }
}
