//! `office`: the extension-host front end. Each action is one `office.<action>` call on the
//! pool (Node workers carry the office stack); the call declares whether it writes so a worker
//! crash maps to `outcome_unknown` only for writes.

use std::sync::Arc;

use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_core_api::domain::tool::ImageData;
use mixdog_core_api::domain::tool::Tool;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_core_api::domain::tool::ToolError;
use mixdog_core_api::domain::tool::ToolErrorCode;
use mixdog_core_api::domain::tool::ToolOutcome;
use mixdog_core_api::domain::tool::ToolOutput;
use mixdog_core_api::domain::tool::ToolPart;
use mixdog_core_api::domain::tool::ToolSpec;
use mixdog_protocol::JsonValue;
use mixdog_protocol::ThreadId;
use mixdog_protocol::ToolCallId;
use serde_json::Value;
use serde_json::json;

use super::util::cancelled;
use super::util::action_failed;
use super::util::denied;
use super::util::invalid;
use super::util::spec_from_def;
use super::util::unavailable;

pub const ACTIONS: [&str; 24] = [
    "detect", "transactions", "recover", "describe", "author", "create", "attach", "open", "secure", "begin",
    "snapshot", "get", "query", "batch", "diff", "commit", "rollback", "issues", "qa", "validate", "render",
    "save", "finalize", "close",
];
/// Actions that only look at the document.
const READ_ONLY_ACTIONS: [&str; 8] = ["snapshot", "get", "query", "issues", "validate", "describe", "render", "qa"];

/// Whether a call may change a file (`qa` with `autoFix` repairs the document).
pub fn writes(action: &str, args: &Value) -> bool {
    !READ_ONLY_ACTIONS.contains(&action) || args.get("autoFix") == Some(&Value::Bool(true))
}

/// One side of a written file.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum WriteSide {
    Absent,
    /// The content, captured byte for byte.
    Bytes(Vec<u8>),
    /// The file changed but its bytes were not captured: no undo. size and reason are the worker's omitted marker (Node's { omitted, size, reason }).
    Uncaptured { size: u64, reason: Option<String> },
}

/// A file an office call wrote, for the thread's turn review and undo.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct WriteReceipt {
    pub path: String,
    pub before: WriteSide,
    pub after: WriteSide,
}

/// The turn review of a thread: receives the files each office call wrote.
#[async_trait]
pub trait OfficeWrites: Send + Sync {
    async fn record(&self, thread: &ThreadId, call: &ToolCallId, writes: Vec<WriteReceipt>);
}

pub struct OfficeTool {
    spec: ToolSpec,
    pool: Arc<dyn ExtPool>,
    writes: Arc<dyn OfficeWrites>,
    data_dir: String,
}

impl OfficeTool {
    /// `data_dir`: the plugin data directory office sessions and designs live under.
    pub fn new(pool: Arc<dyn ExtPool>, writes: Arc<dyn OfficeWrites>, data_dir: String) -> Self {
        Self { spec: spec_from_def(include_str!("defs/office.json"), false, &["office"]), pool, writes, data_dir }
    }
}

/// The model-facing output of the worker's `result` (Node's `executeOfficeTool` return:
/// `content` text and base64 images, `isError`).
fn render(result: &Value) -> ToolOutcome {
    let mut parts = Vec::new();
    for block in result.get("content").and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => parts.push(ToolPart::Text(block.get("text").and_then(Value::as_str).unwrap_or_default().to_owned())),
            Some("image") => {
                let source = &block["source"];
                let mime = source.get("media_type").and_then(Value::as_str).unwrap_or_default();
                let bytes = source.get("data").and_then(Value::as_str).and_then(|d| STANDARD.decode(d).ok());
                if let (false, Some(bytes)) = (mime.is_empty(), bytes) {
                    parts.push(ToolPart::Image { mime: mime.to_owned(), data: ImageData::Bytes(bytes), width: None, height: None });
                }
            }
            _ => {}
        }
    }
    let output = ToolOutput { parts, ..ToolOutput::default() };
    if result.get("isError") == Some(&Value::Bool(true)) {
        let message = output.parts.iter().find_map(|p| if let ToolPart::Text(t) = p { Some(t.clone()) } else { None }).unwrap_or_default();
        let mut error = action_failed("office", message);
        error.partial = Some(output);
        return Err(error);
    }
    Ok(output)
}

fn map_ext_error(error: ExtError, wrote: bool) -> ToolError {
    match error {
        ExtError::Cancelled => cancelled(),
        ExtError::Overloaded => unavailable("office", "Office Use is busy; try again shortly"),
        ExtError::Unavailable { reason } => unavailable("office", reason),
        ExtError::UnknownWorker => action_failed("office", "Office Use worker is gone"),
        ExtError::Failed { code, message } => match code.as_str() {
            "cancelled" => cancelled(),
            "browser_unavailable" => unavailable("browser", message),
            "path_not_approved" => denied(message),
            "unknown_method" => unavailable("office", message),
            _ => action_failed("office", message),
        },
        ExtError::HostExited { .. } => {
            let mut e = action_failed("office", "Office Use worker exited while serving the call");
            if wrote {
                e.outcome_unknown = true;
                e.code = ToolErrorCode::OutcomeUnknown;
            }
            e
        }
    }
}

/// `writes` entries of the worker's receipt: `null` absent, `{bytes: n}` taken from the chunk
/// stream, `{uncaptured: true, size, reason?}` nothing sent.
fn side(spec: &Value, chunks: &mut std::vec::IntoIter<Vec<u8>>) -> WriteSide {
    if spec.is_null() {
        WriteSide::Absent
    } else if spec.get("uncaptured") == Some(&Value::Bool(true)) {
        WriteSide::Uncaptured { size: spec.get("size").and_then(Value::as_u64).unwrap_or(0), reason: spec.get("reason").and_then(Value::as_str).map(str::to_owned) }
    } else {
        WriteSide::Bytes(chunks.next().unwrap_or_default())
    }
}

