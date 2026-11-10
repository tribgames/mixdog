//! `tools/call` results as typed tool output (T §4 target 5), mapped exactly as the Node client
//! maps them (`normalizeMcpToolResult` + `capMcpResult`; goldens in `tests/golden/node.json`):
//! only `content` is read (`structuredContent` is not), text blocks join with newlines, media
//! becomes parts, and `isError` is a failure that carries Node's `Error:` message. Output over the
//! cap keeps its first 1200 and last 400 lines; the full text is saved as an artifact in the data
//! dir and the note names its path.

use std::path::Path;
use std::path::PathBuf;

use base64::Engine;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::TruncationNote;
use mixdog_js::js_trim;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InLane;
use mixdog_rt::LaneToken;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tokio_util::sync::CancellationToken;

/// Default byte cap of one result's text.
pub const DEFAULT_OUTPUT_MAX_BYTES: usize = 50 * 1024;
const MAX_IMAGE_BYTES: usize = 48 * 1024 * 1024;
const MAX_ATTACHMENT_BLOB_BYTES: usize = 64 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Clone, Copy, Debug)]
pub struct OutputPolicy {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub head_lines: usize,
    pub tail_lines: usize,
}

impl Default for OutputPolicy {
    fn default() -> Self {
        Self { max_bytes: DEFAULT_OUTPUT_MAX_BYTES, max_lines: 2000, head_lines: 1200, tail_lines: 400 }
    }
}

/// Where artifacts go.
#[derive(Clone)]
pub struct Spiller {
    dir: PathBuf,
    io: DurabilityIo,
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job (InLane proof)")]
fn write_artifact(_lane: &InLane<DurabilityIo>, dir: &Path, target: &Path, bytes: &[u8], create_only: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    if create_only && target.exists() {
        return Ok(());
    }
    std::fs::write(target, bytes)
}

impl Spiller {
    pub fn new(dir: PathBuf, io: DurabilityIo) -> Self {
        Self { dir, io }
    }

    async fn write(&self, name: String, bytes: Vec<u8>, create_only: bool) -> std::io::Result<PathBuf> {
        let path = self.dir.join(name);
        let (dir, target) = (self.dir.clone(), path.clone());
        let job = self
            .io
            .submit(&CancellationToken::new(), move |lane| write_artifact(lane, &dir, &target, &bytes, create_only))
            .map_err(|_| std::io::Error::other("the durability lane is full"))?;
        job.await.map_err(std::io::Error::other)??;
        Ok(path)
    }

    /// The full text of an over-cap result: `mcp-<ms>-<8 hex>.txt`.
    async fn write_text(&self, text: String) -> std::io::Result<PathBuf> {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let id = uuid::Uuid::new_v4().simple().to_string();
        self.write(format!("mcp-{millis}-{}.txt", &id[..8]), text.into_bytes(), false).await
    }

    /// Media with no inline form, named by its content hash.
    async fn write_binary(&self, bytes: Vec<u8>, extension: &str) -> std::io::Result<PathBuf> {
        let hash: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
        self.write(format!("mcp-{hash}.{extension}"), bytes, true).await
    }
}

/// A server-reported tool failure (`isError: true`) as the model reads it.
#[derive(Clone, PartialEq, Debug)]
pub struct ReportedError {
    /// Node's `Error:`-prefixed text.
    pub text: String,
    /// The result's `structuredContent`, for the typed error.
    pub data: Option<Value>,
}

/// One runtime part of a result, before it becomes a [`ToolPart`].
#[derive(Clone, PartialEq, Debug)]
pub enum Part {
    Text(String),
    Image { mime: String, bytes: Vec<u8> },
    /// Inline file media (`pdf`, `text`, `office`) in the shape Node hands to provider lowering.
    File(Value),
}

impl Part {
    fn is_media(&self) -> bool {
        !matches!(self, Part::Text(_))
    }
}

/// Node's `Buffer.from(data, 'base64')`: skips characters outside the alphabet and accepts both
/// alphabets and missing padding.
fn lenient_base64(data: &str) -> Vec<u8> {
    let mut cleaned: String = data
        .chars()
        .take_while(|c| *c != '=')
        .filter_map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '+' | '/' => Some(c),
            '-' => Some('+'),
            '_' => Some('/'),
            _ => None,
        })
        .collect();
    if cleaned.len() % 4 == 1 {
        cleaned.pop();
    }
    LENIENT.decode(&cleaned).unwrap_or_default()
}

