//! The transcript signatures and the checkpoint restore over Node-shaped message rows
//! (JSON, as `contextMessagesSignature` receives them), for the 1.4.5 migration. A live session
//! signs its [`AgentMessage`](crate::message::AgentMessage)s; both forms share the digest and
//! the restore itself.
//!
//! A row is signed from its own parts. A part that is text or a file by reference, or an
//! inline file or document, is read through [`AttachmentBytes`] exactly as Node reads it.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

use super::Header;
use super::ImageDescriptor;
use super::Restored;
use super::digest_identities;
use super::restore_with;
use super::shape_text;
use super::string_or_empty;
use super::truthy;
use crate::compact::estimate::native_blocks_text;

/// Why a referenced blob could not be read.
#[derive(Debug)]
pub enum BlobError<E> {
    /// Gone, not a regular non-empty file, or failing its content check: Node's
    /// `isPermanentAttachmentError`. The part is then priced as its own JSON.
    Permanent,
    /// Any other failure (a busy or locked file): it propagates, as in Node.
    Transient(E),
}

/// The attachment store and the document extractor, as the transcript signatures read them.
pub trait AttachmentBytes {
    type Error;

    /// `readAttachmentBuffer(reference)`: the blob's bytes, verified against its content address.
    fn bytes(&self, reference: &str) -> Result<Vec<u8>, BlobError<Self::Error>>;

    /// `tryExtractOoxmlTextFromBuffer(bytes, filename, ...)` with the limits of
    /// `media-normalization.mjs`: the extracted text, or `None` when the container cannot be read.
    fn office_text(&self, bytes: &[u8], filename: &str) -> Result<Option<String>, Self::Error>;
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn non_empty<'a>(value: Option<&'a Value>) -> Option<&'a str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `isAttachmentReference`: `/^[a-f0-9]{64}$/` over `String(attachmentRef || '')`.
fn is_attachment_reference(part: &Value) -> bool {
    part.is_object() && {
        let reference = string_or_empty(part.get("attachmentRef"));
        reference.len() == 64 && reference.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }
}

/// `fileInfo(block) !== null`: a document with base64 bytes, or a file with data or a reference.
fn is_file_part(block: &Value) -> bool {
    match str_of(block, "type") {
        Some("document") => {
            block.get("source").is_some_and(|s| str_of(s, "type") == Some("base64") && non_empty(s.get("data")).is_some())
        }
        Some("file") => is_attachment_reference(block) || non_empty(block.get("data")).is_some(),
        _ => false,
    }
}

