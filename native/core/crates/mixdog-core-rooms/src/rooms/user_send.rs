//! A user's message into a group room (`agent-room-messages.ts` `acceptSend`), as any composer sends it: the desktop's and the
//! phone's `submitToSession` on a room log is `room/send` (`service-route.ts`), served by the room service. The steps are
//! `LiveRooms::send`'s; this module reads the request and builds what goes up with the row.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::boundary::validate::prompt::canonical_prompt_file_mime;
use mixdog_js::{js_trim, slice_utf16, utf16_len};
use serde_json::{Map, Value, json};

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
    /// `room/send`'s input `{ threadId, prompt, options }`, `options` as `turn/start` takes them (`clientSubmissionId` for
    /// Node's `id`, `pastedImages`, `pastedTexts`; the others say nothing to a room). Read as Node's handlers read
    /// `submitToSession`'s arguments before anything happens, the desktop's (`ipc-sessions.ts:221-222`) and the phone's
    /// (`remote-session-methods.ts:155-158`) alike: `requiredSessionId`, `requiredPromptContent` and `requiredSubmitOptions`
    /// (`desktop-state.ts:58-65`, `ipc-validation.ts:1123-1266`). Anything else is refused before the room is looked at; the
    /// prompt goes on as those checks return it (an image's type lowercased, a file's canonical, its name cut at 160 units).
    pub fn of(input: &Value) -> Result<Self, RoomError> {
        let input = input.as_object().ok_or_else(|| invalid("room/send input is invalid."))?;
        if input.keys().any(|key| !matches!(key.as_str(), "threadId" | "prompt" | "options")) {
            return Err(invalid("room/send input contains an unsupported field."));
        }
        let session_id = required_session_id(input.get("threadId"))?;
        let prompt = required_prompt_content(input.get("prompt"))?;
        let options = required_submit_options(input.get("options"))?;
        let option = |key: &str| options.get(key).cloned();
        Ok(Self {
            session_id,
            prompt,
            submission_id: option("clientSubmissionId").and_then(|id| id.as_str().map(str::to_owned)).unwrap_or_default(),
            pasted_images: option("pastedImages"),
            pasted_texts: option("pastedTexts"),
        })
    }
}

/// Node's validators throw a plain `TypeError`, which reaches the caller as its message alone (no code).
fn invalid(message: &str) -> RoomError {
    RoomError::Refused(message.to_owned())
}

/// `MAX_PROMPT_LENGTH` (`ipc-validation.ts:315`), in UTF-16 units as every length below.
const MAX_PROMPT_LENGTH: usize = 1_000_000;
/// `MAX_STRUCTURED_STRING_TOTAL` (`ipc-validation.ts:316`).
const MAX_STRUCTURED_STRING_TOTAL: usize = 32_000_000;
/// `shared/prompt-limits.ts:3-14`.
const MAX_PROMPT_FILES: usize = 8;
const MAX_PROMPT_IMAGES: usize = 8;
const MAX_PROMPT_IMAGE_BASE64_LENGTH: usize = 16_000_000;
const MAX_PROMPT_IMAGE_BASE64_TOTAL: usize = 30_000_000;
const MAX_PROMPT_FILE_BASE64_LENGTH: usize = 28_000_000;
const MAX_PROMPT_FILE_BASE64_TOTAL: usize = 28_000_000;
const MAX_PROMPT_FILE_MIME_LENGTH: usize = 128;
/// `MAX_SESSION_ID_LENGTH` (`desktop-state.ts:51`).
const MAX_SESSION_ID_LENGTH: usize = 256;
/// `SUBMIT_OPTION_KEYS` (`ipc-validation.ts:339-349`), `id` as the wire names it.
const SUBMIT_OPTION_KEYS: [&str; 9] =
    ["clientSubmissionId", "submittedAt", "displayText", "goalCommand", "retryFailedTurn", "priority", "pastedImages", "pastedTexts", "kickoff"];

