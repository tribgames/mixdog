//! Media in a request (Node `providers/media-normalization.mjs`, `shared/inline-file-kind.mjs`,
//! and the allowances of `session/context-utils.mjs`): how an attached file lowers to text, what
//! media costs in tokens, and how many bytes tool-result media puts on the wire.
//!
//! Extraction is the extension host's ([`DocumentText`]: Node's own `officeTextForFile` and
//! `extractPdfText`), so the limits, the `None` and the fixed unreadable text are Node's. The
//! labels and wrapping are here. The agent's seams are synchronous and the extraction is not,
//! so [`MediaLowering::prepare_pdf_text`] (awaited on every attempt, as Node awaits
//! `preparePdfTextForProvider`) also reads and extracts every file of the messages into a memo that
//! the synchronous [`MediaText::text_form`] and [`MediaMeter::part`] read. A part that was not
//! prepared is an error, never silently priced as something else.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_agent::compact::estimate::{MediaMeter, PartMeter, IMAGE_TOKEN_ALLOWANCE};
use mixdog_agent::compact::pressure::{clean_image_mime, image_descriptor as json_image_descriptor, image_identity, ImageDescriptor, ImageIdentities};
use mixdog_agent::message::AgentMessage;
use mixdog_agent::compact::triggers::ToolMediaMeter;
use mixdog_agent::text_only::MediaText;
use mixdog_ai::service::model_proxy_inline::{AttachmentReader, ReadError};
use mixdog_core_api::domain::ext::{DocumentText, ExtError, PdfIntake};
use mixdog_exthost::{PDF_INTAKE_TIMEOUT_MS, PDF_UNREADABLE_TEXT};
use mixdog_rt::scoped::{Scope, Scoped};
use mixdog_core_api::domain::provider::{
    BinarySource, Content, ContentPart, DeliveryState, DocumentSource, ErrorKind, ImageSource, MediaSupport, Message, ProviderError, Role,
};
use mixdog_protocol::{ProviderId, ThreadId};
use serde_json::Value;
use sha2::{Digest, Sha256};

// The kinds of a file and their classification are the provider builders': one function for both sides.
pub use mixdog_ai::providers::file_text::{base64_byte_length, inline_file_kind, FileKind};

/// What the attachment store recorded about a stored attachment (Node keeps these on the part).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct StoredFacts {
    pub size_bytes: u64,
    /// A PDF's page count and text-layer character count.
    pub page_count: Option<u64>,
    pub text_chars: Option<u64>,
    /// How many pages have a text layer.
    pub text_pages: Option<u64>,
    /// An image's pixel size.
    pub width: Option<f64>,
    pub height: Option<f64>,
}

/// Facts of the stored attachments, by the reference's 64 hex digits. The synchronous meters read
/// them from [`MediaLowering`]'s memo, filled by [`MediaMeter::prepare`] (the messages about to be
/// measured, new input included) or [`MediaText::prepare_pdf_text`] first.
#[async_trait]
pub trait AttachmentFacts: Send + Sync {
    async fn facts(&self, reference: &str) -> Option<StoredFacts>;
}

/// MAX_PDF_BYTES / MAX_PDF_PAGES of ttachments/limits.mjs.
pub const MAX_PDF_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_PDF_PAGES: u64 = 100;

/// PDF intake (preparePromptSubmissionForProvider, ttachments/store.mjs): the text-layer counts
/// that price a stored PDF and tell the model which pages read as text. A refusal is the intake's
/// error, as in Node: over the size limit, unreadable, or (for a provider that sends the PDF
/// natively) more than MAX_PDF_PAGES pages. A provider that takes the PDF as text reads its first
/// pages, so a longer PDF is accepted. An environment failure or the intake timeout is an error too.
pub async fn pdf_intake_facts(
    docs: &dyn DocumentText,
    thread: &ThreadId,
    data_base64: &str,
    size_bytes: u64,
    native_pdf: bool,
) -> Result<StoredFacts, String> {
    if size_bytes > MAX_PDF_BYTES {
        return Err(format!("PDF exceeds the {} MiB input limit", MAX_PDF_BYTES / 1024 / 1024));
    }
    // A failed inspection fails the intake with the error's own message, as Node's intake throws it (the deadline's
    // "PDF inspection timed out after 60000 ms" among them).
    let counts = docs.pdf_counts(thread, data_base64).await.map_err(|e| match e {
        ExtError::Failed { message, .. } => message,
        other => format!("PDF inspection failed: {other:?}"),
    })?;
    // The parser rejected the bytes: the message is exactly what Node\'s intake throws.
    let counts = match counts {
        PdfIntake::Counts(counts) => counts,
        PdfIntake::Rejected(message) => return Err(message),
    };
    if native_pdf && counts.page_count > MAX_PDF_PAGES {
        return Err(format!("PDF has {} pages; maximum supported attachment is {MAX_PDF_PAGES} pages", counts.page_count));
    }
    Ok(StoredFacts {
        size_bytes,
        page_count: (counts.page_count > 0).then_some(counts.page_count),
        text_pages: Some(counts.text_pages),
        text_chars: Some(counts.text_chars),
        ..StoredFacts::default()
    })
}

const PDF_UNREADABLE_PREFIX: &str = "[PDF text unavailable";
const OFFICE_CACHE_CAP: usize = 256;

#[derive(Clone)]
struct FileInfo {
    data: String,
    mime: String,
    filename: String,
    key: String,
}

#[derive(Clone)]
enum Resolved {
    Bytes(String),
    /// Missing, corrupt or impossible: the part lowers to its placeholder.
    Gone,
}

#[derive(Default)]
struct Memo {
    resolved: HashMap<String, Resolved>,
    office: HashMap<String, Option<String>>,
    pdf: HashMap<String, String>,
    /// What the store recorded of each reference read so far (`None`: nothing recorded).
    facts: HashMap<String, Option<StoredFacts>>,
    /// Each stored text attachment's part as its row holds it: a gone blob prices as the stored part's JSON
    /// (`rawJsonFallbackFromPart` stringifies the part itself, `sizeBytes` and all).
    stored_parts: HashMap<String, Value>,
}

enum Lookup {
    NotFile,
    Gone,
    Cold,
    Info(FileInfo),
}

