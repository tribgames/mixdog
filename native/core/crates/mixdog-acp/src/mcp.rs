//! The tools a Mixdog session hands its agent: an MCP server of the session's own, which lists
//! the session's tool surface and passes every call to the session's turn, where it runs through
//! Mixdog's pipeline and is shown as any other call of a Mixdog tool.
//!
//! The server is one listener on the loopback interface for each session, started with the
//! session and closed the moment the session closes or its process ends, also where one process
//! serves several sessions. Its address carries no secret; every request must carry the bearer
//! token made for that one session, which only that session's `session/new` (or its reopen) is told.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bytes::Bytes;
use http_body_util::BodyExt;
use http_body_util::Full;
use hyper::Method;
use hyper::Request;
use hyper::Response;
use hyper::StatusCode;
use hyper::body::Incoming as Body;
use hyper::header;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use mixdog_agent::agent_tool::board::JobBoard;
use mixdog_agent::handed::Handed;
use mixdog_agent::message::AgentMessage;
use mixdog_agent::message::ToolKind;
use mixdog_agent::offload::Artifact;
use mixdog_agent::offload::ArtifactStore;
use mixdog_agent::offload::OFFLOAD_PREFIX;
use mixdog_ai::providers::compat::schema::Rule;
use mixdog_ai::providers::compat::schema::wire_input_schema;
use mixdog_core_api::domain::provider::BinarySource;
use mixdog_core_api::domain::provider::Content;
use mixdog_core_api::domain::provider::ContentPart;
use mixdog_core_api::domain::provider::ImageSource;
use mixdog_core_api::domain::provider::ToolDefinition;
use mixdog_core_api::domain::provider::ToolExclusionReport;
use mixdog_core_session::session::composer_image::node_base64_decode;
use mixdog_protocol::ThreadId;
use mixdog_rt::CpuInteractive;
use mixdog_rt::LaneToken;
use mixdog_rt::TaskClass;
use serde_json::Value;
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::preset::Command;

/// What a session's agent is handed its tools with.
#[derive(Clone)]
pub struct Handover {
    pub thread: ThreadId,
    pub tools: Arc<dyn SessionTools>,
    /// The program an agent that takes no HTTP server runs as the server's stdio end.
    pub bridge: Option<Command>,
}

impl Handover {
    /// The names of the tools the session's server lists now, in its order.
    pub async fn listed(&self) -> Result<Vec<String>, String> {
        let definitions = self.tools.definitions(&self.thread).await?;
        let (tools, _) = repair_tools_for_gemini(definitions);
        Ok(tools.into_iter().filter_map(|tool| tool.get("name").and_then(Value::as_str).map(str::to_owned)).collect())
    }

    /// Deterministic digest of the session's current repaired `tools/list` surface.
    pub async fn current_digest(&self) -> Option<String> {
        let definitions = self.tools.definitions(&self.thread).await.ok()?;
        let (tools, _) = repair_tools_for_gemini(definitions);
        Some(tools_digest(&tools))
    }
}

/// Repairs each tool's `inputSchema` for Gemini/Neon wires (`Rule::Gemini`), excluding tools whose schema remains
/// invalid so one broken schema never causes the agent to reject the entire `tools/list`.
pub(crate) fn repair_tools_for_gemini(definitions: Vec<ToolDefinition>) -> (Vec<Value>, Vec<ToolExclusionReport>) {
    let mut tools = Vec::with_capacity(definitions.len());
    let mut excluded = Vec::new();
    for (index, tool) in definitions.into_iter().enumerate() {
        match wire_input_schema(&tool.input_schema, Rule::Gemini) {
            Ok(schema) => tools.push(json!({ "name": tool.name, "description": tool.description, "inputSchema": schema })),
            Err(problem) => {
                let message = format!("tool {} ({}): {}", tool.name, problem.pointer, problem.reason);
                excluded.push(ToolExclusionReport { name: tool.name, index, pointer: problem.pointer, reason: problem.reason, message });
            }
        }
    }
    (tools, excluded)
}

/// Validates a single tool's `inputSchema` against `Rule::Gemini` without mutating state or emitting warning logs.
pub(crate) fn check_tool_schema_for_gemini(tool: &ToolDefinition) -> Result<(), String> {
    wire_input_schema(&tool.input_schema, Rule::Gemini).map(|_| ()).map_err(|problem| problem.reason)
}

/// Recursively sorts JSON object keys so digests are invariant to `serde_json` `preserve_order` key ordering.
fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by_key(|(a, _)| *a);
            let mut out = serde_json::Map::with_capacity(entries.len());
            for (key, val) in entries {
                out.insert(key.clone(), canonicalize_json(val));
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_json).collect()),
        other => other.clone(),
    }
}

/// Order-independent digest over repaired `tools/list` entries so surface changes invalidate stale cached tool lists.
pub(crate) fn tools_digest(tools: &[Value]) -> String {
    let mut items: Vec<(String, String)> =
        tools.iter().map(|tool| (tool.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(), canonicalize_json(tool).to_string())).collect();
    items.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    let joined: String = items.into_iter().map(|(_, serialized)| serialized).collect::<Vec<_>>().join("\n");
    crate::session::digest(&joined)
}

/// Order-independent equality over excluded tools, ignoring input `index`, so reordered `tools/list` responses do not re-log.
fn same_exclusions(a: &[ToolExclusionReport], b: &[ToolExclusionReport]) -> bool {
    fn signature(reports: &[ToolExclusionReport]) -> Vec<(&str, &str, &str, &str)> {
        let mut keys: Vec<_> =
            reports.iter().map(|report| (report.name.as_str(), report.pointer.as_str(), report.reason.as_str(), report.message.as_str())).collect();
        keys.sort_unstable();
        keys
    }
    a.len() == b.len() && signature(a) == signature(b)
}

/// The server's name in the agent's `mcpServers`.
pub const SERVER_NAME: &str = "mixdog";

/// The MCP revisions the server speaks, newest first; a client that asks for another is answered with the newest.
const PROTOCOL_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The session's tool of the step list.
pub const STEP_LIST_TOOL: &str = "todo";

/// The paragraph that follows Mixdog's own prompt in the agent's system prompt when it is handed the session's tools.
pub const PREFERENCE: &str = "# Mixdog tools\nThis session runs inside Mixdog, which hands you its own tools through the MCP server `mixdog`. \
Prefer those tools over your built-in ones wherever one of them does the job: their calls follow the user's Mixdog permissions and hooks, \
and the user sees and reviews them in Mixdog. Use a built-in tool only for work no Mixdog tool covers.";

/// [`PREFERENCE`], with how to make a step's calls: the agent's CLI runs the calls of one model step one after another,
/// each behind a safety check, so a step's items go into one call of a tool that takes them as an array; it shows about
/// 10 KB of one MCP call's result and cuts the middle out of a longer one.
pub fn preference() -> String {
    format!(
        "{PREFERENCE}\nYour CLI runs the Mixdog calls of a step one after another, each behind its own safety check. Where a Mixdog tool \
takes several items as an array (files or ranges for `read`, patterns or paths for `grep` and `glob`, queries for `web_search`, and so \
on), give it all the items the step needs in one call instead of one call per item, and make the step's other calls that do not need \
each other's results together in that step. Your CLI shows you about 10 KB of one Mixdog call's result and cuts the middle out of a \
longer one: where a result comes back cut, get the part you need with narrower calls, such as a line range of the file, a narrower \
search or one file's diff."
    )
}

/// The Mixdog session's side of the hand-over: what its server lists, and where a call goes on that outlasts the
/// agent's deadline for it. A call runs in the turn it is made in ([`crate::turn::TurnContext::calls`]).
#[async_trait]
pub trait SessionTools: Send + Sync {
    /// The tool definitions a request of `thread` would send now: for a session on an agent, a bridge session's
    /// (its directly defined tools, `load_tool` and `call_tool`). The agent is listed exactly these.
    async fn definitions(&self, thread: &ThreadId) -> Result<Vec<ToolDefinition>, String>;

    /// The table of the tool calls that went on in the background ([`JobBoard::of_tool_calls`]), which the sessions'
    /// `task` tool reads and whose finished calls are delivered to their sessions.
    fn tasks(&self) -> &JobBoard;
}

/// A call that never ran, answered with `why`.
pub fn unrun(call_id: &str, why: impl Into<String>) -> Handed {
    Handed { message: AgentMessage::tool_text(call_id, why, ToolKind::Error), follow_ups: Vec::new(), failed: true }
}

/// A `tools/call` of the agent, waiting for the session's turn to run it.
pub struct ToolAsk {
    pub name: String,
    pub arguments: Value,
    /// When the server took the call: the agent's deadline for it runs from about then.
    pub received: tokio::time::Instant,
    /// Takes the `tools/call` result.
    pub answer: oneshot::Sender<Value>,
}

impl std::fmt::Debug for ToolAsk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToolAsk").field("name", &self.name).field("arguments", &self.arguments).finish()
    }
}

impl PartialEq for ToolAsk {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name && self.arguments == other.arguments
    }
}

impl ToolAsk {
    /// Answers the call with a refusal the agent's model reads.
    pub fn refuse(self, why: &str) {
        let _ = self.answer.send(result_text(why.to_owned(), true));
    }
}

/// A `tools/call` result of one text.
pub fn result_text(text: String, failed: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": failed })
}

/// Shown in place of a tool-result image when the agent does not advertise image input.
pub const IMAGE_OMITTED_UNSUPPORTED: &str = "[image omitted: this agent takes no image input]";

const IMAGE_OMITTED_UNREADABLE: &str = "[image omitted: image content could not be read]";
const IMAGE_OMITTED_REMOTE_URL: &str = "[image omitted: remote image URL was not passed to the agent]";
const NON_IMAGE_KEPT_PLACEHOLDER: &str = "[content kept in Mixdog and not passed to the agent]";
const MIN_OFFLOADABLE_TEXT_BYTES: usize = 2_000;