const LENIENT: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_allow_trailing_bits(true)
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
);

enum Canon {
    Empty,
    TooLarge,
    Bytes(Vec<u8>),
}

/// Decodes, refusing by encoded length before decoding so huge payloads are never copied.
fn canonical(data: &str, max_bytes: usize) -> Canon {
    if data.len() > (max_bytes * 4).div_ceil(3) * 2 {
        return Canon::TooLarge;
    }
    let bytes = lenient_base64(data);
    if bytes.is_empty() {
        Canon::Empty
    } else if bytes.len() > max_bytes {
        Canon::TooLarge
    } else {
        Canon::Bytes(bytes)
    }
}

fn mib(bytes: usize) -> String {
    format!("{} MiB", bytes / 1024 / 1024)
}

fn nonblank(raw: Option<&str>, default: &str) -> String {
    raw.map(js_trim).filter(|s| !s.is_empty()).unwrap_or(default).to_owned()
}

fn image_part(data: &str, raw_mime: Option<&str>) -> Part {
    let mime = raw_mime
        .filter(|m| !m.is_empty())
        .map(|m| js_trim(m.split(';').next().unwrap_or("")).to_lowercase())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "image/png".to_owned());
    if !SUPPORTED_IMAGE_MIME.contains(&mime.as_str()) {
        return Part::Text(format!("[MCP image omitted: {mime} is not a supported image type]"));
    }
    match canonical(data, MAX_IMAGE_BYTES) {
        Canon::Empty => Part::Text("[MCP image omitted: empty image data]".to_owned()),
        Canon::TooLarge => {
            Part::Text(format!("[MCP image omitted: {mime} image exceeds the {} limit]", mib(MAX_IMAGE_BYTES)))
        }
        Canon::Bytes(bytes) => Part::Image { mime, bytes },
    }
}

fn extension_of(label: &str) -> String {
    let cleaned: String = label.chars().filter(char::is_ascii_alphanumeric).take(8).collect::<String>().to_lowercase();
    if cleaned.is_empty() { "bin".to_owned() } else { cleaned }
}