pub fn image_identity(kind: &str, value: &str, mime_type: &str) -> String {
    Sha256::digest(format!("{kind}\0{mime_type}\0{value}").as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// `cleanMimeType`.
pub fn clean_image_mime(raw: &str) -> String {
    let mime = mixdog_js::js_trim(raw).to_lowercase();
    if mime.starts_with("image/") { mime } else { "image/png".to_owned() }
}

/// `String(a || b)` over optional JSON values.
fn first_text(values: &[Option<&Value>]) -> String {
    values.iter().flatten().find_map(|v| v.as_str().filter(|s| !s.is_empty())).unwrap_or_default().to_owned()
}

/// `positiveDimension(...)`: the first value that is a positive finite number.
fn positive_dimension(values: &[Option<&Value>]) -> Option<f64> {
    values.iter().flatten().find_map(|v| {
        let n = match v {
            Value::Number(n) => n.as_f64()?,
            Value::String(s) => mixdog_js::string_to_number(s),
            _ => return None,
        };
        (n.is_finite() && n > 0.0).then_some(n)
    })
}

/// `imageDescriptor` of one part; `None` when it is no image.
pub fn image_descriptor(block: &Value) -> Option<ImageDescriptor> {
    let object = block.as_object()?;
    let field = |key: &str| object.get(key);
    let kind = str_of(block, "type");
    let dims = |key: &str, inner: &[Option<&Value>]| {
        let mut all = vec![field(key), field("dimensions").and_then(|d| d.get(key))];
        all.extend_from_slice(inner);
        positive_dimension(&all)
    };
    let image_url = field("image_url").filter(|v| v.is_object());
    let source = field("source").filter(|v| v.is_object());
    let inline = field("inlineData").or_else(|| field("inline_data"));
    let inner_of = |key: &str| [image_url.and_then(|v| v.get(key)), source.and_then(|v| v.get(key)), inline.and_then(|v| v.get(key))];
    let width = dims("width", &inner_of("width"));
    let height = dims("height", &inner_of("height"));
    let detail_of = |values: &[Option<&Value>]| {
        values
            .iter()
            .flatten()
            .find(|v| !v.is_null())
            .map_or_else(|| "auto".to_owned(), |v| mixdog_js::value_to_string(v).to_lowercase())
    };
    let detail = detail_of(&[field("detail"), image_url.and_then(|v| v.get("detail")), source.and_then(|v| v.get("detail")), inline.and_then(|v| v.get("detail"))]);
    let described = |identity: String| Some(ImageDescriptor { identity, width, height, detail: detail.clone() });
    if kind == Some("image") {
        if is_attachment_reference(block) {
            let reference = string_or_empty(field("attachmentRef"));
            let mime = first_text(&[field("mimeType"), field("mediaType")]);
            // An attachment reference reads only the part's own size and detail (not its inner objects').
            let detail = field("detail").filter(|v| truthy(Some(v))).map_or_else(|| "auto".to_owned(), |v| mixdog_js::value_to_string(v).to_lowercase());
            return Some(ImageDescriptor {
                identity: image_identity("attachment-ref", &reference, &mime),
                width: positive_dimension(&[field("width"), field("dimensions").and_then(|d| d.get("width"))]),
                height: positive_dimension(&[field("height"), field("dimensions").and_then(|d| d.get("height"))]),
                detail,
            });
        }
        if let Some(data) = non_empty(field("data")) {
            return described(image_identity("inline", data, &clean_image_mime(&first_text(&[field("mimeType"), field("mediaType")]))));
        }
        if source.and_then(|s| s.get("type")).and_then(Value::as_str) == Some("base64") {
            if let Some(data) = non_empty(source.and_then(|s| s.get("data"))) {
                let mime = first_text(&[source.and_then(|s| s.get("media_type")), source.and_then(|s| s.get("mediaType"))]);
                return described(image_identity("inline", data, &clean_image_mime(&mime)));
            }
        }
    }
    if let Some(data) = non_empty(inline.and_then(|i| i.get("data"))) {
        let mime = first_text(&[inline.and_then(|i| i.get("mimeType")), inline.and_then(|i| i.get("mime_type")), inline.and_then(|i| i.get("mediaType")), inline.and_then(|i| i.get("media_type"))]);
        return described(image_identity("inline", data, &clean_image_mime(&mime)));
    }
    let file_id = match (kind, field("file_id"), source) {
        (Some("input_image"), Some(id), _) => non_empty(Some(id)),
        (Some("image"), _, Some(s)) if str_of(s, "type") == Some("file") => non_empty(s.get("file_id")),
        _ => None,
    };
    let file_data = field("fileData").or_else(|| field("file_data"));
    let uri = non_empty(file_data.and_then(|f| f.get("fileUri"))).or_else(|| non_empty(file_data.and_then(|f| f.get("file_uri")))).map(|uri| {
        let mime = first_text(&[file_data.and_then(|f| f.get("mimeType")), file_data.and_then(|f| f.get("mime_type")), file_data.and_then(|f| f.get("mediaType")), file_data.and_then(|f| f.get("media_type"))]);
        (uri.to_owned(), clean_image_mime(&mime))
    });
    let uri = uri.or_else(|| {
        (kind == Some("image")).then(|| non_empty(field("uri"))).flatten().map(|uri| {
            let mime = first_text(&[field("mime_type"), field("mimeType"), field("media_type"), field("mediaType")]);
            (uri.to_owned(), clean_image_mime(&mime))
        })
    });
    let url = match kind {
        Some("image_url" | "input_image") => match field("image_url") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => non_empty(v.get("url")).map(str::to_owned),
            None => None,
        },
        Some("image") if source.and_then(|s| s.get("type")).and_then(Value::as_str) == Some("url") => {
            non_empty(source.and_then(|s| s.get("url"))).map(str::to_owned)
        }
        _ => None,
    };
    if let Some(id) = file_id {
        return described(image_identity("file-id", id, ""));
    }
    if let Some((uri, mime)) = uri {
        return described(image_identity("file-uri", &uri, &mime));
    }
    url.and_then(|u| described(image_identity("url", &u, "")))
}

/// `contentParts(content)`.
fn content_parts(content: &Value) -> Option<Vec<&Value>> {
    if let Some(list) = content.as_array() {
        return Some(list.iter().collect());
    }
    if !content.is_object() {
        return None;
    }
    if let Some(list) = content.get("content").and_then(Value::as_array) {
        return Some(list.iter().collect());
    }
    (is_attachment_reference(content) || image_descriptor(content).is_some() || is_file_part(content)).then(|| vec![content])
}

/// `contentImageDescriptors(content)`.
fn content_images(content: Option<&Value>) -> Vec<ImageDescriptor> {
    content.and_then(content_parts).map_or_else(Vec::new, |parts| parts.into_iter().filter_map(image_descriptor).collect())
}

/// `Buffer.from(data, 'base64')`: both alphabets, characters outside them skipped, decoding
/// stops at the first `=`, a trailing partial byte dropped.
pub(crate) fn node_base64(data: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 3 / 4);
    let (mut bits, mut count) = (0u32, 0u32);
    for c in data.chars() {
        let value = match c {
            'A'..='Z' => c as u32 - 'A' as u32,
            'a'..='z' => c as u32 - 'a' as u32 + 26,
            '0'..='9' => c as u32 - '0' as u32 + 52,
            '+' | '-' => 62,
            '/' | '_' => 63,
            '=' => break,
            _ => continue,
        };
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// `base64ByteLength`.
fn base64_byte_length(data: &str) -> u64 {
    if data.is_empty() {
        return 0;
    }
    let padding = if data.ends_with("==") { 2 } else { u64::from(data.ends_with('=')) };
    ((mixdog_js::utf16_len(data) as u64 * 3) / 4).saturating_sub(padding)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Pdf,
    Text,
    Office,
    Binary,
}

/// `inlineFileKind(mimeType, base64Data, filename)`.
fn inline_file_kind(mime_type: &str, data: &str, filename: &str) -> FileKind {
    const TEXTUAL: [&str; 6] = [
        "application/json",
        "application/xml",
        "application/yaml",
        "application/toml",
        "application/x-ndjson",
        "application/x-www-form-urlencoded",
    ];
    const OFFICE: [&str; 4] = [
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-excel.sheet.macroenabled.12",
    ];
    const GENERIC: [&str; 3] = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
    let mime = mixdog_js::js_trim(mime_type.split(';').next().unwrap_or_default()).to_lowercase();
    let head: String = data.chars().take(8).collect();
    let pdf_magic = mixdog_js::utf16_len(&head) >= 8 && node_base64(&head).starts_with(b"%PDF-");
    if mime == "application/pdf" || pdf_magic {
        return FileKind::Pdf;
    }
    let name = mixdog_js::js_trim(filename).to_lowercase();
    if OFFICE.contains(&mime.as_str())
        || (GENERIC.contains(&mime.as_str()) && [".docx", ".pptx", ".xlsx", ".xlsm"].iter().any(|e| name.ends_with(e)))
    {
        return FileKind::Office;
    }
    if mime.starts_with("text/")
        || mime.starts_with("application/javascript")
        || mime.starts_with("application/ecmascript")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || TEXTUAL.contains(&mime.as_str())
    {
        return FileKind::Text;
    }
    FileKind::Binary
}

/// `String(a || b || ...)`, lowercased and trimmed, else `fallback`.
fn mime_of(values: &[Option<&Value>], fallback: &str) -> String {
    let text = values.iter().flatten().find(|v| truthy(Some(v))).map(|v| mixdog_js::value_to_string(v)).unwrap_or_default();
    let mime = mixdog_js::js_trim(&text).to_lowercase();
    if mime.is_empty() { fallback.to_owned() } else { mime }
}

/// `fileInfo(block)`: the bytes of a file or document part (a reference is read from the store).
struct FileInfo {
    data: String,
    mime: String,
    filename: String,
    /// The decoded bytes (what `Buffer.from(data, 'base64')` yields).
    bytes: Vec<u8>,
}

fn file_info<R: AttachmentBytes + ?Sized>(block: &Value, blobs: &R) -> Result<Option<FileInfo>, BlobError<R::Error>> {
    let (data, bytes, mime, filename) = match str_of(block, "type") {
        Some("document") => {
            let Some(source) = block.get("source").filter(|s| str_of(s, "type") == Some("base64")) else { return Ok(None) };
            let Some(data) = non_empty(source.get("data")) else { return Ok(None) };
            let mime = mime_of(&[source.get("media_type"), source.get("mediaType"), block.get("mimeType"), block.get("mediaType")], "application/pdf");
            let filename = non_empty(block.get("title")).or_else(|| non_empty(block.get("filename"))).unwrap_or_default();
            (data.to_owned(), node_base64(data), mime, filename.to_owned())
        }
        Some("file") => {
            let (data, bytes) = if is_attachment_reference(block) {
                let bytes = blobs.bytes(&string_or_empty(block.get("attachmentRef")))?;
                (STANDARD.encode(&bytes), bytes)
            } else if let Some(data) = block.get("data").and_then(Value::as_str) {
                (data.to_owned(), node_base64(data))
            } else {
                return Ok(None);
            };
            if data.is_empty() {
                return Ok(None);
            }
            let mime = mime_of(&[block.get("mimeType"), block.get("mediaType")], "application/pdf");
            (data, bytes, mime, non_empty(block.get("filename")).unwrap_or_default().to_owned())
        }
        _ => return Ok(None),
    };
    // The bytes decide a PDF before the label does.
    let mime = if inline_file_kind(&mime, &data, "") == FileKind::Pdf { "application/pdf".to_owned() } else { mime };
    Ok(Some(FileInfo { data, mime, filename, bytes }))
}

/// `fileFallbackText`, and `''` for a PDF (it rides as native media).
fn file_text<R: AttachmentBytes + ?Sized>(file: &FileInfo, blobs: &R) -> Result<String, R::Error> {
    let kind = inline_file_kind(&file.mime, &file.data, &file.filename);
    if kind == FileKind::Pdf {
        return Ok(String::new());
    }
    let prefix = if file.filename.is_empty() { String::new() } else { format!("{} ", file.filename) };
    let label = format!("{prefix}({}, {} bytes)", file.mime, base64_byte_length(&file.data));
    match kind {
        FileKind::Text => return Ok(format!("--- {label} ---\n{}", String::from_utf8_lossy(&file.bytes))),
        FileKind::Office => {
            if let Some(extracted) = blobs.office_text(&file.bytes, &file.filename)? {
                return Ok(format!("--- {label} ---\n{extracted}"));
            }
        }
        _ => {}
    }
    Ok(format!("[file not sent inline: {label} — this type has no inline form; open it from disk with read]"))
}

/// `attachmentTextForPart(part)` of a text part that is an attachment reference.
fn attachment_text<R: AttachmentBytes + ?Sized>(part: &Value, blobs: &R) -> Result<String, BlobError<R::Error>> {
    let bytes = blobs.bytes(&string_or_empty(part.get("attachmentRef")))?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if part.get("textKind").and_then(Value::as_str) != Some("file") {
        return Ok(text);
    }
    let name = if truthy(part.get("filename")) { string_or_empty(part.get("filename")) } else { "attachment".to_owned() };
    let name: String = name.chars().map(|c| if matches!(c, '<' | '>' | '"' | '\'') { '_' } else { c }).collect();
    Ok(format!("<file name=\"{name}\">\n{text}\n</file>"))
}

/// `estimatePartText` (`rawJsonFallbackFromPart`): a referenced part whose blob is permanently
/// unreadable is priced as its own JSON; any other read failure propagates.
fn part_text<R: AttachmentBytes + ?Sized>(part: &Value, blobs: &R) -> Result<String, R::Error> {
    match part {
        Value::String(s) => return Ok(s.clone()),
        Value::Null => return Ok(String::new()),
        Value::Object(_) => {}
        other => return Ok(mixdog_js::value_to_string(other)),
    }
    let kind = str_of(part, "type");
    if kind == Some("text") && is_attachment_reference(part) {
        return match attachment_text(part, blobs) {
            Ok(text) => Ok(text),
            Err(BlobError::Permanent) => Ok(mixdog_js::json_stringify(part)),
            Err(BlobError::Transient(e)) => Err(e),
        };
    }
    if let Some(text) = non_empty(part.get("text")).or_else(|| non_empty(part.get("content"))) {
        return Ok(text.to_owned());
    }
    if (kind == Some("image") && is_attachment_reference(part)) || image_descriptor(part).is_some() {
        return Ok(String::new());
    }
    match file_info(part, blobs) {
        Ok(Some(file)) => file_text(&file, blobs),
        Ok(None) => Ok(mixdog_js::json_stringify(part)),
        Err(BlobError::Permanent) => Ok(mixdog_js::json_stringify(part)),
        Err(BlobError::Transient(e)) => Err(e),
    }
}

/// `contentToEstimateText(content, '')`.
fn content_text<R: AttachmentBytes + ?Sized>(content: Option<&Value>, blobs: &R) -> Result<String, R::Error> {
    match content {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(s.clone()),
        Some(content) => match content_parts(content) {
            None => Ok(mixdog_js::json_stringify(content)),
            Some(parts) => {
                let texts = parts.into_iter().map(|p| part_text(p, blobs)).collect::<Result<Vec<_>, _>>()?;
                Ok(texts.into_iter().filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n"))
            }
        },
    }
}

fn non_empty_list(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| v.as_array().is_some_and(|a| !a.is_empty()))
}

/// `messageEstimateText(m)`.
fn estimate_text<R: AttachmentBytes + ?Sized>(m: &Value, blobs: &R) -> Result<String, R::Error> {
    if !m.is_object() {
        return Ok(String::new());
    }
    let assistant = str_of(m, "role") == Some("assistant");
    let mut text = content_text(m.get("content"), blobs)?;
    if assistant {
        if let Some(calls) = non_empty_list(m.get("toolCalls")) {
            text.push('\n');
            text.push_str(&mixdog_js::json_stringify(calls));
        }
    }
    // An empty replay list still counts as "has replay": it suppresses the native fallbacks below.
    let replay = assistant.then(|| m.get("providerReplay").and_then(|r| r.get("items")).filter(|i| i.is_array())).flatten();
    if let Some(items) = replay {
        if non_empty_list(Some(items)).is_some() {
            text.push('\n');
            text.push_str(&native_blocks_text(items));
        }
    } else if assistant {
        for blocks in [m.get("thinkingBlocks"), m.get("assistantBlocks"), m.get("reasoningItems")] {
            if let Some(blocks) = non_empty_list(blocks) {
                text.push('\n');
                text.push_str(&native_blocks_text(blocks));
            }
        }
    }
    if replay.is_none() {
        let thought = m.get("providerMetadata").and_then(|p| p.get("gemini")).and_then(|g| g.get("thoughtParts"));
        if assistant {
            if let Some(parts) = non_empty_list(thought) {
                text.push('\n');
                text.push_str(&native_blocks_text(parts));
            }
        }
    }
    if str_of(m, "role") == Some("tool") && truthy(m.get("toolCallId")) {
        text.push('\n');
        text.push_str(&string_or_empty(m.get("toolCallId")));
    }
    Ok(text)
}

/// `messageImageDescriptors(m)`.
fn images_of(m: &Value) -> Vec<ImageDescriptor> {
    if !m.is_object() {
        return Vec::new();
    }
    let mut images = content_images(m.get("content"));
    if str_of(m, "role") == Some("assistant") {
        images.extend(content_images(m.get("assistantBlocks")));
        images.extend(content_images(m.get("providerReplay").and_then(|r| r.get("items"))));
    }
    images
}

/// `message?.field || ''`.
fn or_empty(m: &Value, key: &str) -> Value {
    m.get(key).filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| Value::String(String::new()))
}

/// `contextMessagesSignature(rows)`: images included.
pub fn rows_exact_signature<R: AttachmentBytes + ?Sized>(rows: &[Value], blobs: &R) -> Result<String, R::Error> {
    let identities = rows
        .iter()
        .map(|m| {
            let text = estimate_text(m, blobs)?;
            let images = images_of(m);
            let allowance: u64 = images.iter().map(ImageDescriptor::allowance).sum();
            Ok(json!([or_empty(m, "role"), or_empty(m, "toolCallId"), text, allowance, images.iter().map(ImageDescriptor::json).collect::<Vec<_>>()]))
        })
        .collect::<Result<Vec<_>, R::Error>>()?;
    Ok(digest_identities(identities.into_iter()))
}

/// `contextMessagesShapeSignature(rows)`: media reduced to a count, whitespace collapsed.
pub fn rows_shape_signature<R: AttachmentBytes + ?Sized>(rows: &[Value], blobs: &R) -> Result<String, R::Error> {
    let identities = rows
        .iter()
        .map(|m| {
            let (text, placeholders) = shape_text(&estimate_text(m, blobs)?);
            Ok(json!([or_empty(m, "role"), or_empty(m, "toolCallId"), text, images_of(m).len() as u64 + placeholders]))
        })
        .collect::<Result<Vec<_>, R::Error>>()?;
    Ok(digest_identities(identities.into_iter()))
}

/// `restoreTurnCheckpointContextState(session, checkpoint)` over Node-shaped rows. `now` is
/// `Date.now()`. The restore reads no token calibration; the rows are signed as they are.
pub fn restore_turn_checkpoint_context_state_rows<R: AttachmentBytes + ?Sized>(
    header: &Header,
    rows: &[Value],
    checkpoint: &Value,
    blobs: &R,
    now: f64,
) -> Result<Restored, R::Error> {
    restore_with(header, rows, checkpoint, &|slice| rows_exact_signature(slice, blobs), now)
}