fn detail_recovery_hint(tool_name: &str) -> &'static str {
    match tool_name.trim().to_ascii_lowercase().as_str() {
        "computer" => "use `computer` capture with `mode=\"zoom\"`, `frame_id`, and `region` to inspect a smaller area",
        "browser" => "use `browser` snapshot with `mode=\"visual\"` and `ref` or `target` to capture a specific element",
        _ => "crop the region of interest to a separate image file (e.g. via `shell`) and `read` that file",
    }
}

fn image_too_large_note(tool_name: &str) -> String {
    format!("[image omitted: image exceeds the agent's size limit even at reduced quality; {}]", detail_recovery_hint(tool_name))
}

fn image_detail_reduced_note(tool_name: &str) -> String {
    format!("Detail was reduced to fit the agent's image budget; {} if fine detail is unreadable.", detail_recovery_hint(tool_name))
}

/// How a finished Mixdog tool call's text and image parts are shaped for an ACP agent's `tools/call` reply.
#[derive(Clone, Copy, Debug)]
pub struct ImageOutput {
    /// The agent advertised `promptCapabilities.image == true`.
    pub supports_images: bool,
    /// Per-image decoded byte ceiling enforced by the agent (e.g. `mcpMaxOutputBytes`), if any.
    pub max_raw_bytes: Option<u64>,
    /// Safe UTF-8 byte ceiling for inline MCP text output before offloading full text to an artifact file.
    pub max_inline_text_bytes: Option<usize>,
    /// The lane its images are fitted on.
    pub cpu: CpuInteractive,
}

/// A finished call as the `tools/call` result the agent reads: its text (offloaded to an artifact file with its path
/// when it exceeds the agent's safe inline text ceiling), its images as image content (resolved from stored
/// attachments/blobs and fitted to Mixdog's native history target inside the agent's hard byte ceiling when the agent
/// advertises image input), and what the tool adds to the conversation beside its result (a loaded skill's instructions).
pub async fn rendered(
    handed: &Handed,
    tool_name: &str,
    images: ImageOutput,
    attachments: &dyn crate::runs::Attachments,
    artifacts: Option<&dyn ArtifactStore>,
) -> Value {
    json!({ "content": content(handed, tool_name, images, attachments, artifacts).await, "isError": handed.failed })
}

/// Formats mid-turn user messages and task notifications into MCP content blocks so the running ACP agent
/// receives them on its next model step, resolving `AttachmentRef` images, files, and offloaded long pastes
/// through the same path as `runs::prompt_blocks` while capping inline paste expansion at `max_inline_text_bytes`.
pub(crate) async fn steer_blocks(
    steers: &[crate::surface::SteerDelivery],
    capabilities: (bool, bool),
    attachments: &dyn crate::runs::Attachments,
    max_inline_text_bytes: Option<usize>,
) -> (Vec<Value>, crate::runs::LeftOut, Vec<String>) {
    let mut blocks = Vec::new();
    let mut left_out = crate::runs::LeftOut::default();
    let mut attached = Vec::new();
    for steer in steers {
        match &steer.content {
            Content::Text(text) => {
                let text = if steer.task_notification { text.to_string() } else { format!("[User message received while you were working]\n{text}") };
                blocks.push(json!({ "type": "text", "text": text }));
            }
            Content::Parts(parts) => {
                if !steer.task_notification {
                    blocks.push(json!({ "type": "text", "text": "[User message received while you were working]" }));
                }
                let row = json!({ "content": parts.iter().map(mixdog_agent::message_row::part_row).collect::<Vec<_>>() });
                let (mut resolved, left, mut paths) = match max_inline_text_bytes.filter(|b| *b > 0) {
                    Some(limit) => crate::runs::prompt_blocks_with_text_limit(&row, capabilities, attachments, limit).await,
                    None => crate::runs::prompt_blocks(&row, capabilities, attachments).await,
                };
                blocks.append(&mut resolved);
                attached.append(&mut paths);
                if left.images > 0 {
                    blocks.push(json!({
                        "type": "text",
                        "text": format!("[{} image(s) of this message were not passed to the agent]", left.images),
                    }));
                    left_out.images += left.images;
                }
                for file in left.files {
                    blocks.push(json!({
                        "type": "text",
                        "text": format!("[Attached file \"{file}\" was not passed to the agent]"),
                    }));
                    left_out.files.push(file);
                }
            }
        }
    }
    (blocks, left_out, attached)
}

fn blocks_text(blocks: &[Value]) -> String {
    blocks.iter().map(|block| block["text"].as_str().unwrap_or("[an image of the result: `task` read of this task gives it]")).collect::<Vec<_>>().join("\n")
}

/// A finished call's result as the text a background task keeps: [`rendered`]'s text, an image noted where it was.
pub async fn text_of(
    handed: &Handed,
    tool_name: &str,
    images: ImageOutput,
    attachments: &dyn crate::runs::Attachments,
    artifacts: Option<&dyn ArtifactStore>,
) -> String {
    blocks_text(&content(handed, tool_name, images, attachments, artifacts).await)
}

/// A finished call's result as a background task keeps it whole: [`text_of`] as its `content`, and [`rendered`]'s images
/// as `images`, which the session's `task` tool gives with the text.
pub async fn kept_result(
    handed: &Handed,
    tool_name: &str,
    images: ImageOutput,
    attachments: &dyn crate::runs::Attachments,
    artifacts: Option<&dyn ArtifactStore>,
) -> Value {
    let blocks = content(handed, tool_name, images, attachments, artifacts).await;
    let text = blocks_text(&blocks);
    let images: Vec<Value> = blocks.into_iter().filter(|block| block["type"] == "image").collect();
    json!({ "content": text, "images": images })
}

/// The answer to a call of `tool` not over within the time the agent waits for it: Mixdog goes on with it as the
/// session's background task `task`, as it goes on with a command its `shell` tool moved to the background.
pub fn kept(tool: &str, task: &str) -> String {
    format!(
        "background task\ntask_id: {task}\ntool: {tool}\nstatus: running\nThis call has not ended within the time the agent waits for a Mixdog \
call: Mixdog goes on with it and keeps its result, which is delivered to you automatically when it ends. Do not make the call again. To \
read the result sooner, use the Mixdog tool `task` with action `wait` and task_id `{task}`, only if no other work remains."
    )
}

/// The answer to a call the agent makes again while Mixdog still goes on with the same call as background task `task`.
pub fn kept_again(tool: &str, task: &str) -> String {
    format!(
        "The same call of `{tool}` is still running as Mixdog background task `{task}`: it was not run again. Its result is delivered to you \
automatically when it ends; use the Mixdog tool `task` with action `wait` and task_id `{task}` only if no other work remains."
    )
}

fn is_image_mime(mime: &str) -> bool {
    mime.trim().to_ascii_lowercase().starts_with("image/")
}

fn parse_data_image_url(url: &str) -> Option<(Option<String>, &str)> {
    let rest = url.get(..5).filter(|prefix| prefix.eq_ignore_ascii_case("data:")).and_then(|_| url.get(5..))?;
    let (meta, payload) = rest.split_once(',')?;
    if !meta.to_ascii_lowercase().ends_with(";base64") {
        return None;
    }
    let mime = meta.split(';').next().map(str::trim).filter(|m| !m.is_empty());
    match mime {
        Some(m) if !is_image_mime(m) => None,
        other => Some((other.map(str::to_ascii_lowercase), payload)),
    }
}

enum RawImage<'a> {
    Base64 { data: &'a str, mime: &'a str },
    AttachmentRef { reference: &'a str, mime: Option<&'a str> },
    Url(&'a str),
}

struct PreparedImage {
    data: Vec<u8>,
    mime: String,
    note: Option<String>,
}

fn image_note(dims: &mixdog_imaging::Dimensions, recompressed: bool, tool_name: &str) -> Option<String> {
    let dims_changed = dims.original_width != dims.display_width || dims.original_height != dims.display_height;
    let downscaled = dims.display_width < dims.original_width || dims.display_height < dims.original_height;
    let detail_lost = downscaled || recompressed;
    match (dims_changed, detail_lost) {
        (true, true) => Some(format!("{} {}", mixdog_imaging::superseding_image_metadata_text(dims), image_detail_reduced_note(tool_name))),
        (true, false) => Some(mixdog_imaging::superseding_image_metadata_text(dims)),
        (false, true) => Some(format!("[{}]", image_detail_reduced_note(tool_name))),
        (false, false) => None,
    }
}