async fn audio_part(data: Option<&str>, raw_mime: Option<&str>, spiller: &Spiller) -> Part {
    let mime = nonblank(raw_mime, "audio");
    let canon = data.filter(|d| !d.is_empty()).map(|d| canonical(d, MAX_ATTACHMENT_BLOB_BYTES));
    match canon {
        None | Some(Canon::Empty) => Part::Text(format!("[MCP audio content: {mime}]")),
        Some(Canon::TooLarge) => Part::Text(format!(
            "[MCP audio omitted: {mime} exceeds the {} limit]",
            mib(MAX_ATTACHMENT_BLOB_BYTES)
        )),
        Some(Canon::Bytes(bytes)) => {
            let subtype = mime.split(';').next().unwrap_or("").split('/').nth(1).unwrap_or("");
            let size = bytes.len();
            match spiller.write_binary(bytes, &extension_of(subtype)).await {
                Ok(path) => Part::Text(format!(
                    "[MCP audio content: {mime} ({size} bytes) saved to {}; open it from disk with read.]",
                    path.display()
                )),
                Err(_) => Part::Text(format!("[MCP audio content: {mime}]")),
            }
        }
    }
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn resource_filename(uri: &str) -> String {
    let path = uri.split(['?', '#']).next().unwrap_or("");
    let tail = path.split('/').rfind(|s| !s.is_empty()).unwrap_or("");
    let name = if tail.is_empty() { "resource".to_owned() } else { percent_decode(tail).unwrap_or_else(|| tail.to_owned()) };
    let cleaned: String = name
        .chars()
        .map(|c| if (c as u32) < 0x20 || c == '/' || c == '\\' { '_' } else { c })
        .take(255)
        .collect();
    if cleaned.is_empty() { "resource".to_owned() } else { cleaned }
}

const TEXTUAL_MIME: [&str; 6] = [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/toml",
    "application/x-ndjson",
    "application/x-www-form-urlencoded",
];
const OFFICE_MIME: [&str; 4] = [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel.sheet.macroenabled.12",
];

#[derive(PartialEq, Eq)]
enum FileKind {
    Pdf,
    Office,
    Text,
    Binary,
}

/// How an inline file payload can reach a model; the bytes decide before the label does.
fn inline_file_kind(mime: &str, bytes: &[u8], filename: &str) -> FileKind {
    let mime = js_trim(mime.split(';').next().unwrap_or("")).to_lowercase();
    if mime == "application/pdf" || bytes.starts_with(b"%PDF-") {
        return FileKind::Pdf;
    }
    let office_name = {
        let lower = js_trim(filename).to_lowercase();
        [".docx", ".pptx", ".xlsx", ".xlsm"].iter().any(|e| lower.ends_with(e))
    };
    if OFFICE_MIME.contains(&mime.as_str())
        || (["application/zip", "application/x-zip-compressed", "application/octet-stream"].contains(&mime.as_str()) && office_name)
    {
        return FileKind::Office;
    }
    if mime.starts_with("text/")
        || mime.starts_with("application/javascript")
        || mime.starts_with("application/ecmascript")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || TEXTUAL_MIME.contains(&mime.as_str())
    {
        return FileKind::Text;
    }
    FileKind::Binary
}

async fn file_part(blob: &str, raw_mime: Option<&str>, uri: &str, spiller: &Spiller) -> Part {
    let mime = nonblank(raw_mime, "application/octet-stream");
    let filename = resource_filename(uri);
    let bytes = match canonical(blob, MAX_ATTACHMENT_BLOB_BYTES) {
        Canon::Empty => return Part::Text(format!("[MCP resource omitted: {filename} has no data]")),
        Canon::TooLarge => {
            return Part::Text(format!(
                "[MCP resource omitted: {filename} ({mime}) exceeds the {} limit]",
                mib(MAX_ATTACHMENT_BLOB_BYTES)
            ));
        }
        Canon::Bytes(bytes) => bytes,
    };
    if inline_file_kind(&mime, &bytes, &filename) == FileKind::Binary {
        let extension = filename
            .rsplit_once('.')
            .map(|(_, e)| e)
            .filter(|e| (1..=8).contains(&e.len()) && e.chars().all(|c| c.is_ascii_alphanumeric()))
            .map_or_else(|| "bin".to_owned(), str::to_lowercase);
        let size = bytes.len();
        return match spiller.write_binary(bytes, &extension).await {
            Ok(path) => Part::Text(format!(
                "[MCP resource {filename} ({mime}, {size} bytes) saved to {}; open it from disk with read.]",
                path.display()
            )),
            Err(_) => {
                Part::Text(format!("[MCP resource omitted: {filename} ({mime}, {size} bytes) could not be saved]"))
            }
        };
    }
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Part::File(serde_json::json!({"type": "file", "data": data, "mimeType": mime, "filename": filename}))
}

/// JavaScript `String(value)` of a non-object content item.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

async fn content_part(item: &Value, spiller: &Spiller) -> Part {
    let Some(block) = item.as_object() else { return Part::Text(js_string(item)) };
    let text = |key: &str| block.get(key).and_then(Value::as_str);
    match text("type") {
        Some("text") => return Part::Text(text("text").unwrap_or_default().to_owned()),
        Some("image") => {
            if let Some(data) = text("data").filter(|d| !d.is_empty()) {
                return image_part(data, text("mimeType"));
            }
        }
        Some("audio") => return audio_part(text("data"), text("mimeType"), spiller).await,
        Some("resource") => {
            if let Some(resource) = block.get("resource").and_then(Value::as_object) {
                let field = |key: &str| resource.get(key).and_then(Value::as_str);
                if let Some(text) = field("text") {
                    return Part::Text(text.to_owned());
                }
                if let Some(blob) = field("blob").filter(|b| !b.is_empty()) {
                    return if field("mimeType").is_some_and(|m| js_trim(m).to_lowercase().starts_with("image/")) {
                        image_part(blob, field("mimeType"))
                    } else {
                        file_part(blob, field("mimeType"), field("uri").unwrap_or(""), spiller).await
                    };
                }
            }
        }
        _ => {}
    }
    Part::Text(item.to_string())
}

fn format_cap_size(bytes: usize) -> String {
    if bytes < 1024 {
        return format!("{bytes} bytes");
    }
    let kb = bytes as f64 / 1024.0;
    if bytes.is_multiple_of(1024) { format!("{} KB", bytes / 1024) } else { format!("{kb:.1} KB") }
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() { 0 } else { text.matches('\n').count() + 1 }
}

struct Plan {
    marker: String,
    head: String,
    tail: String,
}

/// The head/tail cut of `text`, or `None` when it fits (or has no line to elide).
fn plan_cut(text: &str, policy: OutputPolicy) -> Option<Plan> {
    let bytes = text.len();
    let lines = count_lines(text);
    let over_bytes = bytes > policy.max_bytes;
    if !over_bytes && lines <= policy.max_lines {
        return None;
    }
    let rows: Vec<&str> = text.split('\n').collect();
    let head_count = policy.head_lines.min(rows.len());
    let tail_start = head_count.max(rows.len().saturating_sub(policy.tail_lines));
    if tail_start - head_count == 0 {
        return None;
    }
    let limit = if over_bytes { format_cap_size(policy.max_bytes) } else { format!("{} lines", policy.max_lines) };
    let from = head_count + 1;
    let kb = ((bytes as f64) / 1024.0).round().max(1.0) as u64;
    let marker = format!(
        "[output capped at {limit}; lines {from}-{tail_start} of {lines} omitted ({kb} KB file); offset:{from} for more]"
    );
    Some(Plan { marker, head: rows[..head_count].join("\n"), tail: rows[tail_start..].join("\n") })
}

/// Applies the cut across the text parts (one budget over their joined text; media parts pass
/// through intact and every part keeps its position). The marker and `spill_note` land on the
/// part where the elision starts. Returns the parts and the plan's byte totals when it cut.
fn apply_cut(parts: Vec<Part>, plan: &Plan, spill_note: &str) -> Vec<Part> {
    let head_end = plan.head.chars().count();
    let joined_len: usize = {
        let texts: Vec<usize> = parts.iter().filter_map(|p| if let Part::Text(t) = p { Some(t.chars().count()) } else { None }).collect();
        texts.iter().sum::<usize>() + texts.len().saturating_sub(1)
    };
    let tail_start = joined_len - plan.tail.chars().count();
    // Start offset of each text part within the joined text.
    let mut starts = Vec::new();
    let mut offset = 0usize;
    for part in &parts {
        if let Part::Text(t) = part {
            starts.push(offset);
            offset += t.chars().count() + 1;
        }
    }
    let owner = starts.iter().rposition(|s| *s <= head_end);
    let slice = |text: &str, from: usize, to: Option<usize>| -> String {
        text.chars().skip(from).take(to.map_or(usize::MAX, |t| t.saturating_sub(from))).collect()
    };
    let mut out = Vec::new();
    let mut index = 0usize;
    for part in parts {
        let Part::Text(text) = part else {
            out.push(part);
            continue;
        };
        let start = starts[index];
        let this = index;
        index += 1;
        let len = text.chars().count();
        let end = start + len;
        if Some(this) == owner {
            let pre = slice(&text, 0, Some(head_end.saturating_sub(start)));
            let suffix = if end > tail_start { slice(&text, tail_start.saturating_sub(start), None) } else { String::new() };
            let tail = if suffix.is_empty() { String::new() } else { format!("\n{suffix}") };
            out.push(Part::Text(format!("{pre}\n{}{tail}{spill_note}", plan.marker)));
        } else if end <= head_end || start >= tail_start {
            out.push(Part::Text(text));
        } else if start < head_end {
            out.push(Part::Text(slice(&text, 0, Some(head_end - start))));
        } else if end > tail_start {
            out.push(Part::Text(slice(&text, tail_start - start, None)));
        }
    }
    out
}

/// Node's `capMcpResult` over `parts`; the full text is spilled when a cut happens.
pub async fn cap_parts(parts: Vec<Part>, policy: OutputPolicy, spiller: &Spiller) -> (Vec<Part>, Option<TruncationNote>) {
    let joined = parts
        .iter()
        .filter_map(|p| if let Part::Text(t) = p { Some(t.as_str()) } else { None })
        .collect::<Vec<_>>()
        .join("\n");
    let Some(plan) = plan_cut(&joined, policy) else { return (parts, None) };
    let (spill_note, full_path) = match spiller.write_text(joined.clone()).await {
        Ok(path) => (
            format!("\n\n... [full output spilled to {}] ...", path.display()),
            mixdog_core_api::domain::common::AbsPath::new(path),
        ),
        Err(_) => (String::new(), None),
    };
    let note = TruncationNote {
        shown: (plan.head.len() + plan.tail.len()) as u64,
        total: joined.len() as u64,
        next_offset: Some(plan.head.matches('\n').count() as u64 + 2),
        kind: mixdog_core_api::domain::tool::TruncationKind::Cap,
        unit: "bytes".to_owned(),
        limit: None,
        full_path,
    };
    (apply_cut(parts, &plan, &spill_note), Some(note))
}

/// Node's `isError` text of a result without media (`normalizeMcpToolResult`, mcp/client.mjs:904-905): the text, prefixed once.
fn error_text(parts: &[Part]) -> String {
    let joined = parts.iter().filter_map(|p| if let Part::Text(t) = p { Some(t.as_str()) } else { None }).collect::<Vec<_>>().join("\n");
    if joined.starts_with("Error:") { joined } else { format!("Error: {joined}") }
}

/// Node's `isError` result with media (mcp/client.mjs:906-909): the parts stay a structured result, the first text part prefixed
/// once, or an `Error:` text put first when the first part is not text.
fn error_parts(mut parts: Vec<Part>) -> Vec<Part> {
    match parts.first_mut() {
        Some(Part::Text(text)) if !text.starts_with("Error:") => *text = format!("Error: {text}"),
        Some(Part::Text(_)) => {}
        _ => parts.insert(0, Part::Text("Error:".to_owned())),
    }
    parts
}

/// The parts of a result's `content` as Node normalizes them: without media, one text (the text
/// blocks joined by newlines); with media, every part in order.
pub async fn normalize_parts(result: &Value, spiller: &Spiller) -> Vec<Part> {
    let parts = match result.get("content") {
        Some(Value::Array(items)) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(content_part(item, spiller).await);
            }
            parts
        }
        Some(Value::String(text)) => vec![Part::Text(text.clone())],
        Some(other) => vec![Part::Text(other.to_string())],
        None => Vec::new(),
    };
    if parts.iter().any(Part::is_media) {
        return parts;
    }
    let joined = parts
        .iter()
        .filter_map(|p| if let Part::Text(t) = p { Some(t.as_str()) } else { None })
        .collect::<Vec<_>>()
        .join("\n");
    vec![Part::Text(joined)]
}

