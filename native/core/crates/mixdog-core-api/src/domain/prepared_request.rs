//! A request before and after image preparation. A [`DraftRequest`] is what callers assemble; only [`PreparedRequest::seal`]
//! turns it into something the transport layer accepts, and only against a batch that accounts for every image occurrence of
//! the draft, sealed against the same plan. No `Deserialize`, no `Default`, no public constructor on the prepared type.
//!
//! An image occurrence is any image a codec could put on the wire: an image part of a message's content (or the attachment
//! store's reference to one), and any image block in the provider's recorded form of a message (replay envelopes, ordered
//! blocks, thinking blocks, Gemini metadata), which encoders copy as it was recorded. [`PreparedRequest::wire_request`] writes the
//! prepared image into every one of them, so no encoder sees image bytes the preparation did not hand it.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_image_egress::origin::RECORDED_FORM;
use mixdog_image_egress::{Body, ImageIntent, ImageSource, NotSent, Origin, Plan, PreparedBatch, Reason, Refusal, Role as ImageRole, StoredImageId};
use serde_json::{Map, Value};

use super::provider::{BinarySource, Content, ContentPart, ImageSource as PartSource, Message, MessageSource, ModelRequest, Role};

/// An assembled request whose images are not yet prepared for any route, with every image occurrence it holds.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct DraftRequest {
    request: Arc<ModelRequest>,
    intents: Vec<ImageIntent>,
}

fn image_role(role: Role) -> ImageRole {
    match role {
        Role::User => ImageRole::User,
        Role::Assistant => ImageRole::Assistant,
        Role::Tool => ImageRole::Tool,
        Role::System | Role::Developer => ImageRole::System,
    }
}

/// What an image part's source is, by its form. A `data:` URL is inline bytes in another spelling; a 64-hex or `sha256:` id is the
/// attachment store's own reference (a tool's blob), never a provider's file id.
fn image_source(source: &PartSource) -> ImageSource {
    match source {
        PartSource::Base64 { data, mime_type, .. } => ImageSource::Base64 { label: mime_type.clone(), data: data.clone() },
        PartSource::Url(url) if url.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:")) => ImageSource::DataUrl(url.clone()),
        PartSource::Url(url) => ImageSource::Link(url.clone()),
        PartSource::FileId(id) => match id.strip_prefix("sha256:").unwrap_or(id) {
            digest if digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {
                ImageSource::Stored(StoredImageId(digest.to_owned()))
            }
            _ => ImageSource::ProviderFileId { issuer: String::new(), id: id.clone() },
        },
    }
}

fn tool_label(messages: &[Message], upto: usize, call_id: Option<&str>) -> Option<String> {
    let id = call_id?;
    messages[..upto].iter().rev().flat_map(|m| m.tool_calls.iter()).find(|call| call.id == id).map(|call| call.name.clone())
}

/// The image a content part is, with the file name it carries: an image part, or the attachment store's reference to a picture.
/// The one definition of an image part: preparation and the session's image choices both use it.
pub fn image_part(part: &ContentPart) -> Option<(ImageSource, String)> {
    match part {
        ContentPart::Image(source) => Some((image_source(source), String::new())),
        ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename, text: None }
            if mime_type.trim().to_ascii_lowercase().starts_with("image/") =>
        {
            Some((ImageSource::Stored(StoredImageId(reference.clone())), filename.clone().unwrap_or_default()))
        }
        _ => None,
    }
}

/// The position content part `slot` of `message` has in the stored message.
fn stored_part(message: &Message, slot: usize) -> u32 {
    if message.stored_parts.is_empty() { slot as u32 } else { message.stored_parts[slot] }
}

fn is_data_url(url: &str) -> bool {
    url.get(..5).is_some_and(|scheme| scheme.eq_ignore_ascii_case("data:"))
}

fn url_source(url: &str) -> ImageSource {
    if is_data_url(url) { ImageSource::DataUrl(url.to_owned()) } else { ImageSource::Link(url.to_owned()) }
}