pub struct MediaLowering {
    thread: ThreadId,
    docs: Arc<dyn DocumentText>,
    reader: Arc<dyn AttachmentReader>,
    facts: Arc<dyn AttachmentFacts>,
    /// The route takes no document block of any kind (`nativeDocuments === false`).
    no_documents: bool,
    /// The route's provider: Node keeps one providerReplay per message (a route change strips the
    /// previous provider's), so only this provider's envelopes are the replayed blocks.
    provider: ProviderId,
    memo: Mutex<Memo>,
}

fn failure(message: String) -> Box<ProviderError> {
    let mut error = ProviderError::new(ErrorKind::Unknown, DeliveryState::NotSent);
    error.message = message;
    Box::new(error)
}

fn sha256_hex(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

fn decoded_text(data: &str) -> String {
    String::from_utf8_lossy(&STANDARD.decode(data).unwrap_or_default()).into_owned()
}

/// `fileLabel`.
fn file_label(file: &FileInfo) -> String {
    let name = if file.filename.is_empty() { String::new() } else { format!("{} ", file.filename) };
    format!("{name}({}, {} bytes)", file.mime, base64_byte_length(&file.data))
}

/// The reference of a stored text attachment (`{type: 'text', attachmentRef}`).
fn stored_text_ref(part: &ContentPart) -> Option<&str> {
    match part {
        ContentPart::File { source: BinarySource::AttachmentRef(reference), text: Some(_), .. } => Some(reference),
        _ => None,
    }
}

/// `attachmentTextForPart` over a stored text attachment's bytes: a file is wrapped in its name.
fn stored_text(part: &ContentPart, bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes).into_owned();
    let ContentPart::File { filename, text: Some(kind), .. } = part else { return text };
    if kind.kind.as_deref() != Some("file") {
        return text;
    }
    let name = filename.as_deref().filter(|n| !n.is_empty()).unwrap_or("attachment");
    let name: String = name.chars().map(|c| if matches!(c, '<' | '>' | '"' | '\'') { '_' } else { c }).collect();
    format!("<file name=\"{name}\">\n{text}\n</file>")
}

/// `unavailableAttachmentText`.
fn unavailable_text(part: &ContentPart) -> String {
    let (filename, mime, kind) = match part {
        ContentPart::File { filename, mime_type, .. } => (filename.clone().unwrap_or_default(), mime_type.clone(), "file"),
        _ => (String::new(), String::new(), "document"),
    };
    let name = filename.rsplit(['/', '\\']).next().unwrap_or("").to_owned();
    let label = [name, mime].into_iter().find(|v| !v.is_empty()).unwrap_or_else(|| kind.to_owned());
    format!("[attachment unavailable: {label}]")
}

fn mime_of(raw: &str) -> String {
    let m = mixdog_js::js_trim(raw).to_lowercase();
    if m.is_empty() { "application/pdf".to_owned() } else { m }
}

/// `fileFallbackText` for a text file or a description; an Office file passes its extraction.
fn fallback_text(file: &FileInfo, kind: FileKind, office: Option<&str>) -> String {
    match kind {
        FileKind::Text => format!("--- {} ---\n{}", file_label(file), decoded_text(&file.data)),
        FileKind::Office if office.is_some() => format!("--- {} ---\n{}", file_label(file), office.unwrap_or_default()),
        _ => format!("[file not sent inline: {} — this type has no inline form; open it from disk with read]", file_label(file)),
    }
}

impl MediaLowering {
    pub fn new(
        thread: ThreadId,
        docs: Arc<dyn DocumentText>,
        reader: Arc<dyn AttachmentReader>,
        facts: Arc<dyn AttachmentFacts>,
        no_documents: bool,
        provider: ProviderId,
    ) -> Self {
        Self { thread, docs, reader, facts, no_documents, provider, memo: Mutex::new(Memo::default()) }
    }