/// `requiredSessionId` (`desktop-state.ts:58-65`).
fn required_session_id(value: Option<&Value>) -> Result<String, RoomError> {
    let Some(Value::String(value)) = value else { return Err(invalid("session id must be a string.")) };
    let id = js_trim(value);
    if id.is_empty() || utf16_len(id) > MAX_SESSION_ID_LENGTH || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(invalid("session id is invalid."));
    }
    Ok(id.to_owned())
}

/// `requiredString(value, name, maximum)` (`ipc-validation.ts:656-660`): trimmed.
fn required_string(value: Option<&Value>, name: &str, maximum: usize) -> Result<String, RoomError> {
    let Some(Value::String(value)) = value else { return Err(invalid(&format!("{name} must be a string."))) };
    let text = js_trim(value);
    if text.is_empty() || utf16_len(text) > maximum {
        return Err(invalid(&format!("{name} is invalid.")));
    }
    Ok(text.to_owned())
}

/// `/^[A-Za-z0-9+/]*={0,2}$/`.
fn base64_shaped(data: &str) -> bool {
    let body = data.trim_end_matches('=');
    data.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// A part's `data`: a non-empty base64 text of at most `maximum` units.
fn part_data(part: &Map<String, Value>, maximum: usize, refusal: &str) -> Result<String, RoomError> {
    match part.get("data") {
        Some(Value::String(data)) if !data.is_empty() && data.len() <= maximum && base64_shaped(data) => Ok(data.clone()),
        _ => Err(invalid(refusal)),
    }
}

/// `requiredPromptContent` (`ipc-validation.ts:1152-1222`): the prompt as it goes on.
fn required_prompt_content(value: Option<&Value>) -> Result<Value, RoomError> {
    if let Some(Value::String(text)) = value {
        if js_trim(text).is_empty() || utf16_len(text) > MAX_PROMPT_LENGTH {
            return Err(invalid("prompt is invalid."));
        }
        return Ok(Value::String(text.clone()));
    }
    let parts = match value {
        Some(Value::Array(parts)) if !parts.is_empty() && parts.len() <= 32 => parts,
        _ => return Err(invalid("prompt content is invalid.")),
    };
    let (mut text_length, mut image_length, mut images, mut file_length, mut files) = (0, 0, 0, 0, 0);
    let mut has_content = false;
    let mut content = Vec::with_capacity(parts.len());
    for entry in parts {
        let Value::Object(part) = entry else { return Err(invalid("prompt part is invalid.")) };
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let Some(Value::String(text)) = part.get("text") else { return Err(invalid("prompt text part is invalid.")) };
                text_length += utf16_len(text);
                if text_length > MAX_PROMPT_LENGTH {
                    return Err(invalid("prompt text is too large."));
                }
                has_content |= !js_trim(text).is_empty();
                content.push(json!({ "type": "text", "text": text }));
            }
            Some("image") => {
                images += 1;
                if images > MAX_PROMPT_IMAGES {
                    return Err(invalid("too many prompt images."));
                }
                let mime = mixdog_js::js_to_lowercase(&required_string(part.get("mimeType"), "image mime type", 64)?);
                if !matches!(mime.as_str(), "image/png" | "image/jpg" | "image/jpeg" | "image/gif" | "image/webp") {
                    return Err(invalid("image type is unsupported."));
                }
                let data = part_data(part, MAX_PROMPT_IMAGE_BASE64_LENGTH, "image data is invalid.")?;
                image_length += data.len();
                if image_length > MAX_PROMPT_IMAGE_BASE64_TOTAL {
                    return Err(invalid("prompt images are too large."));
                }
                has_content = true;
                content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
            }
            Some("file") => {
                files += 1;
                if files > MAX_PROMPT_FILES {
                    return Err(invalid("too many prompt files."));
                }
                let mime = required_string(part.get("mimeType"), "file mime type", MAX_PROMPT_FILE_MIME_LENGTH)?;
                let mime = canonical_prompt_file_mime(&mime).ok_or_else(|| invalid("file type is unsupported."))?;
                let data = part_data(part, MAX_PROMPT_FILE_BASE64_LENGTH, "file data is invalid.")?;
                file_length += data.len();
                if file_length > MAX_PROMPT_FILE_BASE64_TOTAL {
                    return Err(invalid("prompt files are too large."));
                }
                has_content = true;
                let filename = part.get("filename").and_then(Value::as_str).map(|name| slice_utf16(name, 160)).unwrap_or_default();
                let mut file = json!({ "type": "file", "data": data, "mimeType": mime });
                if !filename.is_empty() {
                    file["filename"] = json!(filename);
                }
                content.push(file);
            }
            _ => return Err(invalid("prompt part type is unsupported.")),
        }
    }
    if !has_content {
        return Err(invalid("prompt is empty."));
    }
    Ok(Value::Array(content))
}