fn text_of<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// The inner object of a Gemini part's `inlineData` / `fileData` (either spelling) when it declares a picture type.
fn gemini_image<'a>(map: &'a Map<String, Value>, keys: [&str; 2]) -> Option<&'a Map<String, Value>> {
    let inner = keys.iter().find_map(|key| map.get(*key)).and_then(Value::as_object)?;
    let mime = text_of(inner, "mimeType").or_else(|| text_of(inner, "mime_type"))?;
    mime.trim().to_ascii_lowercase().starts_with("image/").then_some(inner)
}

const GEMINI_INLINE: [&str; 2] = ["inlineData", "inline_data"];
const GEMINI_FILE: [&str; 2] = ["fileData", "file_data"];

/// The image a block of a recorded form holds, in the spelling of the wire that recorded it: an Anthropic `image` block, a
/// Responses `input_image` or `image_generation_call` result, a Chat `image_url`, a Gemini part with picture `inlineData` or
/// `fileData`. `None` for any other block (whose children may still hold one).
fn recorded_image(map: &Map<String, Value>) -> Option<ImageSource> {
    match text_of(map, "type") {
        Some("image") => {
            let source = map.get("source")?.as_object()?;
            match text_of(source, "type")? {
                "base64" => {
                    Some(ImageSource::Base64 { label: text_of(source, "media_type").unwrap_or_default().to_owned(), data: text_of(source, "data")?.to_owned() })
                }
                "url" => Some(url_source(text_of(source, "url")?)),
                "file" => Some(ImageSource::ProviderFileId { issuer: String::new(), id: text_of(source, "file_id")?.to_owned() }),
                _ => None,
            }
        }
        Some("input_image") => match (text_of(map, "image_url"), text_of(map, "file_id")) {
            (Some(url), _) => Some(url_source(url)),
            (None, Some(id)) => Some(ImageSource::ProviderFileId { issuer: String::new(), id: id.to_owned() }),
            (None, None) => None,
        },
        Some("image_url") => {
            let value = map.get("image_url")?;
            Some(url_source(value.as_str().or_else(|| value.get("url")?.as_str()).filter(|url| !url.is_empty())?))
        }
        Some("image_generation_call") => Some(ImageSource::Base64 { label: String::new(), data: text_of(map, "result")?.to_owned() }),
        _ => {
            if let Some(inline) = gemini_image(map, GEMINI_INLINE) {
                let label = text_of(inline, "mimeType").or_else(|| text_of(inline, "mime_type")).unwrap_or_default();
                return Some(ImageSource::Base64 { label: label.to_owned(), data: text_of(inline, "data")?.to_owned() });
            }
            let file = gemini_image(map, GEMINI_FILE)?;
            Some(ImageSource::Link(text_of(file, "fileUri").or_else(|| text_of(file, "file_uri"))?.to_owned()))
        }
    }
}

/// The JSON pointers of every image block of a recorded form, in document order. Only content is walked, as 1.4.5 walks it
/// (`prepareAnthropicImages`): a list of blocks, the content of a `tool_result` or a Responses `message`, the `output` list of a
/// `function_call_output`, and the part lists of a Gemini content object or metadata map. Every other block is opaque: a tool
/// call's input or arguments, a signed thinking block or a function call's args is never read, however much it looks like an
/// image.
fn recorded_image_paths(value: &Value, path: &mut String, out: &mut Vec<String>) {
    match value {
        Value::Array(blocks) => {
            for (index, block) in blocks.iter().enumerate() {
                let at = path.len();
                path.push_str(&format!("/{index}"));
                if let Value::Object(map) = block {
                    recorded_block(map, path, out);
                }
                path.truncate(at);
            }
        }
        Value::Object(map) => recorded_block(map, path, out),
        _ => {}
    }
}