    fn memo(&self) -> std::sync::MutexGuard<'_, Memo> {
        self.memo.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// `fileInfo` on what is known without a read.
    fn lookup(&self, part: &ContentPart) -> Lookup {
        match part {
            ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, title } if !data.is_empty() => {
                let mime = mime_of(media_type);
                let mime = if inline_file_kind(&mime, data, "") == FileKind::Pdf { "application/pdf".to_owned() } else { mime };
                Lookup::Info(FileInfo { key: sha256_hex(data), data: data.clone(), mime, filename: title.clone().unwrap_or_default() })
            }
            ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, text: None } if !data.is_empty() => {
                let mime = mime_of(mime_type);
                let mime = if inline_file_kind(&mime, data, "") == FileKind::Pdf { "application/pdf".to_owned() } else { mime };
                Lookup::Info(FileInfo { key: sha256_hex(data), data: data.clone(), mime, filename: filename.clone().unwrap_or_default() })
            }
            ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type, filename, text: None } => {
                match self.memo().resolved.get(reference) {
                    None => Lookup::Cold,
                    Some(Resolved::Gone) => Lookup::Gone,
                    Some(Resolved::Bytes(data)) => {
                        let mime = mime_of(mime_type);
                        let mime = if inline_file_kind(&mime, data, "") == FileKind::Pdf { "application/pdf".to_owned() } else { mime };
                        Lookup::Info(FileInfo { key: reference.clone(), data: data.clone(), mime, filename: filename.clone().unwrap_or_default() })
                    }
                }
            }
            _ => Lookup::NotFile,
        }
    }

    /// Reads a stored file into the memo. A permanently unreadable blob is remembered as gone; any
    /// other failure propagates and nothing is remembered.
    async fn resolve(&self, part: &ContentPart) -> Result<(), Box<ProviderError>> {
        let ContentPart::File { source: BinarySource::AttachmentRef(reference), text: None, .. } = part else { return Ok(()) };
        self.resolve_ref(reference).await.map_err(failure)
    }

    /// [`Self::resolve`] by reference; the error is the read's own message.
    async fn resolve_ref(&self, reference: &str) -> Result<(), String> {
        if self.memo().resolved.contains_key(reference) {
            return Ok(());
        }
        let resolved = match self.reader.read(reference).await {
            Ok(bytes) => Resolved::Bytes(STANDARD.encode(bytes)),
            Err(ReadError::Permanent) => Resolved::Gone,
            Err(ReadError::Other(message)) => return Err(message),
        };
        let mut memo = self.memo();
        if memo.resolved.len() > OFFICE_CACHE_CAP {
            memo.resolved.clear();
        }
        memo.resolved.insert(reference.to_owned(), resolved);
        Ok(())
    }

    async fn office(&self, file: &FileInfo) -> Result<Option<String>, Box<ProviderError>> {
        let key = format!("{}\0{}", file.key, file.filename);
        if let Some(hit) = self.memo().office.get(&key) {
            return Ok(hit.clone());
        }
        let text = self
            .docs
            .office_text(&self.thread, &file.filename, &file.data)
            .await
            .map_err(|e| failure(format!("office text extraction failed: {e:?}")))?;
        let mut memo = self.memo();
        if memo.office.len() > OFFICE_CACHE_CAP {
            memo.office.clear();
        }
        memo.office.insert(key, text.clone());
        Ok(text)
    }

    /// `budget` is the one bound of the pass's PDF extractions, set when the first is asked for. Node's extraction has
    /// no deadline and waits; here a PDF not read by the bound is the fixed unreadable text, what Node's own
    /// `extractPdfText` gives a PDF it cannot read, so the turn goes on and the model is told the document could not be
    /// read. The bound is Node's PDF intake deadline (`PDF_INTAKE_TIMEOUT_MS`), which Node's intake of a submission ends
    /// the submission at for the first PDF that reaches it: all the turn's PDFs share it, so none adds its own, and the
    /// text is kept (memo) so every attempt sends the same words.
    async fn pdf(&self, file: &FileInfo, budget: &mut Option<Scope<'static>>) -> Result<String, Box<ProviderError>> {
        // An inline part and the reference stored for it share one entry in Node (the bytes'
        // hash); here the key is the reference or the payload's own hash.
        if let Some(hit) = self.memo().pdf.get(&file.key) {
            return Ok(hit.clone());
        }
        let scope = *budget.get_or_insert_with(|| Scope::new().within(Duration::from_millis(PDF_INTAKE_TIMEOUT_MS)));
        let text = match scope.run(self.docs.pdf_text(&self.thread, &file.data)).await {
            Scoped::Done(extracted) => extracted.map_err(|e| failure(format!("pdf text extraction failed: {e:?}")))?,
            _ => PDF_UNREADABLE_TEXT.to_owned(),
        };
        let mut memo = self.memo();
        if memo.pdf.len() > OFFICE_CACHE_CAP {
            memo.pdf.clear();
        }
        memo.pdf.insert(file.key.clone(), text.clone());
        Ok(text)
    }

    /// `documentSourceText`: the text of a document whose source is not base64 bytes.
    fn document_source_text(part: &ContentPart) -> Option<String> {
        let ContentPart::Document { source, title } = part else { return None };
        let text = match source {
            DocumentSource::Text { data, .. } => data.clone(),
            DocumentSource::Content(content) => content_to_text(content),
            DocumentSource::Base64 { .. } => return None,
        };
        Some(match title.as_deref().filter(|t| !t.is_empty()) {
            Some(title) => format!("--- {title} ---\n{text}"),
            None => text,
        })
    }

    /// Reads the store's facts of `reference` into the memo, once.
    async fn prime(&self, reference: &str) {
        if self.memo().facts.contains_key(reference) {
            return;
        }
        let facts = self.facts.facts(reference).await;
        let mut memo = self.memo();
        if memo.facts.len() > OFFICE_CACHE_CAP {
            memo.facts.clear();
        }
        memo.facts.insert(reference.to_owned(), facts);
    }

    /// The memoized facts of a primed reference; `None` when nothing is recorded or it was not primed.
    fn stored_facts(&self, reference: &str) -> Option<StoredFacts> {
        self.memo().facts.get(reference).copied().flatten()
    }

    /// The base64 size a stored attachment expands to, from its recorded size.
    fn stored_wire_bytes(&self, reference: Option<&str>) -> u64 {
        reference.and_then(|r| self.stored_facts(r)).map_or(0, |f| f.size_bytes.div_ceil(3) * 4)
    }

    /// Reads and extracts every file part of `messages` into the memo.
    async fn warm(&self, messages: &[Message]) -> Result<(), Box<ProviderError>> {
        for message in messages {
            let Content::Parts(parts) = &message.content else { continue };
            for part in parts {
                if let Some(reference) = is_image_ref(part).or_else(|| is_pdf_ref(part)) {
                    self.prime(reference).await;
                }
                self.resolve(part).await?;
                if let Lookup::Info(file) = self.lookup(part) {
                    if inline_file_kind(&file.mime, &file.data, &file.filename) == FileKind::Office {
                        self.office(&file).await?;
                    }
                }
            }
        }
        Ok(())
    }
}