/// Receipts in order: per change, before then after, from the chunks in the order sent.
pub fn receipts(writes: &Value, chunks: Vec<Vec<u8>>) -> Vec<WriteReceipt> {
    let mut chunks = chunks.into_iter();
    writes
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| WriteReceipt {
            path: w.get("path").and_then(Value::as_str).unwrap_or_default().to_owned(),
            before: side(&w["before"], &mut chunks),
            after: side(&w["after"], &mut chunks),
        })
        .collect()
}

/// Every path the call may touch: `args.path` and `args.output`, resolved against the cwd.
fn approved_paths(args: &Value, cwd: &AbsPath) -> Vec<AbsPath> {
    ["path", "output"]
        .iter()
        .filter_map(|key| args.get(key).and_then(Value::as_str).filter(|p| !p.is_empty()))
        .filter_map(|p| AbsPath::new(cwd.as_path().join(p)))
        .collect()
}

#[async_trait]
impl Tool for OfficeTool {
    fn spec(&self) -> &ToolSpec {
        &self.spec
    }

    async fn call(&self, ctx: &ToolContext, args: JsonValue) -> ToolOutcome {
        let action = args.get("action").and_then(Value::as_str).unwrap_or_default().to_lowercase();
        if !ACTIONS.contains(&action.as_str()) {
            return Err(invalid("action", format!("unknown office action \"{action}\"")));
        }
        let wrote = writes(&action, &args);
        let mut stream = self
            .pool
            .call(ExtCall {
                thread: ctx.thread_id.clone(),
                method: "office.run".to_owned(),
                params: json!({ "args": args, "cwd": ctx.cwd.as_path().to_string_lossy(), "dataDir": self.data_dir }),
                paths: approved_paths(&args, &ctx.cwd),
            })
            .map_err(|e| map_ext_error(e, false))?;
        let mut chunks: Vec<Vec<u8>> = Vec::new();
        let done = loop {
            // Dropping the stream on cancel sends `cancel{id}` to the worker.
            let frame = tokio::select! {
                biased;
                _ = ctx.cancel.cancelled() => {
                    let mut e = cancelled();
                    e.outcome_unknown = wrote;
                    return Err(e);
                }
                f = stream.next() => f,
            };
            match frame {
                Some(ExtFrame::Chunk(bytes)) => chunks.push(bytes),
                Some(ExtFrame::Done(result)) => break result,
                None => break Err(ExtError::UnknownWorker),
            }
        };
        let value = done.map_err(|e| map_ext_error(e, wrote))?;
        // Files under the data directory (designs, session state) are not the user's documents.
        let data_dir = std::path::Path::new(&self.data_dir);
        let recorded: Vec<WriteReceipt> =
            receipts(&value["writes"], chunks).into_iter().filter(|w| !std::path::Path::new(&w.path).starts_with(data_dir)).collect();
        if !recorded.is_empty() {
            self.writes.record(&ctx.thread_id, &ctx.call_id, recorded).await;
        }
        render(&value["result"])
    }
}
#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn read_only_actions_do_not_write_unless_auto_fix() {
        assert!(!writes("snapshot", &json!({})));
        assert!(writes("qa", &json!({"autoFix": true})));
        assert!(writes("batch", &json!({})));
    }

    #[test]
    fn result_blocks_become_parts_and_error_flag_a_failure() {
        let ok = render(&json!({"content":[{"type":"text","text":"done"}]})).unwrap();
        assert_eq!(ok.parts, vec![ToolPart::Text("done".into())]);
        let err = render(&json!({"content":[{"type":"text","text":"bad"}],"isError":true})).unwrap_err();
        assert_eq!(err.message_for_model, "bad");
        assert!(err.partial.is_some());
    }

    #[test]
    fn receipts_pair_chunks_in_before_then_after_order() {
        let writes = json!([
            {"path":"/a","before":null,"after":{"bytes":2}},
            {"path":"/b","before":{"bytes":3},"after":{"uncaptured":true,"size":9,"reason":"binary"}},
            {"path":"/c","before":{"uncaptured":true},"after":{"bytes":1}},
        ]);
        let got = receipts(&writes, vec![b"hi".to_vec(), b"old".to_vec(), b"x".to_vec()]);
        assert_eq!(got[0], WriteReceipt { path: "/a".into(), before: WriteSide::Absent, after: WriteSide::Bytes(b"hi".to_vec()) });
        assert_eq!(got[1], WriteReceipt { path: "/b".into(), before: WriteSide::Bytes(b"old".to_vec()), after: WriteSide::Uncaptured { size: 9, reason: Some("binary".into()) } });
        assert_eq!(got[2].after, WriteSide::Bytes(b"x".to_vec()));
    }

    #[test]
    fn worker_codes_map_to_typed_errors() {
        let failed = |code: &str| map_ext_error(ExtError::Failed { code: code.into(), message: "m".into() }, true);
        assert_eq!(failed("cancelled").code, ToolErrorCode::Cancelled);
        assert!(matches!(failed("browser_unavailable").code, ToolErrorCode::Unavailable { .. }));
        assert_eq!(failed("path_not_approved").code, ToolErrorCode::PermissionDenied);
        let exited = map_ext_error(ExtError::HostExited { exit: mixdog_core_api::domain::ext::ExtExit::Code(1) }, true);
        assert_eq!((exited.code, exited.outcome_unknown), (ToolErrorCode::OutcomeUnknown, true));
    }
}