fn recorded_block(map: &Map<String, Value>, path: &mut String, out: &mut Vec<String>) {
    if recorded_image(map).is_some() {
        out.push(path.clone());
        return;
    }
    let nested = |key: &str, path: &mut String, out: &mut Vec<String>| {
        if let Some(list @ Value::Array(_)) = map.get(key) {
            let at = path.len();
            path.push_str(&format!("/{key}"));
            recorded_image_paths(list, path, out);
            path.truncate(at);
        }
    };
    match text_of(map, "type") {
        Some("tool_result" | "message") => nested("content", path, out),
        Some("function_call_output") => nested("output", path, out),
        Some(_) => {}
        // An untyped object is a Gemini content (`parts`) or the stored Gemini metadata (`thoughtParts`, `textParts`): its
        // lists are part lists. A Gemini part's own objects (`functionCall`, `functionResponse`) are not lists and stay unread.
        None => {
            let keys: Vec<&String> = map.iter().filter(|(_, value)| value.is_array()).map(|(key, _)| key).collect();
            for key in keys {
                nested(key, path, out);
            }
        }
    }
}

/// Every image of a recorded form, in the walk of [`recorded_image_paths`].
fn recorded_images(value: &Value, found: &mut Vec<ImageSource>) {
    let mut paths = Vec::new();
    recorded_image_paths(value, &mut String::new(), &mut paths);
    for path in paths {
        let Some(Value::Object(map)) = value.pointer(&path) else { unreachable!("the walk found a block there") };
        found.push(recorded_image(map).expect("the walk found an image there"));
    }
}