fn tool_part(part: Part) -> ToolPart {
    match part {
        Part::Text(text) => ToolPart::Text(text),
        Part::Image { mime, bytes } => ToolPart::Image { mime, data: ImageData::Bytes(bytes) },
        Part::File(value) => ToolPart::Json(value),
    }
}

/// Maps a `tools/call` result. `Err` carries the server's own error text.
pub async fn map_call_result(result: &Value, policy: OutputPolicy, spiller: &Spiller) -> Result<ToolOutput, ReportedError> {
    let mut parts = normalize_parts(result, spiller).await;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        // Without media Node returns the `Error: …` text (classified an error by the loop); with media it returns the parts as a
        // structured result, which the loop does not classify (execute-call.mjs classifyToolReturn: a non-string is normal).
        if !parts.iter().any(Part::is_media) {
            return Err(ReportedError {
                text: error_text(&parts),
                data: result.get("structuredContent").filter(|v| !v.is_null()).cloned(),
            });
        }
        parts = error_parts(parts);
    }
    let (parts, truncation) = cap_parts(parts, policy, spiller).await;
    Ok(ToolOutput { parts: parts.into_iter().map(tool_part).collect(), truncation, ..ToolOutput::default() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_size_labels_match_node() {
        assert_eq!(format_cap_size(51_200), "50 KB");
        assert_eq!(format_cap_size(1536), "1.5 KB");
        assert_eq!(format_cap_size(10), "10 bytes");
    }

    #[test]
    fn a_single_long_line_is_never_cut() {
        let policy = OutputPolicy::default();
        assert!(plan_cut(&"x".repeat(200 * 1024), policy).is_none());
    }

    #[test]
    fn filenames_follow_the_uri_tail() {
        assert_eq!(resource_filename("file:///a/b%20c.txt?x=1"), "b c.txt");
        assert_eq!(resource_filename(""), "resource");
        assert_eq!(resource_filename("http://h/"), "h");
    }

    #[test]
    fn lenient_base64_matches_buffer_from() {
        assert_eq!(lenient_base64("aGk="), b"hi");
        assert_eq!(lenient_base64("aGk"), b"hi");
        assert_eq!(lenient_base64("a G-k_"), lenient_base64("aG+k"));
    }
}
