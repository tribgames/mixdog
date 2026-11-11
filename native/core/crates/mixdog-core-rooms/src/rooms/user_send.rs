//! A user's message into a group room (`agent-room-messages.ts` `acceptSend`), as any composer sends it: the desktop's and the
//! phone's `submitToSession` on a room log is `room/send` (`service-route.ts`), served by the room service. The steps are
//! `LiveRooms::send`'s; this module reads the request and builds what goes up with the row.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_js::js_trim;
use serde_json::{Map, Value};

use super::RoomError;
use super::calls::{CallRunner, RoomCalls};
use super::live::LiveRooms;
use super::records::{RoomStore, Rooms};

/// One message as `submitToSession(sessionId, prompt, options)` gives it (`session-host.ts:1089-1091`).
#[derive(Clone, Debug, PartialEq)]
pub struct UserMessage {
    /// The room's log session.
    pub session_id: String,
    /// A text, or a list of parts (`DesktopPromptContent`).
    pub prompt: Value,
    /// `options.id` (`clientSubmissionId` on the wire); empty for none.
    pub submission_id: String,
    pub pasted_images: Option<Value>,
    pub pasted_texts: Option<Value>,
}

impl UserMessage {
    /// `room/send`'s input `{ threadId, prompt, options }`, `options` as `turn/start` takes them (`clientSubmissionId`,
    /// `pastedImages`, `pastedTexts`; the others say nothing to a room).
    pub fn of(input: &Value) -> Result<Self, RoomError> {
        let session_id = input.get("threadId").and_then(Value::as_str).ok_or_else(|| RoomError::Invalid("threadId is required.".into()))?;
        let prompt = input
            .get("prompt")
            .filter(|prompt| prompt.is_string() || prompt.is_array())
            .cloned()
            .ok_or_else(|| RoomError::Invalid("prompt is a text or a list of parts.".into()))?;
        let option = |key: &str| input.get("options").and_then(|options| options.get(key)).filter(|value| !value.is_null()).cloned();
        Ok(Self {
            session_id: session_id.to_owned(),
            prompt,
            submission_id: option("clientSubmissionId").and_then(|id| id.as_str().map(str::to_owned)).unwrap_or_default(),
            pasted_images: option("pastedImages"),
            pasted_texts: option("pastedTexts"),
        })
    }
}

/// `promptText(prompt)`: a text trimmed, or the text parts joined by line breaks and trimmed.
pub(crate) fn prompt_text(prompt: &Value) -> String {
    match prompt {
        Value::String(text) => js_trim(text).to_owned(),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts
                .iter()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .filter(|text| !text.is_empty())
                .collect();
            js_trim(&texts.join("\n")).to_owned()
        }
        _ => String::new(),
    }
}

/// `Object.keys(value ?? {}).length`: a side table that names anything.
fn named_anything(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| match value {
        Value::Object(map) => !map.is_empty(),
        Value::Array(list) => !list.is_empty(),
        Value::String(text) => !text.is_empty(),
        _ => false,
    })
}

/// `roomUpload(prompt, pasted)` (`agent-room-messages.ts:36-46`): the files a message carries up with its row (its image and
/// file parts, and the pasted / attached texts its tokens name); `None` when it has none.
pub(crate) fn room_upload(message: &UserMessage) -> Option<Value> {
    let parts: Vec<Value> = match &message.prompt {
        Value::Array(parts) => parts.iter().filter(|part| part.get("type").and_then(Value::as_str) != Some("text")).cloned().collect(),
        _ => Vec::new(),
    };
    let images = named_anything(message.pasted_images.as_ref());
    let texts = named_anything(message.pasted_texts.as_ref());
    if parts.is_empty() && images.is_none() && texts.is_none() {
        return None;
    }
    let mut upload = Map::new();
    upload.insert("parts".into(), Value::Array(parts));
    if let Some(images) = images {
        upload.insert("pastedImages".into(), images.clone());
    }
    if let Some(texts) = texts {
        upload.insert("pastedTexts".into(), texts.clone());
    }
    Some(Value::Object(upload))
}

/// The row id a submission id gives (`/^[A-Za-z0-9_-]{1,100}$/`), so the sender's pending bubble gives way to the row.
pub(crate) fn submission_row_id(submission_id: &str) -> Option<&str> {
    let fits = (1..=100).contains(&submission_id.len())
        && submission_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    fits.then_some(submission_id)
}

/// The room service's way to post a user's message.
#[async_trait]
pub trait RoomSend: Send + Sync {
    /// True when the message was posted; false when its submission was accepted before (acknowledged, nothing posted).
    async fn send(&self, message: &UserMessage) -> Result<bool, RoomError>;
}

/// [`RoomSend`] over the hosted rooms, their records and the one scheduler (as `compose_flip.rs` composes them).
pub struct UserSend<S: RoomStore, R: CallRunner> {
    rooms: Arc<Rooms<S>>,
    live: Arc<LiveRooms>,
    calls: Arc<RoomCalls<R>>,
}

impl<S: RoomStore, R: CallRunner> UserSend<S, R> {
    pub fn new(rooms: Arc<Rooms<S>>, live: Arc<LiveRooms>, calls: Arc<RoomCalls<R>>) -> Self {
        Self { rooms, live, calls }
    }
}

#[async_trait]
impl<S: RoomStore + 'static, R: CallRunner + 'static> RoomSend for UserSend<S, R> {
    async fn send(&self, message: &UserMessage) -> Result<bool, RoomError> {
        self.live.send(&self.rooms, &self.calls, message).await
    }
}