/// `validateStructuredValue` (`ipc-validation.ts:1123-1150`).
fn validate_structured(value: &Value, strings: &mut usize, nodes: &mut usize, depth: usize) -> Result<(), RoomError> {
    *nodes += 1;
    if *nodes > 20_000 || depth > 12 {
        return Err(invalid("structured input is too large."));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            *strings += utf16_len(text);
            if *strings > MAX_STRUCTURED_STRING_TOTAL {
                return Err(invalid("structured input is too large."));
            }
            Ok(())
        }
        Value::Array(entries) => {
            if entries.len() > 5_000 {
                return Err(invalid("structured input contains too many entries."));
            }
            entries.iter().try_for_each(|entry| validate_structured(entry, strings, nodes, depth + 1))
        }
        Value::Object(fields) => {
            if fields.len() > 5_000 {
                return Err(invalid("structured input contains too many fields."));
            }
            for (key, entry) in fields {
                if matches!(key.as_str(), "__proto__" | "prototype" | "constructor") {
                    return Err(invalid("structured input contains an invalid field."));
                }
                validate_structured(entry, strings, nodes, depth + 1)?;
            }
            Ok(())
        }
    }
}

/// `Number.isSafeInteger(value) && value > 0`.
fn positive_safe_integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|n| n.fract() == 0.0 && n > 0.0 && n <= 9_007_199_254_740_991.0)
}

/// `requiredSubmitOptions` (`ipc-validation.ts:1225-1266`); absent is none.
fn required_submit_options(value: Option<&Value>) -> Result<Map<String, Value>, RoomError> {
    let options = match value {
        None => return Ok(Map::new()),
        Some(Value::Object(options)) => options,
        Some(_) => return Err(invalid("submit options are invalid.")),
    };
    validate_structured(&Value::Object(options.clone()), &mut 0, &mut 0, 0)?;
    if options.keys().any(|key| !SUBMIT_OPTION_KEYS.contains(&key.as_str())) {
        return Err(invalid("submit options contains an unsupported field."));
    }
    let control = |text: &str| text.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}');
    let string = |key: &str| options.get(key).map(|value| value.as_str());
    if let Some(id) = string("clientSubmissionId")
        && !id.is_some_and(|id| !js_trim(id).is_empty() && utf16_len(id) <= 256 && !control(id))
    {
        return Err(invalid("submit id is invalid."));
    }
    if options.get("submittedAt").is_some_and(|at| !positive_safe_integer(at)) {
        return Err(invalid("submit timestamp is invalid."));
    }
    for (key, refusal) in [("retryFailedTurn", "submit retryFailedTurn is invalid."), ("kickoff", "submit kickoff is invalid.")] {
        if options.get(key).is_some_and(|flag| !flag.is_boolean()) {
            return Err(invalid(refusal));
        }
    }
    if string("priority").is_some_and(|priority| !matches!(priority, Some("now" | "next" | "later"))) {
        return Err(invalid("submit priority is invalid."));
    }
    if string("displayText").is_some_and(|text| !text.is_some_and(|text| utf16_len(text) <= MAX_PROMPT_LENGTH)) {
        return Err(invalid("submit display text is invalid."));
    }
    if string("goalCommand").is_some_and(|text| !text.is_some_and(|text| !js_trim(text).is_empty() && utf16_len(text) <= MAX_PROMPT_LENGTH)) {
        return Err(invalid("goal command is invalid."));
    }
    Ok(options.clone())
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