fn prepare_image_sync(bytes: Vec<u8>, mime_hint: Option<String>, max_raw_bytes: usize, tool_name: String) -> Result<PreparedImage, String> {
    if bytes.is_empty() {
        return Err(IMAGE_OMITTED_UNREADABLE.to_owned());
    }
    let ext = mime_hint.as_deref().and_then(|m| m.split('/').nth(1)).filter(|ext| !ext.is_empty()).unwrap_or("png");
    let Some(resized) =
        mixdog_imaging::resize_image_buffer(&bytes, ext, mixdog_imaging::ResizeOptions::default()).map_err(|_| IMAGE_OMITTED_UNREADABLE.to_owned())?
    else {
        return Err(IMAGE_OMITTED_UNREADABLE.to_owned());
    };
    if resized.branch == mixdog_imaging::Branch::TokenFallback {
        return Err(image_too_large_note(&tool_name));
    }
    // Target Mixdog's native history budget (1568 px display box, <= 256 KiB base64 via the shared q85/70/50 JPEG
    // ladder) because every byte stays in the agent's history; `max_raw_bytes` (up to 3.75 MiB) is the hard ceiling.
    let target_b64 = mixdog_imaging::tool_jpeg::TOOL_IMAGE_TARGET_BASE64_SIZE;
    let fmt = mixdog_imaging::policy::normalize_fmt(resized.mime.split('/').nth(1));
    let reencodable_still = mixdog_imaging::tool_jpeg::TOOL_IMAGE_SOURCE_FORMATS.contains(&fmt.as_str());
    let over_history_target = reencodable_still && mixdog_imaging::policy::base64_len(resized.data.len()) > target_b64;
    if over_history_target || resized.data.len() > max_raw_bytes {
        let fitted = mixdog_imaging::fit_tool_image_jpeg(&bytes, |len| len <= max_raw_bytes && mixdog_imaging::policy::base64_len(len) <= target_b64)
            .map_err(|_| IMAGE_OMITTED_UNREADABLE.to_owned())?;
        if fitted.data.len() <= max_raw_bytes && (fitted.data.len() < resized.data.len() || resized.data.len() > max_raw_bytes) {
            let note = image_note(&fitted.dimensions, true, &tool_name);
            return Ok(PreparedImage { data: fitted.data, mime: "image/jpeg".to_owned(), note });
        }
    }
    if resized.data.len() <= max_raw_bytes {
        let note = image_note(&resized.dimensions, resized.branch == mixdog_imaging::Branch::TokenJpeg, &tool_name);
        return Ok(PreparedImage { data: resized.data, mime: resized.mime, note });
    }
    Err(image_too_large_note(&tool_name))
}

async fn resolve_image_blocks(raw: RawImage<'_>, tool_name: &str, images: ImageOutput, attachments: &dyn crate::runs::Attachments) -> Vec<Value> {
    if !images.supports_images {
        return vec![json!({ "type": "text", "text": IMAGE_OMITTED_UNSUPPORTED })];
    }
    let resolved: Result<(Vec<u8>, Option<String>), &'static str> = match raw {
        RawImage::Base64 { data, mime } => Ok((node_base64_decode(data), Some(mime.to_owned()))),
        RawImage::AttachmentRef { reference, mime } => match attachments.bytes(reference).await {
            Some(bytes) => Ok((bytes, mime.map(str::to_owned))),
            None => Err(IMAGE_OMITTED_UNREADABLE),
        },
        RawImage::Url(url) => match parse_data_image_url(url) {
            Some((mime, payload)) => Ok((node_base64_decode(payload), mime)),
            None if url.get(..5).is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:")) => Err(IMAGE_OMITTED_UNREADABLE),
            None => Err(IMAGE_OMITTED_REMOTE_URL),
        },
    };
    let (bytes, mime_hint) = match resolved {
        Ok(pair) => pair,
        Err(note) => return vec![json!({ "type": "text", "text": note })],
    };
    let default_max = mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE as usize;
    let max_raw_bytes =
        images.max_raw_bytes.and_then(|limit| usize::try_from(limit).ok()).filter(|limit| *limit > 0).map_or(default_max, |limit| limit.min(default_max));
    let tool = tool_name.to_owned();
    let prepared = match images.cpu.submit(&CancellationToken::new(), move |_| prepare_image_sync(bytes, mime_hint, max_raw_bytes, tool)) {
        Ok(job) => job.await.unwrap_or_else(|_| Err(IMAGE_OMITTED_UNREADABLE.to_owned())),
        Err(_) => Err(IMAGE_OMITTED_UNREADABLE.to_owned()),
    };
    match prepared {
        Ok(prepared) => {
            let mut out = Vec::with_capacity(if prepared.note.is_some() { 2 } else { 1 });
            if let Some(note) = prepared.note {
                out.push(json!({ "type": "text", "text": note }));
            }
            out.push(json!({ "type": "image", "mimeType": prepared.mime, "data": STANDARD.encode(&prepared.data) }));
            out
        }
        Err(note) => vec![json!({ "type": "text", "text": note })],
    }
}

fn utf8_floor(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn utf8_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn block_text_bytes(block: &Value) -> usize {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").and_then(Value::as_str).map_or(0, str::len),
        Some("resource") => {
            let res = block.get("resource");
            let text = res.and_then(|r| r.get("text")).and_then(Value::as_str).map_or(0, str::len);
            let uri = res.and_then(|r| r.get("uri")).and_then(Value::as_str).map_or(0, str::len);
            text + uri
        }
        Some("resource_link") => {
            let uri = block.get("uri").and_then(Value::as_str).map_or(0, str::len);
            let name = block.get("name").and_then(Value::as_str).map_or(0, str::len);
            uri + name
        }
        _ => 0,
    }
}

fn total_inline_text_bytes(blocks: &[Value]) -> usize {
    let mut sum = 0usize;
    let mut text_blocks = 0usize;
    for block in blocks {
        let len = block_text_bytes(block);
        if len > 0 {
            sum = sum.saturating_add(len);
            text_blocks += 1;
        }
    }
    sum.saturating_add(text_blocks.saturating_sub(1))
}

fn block_inline_text(block: &Value) -> Option<&str> {
    match block.get("type").and_then(Value::as_str) {
        Some("text") => block.get("text").and_then(Value::as_str),
        Some("resource") => block.get("resource").and_then(|r| r.get("text")).and_then(Value::as_str),
        _ => None,
    }
}

fn resource_file_uri(block: &Value) -> Option<&str> {
    if block.get("type").and_then(Value::as_str) != Some("resource") {
        return None;
    }
    block.get("resource").and_then(|r| r.get("uri")).and_then(Value::as_str).filter(|uri| uri.starts_with("file://"))
}

fn format_file_resource_pointer(uri: &str, text_len: usize, max_bytes: usize) -> String {
    let size_kb = text_len.div_ceil(1024).max(1);
    let max_kb = (max_bytes / 1024).max(1);
    let full = format!(
        "{OFFLOAD_PREFIX} attachment → {uri} ({size_kb} KB)]\n[full text is at {uri}; this agent's inline text limit is {max_kb} KB (default `read` returns up to 50 KB and will be offloaded again). Read it in pages with `read` using `offset` and a small `limit` (e.g. `limit: 200`, or fewer for long lines) so each page stays under {max_kb} KB, or search it with `grep`.]"
    );
    utf8_floor(&full, max_bytes).to_owned()
}

fn format_acp_offload_pointer(artifact: &Artifact, label: &str, text: &str, max_bytes: usize) -> String {
    let size_kb = text.len().div_ceil(1024).max(1);
    let max_kb = (max_bytes / 1024).max(1);
    let path = &artifact.display_path;
    let header = format!("{OFFLOAD_PREFIX} {label} → {path} ({size_kb} KB, {} lines)]", artifact.lines);
    let footer = format!(
        "[full output saved at {path}; this agent's inline text limit is {max_kb} KB (default `read` returns up to 50 KB and will be offloaded again). Read it in pages with `read` using `offset` and a small `limit` (e.g. `limit: 200`, or fewer for long lines) so each page stays under {max_kb} KB, or search it with `grep`.]"
    );
    let sep_overhead = 64usize;
    let preview_budget = 512usize.min(max_bytes.saturating_sub(header.len() + footer.len() + sep_overhead));
    if preview_budget >= 64 {
        let head_budget = (preview_budget * 3) / 5;
        let tail_budget = preview_budget - head_budget;
        let mut head = utf8_floor(text, head_budget);
        if let Some(cut) = head.rfind('\n')
            && cut > (head_budget * 3) / 5
        {
            head = &head[..cut];
        }
        let mut tail = utf8_tail(text, tail_budget);
        if let Some(cut) = tail.find('\n')
            && cut < (tail_budget * 2) / 5
        {
            tail = &tail[cut + 1..];
        }
        let preview = format!("{head}\n... [preview middle omitted] ...\n{tail}");
        let combined = format!("{header}\n\n{preview}\n{footer}");
        if combined.len() <= max_bytes {
            return combined;
        }
    }
    let compact = format!("{header}\n{footer}");
    utf8_floor(&compact, max_bytes).to_owned()
}

async fn offload_large_blocks_in_range(blocks: &mut [Value], range: std::ops::Range<usize>, label: &str, max_bytes: usize, store: Option<&dyn ArtifactStore>) {
    let mut candidates: Vec<(usize, usize)> = range
        .filter_map(|i| {
            let block = &blocks[i];
            let len = block_text_bytes(block);
            let text = block_inline_text(block)?;
            (len >= MIN_OFFLOADABLE_TEXT_BYTES && !text.starts_with(OFFLOAD_PREFIX)).then_some((i, len))
        })
        .collect();
    candidates.sort_by_key(|&(_, len)| std::cmp::Reverse(len));
    for (index, old_len) in candidates {
        if total_inline_text_bytes(blocks) <= max_bytes {
            break;
        }
        if let Some(uri) = resource_file_uri(&blocks[index]).map(str::to_owned) {
            let text_len = block_inline_text(&blocks[index]).map_or(old_len, str::len);
            let pointer = format_file_resource_pointer(&uri, text_len, max_bytes);
            if pointer.len() < old_len {
                blocks[index] = json!({ "type": "text", "text": pointer });
            }
            continue;
        }
        let Some(store) = store else { continue };
        let Some(text) = block_inline_text(&blocks[index]).map(str::to_owned) else { continue };
        if let Some(artifact) = store.persist(&text).await {
            let pointer = format_acp_offload_pointer(&artifact, label, &text, max_bytes);
            if pointer.len() < old_len {
                blocks[index] = json!({ "type": "text", "text": pointer });
            }
        }
    }
}

