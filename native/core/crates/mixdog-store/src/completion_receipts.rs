//! A terminal result belongs to its session until that session consumes it. Receipts are
//! folded with the delivery record, so dequeue, task reads and restart replay share one owner.

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::schema::shared_header::HeaderMap;

const RECEIPTS: &str = "completionReceipts";

pub fn queue_id(execution: &str, text: &str) -> String {
    let execution = mixdog_js::js_trim(execution);
    let identity = if execution.is_empty() { format!("content:{text}") } else { format!("execution:{execution}") };
    let digest = Sha256::digest(identity.as_bytes());
    format!("completion_{}", &format!("{digest:x}")[..24])
}

pub fn contains<H: HeaderMap + ?Sized>(header: &H, qid: &str) -> bool {
    header.value(RECEIPTS).and_then(Value::as_object).is_some_and(|receipts| receipts.contains_key(qid))
}

pub fn record<H: HeaderMap + ?Sized>(header: &mut H, qid: &str) {
    let receipts = header.value_or_insert(RECEIPTS, || Value::Object(Default::default()));
    if let Some(receipts) = receipts.as_object_mut() {
        receipts.insert(qid.to_owned(), Value::Bool(true));
    }
}

/// Only the task tool's terminal read/wait carries this fact. Output text and running reads
/// cannot acknowledge a result that the model has not received.
pub fn tool_receipt(body: &Value) -> Option<String> {
    if body.get("role").and_then(Value::as_str) != Some("tool") {
        return None;
    }
    let meta = body.get("toolMeta")?;
    if meta.get("code").and_then(Value::as_str) != Some("task-completion")
        || !matches!(meta.get("status").and_then(Value::as_str), Some("completed" | "failed" | "cancelled"))
    {
        return None;
    }
    let execution = meta.get("executionId")?.as_str()?.trim();
    (!execution.is_empty()).then(|| queue_id(execution, ""))
}