/// `contentToText(source.content, '')` for a document's content source: its text blocks.
fn content_to_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(parts) => parts
            .iter()
            .map(|p| match p {
                serde_json::Value::String(s) => s.clone(),
                other => other.get("text").and_then(|t| t.as_str()).map_or_else(|| other.to_string(), str::to_owned),
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// What one route turns the files of a request into text for.
struct Lowered {
    /// A PDF is sent as its text (`nativePdf === false`, or no document at all).
    pdf: bool,
    /// No document block of any kind (`nativeDocuments === false`).
    no_documents: bool,
    /// The route takes media, so the lowering of an Office file and of a stored file whose blob is gone is the
    /// route's own; a text-only route leaves both to its degrade step.
    route_files: bool,
}

impl MediaLowering {
    /// `preparePdfTextForProvider`: the messages with each file part that has a text form replaced by it.
    async fn lower(&self, messages: Vec<Message>, how: Lowered) -> Result<Vec<Message>, Box<ProviderError>> {
        self.warm(&messages).await?;
        let mut budget = None;
        let mut out = Vec::with_capacity(messages.len());
        for mut message in messages {
            if let Content::Parts(parts) = &mut message.content {
                for part in parts.iter_mut() {
                    let replacement = match self.lookup(part) {
                        Lookup::Info(file) => match inline_file_kind(&file.mime, &file.data, &file.filename) {
                            FileKind::Pdf if how.pdf => Some(format!("--- {} ---\n{}", file_label(&file), self.pdf(&file, &mut budget).await?)),
                            FileKind::Pdf => None,
                            kind if how.no_documents || (how.route_files && kind == FileKind::Office) => self.text_form(part)?,
                            _ => None,
                        },
                        Lookup::Gone if how.route_files => Some(unavailable_text(part)),
                        Lookup::NotFile if how.no_documents => Self::document_source_text(part),
                        _ => None,
                    };
                    if let Some(text) = replacement {
                        *part = ContentPart::Text(text, None);
                    }
                }
            }
            out.push(message);
        }
        Ok(out)
    }
}

#[async_trait]
impl MediaText for MediaLowering {
    async fn prepare_pdf_text(&self, messages: Vec<Message>) -> Result<Vec<Message>, Box<ProviderError>> {
        self.lower(messages, Lowered { pdf: true, no_documents: self.no_documents, route_files: false }).await
    }

    async fn prepare_for_route(&self, messages: Vec<Message>, support: MediaSupport) -> Result<Vec<Message>, Box<ProviderError>> {
        let no_documents = support.native_documents == Some(false);
        self.lower(messages, Lowered { pdf: !support.native_pdf || no_documents, no_documents, route_files: true }).await
    }

    fn text_form(&self, part: &ContentPart) -> Result<Option<String>, Box<ProviderError>> {
        match self.lookup(part) {
            Lookup::NotFile => Ok(None),
            Lookup::Gone => Ok(Some(unavailable_text(part))),
            Lookup::Cold => Err(failure("internal error: a stored file reached text lowering unread (await prepare_pdf_text before building the request)".to_owned())),
            Lookup::Info(file) => {
                let kind = inline_file_kind(&file.mime, &file.data, &file.filename);
                match kind {
                    FileKind::Pdf => Err(failure("internal error: a PDF part reached text lowering unprepared (await preparePdfTextForProvider before building the request)".to_owned())),
                    FileKind::Office => {
                        let key = format!("{}\0{}", file.key, file.filename);
                        let memo = self.memo();
                        match memo.office.get(&key) {
                            Some(text) => Ok(Some(fallback_text(&file, kind, text.as_deref()))),
                            None => Err(failure("internal error: an Office file reached text lowering unprepared (await prepare_pdf_text before building the request)".to_owned())),
                        }
                    }
                    _ => Ok(Some(fallback_text(&file, kind, None))),
                }
            }
        }
    }
}

// ---- token allowances (`context-utils.mjs`) ----

const FILE_TOKEN_ALLOWANCE_FLOOR: u64 = 1_500;
const FILE_MAX_TOKEN_ALLOWANCE: u64 = 300_000;
const PDF_TEXT_CHARS_PER_TOKEN: u64 = 2;
const FILE_TOKENS_PER_PAGE_UNMEASURED: u64 = 2_500;
/// `PDF_TEXT_MAX_BYTES / 4`: a PDF that lowers to text costs at most its extraction budget.
const PDF_TEXT_MAX_TOKENS: u64 = 256 * 1024 / 4;

/// `fileDescriptorAllowance`.
fn pdf_allowance(size_bytes: u64, pages: Option<u64>, text_chars: Option<u64>, native: bool) -> u64 {
    let pages = pages.unwrap_or(0);
    let native_tokens = match text_chars {
        Some(chars) if pages > 0 => pages * IMAGE_TOKEN_ALLOWANCE + chars.div_ceil(PDF_TEXT_CHARS_PER_TOKEN),
        _ if pages > 0 => pages * FILE_TOKENS_PER_PAGE_UNMEASURED,
        _ => FILE_TOKEN_ALLOWANCE_FLOOR.max(size_bytes.div_ceil(16)),
    }
    .min(FILE_MAX_TOKEN_ALLOWANCE);
    if native { native_tokens } else { native_tokens.min(PDF_TEXT_MAX_TOKENS) }
}

/// `imageDescriptorAllowance`.
fn image_allowance(width: Option<f64>, height: Option<f64>) -> u64 {
    match (width, height) {
        (Some(w), Some(h)) if w > 0.0 && h > 0.0 => IMAGE_TOKEN_ALLOWANCE.min((w * h / 750.0).ceil() as u64),
        _ => IMAGE_TOKEN_ALLOWANCE,
    }
}

fn is_image_ref(part: &ContentPart) -> Option<&str> {
    match part {
        ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, text: None, .. }
            if mime_type.trim().to_lowercase().starts_with("image/") =>
        {
            Some(r)
        }
        _ => None,
    }
}

fn is_pdf_ref(part: &ContentPart) -> Option<&str> {
    match part {
        ContentPart::File { source: BinarySource::AttachmentRef(r), mime_type, text: None, .. }
            if inline_file_kind(&mime_of(mime_type), "", "") == FileKind::Pdf =>
        {
            Some(r)
        }
        _ => None,
    }
}

#[async_trait]
impl MediaMeter for MediaLowering {
    /// Reads the facts of every stored image or PDF the messages carry into the memo.
    async fn prepare(&self, messages: &[AgentMessage]) -> Result<(), String> {
        let mut references: Vec<String> = Vec::new();
        let mut texts: Vec<&ContentPart> = Vec::new();
        for message in messages {
            if let Content::Parts(parts) = &message.message.content {
                references.extend(parts.iter().filter_map(|part| is_image_ref(part).or_else(|| is_pdf_ref(part))).map(str::to_owned));
                texts.extend(parts.iter().filter(|part| stored_text_ref(part).is_some()));
                // The row's parts, one per typed part (`message_of` reads them in order), envelope or not.
                let content = message.stored.as_ref().and_then(|row| row.get("content"));
                let rows = content.and_then(|c| c.as_array().or_else(|| c.get("content").and_then(Value::as_array)));
                for (part, row) in parts.iter().zip(rows.into_iter().flatten()) {
                    if let Some(reference) = stored_text_ref(part) {
                        self.memo().stored_parts.insert(reference.to_owned(), row.clone());
                    }
                }
            }
        }
        for reference in references {
            self.prime(&reference).await;
        }
        for reference in texts.into_iter().filter_map(stored_text_ref) {
            self.resolve_ref(reference).await?;
        }
        Ok(())
    }

    /// `rawJsonFallbackFromPart` and the image and document allowances, for a part of a stored
    /// message. A stored file is read from the memo, so [`MediaText::prepare_pdf_text`] (or the
    /// host's warm of the history) comes first.
    fn part(&self, part: &ContentPart) -> PartMeter {
        if let Some(reference) = stored_text_ref(part) {
            // `attachmentTextForPart`; a blob gone for good prices as the part's own JSON (`rawJsonFallbackFromPart`).
            let memo = self.memo();
            let text = match memo.resolved.get(reference) {
                Some(Resolved::Bytes(data)) => stored_text(part, &STANDARD.decode(data).unwrap_or_default()),
                Some(Resolved::Gone) => mixdog_js::json_stringify(&memo.stored_parts.get(reference).cloned().unwrap_or_else(|| super::message_row::part_row(part))),
                None => String::new(),
            };
            return PartMeter { text, tokens: 0 };
        }
        match part {
            ContentPart::Text(text, _) => PartMeter { text: text.clone(), tokens: 0 },
            ContentPart::Image(ImageSource::Base64 { width, height, .. }) => {
                PartMeter { text: String::new(), tokens: image_allowance(width.map(f64::from), height.map(f64::from)) }
            }
            ContentPart::Image(_) => PartMeter { text: String::new(), tokens: IMAGE_TOKEN_ALLOWANCE },
            _ => {
                if let Some(reference) = is_image_ref(part) {
                    let f = self.stored_facts(reference).unwrap_or_default();
                    return PartMeter { text: String::new(), tokens: image_allowance(f.width, f.height) };
                }
                if let Some(reference) = is_pdf_ref(part) {
                    let f = self.stored_facts(reference).unwrap_or_default();
                    return PartMeter { text: String::new(), tokens: pdf_allowance(f.size_bytes, f.page_count, f.text_chars, true) };
                }
                match self.lookup(part) {
                    Lookup::Info(file) => {
                        let kind = inline_file_kind(&file.mime, &file.data, &file.filename);
                        match kind {
                            FileKind::Pdf => PartMeter { text: String::new(), tokens: pdf_allowance(base64_byte_length(&file.data), None, None, true) },
                            _ => PartMeter { text: self.text_form(part).ok().flatten().unwrap_or_default(), tokens: 0 },
                        }
                    }
                    // A stored file with no blob is priced as the part itself.
                    Lookup::Gone => PartMeter { text: unavailable_text(part), tokens: 0 },
                    Lookup::Cold | Lookup::NotFile => PartMeter { text: String::new(), tokens: 0 },
                }
            }
        }
    }
}

impl ToolMediaMeter for MediaLowering {
    fn bytes(&self, content: &Content, native_pdf: bool) -> u64 {
        let Content::Parts(parts) = content else { return 0 };
        parts
            .iter()
            .map(|part| match part {
                ContentPart::Image(ImageSource::Base64 { data, .. }) => mixdog_js::utf16_len(data) as u64,
                ContentPart::Image(ImageSource::Url(url)) if url.starts_with("data:") => mixdog_js::utf16_len(url) as u64,
                ContentPart::Image(_) => 0,
                _ if is_image_ref(part).is_some() => self.stored_wire_bytes(is_image_ref(part)),
                _ if native_pdf && is_pdf_ref(part).is_some() => self.stored_wire_bytes(is_pdf_ref(part)),
                ContentPart::File { source: BinarySource::Base64(data), mime_type, text: None, .. }
                    if native_pdf && inline_file_kind(&mime_of(mime_type), data, "") == FileKind::Pdf =>
                {
                    mixdog_js::utf16_len(data) as u64
                }
                ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, .. }
                    if native_pdf && inline_file_kind(&mime_of(media_type), data, "") == FileKind::Pdf =>
                {
                    mixdog_js::utf16_len(data) as u64
                }
                _ => 0,
            })
            .sum()
    }

    fn count(&self, content: &Content, native_pdf: bool) -> u64 {
        let Content::Parts(parts) = content else { return 0 };
        parts
            .iter()
            .filter(|part| match part {
                ContentPart::Image(_) => true,
                _ if is_image_ref(part).is_some() => true,
                _ if is_pdf_ref(part).is_some() => native_pdf,
                ContentPart::File { source: BinarySource::Base64(data), mime_type, filename, text: None } => {
                    native_pdf && inline_file_kind(&mime_of(mime_type), data, filename.as_deref().unwrap_or("")) == FileKind::Pdf
                }
                ContentPart::Document { source: DocumentSource::Base64 { media_type, data }, .. } => {
                    native_pdf && inline_file_kind(&mime_of(media_type), data, "") == FileKind::Pdf
                }
                _ => false,
            })
            .count() as u64
    }
}