async fn consolidate_text_range_to_artifact(
    blocks: &mut Vec<Value>,
    start: usize,
    end: usize,
    label: &str,
    max_bytes: usize,
    store: &dyn ArtifactStore,
) -> usize {
    if start >= end {
        return end;
    }
    let mut parts = Vec::new();
    let mut combined_bytes = 0usize;
    let mut first_slot = None;
    let mut text_block_count = 0usize;
    let mut has_non_offloaded = false;
    for (offset, block) in blocks[start..end].iter().enumerate() {
        if let Some(text) = block_inline_text(block) {
            first_slot.get_or_insert(offset);
            text_block_count += 1;
            combined_bytes = combined_bytes.saturating_add(block_text_bytes(block));
            if !text.starts_with(OFFLOAD_PREFIX) {
                has_non_offloaded = true;
            }
            if let Some(uri) = resource_file_uri(block) {
                parts.push(format!("[file: {uri}]\n{text}"));
            } else {
                parts.push(text.to_owned());
            }
        }
    }
    let Some(first_slot) = first_slot else { return end };
    if !has_non_offloaded && text_block_count <= 1 {
        return end;
    }
    let combined = parts.join("\n");
    let Some(artifact) = store.persist(&combined).await else { return end };
    let pointer = format_acp_offload_pointer(&artifact, label, &combined, max_bytes);
    let old_total = combined_bytes.saturating_add(text_block_count.saturating_sub(1));
    if pointer.len() >= old_total {
        return end;
    }
    let mut replacement = Vec::with_capacity(end - start);
    let mut inserted = false;
    for (offset, block) in blocks[start..end].iter().enumerate() {
        if block_inline_text(block).is_some() {
            if offset == first_slot && !inserted {
                replacement.push(json!({ "type": "text", "text": pointer }));
                inserted = true;
            }
        } else {
            replacement.push(block.clone());
        }
    }
    let new_len = replacement.len();
    blocks.splice(start..end, replacement);
    start + new_len
}

fn truncate_blocks_range(blocks: &mut Vec<Value>, start: usize, end: usize, budget: usize, label: &str, max_bytes: usize) -> usize {
    if start >= end {
        return end;
    }
    let range_bytes = total_inline_text_bytes(&blocks[start..end]);
    if range_bytes <= budget {
        return end;
    }
    let link_bytes: usize = blocks[start..end].iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("resource_link")).map(block_text_bytes).sum();
    let link_count = blocks[start..end].iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("resource_link")).count();
    let keep_links = link_bytes.saturating_add(link_count) <= budget / 2;
    let text_budget = if keep_links { budget.saturating_sub(link_bytes).saturating_sub(link_count) } else { budget };

    let mut parts = Vec::new();
    let mut first_slot = None;
    for (offset, block) in blocks[start..end].iter().enumerate() {
        if let Some(text) = block_inline_text(block) {
            first_slot.get_or_insert(offset);
            if let Some(uri) = resource_file_uri(block) {
                parts.push(format!("[file: {uri}]\n{text}"));
            } else {
                parts.push(text.to_owned());
            }
        } else if !keep_links && block.get("type").and_then(Value::as_str) == Some("resource_link") {
            first_slot.get_or_insert(offset);
            let uri = block.get("uri").and_then(Value::as_str).unwrap_or_default();
            let name = block.get("name").and_then(Value::as_str).unwrap_or("attachment");
            parts.push(format!("[file: {name} -> {uri}]"));
        }
    }
    let Some(first_slot) = first_slot else { return end };
    let full_text = parts.join("\n");
    let max_kb = (max_bytes / 1024).max(1);
    let make_suffix = |omitted: usize| {
        format!(
            "\n\n[truncated: {omitted} bytes of `{label}` output omitted — exceeded this agent's {max_kb} KB inline text limit and could not be saved to an artifact file; re-run with a narrower range (e.g. `read` with `offset` and small `limit` under {max_kb} KB, narrower `grep`/`glob`, or redirect `shell` output to a file)]"
        )
    };
    let initial_suffix = make_suffix(full_text.len());
    let truncated_text = if initial_suffix.len() <= text_budget {
        let mut keep = text_budget - initial_suffix.len();
        let mut prefix = utf8_floor(&full_text, keep);
        let mut suffix = make_suffix(full_text.len().saturating_sub(prefix.len()));
        while prefix.len() + suffix.len() > text_budget && !prefix.is_empty() {
            keep = text_budget.saturating_sub(suffix.len());
            prefix = utf8_floor(&full_text, keep);
            suffix = make_suffix(full_text.len().saturating_sub(prefix.len()));
        }
        let combined = format!("{prefix}{suffix}");
        utf8_floor(&combined, text_budget).to_owned()
    } else {
        let short = format!("[truncated: `{label}` output exceeded {max_kb} KB inline limit and could not be saved; use narrower calls]");
        utf8_floor(&short, text_budget).to_owned()
    };

    let mut replacement = Vec::with_capacity(end - start);
    let mut inserted = false;
    for (offset, block) in blocks[start..end].iter().enumerate() {
        let is_consumed = block_inline_text(block).is_some() || (!keep_links && block.get("type").and_then(Value::as_str) == Some("resource_link"));
        if is_consumed {
            if offset == first_slot && !inserted {
                if !truncated_text.is_empty() {
                    replacement.push(json!({ "type": "text", "text": truncated_text }));
                }
                inserted = true;
            }
        } else {
            replacement.push(block.clone());
        }
    }
    let new_len = replacement.len();
    blocks.splice(start..end, replacement);
    start + new_len
}

/// Ensures the total inline text across `blocks` never exceeds `max_bytes` so the ACP server never silently truncates
/// text (or trailing mid-turn user messages). Tool blocks (`0..protected_from`) are offloaded/trimmed before protected
/// trailing blocks (`protected_from..`, e.g. mid-turn steers and advisories). Any result already within `max_bytes`
/// (such as a page read back via `read` with `offset`/`limit`) passes untouched.
async fn enforce_inline_text_budget(blocks: &mut Vec<Value>, tool_name: &str, protected_from: usize, max_bytes: usize, store: Option<&dyn ArtifactStore>) {
    if total_inline_text_bytes(blocks) <= max_bytes {
        return;
    }
    let mut protected_from = protected_from.min(blocks.len());

    // Stage 1: offload individual large blocks (tool output first, then protected steers).
    offload_large_blocks_in_range(blocks, 0..protected_from, tool_name, max_bytes, store).await;
    if total_inline_text_bytes(blocks) <= max_bytes {
        return;
    }
    let len = blocks.len();
    offload_large_blocks_in_range(blocks, protected_from..len, "user-message", max_bytes, store).await;
    if total_inline_text_bytes(blocks) <= max_bytes {
        return;
    }

    // Stage 2: consolidate many small blocks (< MIN_OFFLOADABLE_TEXT_BYTES each) into one artifact file.
    if let Some(store) = store {
        protected_from = consolidate_text_range_to_artifact(blocks, 0, protected_from, tool_name, max_bytes, store).await;
        if total_inline_text_bytes(blocks) <= max_bytes {
            return;
        }
        let len = blocks.len();
        let _ = consolidate_text_range_to_artifact(blocks, protected_from, len, "user-message", max_bytes, store).await;
        if total_inline_text_bytes(blocks) <= max_bytes {
            return;
        }
    }

    // Stage 3: guaranteed hard cap with an explicit truncation notice when no store is available or persist failed.
    let tool_bytes = total_inline_text_bytes(&blocks[..protected_from]);
    let steer_bytes = total_inline_text_bytes(&blocks[protected_from..]);
    let cross_sep = usize::from(tool_bytes > 0 && steer_bytes > 0);
    if tool_bytes > 0 {
        let available_for_tool = max_bytes.saturating_sub(steer_bytes).saturating_sub(cross_sep);
        let tool_budget = if available_for_tool < 256 && max_bytes >= 512 { 256 } else { available_for_tool };
        protected_from = truncate_blocks_range(blocks, 0, protected_from, tool_budget, tool_name, max_bytes);
    }
    if total_inline_text_bytes(blocks) > max_bytes {
        let tool_bytes_after = total_inline_text_bytes(&blocks[..protected_from]);
        let cross_sep = usize::from(tool_bytes_after > 0);
        let steer_budget = max_bytes.saturating_sub(tool_bytes_after).saturating_sub(cross_sep);
        let len = blocks.len();
        let _ = truncate_blocks_range(blocks, protected_from, len, steer_budget, "user-message", max_bytes);
    }
}

/// Applies [`enforce_inline_text_budget`] to a finished MCP `tools/call` reply right before delivery (after any
/// `cliff_advisory` or mid-turn user steers have been appended to `answer["content"]`).
pub(crate) async fn enforce_answer_text_budget(
    answer: &mut Value,
    tool_name: &str,
    protected_from: usize,
    max_bytes: usize,
    store: Option<&dyn ArtifactStore>,
) {
    if let Some(blocks) = answer.get_mut("content").and_then(Value::as_array_mut) {
        enforce_inline_text_budget(blocks, tool_name, protected_from, max_bytes, store).await;
    }
}