/// Write `bodies[n]` into the `n`-th image of a recorded form, in the walk of [`recorded_image_paths`] and in the block's own
/// spelling; `next` counts the images met so far.
fn write_recorded_images(value: &mut Value, bodies: &[&Body], next: &mut usize) {
    let mut paths = Vec::new();
    recorded_image_paths(value, &mut String::new(), &mut paths);
    for path in paths {
        let Some(Value::Object(map)) = value.pointer_mut(&path) else { unreachable!("the walk found a block there") };
        write_recorded(map, bodies[*next]);
        *next += 1;
    }
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// The prepared image in the place of a recorded image block, keeping the block's keys where they are. A body is the form its
/// source was (inline bytes from base64 or a `data:` URL, a link from a link, a file id from a file id), so each block family
/// receives only the forms its own source kinds prepare to.
fn write_recorded(map: &mut Map<String, Value>, body: &Body) {
    match (text_of(map, "type").map(str::to_owned).as_deref(), body) {
        (Some("image"), Body::Inline { mime, bytes }) => {
            map.insert("source".into(), serde_json::json!({ "type": "base64", "media_type": mime, "data": STANDARD.encode(bytes) }));
        }
        (Some("image"), Body::Link(url)) => {
            map.insert("source".into(), serde_json::json!({ "type": "url", "url": url }));
        }
        (Some("image"), Body::FileId { id, .. }) => {
            map.insert("source".into(), serde_json::json!({ "type": "file", "file_id": id }));
        }
        (Some("input_image"), Body::Inline { mime, bytes }) => {
            map.insert("image_url".into(), Value::String(data_url(mime, bytes)));
        }
        (Some("input_image"), Body::Link(url)) => {
            map.insert("image_url".into(), Value::String(url.clone()));
        }
        (Some("input_image"), Body::FileId { id, .. }) => {
            map.insert("file_id".into(), Value::String(id.clone()));
        }
        (Some("image_url"), Body::Inline { mime, bytes }) => set_chat_url(map, data_url(mime, bytes)),
        (Some("image_url"), Body::Link(url)) => set_chat_url(map, url.clone()),
        (Some("image_generation_call"), Body::Inline { bytes, .. }) => {
            map.insert("result".into(), Value::String(STANDARD.encode(bytes)));
        }
        (_, Body::Inline { mime, bytes }) if gemini_image(map, GEMINI_INLINE).is_some() => {
            let key = GEMINI_INLINE.iter().find(|key| map.contains_key(**key)).copied().unwrap_or(GEMINI_INLINE[0]);
            let Some(Value::Object(inner)) = map.get_mut(key) else { unreachable!("gemini_image found it") };
            let mime_key = if inner.contains_key("mime_type") { "mime_type" } else { "mimeType" };
            inner.insert(mime_key.into(), Value::String((*mime).to_owned()));
            inner.insert("data".into(), Value::String(STANDARD.encode(bytes)));
        }
        (_, Body::Link(url)) if gemini_image(map, GEMINI_FILE).is_some() => {
            let key = GEMINI_FILE.iter().find(|key| map.contains_key(**key)).copied().unwrap_or(GEMINI_FILE[0]);
            let Some(Value::Object(inner)) = map.get_mut(key) else { unreachable!("gemini_image found it") };
            let uri_key = if inner.contains_key("file_uri") { "file_uri" } else { "fileUri" };
            inner.insert(uri_key.into(), Value::String(url.clone()));
        }
        (kind, body) => unreachable!("a {kind:?} block's source never prepares to {body:?}"),
    }
}

/// A Chat `image_url` block's url, in the spelling the block has (`{url}` or a bare string).
fn set_chat_url(map: &mut Map<String, Value>, url: String) {
    match map.get_mut("image_url") {
        Some(Value::Object(inner)) => {
            inner.insert("url".into(), Value::String(url));
        }
        _ => {
            map.insert("image_url".into(), Value::String(url));
        }
    }
}

/// The index of the latest message the person wrote (not the per-request reminder): where a new start would begin.
fn latest_prompt(messages: &[Message]) -> Option<usize> {
    messages.iter().rposition(|message| message.role == Role::User && message.source != Some(MessageSource::TailReminder))
}

/// Every image occurrence of `request`, in request order: each message's content images (named by their stored position), then
/// the images of its recorded form ([`RECORDED_FORM`]).
fn intents_of(request: &ModelRequest, session: &str, branch: &str) -> Vec<ImageIntent> {
    let mut out = Vec::new();
    let mut turn = 0u32;
    for (index, message) in request.messages.iter().enumerate() {
        if message.role == Role::User {
            turn += 1;
        }
        let origin = |part_path: Vec<u32>, display_name: String| Origin {
            session: session.to_owned(),
            branch: branch.to_owned(),
            message_id: message.message_id.clone().unwrap_or_else(|| format!("#{index}")),
            role: image_role(message.role),
            tool_call_id: message.tool_call_id.clone(),
            part_path,
            display_name,
            turn,
            tool_label: tool_label(&request.messages, index, message.tool_call_id.as_deref()),
        };
        if let Content::Parts(parts) = &message.content {
            for (slot, part) in parts.iter().enumerate() {
                if let Some((source, name)) = image_part(part) {
                    out.push(ImageIntent { origin: origin(vec![index as u32, stored_part(message, slot)], name), source });
                }
            }
        }
        let mut recorded = Vec::new();
        message.recorded_form().for_each(|value| recorded_images(value, &mut recorded));
        for (n, source) in recorded.into_iter().enumerate() {
            out.push(ImageIntent { origin: origin(vec![index as u32, RECORDED_FORM, n as u32], String::new()), source });
        }
    }
    out
}

impl DraftRequest {
    /// The draft of `request`, with every image occurrence it holds captured as it stands: build it before any projection that
    /// could drop or rewrite an image (non-vision, text-only, strip).
    pub fn new(request: Arc<ModelRequest>, session: &str, branch: &str) -> Self {
        let intents = intents_of(&request, session, branch);
        Self { request, intents }
    }

    /// The draft as assembled.
    pub fn request(&self) -> &Arc<ModelRequest> {
        &self.request
    }

    /// Every image occurrence of the draft, in request order.
    pub fn intents(&self) -> &[ImageIntent] {
        &self.intents
    }

    /// The draft's request, unchanged: what is sent when it holds no image occurrence at all.
    pub fn into_request(self) -> Arc<ModelRequest> {
        self.request
    }

    /// Offer the new start on `not_sent` when it would leave every blocker out (see [`NotSent::offer_new_context`]).
    pub fn offer_new_context(&self, not_sent: &mut NotSent) {
        if let Some(prompt) = latest_prompt(&self.request.messages) {
            not_sent.offer_new_context(prompt);
        }
    }
}

/// A request whose every image occurrence is accounted for against one plan. It is made by [`PreparedRequest::seal`] alone:
///
/// ```compile_fail,E0451
/// use mixdog_core_api::domain::prepared_request::PreparedRequest;
/// use mixdog_core_api::domain::provider::ModelRequest;
/// use mixdog_image_egress::{Plan, PreparedBatch};
/// fn forge(request: ModelRequest, plan: Plan, batch: PreparedBatch) -> PreparedRequest {
///     PreparedRequest { request, plan, batch }
/// }
/// ```
///
/// ```compile_fail,E0599
/// let _ = mixdog_core_api::domain::prepared_request::PreparedRequest::default();
/// ```
#[derive(Clone, Debug)]
pub struct PreparedRequest {
    request: Arc<ModelRequest>,
    plan: Plan,
    batch: PreparedBatch,
}

impl PreparedRequest {
    /// Seal `draft` against `plan` and `batch`. The batch must have been sealed for this plan and hold exactly the draft's
    /// occurrences; anything else is [`NotSent`], never a partial request.
    pub fn seal(draft: DraftRequest, plan: Plan, batch: PreparedBatch) -> Result<Self, NotSent> {
        let intents = &draft.intents;
        let mut blockers = Vec::new();
        if !batch.matches(&plan) {
            blockers.extend(intents.iter().map(|i| Refusal::new(i.origin.clone(), Reason::Corrupt)));
        } else {
            for intent in intents {
                if batch.get(&intent.origin).is_none() {
                    blockers.push(Refusal::new(intent.origin.clone(), Reason::Missing));
                }
            }
            if batch.images().len() != intents.len() {
                for image in batch.images() {
                    if !intents.iter().any(|i| &i.origin == image.origin()) {
                        blockers.push(Refusal::new(image.origin().clone(), Reason::Corrupt));
                    }
                }
            }
        }
        if !blockers.is_empty() {
            return Err(NotSent::new(blockers));
        }
        Ok(Self { request: draft.request, plan, batch })
    }

    /// The plan this request was prepared for: endpoint and credentials are chosen from it, nothing else.
    pub fn plan(&self) -> &Plan {
        &self.plan
    }

    pub fn batch(&self) -> &PreparedBatch {
        &self.batch
    }

    /// The request the wire codecs encode: every image occurrence, in the content and in the recorded form alike, holds what its
    /// prepared image dictates (validated bytes of the sniffed type, or the carried pointer) in the place it had, so a codec
    /// cannot see an unprepared image. Nothing is added, dropped or reordered. The batch was sealed against this request's own
    /// occurrences, so every place it names exists.
    pub fn wire_request(&self) -> ModelRequest {
        let mut out = (*self.request).clone();
        for (index, message) in out.messages.iter_mut().enumerate() {
            let mine: Vec<&mixdog_image_egress::PreparedImage> =
                self.batch.images().iter().filter(|image| image.origin().part_path[0] as usize == index).collect();
            if mine.is_empty() {
                continue;
            }
            let mut recorded: Vec<&Body> = Vec::new();
            for image in &mine {
                let path = &image.origin().part_path;
                if path[1] == RECORDED_FORM {
                    recorded.push(image.body());
                    continue;
                }
                let slot = if message.stored_parts.is_empty() {
                    path[1] as usize
                } else {
                    message.stored_parts.iter().position(|&p| p == path[1]).expect("a sealed image names a part of this message")
                };
                let Content::Parts(parts) = &mut message.content else { unreachable!("a sealed content image sits in parts") };
                parts[slot] = ContentPart::Image(match image.body() {
                    Body::Inline { mime, bytes } => {
                        PartSource::Base64 { data: STANDARD.encode(bytes), mime_type: (*mime).to_owned(), width: None, height: None }
                    }
                    Body::Link(url) => PartSource::Url(url.clone()),
                    Body::FileId { id, .. } => PartSource::FileId(id.clone()),
                });
            }
            if !recorded.is_empty() {
                let mut next = 0;
                message.recorded_form_mut().for_each(|value| write_recorded_images(value, &recorded, &mut next));
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use mixdog_image_egress::{Column, ImageFacts, ImageKind, InputImagePolicy, RouteKey};

    use super::*;
    use crate::domain::provider::RequestOptions;

    fn draft(images: usize) -> DraftRequest {
        let parts: Vec<ContentPart> = (0..images)
            .map(|_| ContentPart::Image(PartSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into(), width: None, height: None }))
            .collect();
        let mut tool = Message::new(Role::Tool, Content::Parts(parts));
        tool.tool_call_id = Some("c1".into());
        let mut assistant = Message::new(Role::Assistant, Content::Text(String::new()));
        assistant.tool_calls.push(crate::domain::provider::ToolCall {
            id: "c1".into(),
            name: "Read".into(),
            arguments: serde_json::Value::Null,
            native_type: None,
        });
        draft_of(vec![Message::new(Role::User, Content::Text("hi".into())), assistant, tool])
    }

    fn draft_of(messages: Vec<Message>) -> DraftRequest {
        DraftRequest::new(Arc::new(ModelRequest { model: "m".into(), messages, tools: Vec::new(), options: RequestOptions::default() }), "s", "b")
    }

    fn plan(model: &str) -> Plan {
        let route = RouteKey {
            endpoint: "e".into(),
            account: "a".into(),
            model: model.into(),
            wire_branch: "chat".into(),
            operation: "send".into(),
            capability_revision: 1,
        };
        Plan::new(route, InputImagePolicy::for_column(Column::Chat))
    }

    fn facts() -> ImageFacts {
        ImageFacts::for_test(ImageKind::Png, 1, 1, 1, 3, None)
    }

    fn batch(plan: &Plan, intents: &[ImageIntent], skip: Option<usize>) -> PreparedBatch {
        let mut b = plan.batch(intents.iter().map(|i| i.origin.clone()).collect());
        for (n, intent) in intents.iter().enumerate() {
            if Some(n) != skip {
                b.accept(plan.prepare_local(&intent.origin, &facts(), Arc::from(&[1u8, 2, 3][..]), None).unwrap());
            }
        }
        match b.seal() {
            Ok(batch) => batch,
            Err(_) => plan.batch(Vec::new()).seal().unwrap(),
        }
    }

    #[test]
    fn intents_capture_every_tool_image_in_order_with_tool_label() {
        let draft = draft(3);
        let intents = draft.intents();
        assert_eq!(intents.len(), 3);
        let ordinals: Vec<u32> = intents.iter().map(|i| i.origin.part_path[1]).collect();
        assert_eq!(ordinals, vec![0, 1, 2]);
        assert_eq!(intents[2].origin.tool_label.as_deref(), Some("Read"));
        assert_eq!(intents[0].origin.role, ImageRole::Tool);
    }

    #[test]
    fn an_image_is_named_by_its_stored_position_after_a_choice_left_parts_out() {
        let image = |tag: &str| ContentPart::Image(PartSource::Base64 { data: tag.into(), mime_type: "image/png".into(), width: None, height: None });
        // Stored as [a, text, b, c]; the person left `a` out, so the projection holds [text, b, c] at stored places 1, 2, 3.
        let mut message = Message::new(Role::User, Content::Parts(vec![ContentPart::Text("t".into(), None), image("b"), image("c")]));
        message.stored_parts = vec![1, 2, 3];
        let draft = draft_of(vec![message]);
        let parts: Vec<u32> = draft.intents().iter().map(|i| i.origin.part_path[1]).collect();
        assert_eq!(parts, vec![2, 3]);
        // The prepared image goes back into the part that holds it now.
        let plan = plan("m");
        let sealed = batch(&plan, draft.intents(), None);
        let wire = PreparedRequest::seal(draft, plan, sealed).unwrap().wire_request();
        let Content::Parts(parts) = &wire.messages[0].content else { panic!("parts") };
        assert!(matches!(&parts[0], ContentPart::Text(..)));
        assert!(parts[1..].iter().all(|part| matches!(part, ContentPart::Image(PartSource::Base64 { data, .. }) if data == "AQID")));
    }

    #[test]
    fn an_image_in_a_messages_recorded_form_is_an_occurrence_and_is_written_back_prepared() {
        let mut assistant = Message::new(Role::Assistant, Content::Text("here".into()));
        assistant.assistant_blocks = Some(serde_json::json!([
            { "type": "text", "text": "here" },
            { "type": "tool_result", "content": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "OLD1" } }] },
        ]));
        assistant.push_replay(crate::domain::provider::ProviderReplay {
            owner: mixdog_protocol::ProviderId::from("gemini"),
            items: serde_json::json!({ "parts": [{ "inlineData": { "mimeType": "image/png", "data": "OLD2" } }, { "inlineData": { "mimeType": "application/pdf", "data": "PDF" } }] }),
        });
        let draft = draft_of(vec![Message::new(Role::User, Content::Text("draw".into())), assistant]);
        let intents = draft.intents();
        assert_eq!(intents.len(), 2, "a PDF part is no image");
        // The replay envelope comes first in the recorded form, then the ordered blocks.
        assert!(matches!(&intents[0].source, ImageSource::Base64 { data, .. } if data == "OLD2"));
        assert!(matches!(&intents[1].source, ImageSource::Base64 { data, .. } if data == "OLD1"));
        assert!(intents.iter().all(|i| i.origin.in_recorded_form() && i.origin.role == ImageRole::Assistant));
        let plan = plan("m");
        let sealed = batch(&plan, intents, None);
        let wire = PreparedRequest::seal(draft, plan, sealed).unwrap().wire_request();
        let message = &wire.messages[1];
        assert_eq!(
            message.assistant_blocks.as_ref().unwrap()[1]["content"][0]["source"],
            serde_json::json!({ "type": "base64", "media_type": "image/png", "data": "AQID" })
        );
        let replay = &message.provider_replay()[0].items;
        assert_eq!(replay["parts"][0]["inlineData"], serde_json::json!({ "mimeType": "image/png", "data": "AQID" }));
        assert_eq!(replay["parts"][1]["inlineData"]["data"], "PDF", "what is not an image is untouched");
    }

    #[test]
    fn a_tool_calls_input_that_looks_like_an_image_is_never_an_occurrence_or_rewritten() {
        let mut assistant = Message::new(Role::Assistant, Content::Text("calling".into()));
        let blocks = serde_json::json!([
            { "type": "tool_use", "id": "t1", "name": "post", "input": { "type": "image_url", "image_url": { "url": "https://example.com/a.png" } } },
            { "type": "function_call", "arguments": "{}", "input": [{ "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AAAA" } }] },
            { "type": "thinking", "thinking": "x", "signature": "s", "content": [{ "type": "input_image", "image_url": "data:image/png;base64,AAAA" }] },
        ]);
        assistant.assistant_blocks = Some(blocks.clone());
        assistant.gemini_metadata = Some(
            serde_json::json!({ "textParts": [{ "functionCall": { "name": "f", "args": { "parts": [{ "inlineData": { "mimeType": "image/png", "data": "AAAA" } }] } } }] }),
        );
        let draft = draft_of(vec![Message::new(Role::User, Content::Text("go".into())), assistant]);
        assert!(draft.intents().is_empty(), "{:?}", draft.intents());
    }

    #[test]
    fn a_new_start_is_offered_only_for_blockers_before_the_latest_prompt() {
        let image = ContentPart::Image(PartSource::Base64 { data: "AAAA".into(), mime_type: "image/png".into(), width: None, height: None });
        let draft = draft_of(vec![Message::new(Role::User, Content::Parts(vec![image.clone()])), Message::new(Role::User, Content::Parts(vec![image]))]);
        let refuse = |at: usize| NotSent::new(vec![Refusal::new(draft.intents()[at].origin.clone(), Reason::NoVision)]);
        let (mut early, mut late) = (refuse(0), refuse(1));
        draft.offer_new_context(&mut early);
        draft.offer_new_context(&mut late);
        assert!(early.new_context_offered);
        assert!(!late.new_context_offered, "the latest prompt's own image stays in a new start");
    }

    #[test]
    fn the_wire_request_holds_exactly_the_sealed_images_in_their_positions() {
        let d = draft(2);
        let plan = plan("m");
        let sealed = batch(&plan, d.intents(), None);
        let prepared = PreparedRequest::seal(d, plan, sealed).unwrap();
        let wire = prepared.wire_request();
        let Content::Parts(parts) = &wire.messages[2].content else { panic!("parts") };
        assert_eq!(parts.len(), 2, "nothing is added or dropped");
        for part in parts {
            assert!(matches!(part, ContentPart::Image(PartSource::Base64 { data, mime_type, .. }) if data == "AQID" && mime_type == "image/png"));
        }
        assert_eq!(wire.messages[0], prepared.request.messages[0], "other messages are untouched");
    }

    #[test]
    fn a_stored_reference_and_a_data_url_are_occurrences_and_a_hex_blob_id_is_not_a_provider_file_id() {
        let stored = ContentPart::File {
            source: BinarySource::AttachmentRef("a".repeat(64)),
            mime_type: "image/png".into(),
            filename: Some("scan.png".into()),
            text: None,
        };
        let text_file = ContentPart::File { source: BinarySource::AttachmentRef("b".repeat(64)), mime_type: "text/plain".into(), filename: None, text: None };
        let mut message = Message::new(
            Role::User,
            Content::Parts(vec![
                stored,
                text_file,
                ContentPart::Image(PartSource::Url("DATA:image/png;base64,AAAA".into())),
                ContentPart::Image(PartSource::FileId(format!("sha256:{}", "c".repeat(64)))),
                ContentPart::Image(PartSource::FileId("file-abc".into())),
                ContentPart::Image(PartSource::Url("https://example.com/a.png".into())),
            ]),
        );
        message.message_id = Some("row-7".into());
        let draft = draft_of(vec![message]);
        let intents = draft.intents();
        assert_eq!(intents.len(), 5, "a text attachment is no image");
        assert!(matches!(&intents[0].source, ImageSource::Stored(id) if id.0 == "a".repeat(64)));
        assert_eq!(intents[0].origin.display_name, "scan.png");
        assert!(matches!(&intents[1].source, ImageSource::DataUrl(_)));
        assert!(matches!(&intents[2].source, ImageSource::Stored(id) if id.0 == "c".repeat(64)));
        assert!(matches!(&intents[3].source, ImageSource::ProviderFileId { .. }));
        assert!(matches!(&intents[4].source, ImageSource::Link(_)));
        assert_eq!(intents[0].origin.message_id, "row-7", "the row's own id names the message");
    }

    #[test]
    fn seal_requires_every_occurrence_and_the_same_plan() {
        let d = draft(2);
        let plan = plan("m");
        let intents = d.intents().to_vec();
        assert!(PreparedRequest::seal(d.clone(), plan.clone(), batch(&plan, &intents, None)).is_ok());
        // A batch missing the second image is NotSent naming it.
        let short = batch(&plan, &intents, Some(1));
        let err = PreparedRequest::seal(d.clone(), plan.clone(), short).unwrap_err();
        assert!(err.blockers.iter().all(|b| b.reason == Reason::Missing));
        // A batch sealed for another plan cannot be replayed on this one.
        let other = self::plan("other");
        let foreign = batch(&other, &intents, None);
        assert!(PreparedRequest::seal(d, plan, foreign).is_err());
    }
}