const _: &str = PDF_UNREADABLE_PREFIX;

impl ImageIdentities for MediaLowering {
    /// The images of a message: its content parts, and for an assistant message the native
    /// blocks it replays (`assistantBlocks`, `providerReplay.items`).
    fn images(&self, message: &AgentMessage) -> Vec<ImageDescriptor> {
        let plain = |identity: String| ImageDescriptor { identity, width: None, height: None, detail: "auto".to_owned() };
        let mut out: Vec<ImageDescriptor> = Vec::new();
        if let Content::Parts(parts) = &message.message.content {
            for part in parts {
                match part {
                    ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => out.push(plain(image_identity("inline", data, &clean_image_mime(mime_type)))),
                    ContentPart::Image(ImageSource::Url(url)) => out.push(plain(image_identity("url", url, ""))),
                    ContentPart::Image(ImageSource::FileId(id)) => out.push(plain(image_identity("file-id", id, ""))),
                    _ => {
                        if let Some(reference) = is_image_ref(part) {
                            let mime = match part {
                                ContentPart::File { mime_type, .. } => mime_type.as_str(),
                                _ => "",
                            };
                            let f = self.stored_facts(reference).unwrap_or_default();
                            out.push(ImageDescriptor { identity: image_identity("attachment-ref", reference, mime), width: f.width.filter(|w| *w > 0.0), height: f.height.filter(|h| *h > 0.0), detail: "auto".to_owned() });
                        }
                    }
                }
            }
        }
        if message.role() == Role::Assistant {
            let blocks = message.message.assistant_blocks.iter().chain(message.message.replay_for(&self.provider).map(|r| &r.items));
            for value in blocks {
                match value {
                    Value::Array(items) => out.extend(items.iter().filter_map(json_image_descriptor)),
                    other => out.extend(json_image_descriptor(other)),
                }
            }
        }
        out
    }
}
#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    struct Docs;
    #[async_trait]
    impl DocumentText for Docs {
        async fn office_text(&self, _: &ThreadId, filename: &str, _: &str) -> Result<Option<String>, ExtError> {
            Ok((filename != "broken.docx").then(|| "EXTRACTED".to_owned()))
        }
        async fn pdf_text(&self, _: &ThreadId, _: &str) -> Result<String, ExtError> {
            Ok("PDFTEXT".to_owned())
        }
        async fn pdf_counts(&self, _: &ThreadId, data: &str) -> Result<PdfIntake, ExtError> {
            use mixdog_core_api::domain::ext::PdfCounts;
            Ok(match data {
                "unreadable" => PdfIntake::Rejected("Invalid PDF structure.".to_owned()),
                "long" => PdfIntake::Counts(PdfCounts { page_count: 101, text_pages: 100, text_chars: 9 }),
                _ => PdfIntake::Counts(PdfCounts { page_count: 3, text_pages: 2, text_chars: 4_001 }),
            })
        }
    }

    struct Store(Vec<(&'static str, Vec<u8>)>);
    #[async_trait]
    impl AttachmentReader for Store {
        async fn read(&self, reference: &str) -> Result<Vec<u8>, ReadError> {
            match reference {
                "flaky" => Err(ReadError::Other("EBUSY".into())),
                _ => self.0.iter().find(|(r, _)| *r == reference).map(|(_, b)| b.clone()).ok_or(ReadError::Permanent),
            }
        }
    }

    struct Facts;
    #[async_trait]
    impl AttachmentFacts for Facts {
        async fn facts(&self, reference: &str) -> Option<StoredFacts> {
            match reference {
                "scan" => Some(StoredFacts { size_bytes: 5_000_000, page_count: Some(37), text_chars: None, ..Default::default() }),
                "typed" => Some(StoredFacts { size_bytes: 90_000, page_count: Some(3), text_chars: Some(4_001), ..Default::default() }),
                "shot" => Some(StoredFacts { size_bytes: 300, width: Some(100.0), height: Some(50.0), ..Default::default() }),
                _ => None,
            }
        }
    }

    /// An inline image is priced by the size its tool reported (`imageDescriptorAllowance`), the flat allowance when it reported none.
    #[test]
    fn an_inline_image_is_priced_by_its_reported_size() {
        let l = lowering(false);
        let image = |width, height| ContentPart::Image(ImageSource::Base64 { data: "AAAA".into(), mime_type: "image/jpeg".into(), width, height });
        assert_eq!(l.part(&image(Some(50), Some(30))).tokens, 2);
        assert_eq!(l.part(&image(Some(1280), Some(720))).tokens, 1_229);
        assert_eq!(l.part(&image(None, None)).tokens, 1_568);
    }

    fn lowering(no_documents: bool) -> MediaLowering {
        let store = Store(vec![("doc", b"hello".to_vec()), ("pdf", b"%PDF-1.4 body".to_vec()), ("office", b"PK".to_vec())]);
        MediaLowering::new(ThreadId::from("t".to_owned()), Arc::new(Docs), Arc::new(store), Arc::new(Facts), no_documents, ProviderId::from("anthropic"))
    }

    fn b64(text: &str) -> String {
        STANDARD.encode(text)
    }

    fn file(data: &str, mime: &str, filename: Option<&str>) -> ContentPart {
        ContentPart::File { source: BinarySource::Base64(b64(data)), mime_type: mime.into(), filename: filename.map(str::to_owned), text: None }
    }

    fn reference(r: &str, mime: &str, filename: Option<&str>) -> ContentPart {
        ContentPart::File { source: BinarySource::AttachmentRef(r.into()), mime_type: mime.into(), filename: filename.map(str::to_owned), text: None }
    }

    /// Node's real `contentToText`, `contentMediaBytes`/`Count` and the PDF/image allowances.
    #[test]
    fn inline_parts_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/media.json")).unwrap();
        let big = format!("%PDF-1.4 {}", "x".repeat(40_000));
        let doc = |media: &str, data: &str, title: &str| ContentPart::Document {
            source: DocumentSource::Base64 { media_type: media.into(), data: b64(data) },
            title: Some(title.into()),
        };
        let parts: Vec<(&str, ContentPart)> = vec![
            ("text_file", file("hello", "text/plain", Some("a.txt"))),
            ("json_nameless", file("{\"a\":1}", "application/json", None)),
            ("binary_zip", file("PK\u{3}\u{4}abcdef", "application/zip", Some("x.zip"))),
            ("mislabelled_pdf", file(&big, "application/octet-stream", Some("scan.bin"))),
            ("labelled_pdf", file("%PDF-1.7 tiny", "application/pdf", None)),
            ("pdf_document", doc("application/pdf", &big, "Big")),
            ("text_document", doc("text/markdown", "# hi", "notes.md")),
            ("image_inline", ContentPart::Image(ImageSource::Base64 { data: "AAAABBBB".into(), mime_type: "image/png".into(), width: None, height: None })),
            ("image_data_url", ContentPart::Image(ImageSource::Url("data:image/png;base64,AAAA".into()))),
        ];
        let lowering = lowering(false);
        for (id, part) in &parts {
            let want = &golden["cases"][*id];
            let content = Content::Parts(vec![part.clone()]);
            assert_eq!(json!(lowering.bytes(&content, true)), want["bytes"], "{id} bytes");
            assert_eq!(json!(lowering.bytes(&content, false)), want["bytesText"], "{id} bytes as text");
            assert_eq!(json!(lowering.count(&content, true)), want["count"], "{id} count");
            assert_eq!(json!(lowering.count(&content, false)), want["countText"], "{id} count as text");
            let meter = lowering.part(part);
            assert_eq!(json!(meter.text), want["text"], "{id} text");
            assert_eq!(json!(meter.tokens), json!(want["pdfNative"].as_u64().unwrap() + want["image"].as_u64().unwrap()), "{id} tokens");
        }
        assert_eq!(pdf_allowance(40_009, None, None, false), golden["cases"]["pdf_document"]["pdfText"]);
    }

    #[tokio::test]
    async fn stored_media_is_priced_from_the_recorded_facts() {
        let l = lowering(false);
        // The meters read the memo: the messages that carry the references prime it.
        let message = |r: &str, mime: &str| {
            let mut m = AgentMessage::user("x");
            m.message.content = Content::Parts(vec![reference(r, mime, None)]);
            m
        };
        l.prepare(&[message("scan", "application/pdf"), message("typed", "application/pdf"), message("shot", "image/png"), message("unknown", "image/png")]).await.unwrap();
        let content = |p: ContentPart| Content::Parts(vec![p]);
        // 37 pages, no text layer measured: 2 500 a page; 3 pages with 4 001 chars: 3*1568 + 2001.
        assert_eq!(l.part(&reference("scan", "application/pdf", None)).tokens, 92_500);
        assert_eq!(l.part(&reference("typed", "application/pdf", None)).tokens, 3 * 1_568 + 2_001);
        assert_eq!(l.part(&reference("shot", "image/png", None)).tokens, 7);
        assert_eq!(l.part(&reference("unknown", "image/png", None)).tokens, 1_568);
        assert_eq!(l.bytes(&content(reference("shot", "image/png", None)), true), 400);
        assert_eq!(l.bytes(&content(reference("scan", "application/pdf", None)), false), 0);
        assert_eq!(l.count(&content(reference("scan", "application/pdf", None)), true), 1);
        assert_eq!(pdf_allowance(5_000_000, Some(500), None, true), 300_000);
        assert_eq!(pdf_allowance(5_000_000, Some(500), None, false), 65_536);
    }

    #[tokio::test]
    async fn preparing_replaces_pdfs_and_warms_office_and_stored_files() {
        let l = lowering(false);
        let office = reference("office", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", Some("a.docx"));
        let messages = vec![Message::new(Role::User, Content::Parts(vec![reference("pdf", "application/pdf", Some("p.pdf")), office.clone(), reference("doc", "text/plain", Some("d.txt"))]))];
        // Cold: nothing read yet.
        assert!(l.text_form(&office).is_err());
        let prepared = l.prepare_pdf_text(messages).await.unwrap();
        let Content::Parts(parts) = &prepared[0].content else { panic!("parts") };
        assert_eq!(parts[0], ContentPart::Text("--- p.pdf (application/pdf, 13 bytes) ---\nPDFTEXT".into(), None));
        assert_eq!(parts[1], office, "an Office file keeps its part unless the route takes no documents");
        assert_eq!(l.text_form(&office).unwrap().unwrap(), "--- a.docx (application/vnd.openxmlformats-officedocument.wordprocessingml.document, 2 bytes) ---\nEXTRACTED");
        assert_eq!(l.text_form(&reference("doc", "text/plain", Some("d.txt"))).unwrap().unwrap(), "--- d.txt (text/plain, 5 bytes) ---\nhello");
    }

    /// A worker whose extraction of a PDF ends when the test says: `one` once `release_one` is notified, `hang` never.
    struct SlowDocs {
        release_one: Arc<tokio::sync::Notify>,
    }
    #[async_trait]
    impl DocumentText for SlowDocs {
        async fn office_text(&self, _: &ThreadId, _: &str, _: &str) -> Result<Option<String>, ExtError> {
            unreachable!("no Office file")
        }
        async fn pdf_text(&self, _: &ThreadId, data: &str) -> Result<String, ExtError> {
            match String::from_utf8(STANDARD.decode(data).unwrap()).unwrap().as_str() {
                "%PDF one" => {
                    self.release_one.notified().await;
                    Ok("ONE".to_owned())
                }
                _ => std::future::pending().await,
            }
        }
        async fn pdf_counts(&self, _: &ThreadId, _: &str) -> Result<PdfIntake, ExtError> {
            unreachable!("a request lowering counts no PDF pages")
        }
    }

    /// The prompt's PDFs lowering on the test's clock, which moves only by `advance`.
    struct Lowering {
        done: tokio::task::JoinHandle<Vec<String>>,
        release_one: Arc<tokio::sync::Notify>,
    }

    impl Lowering {
        fn start(files: &[&'static str]) -> Self {
            let store = Store(vec![("one", b"%PDF one".to_vec()), ("hang", b"%PDF hang".to_vec()), ("hang2", b"%PDF hang two".to_vec())]);
            let release_one = Arc::new(tokio::sync::Notify::new());
            let docs = SlowDocs { release_one: release_one.clone() };
            let l = MediaLowering::new(ThreadId::from("t".to_owned()), Arc::new(docs), Arc::new(store), Arc::new(Facts), false, ProviderId::from("anthropic"));
            let parts = files.iter().map(|r| reference(r, "application/pdf", Some("p.pdf"))).collect();
            let done = tokio::spawn(async move {
                let prepared = l.prepare_pdf_text(vec![Message::new(Role::User, Content::Parts(parts))]).await.unwrap();
                let Content::Parts(parts) = &prepared[0].content else { panic!("parts") };
                parts
                    .iter()
                    .map(|p| match p {
                        ContentPart::Text(text, _) => text.rsplit('\n').next().unwrap().to_owned(),
                        other => panic!("a PDF stayed a part: {other:?}"),
                    })
                    .collect()
            });
            Self { done, release_one }
        }

        /// Moves the clock by `ms` and lets the lowering run to wherever that takes it.
        async fn advance(&self, ms: u64) {
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
            tokio::time::advance(Duration::from_millis(ms)).await;
            for _ in 0..8 {
                tokio::task::yield_now().await;
            }
        }
    }

    /// A PDF the worker never reads is, at the bound, the text Node gives a PDF it cannot read (the recorded `not-a-pdf`
    /// case): Node waits, so a user sees the model told the document could not be read, never an error. The bound is
    /// one for the turn's PDFs: two that never answer end together at 60 s, not one after the other at 120 s.
    #[tokio::test(start_paused = true)]
    async fn a_turns_pdfs_share_one_bound() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/tools/media-text/pdf.json");
        let recorded: Vec<Value> = serde_json::from_str(&mixdog_testkit::read_string(&path)).unwrap();
        let unreadable = recorded.iter().find(|c| c["name"] == "not-a-pdf").unwrap()["text"].as_str().unwrap().to_owned();
        assert_eq!(unreadable, PDF_UNREADABLE_TEXT);

        let both = Lowering::start(&["hang", "hang2"]);
        both.advance(PDF_INTAKE_TIMEOUT_MS - 1).await;
        assert!(!both.done.is_finished(), "answered a millisecond before the bound");
        both.advance(1).await;
        assert!(both.done.is_finished(), "the second PDF was still waiting at the turn's bound");
        assert_eq!(both.done.await.unwrap(), [unreadable.clone(), unreadable.clone()]);

        // The first PDF is read 40 s into the bound (the worker answers when released, at 40 s of the clock): the one
        // after it has the 20 s that are left.
        let slow_then_hung = Lowering::start(&["one", "hang"]);
        slow_then_hung.advance(40_000).await;
        slow_then_hung.release_one.notify_one();
        slow_then_hung.advance(PDF_INTAKE_TIMEOUT_MS - 40_000 - 1).await;
        assert!(!slow_then_hung.done.is_finished(), "answered a millisecond before the bound");
        slow_then_hung.advance(1).await;
        assert!(slow_then_hung.done.is_finished(), "the second PDF got more than what was left of the bound");
        assert_eq!(slow_then_hung.done.await.unwrap(), ["ONE".to_owned(), unreadable]);
    }

    #[tokio::test]
    async fn an_unreadable_container_keeps_the_description_and_a_gone_blob_its_placeholder() {
        let l = lowering(true);
        let broken = ContentPart::File {
            source: BinarySource::Base64(b64("PK")),
            mime_type: "application/octet-stream".into(),
            filename: Some("broken.docx".into()),
            text: None,
        };
        let gone = reference("missing", "application/pdf", Some("C:\\x\\old.pdf"));
        let messages = vec![Message::new(Role::User, Content::Parts(vec![broken, gone]))];
        let prepared = l.prepare_pdf_text(messages).await.unwrap();
        let Content::Parts(parts) = &prepared[0].content else { panic!("parts") };
        assert_eq!(parts[0], ContentPart::Text("[file not sent inline: broken.docx (application/octet-stream, 2 bytes) — this type has no inline form; open it from disk with read]".into(), None));
        // A blob that is permanently gone is left alone by the prepare step and lowers to its placeholder.
        assert!(matches!(parts[1], ContentPart::File { .. }));
        assert_eq!(l.text_form(&parts[1]).unwrap().unwrap(), "[attachment unavailable: old.pdf]");
    }

    #[tokio::test]
    async fn a_transient_read_error_surfaces_and_nothing_is_remembered() {
        let l = lowering(false);
        let messages = vec![Message::new(Role::User, Content::Parts(vec![reference("flaky", "application/pdf", None)]))];
        let error = l.prepare_pdf_text(messages).await.unwrap_err();
        assert_eq!(error.message, "EBUSY");
        assert!(l.text_form(&reference("flaky", "application/pdf", None)).is_err());
    }

    #[tokio::test]
    async fn pdf_intake_prices_with_the_counts_and_refuses_as_node_does() {
        let thread = ThreadId::from("t".to_owned());
        let docs = Docs;
        let ok = pdf_intake_facts(&docs, &thread, "pdf", 90_000, true).await.unwrap();
        assert_eq!((ok.page_count, ok.text_pages, ok.text_chars, ok.size_bytes), (Some(3), Some(2), Some(4_001), 90_000));
        assert_eq!(pdf_intake_facts(&docs, &thread, "pdf", 20 * 1024 * 1024 + 1, true).await.unwrap_err(), "PDF exceeds the 20 MiB input limit");
        assert_eq!(
            pdf_intake_facts(&docs, &thread, "long", 1, true).await.unwrap_err(),
            "PDF has 101 pages; maximum supported attachment is 100 pages"
        );
        // A provider that takes the PDF as text reads its first pages: a longer one is accepted.
        assert_eq!(pdf_intake_facts(&docs, &thread, "long", 1, false).await.unwrap().page_count, Some(101));
        assert_eq!(pdf_intake_facts(&docs, &thread, "unreadable", 1, true).await.unwrap_err(), "Invalid PDF structure.");
    }

    /// Node's `contentImageDescriptors` on 14 provider-native blocks.
    #[test]
    fn json_image_descriptors_follow_node() {
        let golden: Value = serde_json::from_str(include_str!("golden/image_descriptors.json")).unwrap();
        for (name, row) in golden.as_object().unwrap() {
            let got: Vec<Value> = json_image_descriptor(&row["block"])
                .into_iter()
                .map(|d| json!({ "identity": d.identity, "width": d.width.map(mixdog_js::json_number), "height": d.height.map(mixdog_js::json_number), "detail": d.detail }))
                .collect();
            assert_eq!(json!(got), row["descriptors"], "{name}");
        }
    }

    #[test]
    fn content_parts_and_replayed_blocks_describe_the_same_images() {
        let l = lowering(false);
        let golden: Value = serde_json::from_str(include_str!("golden/image_descriptors.json")).unwrap();
        let id = |name: &str| golden[name]["descriptors"][0]["identity"].as_str().unwrap().to_owned();
        let mut m = AgentMessage::user("x");
        m.message.content = Content::Parts(vec![
            ContentPart::Image(ImageSource::Base64 { data: "AAAABBBB".into(), mime_type: "IMAGE/JPEG".into(), width: None, height: None }),
            ContentPart::Image(ImageSource::Url("http://x/y.png".into())),
            ContentPart::Image(ImageSource::FileId("file_2".into())),
        ]);
        let ids: Vec<String> = l.images(&m).into_iter().map(|d| d.identity).collect();
        assert_eq!(ids, [id("data"), id("image_url_string"), id("source_file").replace(&id("source_file"), &image_identity("file-id", "file_2", ""))]);
    }

    #[test]
    fn only_the_routes_providers_envelope_is_scanned() {
        use mixdog_core_api::domain::provider::ProviderReplay;
        let l = lowering(false);
        let block = |url: &str| serde_json::json!([{ "type": "image", "source": { "type": "url", "url": url } }]);
        let mut m = AgentMessage::assistant("x", Vec::new());
        m.message.push_replay(ProviderReplay { owner: ProviderId::from("openai"), items: block("http://x/other.png") });
        m.message.push_replay(ProviderReplay { owner: ProviderId::from("anthropic"), items: block("http://x/own.png") });
        let got: Vec<String> = l.images(&m).into_iter().map(|d| d.identity).collect();
        let mut own = AgentMessage::assistant("x", Vec::new());
        own.message.push_replay(ProviderReplay { owner: ProviderId::from("anthropic"), items: block("http://x/own.png") });
        let want: Vec<String> = l.images(&own).into_iter().map(|d| d.identity).collect();
        assert_eq!(got, want);
        assert_eq!(got.len(), 1);
    }
}