async fn content(
    handed: &Handed,
    tool_name: &str,
    images: ImageOutput,
    attachments: &dyn crate::runs::Attachments,
    artifacts: Option<&dyn ArtifactStore>,
) -> Vec<Value> {
    let mut content = Vec::new();
    match &handed.message.message.content {
        Content::Text(text) => content.push(json!({ "type": "text", "text": text.to_string() })),
        Content::Parts(parts) => {
            for part in parts {
                match part {
                    ContentPart::Text(text, _) => content.push(json!({ "type": "text", "text": text })),
                    ContentPart::Image(ImageSource::Base64 { data, mime_type, .. }) => {
                        content.extend(resolve_image_blocks(RawImage::Base64 { data, mime: mime_type }, tool_name, images, attachments).await);
                    }
                    ContentPart::Image(ImageSource::FileId(id)) => {
                        let reference = id.strip_prefix("sha256:").unwrap_or(id.as_str());
                        content.extend(resolve_image_blocks(RawImage::AttachmentRef { reference, mime: None }, tool_name, images, attachments).await);
                    }
                    ContentPart::Image(ImageSource::Url(url)) => {
                        content.extend(resolve_image_blocks(RawImage::Url(url), tool_name, images, attachments).await);
                    }
                    ContentPart::File { source, mime_type, text: None, .. } if is_image_mime(mime_type) => {
                        let raw = match source {
                            BinarySource::AttachmentRef(reference) => RawImage::AttachmentRef { reference, mime: Some(mime_type) },
                            BinarySource::Base64(data) => RawImage::Base64 { data, mime: mime_type },
                        };
                        content.extend(resolve_image_blocks(raw, tool_name, images, attachments).await);
                    }
                    // Non-image stored files and documents have no MCP tool-result form: the agent is told one was kept.
                    _ => content.push(json!({ "type": "text", "text": NON_IMAGE_KEPT_PLACEHOLDER })),
                }
            }
        }
    }
    content.extend(handed.follow_ups.iter().map(|text| json!({ "type": "text", "text": text })));
    if let Some(max_bytes) = images.max_inline_text_bytes.filter(|b| *b > 0) {
        let len = content.len();
        enforce_inline_text_budget(&mut content, tool_name, len, max_bytes, artifacts).await;
    }
    content
}

/// A session's server: where the agent reaches it, and its end.
pub struct ToolServer {
    port: u16,
    token: String,
    stop: CancellationToken,
    /// An MCP client has initialized the server.
    initialized: Arc<AtomicBool>,
    /// Digest of the most recent `tools/list` served to the agent.
    served_digest: Arc<Mutex<Option<String>>>,
    /// Tools excluded by `Rule::Gemini` schema repair on the most recent `tools/list`.
    excluded: Arc<Mutex<Vec<ToolExclusionReport>>>,
}

impl Drop for ToolServer {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

struct Served {
    thread: ThreadId,
    token: String,
    tools: Arc<dyn SessionTools>,
    asks: mpsc::UnboundedSender<ToolAsk>,
    initialized: Arc<AtomicBool>,
    served_digest: Arc<Mutex<Option<String>>>,
    excluded: Arc<Mutex<Vec<ToolExclusionReport>>>,
}

type Reply = Response<Full<Bytes>>;

fn plain(status: StatusCode) -> Reply {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
}

/// A refusal is sent once the request's body has been read, and dropped, as an accepted request's is. A connection
/// that closes with request bytes unread is reset, and a reset that reaches the client before it reads takes the
/// refusal with it (RFC 9112 §9.6); a body written after its head can arrive after the refusal was sent.
async fn refused(mut body: Body, status: StatusCode) -> Reply {
    while let Some(Ok(_)) = body.frame().await {}
    plain(status)
}

fn answered(message: Value) -> Reply {
    let mut response = Response::new(Full::new(Bytes::from(message.to_string())));
    response.headers_mut().insert(header::CONTENT_TYPE, header::HeaderValue::from_static("application/json"));
    response
}

impl ToolServer {
    /// Starts the server of `thread`'s session; the calls the agent makes arrive on the returned channel, which the
    /// session's routing reads. The server ends when this value is dropped.
    pub async fn start(thread: ThreadId, tools: Arc<dyn SessionTools>) -> std::io::Result<(Self, mpsc::UnboundedReceiver<ToolAsk>)> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        // 244 random bits: the one thing that tells the session's agent, in this session, from every other program on
        // this machine and every other session of a shared agent.
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let stop = CancellationToken::new();
        let (asks, calls) = mpsc::unbounded_channel();
        let initialized: Arc<AtomicBool> = Arc::default();
        let served_digest: Arc<Mutex<Option<String>>> = Arc::default();
        let excluded: Arc<Mutex<Vec<ToolExclusionReport>>> = Arc::default();
        let served = Arc::new(Served {
            thread,
            token: token.clone(),
            tools,
            asks,
            initialized: initialized.clone(),
            served_digest: served_digest.clone(),
            excluded: excluded.clone(),
        });
        let stopped = stop.clone();
        drop(mixdog_rt::spawn("acp.mcp", TaskClass::Work, async move {
            loop {
                let stream = tokio::select! {
                    () = stopped.cancelled() => return,
                    accepted = listener.accept() => match accepted {
                        Ok((stream, _)) => stream,
                        Err(_) => continue,
                    },
                };
                let (served, stopped) = (served.clone(), stopped.clone());
                drop(mixdog_rt::spawn("acp.mcp.conn", TaskClass::Work, async move {
                    let service = service_fn(move |request| {
                        let served = served.clone();
                        async move { Ok::<_, Infallible>(served.handle(request).await) }
                    });
                    let connection = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(stream), service);
                    tokio::select! {
                        () = stopped.cancelled() => {}
                        _ = connection => {}
                    }
                }));
            }
        }));
        Ok((Self { port, token, stop, initialized, served_digest, excluded }, calls))
    }

    /// Set once the agent's MCP client has initialized the server: it took the session's tools.
    pub fn initialized(&self) -> Arc<AtomicBool> {
        self.initialized.clone()
    }

    /// Shared cell holding the digest of the last `tools/list` served to the agent.
    pub fn served_digest(&self) -> Arc<Mutex<Option<String>>> {
        self.served_digest.clone()
    }

    /// Shared cell holding any tools excluded during `Rule::Gemini` schema repair on `tools/list`.
    pub fn excluded(&self) -> Arc<Mutex<Vec<ToolExclusionReport>>> {
        self.excluded.clone()
    }

    /// The server's entry of `mcpServers` in a `session/new` or a reopen: the listener itself for an agent that
    /// takes an HTTP server (`http`), else `bridge`, the program the agent starts as the server's stdio end. `None`
    /// where the agent can be given neither.
    pub fn entry(&self, http: bool, bridge: Option<&Command>) -> Option<Value> {
        if http {
            return Some(json!({
                "type": "http",
                "name": SERVER_NAME,
                "url": format!("http://127.0.0.1:{}/mcp", self.port),
                "headers": [{ "name": "Authorization", "value": format!("Bearer {}", self.token) }],
            }));
        }
        bridge.map(|bridge| {
            json!({
                "name": SERVER_NAME,
                "command": bridge.program,
                "args": bridge.args,
                "env": [
                    { "name": crate::mcp_bridge::PORT_ENV, "value": self.port.to_string() },
                    { "name": crate::mcp_bridge::TOKEN_ENV, "value": self.token },
                ],
            })
        })
    }
}

