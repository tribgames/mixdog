//! A room's log as the room exchange writes it (`agent-room-delivery.mjs` `commit`): stored rows
//! appended to the room session without a turn, each shown live as it lands.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::thread::ThreadRoomView;
use mixdog_core_api::CoreError;
use mixdog_core_api::Reply;
use mixdog_core_api::ThreadHandle;
use mixdog_core_api::call::CallContext;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::ids::ThreadId;
use serde_json::Value;
use serde_json::json;

use super::SessionDirectory;

#[async_trait]
pub trait RoomLog: Send + Sync {
    /// Appends `messages` (each `roomRowMessage(row)`: `{role, content, meta: {source, room,
    /// transcript: {at, messageId, attachments?}}}`) to the log of `session_id`, in order after
    /// every earlier append to it. A message whose `meta.transcript.messageId` the log already
    /// holds, or an earlier message of the batch carries, is skipped. Resolves how many were
    /// added. Fails when the session does not exist or is closed (`session <id> is not
    /// available`).
    async fn append_rows(&self, session_id: &str, messages: Vec<Value>) -> Result<usize, CoreError>;
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `commit`'s filter: the messages of `messages` whose `meta.transcript.messageId` neither
/// `held` (the conversation; ids that are truthy) nor an earlier message of the batch carries.
/// A missing id is one value too, as in Node's `Set`.
pub(crate) fn fresh_rows<'a>(held: impl Iterator<Item = &'a Value>, messages: Vec<Value>) -> Vec<Value> {
    let key = |message: &Value| match message.pointer("/meta/transcript/messageId") {
        None => "undefined".to_owned(),
        Some(id) => id.to_string(),
    };
    let mut posted: HashSet<String> = held
        .filter(|message| message.pointer("/meta/transcript/messageId").is_some_and(truthy))
        .map(key)
        .collect();
    messages.into_iter().filter(|message| posted.insert(key(message))).collect()
}

/// [`RoomLog`] over the session directory: the room session, opened when not loaded, takes
/// the post through `thread/roomRows/append`.
pub struct SessionRoomLog {
    directory: Arc<SessionDirectory>,
}

impl SessionRoomLog {
    pub fn new(directory: Arc<SessionDirectory>) -> Self {
        Self { directory }
    }
}

#[async_trait]
impl RoomLog for SessionRoomLog {
    async fn append_rows(&self, session_id: &str, messages: Vec<Value>) -> Result<usize, CoreError> {
        let handle = open_for_post(&self.directory, session_id).await?;
        post(&handle, messages, CallContext::internal("room-log"), None).await
    }
}

impl SessionRoomLog {
    /// [`RoomLog::append_rows`] with the room's view as it stands with these rows (`None`: the room shows nothing): the log
    /// takes rows and view as one update, published as one revision.
    pub async fn append_rows_with_view(&self, session_id: &str, messages: Vec<Value>, view: Option<ThreadRoomView>) -> Result<usize, CoreError> {
        let handle = open_for_post(&self.directory, session_id).await?;
        post_on_opened_with_view(&handle, messages, view).await
    }

    /// The room's view set with no row of its own, in the log's own queue behind the posts before it. A room view is set on the
    /// log loaded for it; clearing one reaches only a log that is loaded (a fresh load has none).
    pub async fn set_view(&self, session_id: &str, view: Option<ThreadRoomView>) -> Result<(), CoreError> {
        let thread = ThreadId::from(session_id);
        let handle = match &view {
            Some(_) => Some(self.directory.open_handle(&thread, &CallContext::internal("room-view")).await?),
            None => self.directory.handle(&thread),
        };
        let Some(handle) = handle else { return Ok(()) };
        let params = json!({ "roomView": view });
        handle.request(CoreRequest { method: mixdog_core_api::ids::Method("thread/roomView/set"), params, op: None, ctx: CallContext::internal("room-view") }).await.map(drop)
    }
}

/// The room log opened for a post: one that is gone or closing is refused as `session <id> is not available`.
pub async fn open_for_post(directory: &SessionDirectory, session_id: &str) -> Result<Arc<super::SessionHandle>, CoreError> {
    let thread = ThreadId::from(session_id);
    directory.open_handle(&thread, &CallContext::internal("room-log")).await.map_err(|error| unavailable(session_id, error))
}

/// `session <id> is not available`: a log that is gone or closing (Node's `commit`, and the refusal of a save its
/// generation fence dropped).
fn unavailable(session_id: &str, error: CoreError) -> CoreError {
    match error {
        CoreError::ThreadNotFound { .. } | CoreError::ThreadClosing { .. } => {
            mixdog_core_base::support::failed("session", format!("session {session_id} is not available"))
        }
        other => other,
    }
}

/// The post itself, on a log already opened (what [`RoomLog::append_rows`] does after it opened the log): a log that closes
/// before the rows are taken in refuses them.
pub async fn post_on_opened(handle: &super::SessionHandle, messages: Vec<Value>) -> Result<usize, CoreError> {
    post(handle, messages, CallContext::internal("room-log"), None).await
}

/// [`post_on_opened`] with the room's view as it stands with the rows: one update of the log.
pub async fn post_on_opened_with_view(handle: &super::SessionHandle, messages: Vec<Value>, view: Option<ThreadRoomView>) -> Result<usize, CoreError> {
    post(handle, messages, CallContext::internal("room-log"), Some(view)).await
}

async fn post(handle: &super::SessionHandle, messages: Vec<Value>, ctx: CallContext, view: Option<Option<ThreadRoomView>>) -> Result<usize, CoreError> {
    let mut params = json!({ "messages": messages });
    if let Some(view) = view {
        params["roomView"] = json!(view);
    }
    let request = CoreRequest { method: mixdog_core_api::ids::Method("thread/roomRows/append"), params, op: None, ctx };
    match handle.request(request).await.map_err(|error| unavailable(handle.id.as_str(), error))? {
        Reply::Value(value) => Ok(value["added"].as_u64().unwrap_or(0) as usize),
        _ => Ok(0),
    }
}
