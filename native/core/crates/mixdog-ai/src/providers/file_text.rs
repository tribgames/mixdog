//! What a file part is on a provider's wire (`shared/inline-file-kind.mjs` `inlineFileKind`, and `fileFallbackText` of
//! `providers/media-normalization.mjs`): only a PDF has a native form on every wire; text-typed bytes are readable as
//! text, and any other payload is named, so a file never reaches an endpoint as a block it rejects. Every provider's
//! builder lowers its non-PDF files through here, and the host's media layer classifies the files it extracts through
//! the same function.

use std::borrow::Cow;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::DocumentSource;
use mixdog_core_api::domain::provider::Message;

/// How an inline file payload can reach a model (`inlineFileKind`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileKind {
    Pdf,
    Text,
    Office,
    Binary,
}

const TEXTUAL_MIME_TYPES: [&str; 6] = [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/toml",
    "application/x-ndjson",
    "application/x-www-form-urlencoded",
];
const OFFICE_MIME_TYPES: [&str; 4] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
];
const GENERIC_CONTAINER_MIME_TYPES: [&str; 3] = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];

/// `base64ByteLength`.
pub fn base64_byte_length(data: &str) -> u64 {
    if data.is_empty() {
        return 0;
    }
    let padding = if data.ends_with("==") { 2 } else { u64::from(data.ends_with('=')) };
    ((mixdog_js::utf16_len(data) as u64 * 3) / 4).saturating_sub(padding)
}

fn has_pdf_magic(base64_data: &str) -> bool {
    let head: String = base64_data.chars().take(8).collect();
    if head.chars().count() < 8 {
        return false;
    }
    STANDARD.decode(head.trim_end_matches('=')).or_else(|_| STANDARD.decode(&head)).is_ok_and(|b| b.starts_with(b"%PDF-"))
        || base64_data.starts_with("JVBERi0")
}

fn office_extension(filename: &str) -> bool {
    let name = mixdog_js::js_trim(filename).to_lowercase();
    [".docx", ".pptx", ".xlsx", ".xlsm"].iter().any(|e| name.ends_with(e))
}

/// `inlineFileKind(mimeType, base64Data, filename)`.
pub fn inline_file_kind(mime_type: &str, base64_data: &str, filename: &str) -> FileKind {
    let mime = mixdog_js::js_trim(mime_type.split(';').next().unwrap_or("")).to_lowercase();
    if mime == "application/pdf" || has_pdf_magic(base64_data) {
        return FileKind::Pdf;
    }
    if OFFICE_MIME_TYPES.contains(&mime.as_str()) {
        return FileKind::Office;
    }
    if GENERIC_CONTAINER_MIME_TYPES.contains(&mime.as_str()) && office_extension(filename) {
        return FileKind::Office;
    }
    if mime.starts_with("text/")
        || mime.starts_with("application/javascript")
        || mime.starts_with("application/ecmascript")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || TEXTUAL_MIME_TYPES.contains(&mime.as_str())
    {
        return FileKind::Text;
    }
    FileKind::Binary
}

/// The transport label of a file as `fileInfo` records it: trimmed, lower-cased, `application/pdf` when blank, and
/// `application/pdf` whatever it says when the bytes are a PDF (`bytesDecideMime`).
pub fn file_mime(mime_type: &str, base64_data: &str) -> String {
    let mime = mixdog_js::js_trim(mime_type).to_lowercase();
    let mime = if mime.is_empty() { "application/pdf".to_owned() } else { mime };
    if inline_file_kind(&mime, base64_data, "") == FileKind::Pdf { "application/pdf".to_owned() } else { mime }
}

/// `fileKind(fileInfo(part))`: the kind of a file part by its transport label, its bytes and its name.
pub fn file_kind(mime_type: &str, base64_data: &str, filename: Option<&str>) -> FileKind {
    inline_file_kind(&file_mime(mime_type, base64_data), base64_data, filename.unwrap_or(""))
}

/// `fileLabel`: `name (mime, N bytes)`.
pub fn file_label(filename: Option<&str>, mime: &str, base64_data: &str) -> String {
    let name = filename.filter(|n| !n.is_empty()).map(|n| format!("{n} ")).unwrap_or_default();
    format!("{name}({mime}, {} bytes)", base64_byte_length(base64_data))
}

/// `fileDecodedText`.
pub fn file_decoded_text(base64_data: &str) -> String {
    String::from_utf8_lossy(&STANDARD.decode(base64_data).unwrap_or_default()).into_owned()
}

/// `unavailableAttachmentText` of a stored file whose blob the host could not read into the request.
pub fn unavailable_file_text(filename: Option<&str>, mime_type: &str) -> String {
    let name = filename.and_then(|f| f.rsplit(['/', '\\']).next()).unwrap_or("");
    let label = [name, mime_type, "file"].into_iter().find(|v| !v.is_empty()).unwrap_or("file");
    format!("[attachment unavailable: {label}]")
}

/// The text a file or document part is on a wire with no document block (`fileFallbackText`, the stand-in of a
/// stored file that is not there); `None` for any other part.
pub fn file_part_text(part: &ContentPart) -> Option<String> {
    match part {
        ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, .. } => {
            Some(file_fallback_text(filename.as_deref(), mime_type, data))
        }
        ContentPart::File { source: BinarySource::AttachmentRef(_), mime_type, filename, .. } => {
            Some(unavailable_file_text(filename.as_deref(), mime_type))
        }
        ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, title } => {
            Some(file_fallback_text(title.as_deref(), media_type, data))
        }
        _ => None,
    }
}

/// `messages` with every file part as its text, for a builder that carries text and images only; the same messages
/// when there is no file part.
pub fn files_as_text(messages: &[Message]) -> Cow<'_, [Message]> {
    let has_file = |m: &Message| matches!(&m.content, Content::Parts(parts) if parts.iter().any(|p| file_part_text(p).is_some()));
    if !messages.iter().any(has_file) {
        return Cow::Borrowed(messages);
    }
    Cow::Owned(
        messages
            .iter()
            .map(|message| {
                let mut message = message.clone();
                if let Content::Parts(parts) = &mut message.content {
                    for part in parts.iter_mut() {
                        if let Some(text) = file_part_text(part) {
                            *part = ContentPart::Text(text, None);
                        }
                    }
                }
                message
            })
            .collect(),
    )
}

/// `fileFallbackText` of a file with no inline form on this wire and no extracted text (an Office file whose
/// extraction found none is described): a text-typed payload reads as text, any other is named so the model can open it
/// from disk.
pub fn file_fallback_text(filename: Option<&str>, mime_type: &str, base64_data: &str) -> String {
    let mime = file_mime(mime_type, base64_data);
    let label = file_label(filename, &mime, base64_data);
    if file_kind(&mime, base64_data, filename) == FileKind::Text {
        format!("--- {label} ---\n{}", file_decoded_text(base64_data))
    } else {
        format!("[file not sent inline: {label} — this type has no inline form; open it from disk with read]")
    }
}