impl Served {
    async fn handle(self: &Arc<Self>, request: Request<Body>) -> Reply {
        let bearer = request.headers().get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()).and_then(|value| value.strip_prefix("Bearer "));
        // A page in a browser can reach a loopback port; it cannot leave out its `Origin`, and the agent sends none.
        let refusal = if bearer != Some(self.token.as_str()) || request.headers().contains_key(header::ORIGIN) {
            Some(StatusCode::UNAUTHORIZED)
        } else if request.uri().path() != "/mcp" {
            Some(StatusCode::NOT_FOUND)
        } else if request.method() != Method::POST {
            // The server sends nothing of its own, so it offers no stream to listen on.
            Some(StatusCode::METHOD_NOT_ALLOWED)
        } else {
            None
        };
        if let Some(status) = refusal {
            return refused(request.into_body(), status).await;
        }
        let Ok(body) = request.into_body().collect().await else { return plain(StatusCode::BAD_REQUEST) };
        let Ok(message) = serde_json::from_slice::<Value>(&body.to_bytes()) else {
            return answered(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "the body is not JSON" } }));
        };
        match message {
            Value::Array(batch) => {
                let mut tasks = tokio::task::JoinSet::new();
                for (index, message) in batch.into_iter().enumerate() {
                    let served = self.clone();
                    tasks.spawn(async move { (index, served.message(&message).await) });
                }
                let mut ordered: Vec<(usize, Value)> = Vec::new();
                while let Some(joined) = tasks.join_next().await {
                    if let Ok((index, Some(answer))) = joined {
                        ordered.push((index, answer));
                    }
                }
                ordered.sort_by_key(|(index, _)| *index);
                let answers: Vec<Value> = ordered.into_iter().map(|(_, answer)| answer).collect();
                if answers.is_empty() { plain(StatusCode::ACCEPTED) } else { answered(Value::Array(answers)) }
            }
            message => match self.message(&message).await {
                Some(answer) => answered(answer),
                None => plain(StatusCode::ACCEPTED),
            },
        }
    }

    /// The answer to one message; a notification and a response have none.
    async fn message(&self, message: &Value) -> Option<Value> {
        let id = message.get("id").filter(|id| !id.is_null())?.clone();
        let method = message.get("method").and_then(Value::as_str)?;
        let params = message.get("params").unwrap_or(&Value::Null);
        let result = match method {
            "initialize" => {
                self.initialized.store(true, Ordering::SeqCst);
                let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
                let version = PROTOCOL_VERSIONS.iter().find(|version| **version == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": SERVER_NAME, "title": "Mixdog", "version": env!("CARGO_PKG_VERSION") },
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => self.tools.definitions(&self.thread).await.map(|definitions| {
                let (tools, excluded) = repair_tools_for_gemini(definitions);
                let digest = tools_digest(&tools);
                *self.served_digest.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(digest);
                let mut prev = self.excluded.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                if !same_exclusions(&prev, &excluded) {
                    for report in &excluded {
                        tracing::warn!(tool = %report.name, pointer = %report.pointer, reason = %report.reason, "[acp.mcp] excluded tool with invalid Gemini schema");
                    }
                    *prev = excluded;
                }
                json!({ "tools": tools })
            }),
            "tools/call" => {
                let raw_name = params.get("name").and_then(Value::as_str).unwrap_or_default();
                let prefix = format!("mcp_{SERVER_NAME}_");
                let name = raw_name.strip_prefix(&prefix).unwrap_or(raw_name).to_owned();
                let arguments = params.get("arguments").cloned().filter(|arguments| !arguments.is_null()).unwrap_or_else(|| json!({}));
                let (answer, answered) = oneshot::channel();
                // A session whose agent is gone answers nobody; the call's sender then drops.
                let _ = self.asks.send(ToolAsk { name, arguments, received: tokio::time::Instant::now(), answer });
                Ok(answered.await.unwrap_or_else(|_| result_text("The session's agent has ended.".to_owned(), true)))
            }
            other => {
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("{other} is not offered by this server") } }));
            }
        };
        Some(match result {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": message } }),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every agent handed the session's tools is told to prefer them over its built-in ones, to give a tool that takes an
    /// array all of a step's items in one call, and to get a cut result's part with narrower calls.
    #[test]
    fn an_agent_is_told_to_prefer_mixdog_tools_and_to_give_a_steps_items_to_one_array_call() {
        let told = preference();
        assert!(told.starts_with(PREFERENCE), "{told}");
        assert!(told.contains("give it all the items the step needs in one call instead of one call per item"), "{told}");
        assert!(told.contains("queries for `web_search`"), "{told}");
        assert!(told.contains("get the part you need with narrower calls"), "{told}");
    }

    #[test]
    fn gemini_schema_repair_lowers_legacy_draft_and_excludes_broken_tools() {
        let legacy = ToolDefinition {
            name: "read".into(),
            description: "reads".into(),
            input_schema: json!({
                "$schema": "http://json-schema.org/draft-07/schema#",
                "type": "object",
                "definitions": { "line": { "type": "integer", "exclusiveMinimum": true, "minimum": 0 } },
                "properties": { "offset": { "$ref": "#/definitions/line" } }
            }),
            defer_loading: false,
            freeform: None,
        };
        let broken = ToolDefinition {
            name: "bad".into(),
            description: "broken".into(),
            input_schema: json!("not-an-object-schema"),
            defer_loading: false,
            freeform: None,
        };
        let (repaired, excluded) = repair_tools_for_gemini(vec![legacy, broken]);
        assert_eq!(repaired.len(), 1);
        assert_eq!(repaired[0]["name"], "read");
        assert!(repaired[0]["inputSchema"].get("$defs").is_some(), "{:?}", repaired[0]["inputSchema"]);
        assert_eq!(excluded.len(), 1);
        assert_eq!(excluded[0].name, "bad");
        assert_ne!(tools_digest(&repaired), tools_digest(&[]));

        // Equivalent tool listings with different tool ordering AND different nested JSON schema key ordering must hash identically.
        let mut props_a = serde_json::Map::new();
        props_a.insert("alpha".into(), json!({ "type": "string", "description": "a" }));
        props_a.insert("beta".into(), json!({ "description": "b", "type": "integer" }));
        let mut schema_a = serde_json::Map::new();
        schema_a.insert("type".into(), json!("object"));
        schema_a.insert("properties".into(), Value::Object(props_a));

        let mut props_b = serde_json::Map::new();
        props_b.insert("beta".into(), json!({ "type": "integer", "description": "b" }));
        props_b.insert("alpha".into(), json!({ "description": "a", "type": "string" }));
        let mut schema_b = serde_json::Map::new();
        schema_b.insert("properties".into(), Value::Object(props_b));
        schema_b.insert("type".into(), json!("object"));

        let list_one = vec![
            ToolDefinition { name: "first".into(), description: "one".into(), input_schema: Value::Object(schema_a), defer_loading: false, freeform: None },
            ToolDefinition {
                name: "second".into(),
                description: "two".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
                defer_loading: false,
                freeform: None,
            },
        ];
        let list_two = vec![
            ToolDefinition {
                name: "second".into(),
                description: "two".into(),
                input_schema: json!({ "properties": {}, "type": "object" }),
                defer_loading: false,
                freeform: None,
            },
            ToolDefinition { name: "first".into(), description: "one".into(), input_schema: Value::Object(schema_b), defer_loading: false, freeform: None },
        ];
        let (repaired_one, _) = repair_tools_for_gemini(list_one);
        let (repaired_two, _) = repair_tools_for_gemini(list_two);
        assert_eq!(
            tools_digest(&repaired_one),
            tools_digest(&repaired_two),
            "tools_digest must be invariant to tool ordering and nested JSON schema key ordering"
        );
    }

    #[test]
    fn same_exclusions_ignores_tool_order_and_input_index() {
        let valid = ToolDefinition {
            name: "ok".into(),
            description: "ok".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
            defer_loading: false,
            freeform: None,
        };
        let bad_a =
            ToolDefinition { name: "bad_a".into(), description: "a".into(), input_schema: json!("not-an-object"), defer_loading: false, freeform: None };
        let bad_b = ToolDefinition { name: "bad_b".into(), description: "b".into(), input_schema: json!(42), defer_loading: false, freeform: None };
        let (_, excluded_one) = repair_tools_for_gemini(vec![bad_a.clone(), valid.clone(), bad_b.clone()]);
        let (_, excluded_two) = repair_tools_for_gemini(vec![valid, bad_b.clone(), bad_a]);
        assert_ne!(excluded_one, excluded_two);
        assert!(same_exclusions(&excluded_one, &excluded_two));
        assert!(!same_exclusions(&excluded_one, &excluded_two[..1]));

        let bad_c =
            ToolDefinition { name: "bad_c".into(), description: "c".into(), input_schema: json!("not-an-object"), defer_loading: false, freeform: None };
        let (_, excluded_other) = repair_tools_for_gemini(vec![bad_b, bad_c]);
        assert!(!same_exclusions(&excluded_one, &excluded_other));
    }

    struct MemoryAttachments(std::collections::HashMap<String, Vec<u8>>);

    #[async_trait]
    impl crate::runs::Attachments for MemoryAttachments {
        async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
            self.0.get(reference).cloned()
        }
    }

    fn synthetic_raster(width: u32, height: u32, noise_mask: u8) -> mixdog_imaging::Raster {
        let mut data = Vec::with_capacity((width * height * 3) as usize);
        let mut state = 0x1234_5678u32;
        for y in 0..height {
            for x in 0..width {
                let n = if noise_mask != 0 {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    ((state >> 24) as u8) & noise_mask
                } else {
                    0
                };
                data.extend_from_slice(&[
                    ((x * 255 / width.max(1)) as u8).wrapping_add(n),
                    ((y * 255 / height.max(1)) as u8).wrapping_add(n.rotate_left(3)),
                    64u8.wrapping_add(n.rotate_left(5)),
                ]);
            }
        }
        mixdog_imaging::Raster { width, height, has_alpha: false, data }
    }

    fn synthetic_png(width: u32, height: u32, noise_mask: u8) -> Vec<u8> {
        mixdog_imaging::encode::encode_in_format(&synthetic_raster(width, height, noise_mask), mixdog_imaging::Format::Png).expect("encode png")
    }

    fn handed_parts(parts: Vec<ContentPart>) -> Handed {
        Handed { message: AgentMessage::tool_result("call-1", Content::Parts(parts), ToolKind::Normal), follow_ups: Vec::new(), failed: false }
    }

    #[tokio::test]
    async fn screenshot_reaches_image_capable_agent_at_profile_display_box_with_detail_note() {
        let screenshot = synthetic_png(1920, 1080, 7);
        assert!(
            mixdog_imaging::policy::base64_len(screenshot.len()) > mixdog_imaging::tool_jpeg::TOOL_IMAGE_TARGET_BASE64_SIZE,
            "fixture PNG must exceed native history target so JPEG ladder engages: {}",
            screenshot.len()
        );
        let reference = "a".repeat(64);
        let attachments = MemoryAttachments(std::iter::once((reference.clone(), screenshot)).collect());
        let handed = handed_parts(vec![
            ContentPart::Text("[Image: source: screen.png, 1920x1080, displayed at 1920x1080]".into(), None),
            ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: "image/png".into(), filename: None, text: None },
        ]);

        let limit = mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE;
        let out = rendered(
            &handed,
            "computer",
            ImageOutput { supports_images: true, max_raw_bytes: Some(limit), max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive },
            &attachments,
            None,
        )
        .await;
        let blocks = out["content"].as_array().expect("content array");
        assert!(
            blocks.iter().all(|b| b["text"].as_str() != Some(NON_IMAGE_KEPT_PLACEHOLDER)),
            "file-backed image must not become kept placeholder: {blocks:?}"
        );
        let image = blocks.iter().find(|b| b["type"] == "image").expect("image block");
        assert_eq!(image["mimeType"], "image/jpeg", "oversized PNG screenshot should target native JPEG history budget");
        let b64 = image["data"].as_str().expect("base64");
        assert!(
            b64.len() <= mixdog_imaging::tool_jpeg::TOOL_IMAGE_TARGET_BASE64_SIZE,
            "screenshot should fit native history target (<= 256 KiB b64), got {}",
            b64.len()
        );
        let decoded = STANDARD.decode(b64).expect("valid base64");
        assert!(decoded.len() <= limit as usize, "got {}", decoded.len());
        let parsed = mixdog_imaging::decode(&decoded, mixdog_imaging::DECODE_PIXEL_LIMIT).expect("valid scaled image");
        assert_eq!((parsed.width, parsed.height), (1456, 819), "1920x1080 screenshot should arrive at the model profile display box");
        let note = blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .find(|t| t.contains("supersede"))
            .expect("resized image should carry superseding display dimensions");
        assert!(note.contains("mode=\"zoom\""), "computer tool note should name capture zoom: {note}");
        assert!(!note.contains("cropped read"), "must never advise non-existent cropped read: {note}");

        // Browser and read tools name recovery actions that exist for each tool.
        let browser = rendered(
            &handed,
            "browser",
            ImageOutput { supports_images: true, max_raw_bytes: None, max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive },
            &attachments,
            None,
        )
        .await;
        let browser_note = browser["content"]
            .as_array()
            .expect("blocks")
            .iter()
            .filter_map(|b| b["text"].as_str())
            .find(|t| t.contains("supersede"))
            .expect("browser superseding note");
        assert!(browser_note.contains("mode=\"visual\""), "{browser_note}");
        assert!(!browser_note.contains("cropped read"), "{browser_note}");

        let read_out = rendered(
            &handed,
            "read",
            ImageOutput { supports_images: true, max_raw_bytes: None, max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive },
            &attachments,
            None,
        )
        .await;
        let read_note = read_out["content"]
            .as_array()
            .expect("blocks")
            .iter()
            .filter_map(|b| b["text"].as_str())
            .find(|t| t.contains("supersede"))
            .expect("read superseding note");
        assert!(read_note.contains("separate image file"), "{read_note}");
        assert!(!read_note.contains("cropped read"), "{read_note}");
    }

    #[tokio::test]
    async fn tighter_agent_limit_uses_shared_jpeg_ladder_and_omits_when_still_too_large() {
        // Low-amplitude noise keeps the PNG large while JPEG at the same display box stays compact.
        let png = synthetic_png(1200, 800, 7);
        let tight_limit = 300_000_u64;
        assert!(png.len() > tight_limit as usize, "fixture PNG must exceed tight_limit: {}", png.len());
        let reference = "e".repeat(64);
        let attachments = MemoryAttachments(std::iter::once((reference.clone(), png)).collect());
        let handed =
            handed_parts(vec![ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: "image/png".into(), filename: None, text: None }]);

        let bounded = rendered(
            &handed,
            "computer",
            ImageOutput {
                supports_images: true,
                max_raw_bytes: Some(tight_limit),
                max_inline_text_bytes: None,
                cpu: mixdog_rt::testing::tokens().cpu_interactive,
            },
            &attachments,
            None,
        )
        .await;
        let blocks = bounded["content"].as_array().expect("content array");
        let image = blocks.iter().find(|b| b["type"] == "image").expect("JPEG-fitted image block");
        assert_eq!(image["mimeType"], "image/jpeg");
        let decoded = STANDARD.decode(image["data"].as_str().expect("base64")).expect("valid base64");
        assert!(decoded.len() <= tight_limit as usize, "got {}", decoded.len());
        let parsed = mixdog_imaging::decode(&decoded, mixdog_imaging::DECODE_PIXEL_LIMIT).expect("valid JPEG");
        assert_eq!((parsed.width, parsed.height), (1200, 800), "must not shrink pixels below display box");
        assert!(
            blocks.iter().any(|b| b["text"].as_str().is_some_and(|t| t.contains("mode=\"zoom\""))),
            "recompressed image should note detail loss with tool-specific recovery: {blocks:?}"
        );

        // When even the display-box q50 JPEG cannot fit, omit with tool-specific guidance rather than shrinking past usefulness.
        let impossible = rendered(
            &handed,
            "computer",
            ImageOutput { supports_images: true, max_raw_bytes: Some(2_000), max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive },
            &attachments,
            None,
        )
        .await;
        let blocks = impossible["content"].as_array().expect("content array");
        assert!(blocks.iter().all(|b| b["type"] == "text"), "must not emit unusable tiny image: {blocks:?}");
        assert_eq!(blocks[0]["text"], image_too_large_note("computer"));
    }

    #[tokio::test]
    async fn undecodable_corrupt_mislabelled_and_empty_blobs_never_become_image_blocks() {
        let valid_png = synthetic_png(200, 200, 0);
        let truncated_png = valid_png[..32].to_vec();
        let small_ref = "1".repeat(64);
        let pdf_ref = "2".repeat(64);
        let large_corrupt_ref = "3".repeat(64);
        let missing_ref = "4".repeat(64);
        let mut map = std::collections::HashMap::new();
        map.insert(small_ref.clone(), b"not an image".to_vec());
        map.insert(pdf_ref.clone(), b"%PDF-1.4\nnot-a-png".to_vec());
        map.insert(large_corrupt_ref.clone(), vec![0xAB; 200_000]);
        let attachments = MemoryAttachments(map);

        let handed = handed_parts(vec![
            ContentPart::File { source: BinarySource::Base64(String::new()), mime_type: "image/png".into(), filename: None, text: None },
            ContentPart::File { source: BinarySource::AttachmentRef(small_ref), mime_type: "image/png".into(), filename: None, text: None },
            ContentPart::Image(ImageSource::Base64 { data: STANDARD.encode(&truncated_png), mime_type: "image/png".into(), width: None, height: None }),
            ContentPart::Image(ImageSource::FileId(format!("sha256:{pdf_ref}"))),
            ContentPart::File { source: BinarySource::AttachmentRef(large_corrupt_ref), mime_type: "image/png".into(), filename: None, text: None },
            ContentPart::Image(ImageSource::Url("data:text/plain;base64,aGVsbG8=".into())),
            ContentPart::File { source: BinarySource::AttachmentRef(missing_ref), mime_type: "image/png".into(), filename: None, text: None },
        ]);

        let out = rendered(
            &handed,
            "read",
            ImageOutput { supports_images: true, max_raw_bytes: Some(100_000), max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive },
            &attachments,
            None,
        )
        .await;
        let blocks = out["content"].as_array().expect("content array");
        assert!(blocks.iter().all(|b| b["type"] == "text"), "undecodable bytes must never reach the agent as image blocks: {blocks:?}");
        let texts: Vec<_> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
        assert_eq!(texts, vec![IMAGE_OMITTED_UNREADABLE; 7], "every corrupt/empty/over-limit-undecodable blob must say unreadable: {texts:?}");
    }

    #[tokio::test]
    async fn lenient_base64_blob_file_and_data_url_images_pass_while_non_images_keep_placeholder() {
        let small_png = synthetic_png(200, 200, 0);
        let small_jpeg = mixdog_imaging::encode::encode_jpeg(&synthetic_raster(200, 200, 0), 85, 255);
        let hex = "b".repeat(64);
        let attachments = MemoryAttachments(std::iter::once((hex.clone(), small_jpeg)).collect());
        // Wrap with CRLF, strip padding, and switch to URL-safe alphabet like Mixdog's node_base64 accepts.
        let lenient_b64: String = STANDARD
            .encode(&small_png)
            .trim_end_matches('=')
            .replace('+', "-")
            .replace('/', "_")
            .as_bytes()
            .chunks(20)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect::<Vec<_>>()
            .join("\r\n");
        let data_url = format!("data:image/png;base64,{lenient_b64}");
        let handed = handed_parts(vec![
            ContentPart::Image(ImageSource::FileId(format!("sha256:{hex}"))),
            ContentPart::Image(ImageSource::Url(data_url)),
            ContentPart::Image(ImageSource::Base64 { data: lenient_b64, mime_type: "image/png".into(), width: Some(200), height: Some(200) }),
            ContentPart::Image(ImageSource::Url("https://example.com/pic.png".into())),
            ContentPart::File { source: BinarySource::AttachmentRef(hex), mime_type: "application/pdf".into(), filename: Some("doc.pdf".into()), text: None },
        ]);

        let out = rendered(
            &handed,
            "read",
            ImageOutput {
                supports_images: true,
                max_raw_bytes: Some(mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE),
                max_inline_text_bytes: None,
                cpu: mixdog_rt::testing::tokens().cpu_interactive,
            },
            &attachments,
            None,
        )
        .await;
        let blocks = out["content"].as_array().expect("content array");
        let images: Vec<_> = blocks.iter().filter(|b| b["type"] == "image").collect();
        assert_eq!(images.len(), 3, "all three image forms must become MCP image blocks: {blocks:?}");
        assert_eq!(images[0]["mimeType"], "image/jpeg", "unknown-MIME FileId must use the decoded format, not guessed image/png");
        assert_eq!(images[1]["mimeType"], "image/png");
        assert_eq!(images[2]["mimeType"], "image/png");
        assert!(blocks.iter().any(|b| b["text"].as_str() == Some(IMAGE_OMITTED_REMOTE_URL)), "{blocks:?}");
        assert!(blocks.iter().any(|b| b["text"].as_str() == Some(NON_IMAGE_KEPT_PLACEHOLDER)), "non-image PDF file keeps the kept placeholder: {blocks:?}");
    }

    #[tokio::test]
    async fn file_backed_image_on_agent_without_image_input_gets_clear_text_line() {
        let small_png = synthetic_png(200, 200, 0);
        let reference = "c".repeat(64);
        let attachments = MemoryAttachments(std::iter::once((reference.clone(), small_png.clone())).collect());
        let handed = handed_parts(vec![
            ContentPart::Text("[Image: source: shot.png, 200x200, displayed at 200x200]".into(), None),
            ContentPart::File { source: BinarySource::AttachmentRef(reference), mime_type: "image/png".into(), filename: None, text: None },
            ContentPart::Image(ImageSource::Base64 { data: STANDARD.encode(&small_png), mime_type: "image/png".into(), width: Some(200), height: Some(200) }),
        ]);

        let limit = mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE;
        let output =
            ImageOutput { supports_images: false, max_raw_bytes: Some(limit), max_inline_text_bytes: None, cpu: mixdog_rt::testing::tokens().cpu_interactive };
        let out = rendered(&handed, "read", output, &attachments, None).await;
        let blocks = out["content"].as_array().expect("content array");
        assert!(blocks.iter().all(|b| b["type"] == "text"), "no image blocks for text-only agent: {blocks:?}");
        let texts: Vec<_> = blocks.iter().filter_map(|b| b["text"].as_str()).collect();
        assert_eq!(texts, vec!["[Image: source: shot.png, 200x200, displayed at 200x200]", IMAGE_OMITTED_UNSUPPORTED, IMAGE_OMITTED_UNSUPPORTED]);

        let kept = kept_result(&handed, "read", output, &attachments, None).await;
        assert_eq!(kept["images"], json!([]));
        assert!(kept["content"].as_str().unwrap_or_default().contains(IMAGE_OMITTED_UNSUPPORTED));
    }

    struct MemoryArtifactStore(Mutex<Vec<(String, String)>>);

    #[async_trait]
    impl ArtifactStore for MemoryArtifactStore {
        async fn persist(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
            let mut entries = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let index = entries.len() + 1;
            let path = format!("C:/tmp/artifacts/artifact-{index}.txt");
            entries.push((path.clone(), content.to_owned()));
            Some(mixdog_agent::offload::Artifact { display_path: path.clone(), path, lines: content.lines().count(), sha256: format!("{index:064x}") })
        }

        async fn preview(&self, content: &str) -> Option<mixdog_agent::offload::Artifact> {
            let path = "C:/tmp/artifacts/preview.txt".to_owned();
            Some(mixdog_agent::offload::Artifact { display_path: path.clone(), path, lines: content.lines().count(), sha256: "0".repeat(64) })
        }
    }

    struct FailingArtifactStore;

    #[async_trait]
    impl ArtifactStore for FailingArtifactStore {
        async fn persist(&self, _content: &str) -> Option<mixdog_agent::offload::Artifact> {
            None
        }

        async fn preview(&self, _content: &str) -> Option<mixdog_agent::offload::Artifact> {
            None
        }
    }

    struct StoredAttachments {
        bytes: std::collections::HashMap<String, Vec<u8>>,
        paths: std::collections::HashMap<String, String>,
    }

    #[async_trait]
    impl crate::runs::Attachments for StoredAttachments {
        async fn bytes(&self, reference: &str) -> Option<Vec<u8>> {
            self.bytes.get(reference).cloned()
        }

        fn path(&self, reference: &str) -> Option<String> {
            self.paths.get(reference).cloned()
        }
    }

    #[tokio::test]
    async fn large_inline_text_result_is_offloaded_to_artifact_file_below_agent_truncation_limit() {
        let store = MemoryArtifactStore(Mutex::default());
        let limit = 44 * 1024;
        // 48 KiB sits between ACP's 44 KiB inline limit and `read`'s 50 KiB default output cap.
        let big_text: String = (1..=650).map(|i| format!("LINE_{i:04}: payload payload payload payload payload payload payload payload\n")).collect();
        assert!(big_text.len() > limit && big_text.len() < 50 * 1024, "fixture must be 45-50 KiB: {}", big_text.len());
        let handed = Handed { message: AgentMessage::tool_text("call-big", big_text.clone(), ToolKind::Normal), follow_ups: Vec::new(), failed: false };

        // Even for `read` (exempt from offload.rs's default tool caps), ACP offloads above the agent's safe inline ceiling.
        let out = rendered(
            &handed,
            "read",
            ImageOutput {
                supports_images: true,
                max_raw_bytes: Some(mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE),
                max_inline_text_bytes: Some(limit),
                cpu: mixdog_rt::testing::tokens().cpu_interactive,
            },
            &crate::runs::NoAttachments,
            Some(&store),
        )
        .await;
        let text = out["content"][0]["text"].as_str().expect("offloaded pointer text");
        assert!(text.len() <= limit, "inline pointer must stay within 44 KiB: {}", text.len());
        assert!(text.starts_with(OFFLOAD_PREFIX), "expected offload pointer: {text}");
        assert!(text.contains("C:/tmp/artifacts/artifact-1.txt"), "pointer must name saved file path: {text}");
        assert!(text.contains("offset") && text.contains("limit") && text.contains("44 KB"), "pointer must explain how to page-read it back: {text}");
        let saved = store.0.lock().unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].1, big_text, "full text must be preserved verbatim in the artifact file");
        drop(saved);

        // Reading back a page that fits within 44 KiB is never offloaded again.
        let page: String = big_text.lines().take(200).collect::<Vec<_>>().join("\n");
        assert!(page.len() < limit, "page must fit under 44 KiB: {}", page.len());
        let page_handed = Handed { message: AgentMessage::tool_text("call-page", page.clone(), ToolKind::Normal), follow_ups: Vec::new(), failed: false };
        let page_out = rendered(
            &page_handed,
            "read",
            ImageOutput {
                supports_images: true,
                max_raw_bytes: Some(mixdog_imaging::policy::IMAGE_TARGET_RAW_SIZE),
                max_inline_text_bytes: Some(limit),
                cpu: mixdog_rt::testing::tokens().cpu_interactive,
            },
            &crate::runs::NoAttachments,
            Some(&store),
        )
        .await;
        assert_eq!(page_out["content"][0]["text"].as_str(), Some(page.as_str()), "a page that fits must pass inline untouched");
        assert_eq!(store.0.lock().unwrap().len(), 1, "fitting page must not create a new artifact");
    }

    #[tokio::test]
    async fn many_small_blocks_and_failed_persist_never_leave_text_over_inline_limit() {
        let limit = 44 * 1024;
        // 40 blocks of 1,500 bytes each = 60 KB, every block individually under MIN_OFFLOADABLE_TEXT_BYTES (2,000 B).
        let parts: Vec<ContentPart> = (0..40).map(|i| ContentPart::Text(format!("block-{i:02}: {}", "x".repeat(1_490)), None)).collect();
        let handed = handed_parts(parts);
        let output =
            ImageOutput { supports_images: true, max_raw_bytes: None, max_inline_text_bytes: Some(limit), cpu: mixdog_rt::testing::tokens().cpu_interactive };

        // With a working store, small blocks consolidate into one saved artifact file with a clear page-read pointer.
        let store = MemoryArtifactStore(Mutex::default());
        let consolidated = rendered(&handed, "grep", output, &crate::runs::NoAttachments, Some(&store)).await;
        let blocks = consolidated["content"].as_array().expect("content array");
        assert!(total_inline_text_bytes(blocks) <= limit, "total bytes must fit: {}", total_inline_text_bytes(blocks));
        let pointer = blocks[0]["text"].as_str().expect("consolidated pointer");
        assert!(pointer.starts_with(OFFLOAD_PREFIX), "{pointer}");
        assert!(pointer.contains("C:/tmp/artifacts/artifact-1.txt"), "{pointer}");
        assert_eq!(store.0.lock().unwrap().len(), 1);

        // When `store.persist` fails (or no store exists), text is still capped within `limit` with an explicit notice.
        for store_opt in [Some(&FailingArtifactStore as &dyn ArtifactStore), None] {
            let truncated = rendered(&handed, "grep", output, &crate::runs::NoAttachments, store_opt).await;
            let blocks = truncated["content"].as_array().expect("content array");
            assert!(total_inline_text_bytes(blocks) <= limit, "fallback must never exceed inline limit: {}", total_inline_text_bytes(blocks));
            let text = blocks[0]["text"].as_str().expect("truncated text");
            assert!(text.contains("[truncated:") && text.contains("could not be saved"), "must tell agent text was cut: {text}");
        }
    }

    #[tokio::test]
    async fn delivered_answer_with_steers_and_offloaded_paste_stays_within_inline_limit() {
        let limit = 44 * 1024;
        let store = MemoryArtifactStore(Mutex::default());

        // 1. A 35 KiB tool result + 15 KiB mid-turn user message totals 50 KiB: tool output offloads first so the user's message survives intact.
        let tool_text = "T".repeat(35 * 1024);
        let user_msg = format!("[User message received while you were working]\n{}", "U".repeat(15 * 1024));
        let mut answer = json!({
            "content": [
                { "type": "text", "text": tool_text },
                { "type": "text", "text": user_msg },
            ],
            "isError": false,
        });
        enforce_answer_text_budget(&mut answer, "read", 1, limit, Some(&store)).await;
        let blocks = answer["content"].as_array().expect("content array");
        assert!(total_inline_text_bytes(blocks) <= limit, "combined answer must fit under 44 KiB: {}", total_inline_text_bytes(blocks));
        assert!(blocks[0]["text"].as_str().is_some_and(|t| t.starts_with(OFFLOAD_PREFIX)), "tool block should offload first: {:?}", blocks[0]);
        assert_eq!(blocks[1]["text"].as_str(), Some(user_msg.as_str()), "mid-turn user message must survive intact");

        // 2. An offloaded 80 KiB user paste in `steer_blocks` must not expand inline past `max_inline_text_bytes`.
        let paste_ref = "f".repeat(64);
        let paste_path = "C:/tmp/blobs/paste.txt".to_owned();
        let attachments = StoredAttachments {
            bytes: std::iter::once((paste_ref.clone(), vec![b'P'; 80 * 1024])).collect(),
            paths: std::iter::once((paste_ref.clone(), paste_path.clone())).collect(),
        };
        let steer = crate::surface::SteerDelivery {
            queued_ids: vec!["q1".into()],
            content: Content::Parts(vec![ContentPart::File {
                source: BinarySource::AttachmentRef(paste_ref),
                mime_type: "text/plain".into(),
                filename: Some("paste.txt".into()),
                text: Some(mixdog_core_api::domain::provider::TextAttachment { kind: Some("paste".into()) }),
            }]),
            task_notification: false,
        };
        let (steer_out, _, attached) = steer_blocks(&[steer], (true, true), &attachments, Some(limit)).await;
        assert!(total_inline_text_bytes(&steer_out) <= limit, "steer paste must not expand over 44 KiB: {}", total_inline_text_bytes(&steer_out));
        assert!(
            steer_out.iter().any(|b| b["type"] == "resource_link" && b["name"] == "paste.txt"),
            "stored oversized paste should remain a resource_link: {steer_out:?}"
        );
        assert_eq!(attached, vec![paste_path]);
    }
}
