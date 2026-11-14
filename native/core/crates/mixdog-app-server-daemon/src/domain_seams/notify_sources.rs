//! What the session notification producer (`notify_producer.rs`) reads from this process: the recorded answer of a turn
//! (`thread/finalAnswer/read` of the session directory), the agent that owns an unattended run, and the fixed texts of a toast
//! in the language the desktop published.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_connections::notifier::{AnswerReadError, AttachmentKind, FinalAnswers};
use mixdog_connections::server_feed::{FinalAnswer, FinalAnswerStatus};
use mixdog_core_api::call::{CallContext, CoreRequest};
use mixdog_core_api::ids::Method;
use mixdog_core_api::{CoreError, Reply, ThreadDirectory};
use mixdog_core_session::session::SessionDirectory;
use serde_json::{Value, json};

use super::notify_producer::{ProducerTexts, RunOwners, Wait};
use crate::compose_connections::UiLanguage;
use crate::held_requests::HeldHome;

/// `thread/finalAnswer/read` over the session directory: the answer of the turn that started at `started_at`, `None` while it is
/// pending.
pub struct DirectoryFinalAnswers {
    directory: Arc<SessionDirectory>,
}

impl DirectoryFinalAnswers {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

/// The answer a read returned: `{ id, at, status: done | failed | cancelled, text, reacted? }`; `None` for no answer yet.
fn answer_of(value: &Value) -> Option<FinalAnswer> {
    let fields = value.as_object()?;
    let status = match fields.get("status")?.as_str()? {
        "done" => FinalAnswerStatus::Done,
        "failed" => FinalAnswerStatus::Failed,
        "cancelled" => FinalAnswerStatus::Cancelled,
        _ => return None,
    };
    let at = fields.get("at")?;
    let at = at.as_i64().or_else(|| at.as_f64().map(|n| n as i64))?;
    Some(FinalAnswer {
        id: fields.get("id").cloned().unwrap_or(Value::Null),
        at,
        status,
        text: fields.get("text").and_then(Value::as_str).unwrap_or_default().to_owned(),
        reacted: fields.get("reacted").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// The session store says the record is gone (deleted, never persisted): no later read can produce its answer.
fn session_missing(error: &CoreError) -> bool {
    matches!(error, CoreError::ThreadNotFound { .. }) || format!("{error:?}").to_lowercase().contains("is not available")
}

#[async_trait]
impl FinalAnswers for DirectoryFinalAnswers {
    async fn read(&self, session_id: &str, started_at: i64) -> Result<Option<FinalAnswer>, AnswerReadError> {
        let request = CoreRequest {
            method: Method("thread/finalAnswer/read"),
            params: json!({ "threadId": session_id, "startedAt": started_at }),
            op: None,
            ctx: CallContext::internal("turn-notification"),
        };
        match self.directory.request(request).await {
            Ok(Reply::Value(value)) => Ok(answer_of(&value)),
            Ok(_) => Err(AnswerReadError::Failed("the final answer read answered no value".to_owned())),
            Err(error) if session_missing(&error) => Err(AnswerReadError::SessionMissing),
            Err(error) => Err(AnswerReadError::Failed(format!("{error:?}"))),
        }
    }
}

/// The agent that owns the unattended run of a session (the held-request home's `run_of`).
pub struct HeldRunOwners(pub Arc<dyn HeldHome>);

#[async_trait]
impl RunOwners for HeldRunOwners {
    async fn owner_of(&self, session_id: &str) -> Option<String> {
        self.0.run_of(&mixdog_protocol::ThreadId::from(session_id)).await.map(|run| run.agent_id)
    }
}

/// The fixed texts of a toast, in the desktop's language.
pub struct CatalogProducerTexts(pub UiLanguage);

impl ProducerTexts for CatalogProducerTexts {
    fn turn_failed(&self) -> String {
        self.0.translate("The turn stopped with an error.")
    }

    fn waiting(&self, wait: Wait) -> String {
        self.0.translate(match wait {
            Wait::Approval => "Waiting for your approval.",
            Wait::Question => "Waiting for your answer.",
        })
    }

    fn attachment_label(&self, kind: AttachmentKind) -> String {
        self.0.translate(match kind {
            AttachmentKind::Image => "Image",
            AttachmentKind::Video => "Video",
            AttachmentKind::File => "File",
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_read_answer_is_the_recorded_turn_answer() {
        let done = answer_of(&json!({ "id": "t1", "at": 2000, "status": "done", "text": "Checked." })).unwrap();
        assert_eq!((done.at, done.status, done.text.as_str(), done.reacted), (2000, FinalAnswerStatus::Done, "Checked.", false));
        let reacted = answer_of(&json!({ "id": "t1", "at": 2000.0, "status": "done", "text": "", "reacted": true })).unwrap();
        assert!(reacted.reacted && reacted.at == 2000);
        let failed = answer_of(&json!({ "id": "t1", "at": 3, "status": "failed", "text": "" })).unwrap();
        assert_eq!(failed.status, FinalAnswerStatus::Failed);
    }

    #[test]
    fn a_pending_answer_is_none_and_an_unknown_status_is_not_an_answer() {
        assert!(answer_of(&Value::Null).is_none());
        assert!(answer_of(&json!({ "at": 1, "status": "running" })).is_none());
        assert!(answer_of(&json!({ "status": "done" })).is_none(), "no time: not an answer");
    }

    #[test]
    fn a_session_whose_record_is_gone_is_missing_and_any_other_failure_is_not() {
        let gone = CoreError::ThreadNotFound { thread_id: mixdog_protocol::ThreadId::from("s1") };
        assert!(session_missing(&gone));
        assert!(!session_missing(&CoreError::ConnectionClosed));
    }
}
