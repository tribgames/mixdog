use super::*;
use crate::queue::queue::QueueError;
use crate::runner::guard::guard_message;

/// Why a command ended without the reply it was after.
#[derive(Debug)]
pub(super) enum RunError {
    /// A failure the agent reads, as the text says it.
    Failed(String),
    Cancelled(Option<Arc<str>>),
    /// The command ran past its ceiling.
    TimedOut(String),
    /// A failure the core already typed (a person who did not approve).
    Tool(ToolError),
    /// The command ends with this reply instead of failing (a dialog blocks the page).
    Reply(Box<ToolReply>),
    /// The host connection was lost after a request of the command was handed to it ([`HostCallError::ConnectionLost`]).
    ConnectionLost,
}

impl From<Cancelled> for RunError {
    fn from(cancelled: Cancelled) -> Self {
        Self::Cancelled(cancelled.reason)
    }
}

impl From<QueueError> for RunError {
    fn from(error: QueueError) -> Self {
        match error {
            QueueError::Cancelled { reason } => Self::Cancelled(reason),
            QueueError::TimedOut { .. } => Self::TimedOut(error.to_string()),
            QueueError::LocalInput => Self::Failed(LOCAL_INPUT_TAKEOVER.to_owned()),
        }
    }
}

impl From<HostCallError> for RunError {
    fn from(error: HostCallError) -> Self {
        match error {
            HostCallError::Cancelled => Self::Cancelled(None),
            HostCallError::ConnectionLost => Self::ConnectionLost,
            HostCallError::DialogBlocking { dialog } => Self::Reply(Box::new(blocking_dialog_reply(&dialog, false, &|text: &str| redact_browser_text(text)))),
            HostCallError::PageGone => Self::Failed("the page is gone; call list_tabs to see what is open, then navigate or use background:true".to_owned()),
            HostCallError::UserInput { .. } => Self::Failed(LOCAL_INPUT_TAKEOVER.to_owned()),
            HostCallError::StaleSnapshot => Self::Failed("the snapshot is stale; take a fresh snapshot before continuing".to_owned()),
            HostCallError::PreconditionFailed { reason, .. } => Self::Failed(format!(
                "the page changed before the action was sent ({reason:?}); nothing was dispatched. Take a fresh snapshot before continuing."
            )),
            HostCallError::Refused { reason } => Self::Failed(reason),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl From<ActionError> for RunError {
    fn from(error: ActionError) -> Self {
        match error {
            ActionError::Cancelled(cancelled) => cancelled.into(),
            ActionError::Host(error) => error.into(),
            ActionError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<observe::ActionError> for RunError {
    fn from(error: observe::ActionError) -> Self {
        match error {
            observe::ActionError::Cancelled(cancelled) => cancelled.into(),
            observe::ActionError::Host(error) => error.into(),
            observe::ActionError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<RefError> for RunError {
    fn from(error: RefError) -> Self {
        match error {
            RefError::Host(error) => error.into(),
            RefError::Refused { message, .. } | RefError::Failed(message) => Self::Failed(message),
        }
    }
}

impl From<page::PageActionError> for RunError {
    fn from(error: page::PageActionError) -> Self {
        match error {
            page::PageActionError::Invalid(message) => Self::Failed(message),
            page::PageActionError::Host(error) => error.into(),
        }
    }
}

impl From<UploadError> for RunError {
    fn from(error: UploadError) -> Self {
        match error {
            UploadError::Invalid(message) | UploadError::Failed(message) => Self::Failed(message),
            UploadError::Host(error) => error.into(),
        }
    }
}

impl From<SettleError> for RunError {
    fn from(error: SettleError) -> Self {
        match error {
            SettleError::Cancelled(cancelled) => cancelled.into(),
            SettleError::ConnectionLost => Self::ConnectionLost,
            SettleError::Failed(text) => Self::Failed(text),
        }
    }
}

impl From<ReplyWaitError> for RunError {
    fn from(error: ReplyWaitError) -> Self {
        match error {
            ReplyWaitError::Settle(error) => error.into(),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl From<crate::reply::reply::ReplyError> for RunError {
    fn from(error: crate::reply::reply::ReplyError) -> Self {
        Self::Failed(error.message)
    }
}

impl From<ApprovalError> for RunError {
    fn from(error: ApprovalError) -> Self {
        match error {
            ApprovalError::NotApproved { reason } => Self::Tool(ToolError::new(ToolErrorCode::PermissionDenied, browser_not_approved(&reason))),
            ApprovalError::Cancelled => Self::Cancelled(None),
            other => Self::Failed(other.to_string()),
        }
    }
}

impl RunError {
    /// The failure as the tool answers it, its text through the secret guard.
    pub(super) fn into_tool_error(self, secrets: &dyn SecretGuard, session: &str) -> ToolError {
        let guarded = |message: &str| guard_message(secrets, session, &redact_browser_text(message));
        match self {
            Self::Failed(message) => {
                let message = guarded(&message);
                ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
            }
            Self::Reply(reply) => {
                let message = guarded(&reply.text);
                ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
            }
            Self::Cancelled(reason) => {
                ToolError::new(ToolErrorCode::Cancelled, reason.map_or_else(|| "browser command cancelled".to_owned(), |reason| reason.to_string()))
            }
            Self::TimedOut(message) => ToolError::new(ToolErrorCode::DeadlineExceeded { partial: false }, message),
            Self::Tool(error) => error,
            Self::ConnectionLost => {
                let message = HostCallError::ConnectionLost.to_string();
                ToolError::new(ToolErrorCode::Failed { reason: message.clone() }, message)
            }
        }
    }
}
