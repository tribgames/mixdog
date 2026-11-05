//! What the PC-side model proxy keeps of Node's host (apps/desktop `model-proxy-host.ts`): the
//! attachment references a server may not make this PC read, the credential-shaped text that never
//! leaves it, and what a server learns of the PC's providers. The call itself is typed
//! (`mixdog_app_protocol::v2::model_proxy`).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

pub type Obj = Map<String, Value>;

/// A refusal Node throws with `code` and `status` set.
#[derive(Debug, PartialEq)]
pub struct Refusal {
    pub message: String,
    pub code: &'static str,
    pub status: u16,
}

const MAX_MESSAGE_DEPTH: usize = 128;

#[allow(clippy::unwrap_used, reason = "constant pattern")]
static CREDENTIAL_TEXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:sk|pk|rk|xai|gsk|sess)-[A-Za-z0-9_-]{12,}(?-u:\b)|(?-u:\b)Bearer\s+[A-Za-z0-9._~+/=-]{8,}|(?-u:\b)AIza[0-9A-Za-z_-]{20,}(?-u:\b)").unwrap()
});
#[allow(clippy::unwrap_used, reason = "constant pattern")]
static CONTROL_RUN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\x00-\x1f\]]+").unwrap());

/// `value.slice(0, limit)`: `limit` UTF-16 code units (a split pair is dropped whole).
fn slice_units(text: &str, limit: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for ch in text.chars() {
        used += ch.len_utf16();
        if used > limit {
            break;
        }
        out.push(ch);
    }
    out
}

/// `redactedText(value, limit)`.
pub fn redacted_text(value: &str, limit: usize) -> String {
    slice_units(&CREDENTIAL_TEXT.replace_all(value, "[redacted]"), limit)
}

fn record(value: Option<&Value>) -> Obj {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Obj::new(),
    }
}

/// `unavailableAttachment(part)`.
fn unavailable_attachment(part: &Obj) -> Value {
    let name = part
        .get("filename")
        .and_then(Value::as_str)
        .map(|f| f.rsplit(['/', '\\']).next().unwrap_or("").to_owned())
        .unwrap_or_default();
    let text = |key: &str| part.get(key).and_then(Value::as_str).map(str::to_owned);
    let label = [Some(name), text("mimeType"), text("mediaType"), text("type")]
        .into_iter()
        .flatten()
        .find(|v| !v.is_empty())
        .map(|v| slice_units(&CONTROL_RUN.replace_all(&v, "_"), 200));
    let label = label.filter(|l| !l.is_empty()).unwrap_or_else(|| "file".to_owned());
    serde_json::json!({ "type": "text", "text": format!("[attachment unavailable: {label}]") })
}

/// `withoutAttachmentReferences(value, depth)`: every attachment-store reference lowered to its
/// "unavailable" text. Applied to the free-form JSON of a request (thinking blocks, document
/// content), where a reference could still hide.
pub fn without_attachment_references(value: &Value, depth: usize) -> Result<Value, Refusal> {
    if !matches!(value, Value::Object(_) | Value::Array(_)) {
        return Ok(value.clone());
    }
    if depth > MAX_MESSAGE_DEPTH {
        return Err(Refusal { message: "The model call is nested too deeply.".into(), code: "MODEL_PROXY_REQUEST_INVALID", status: 400 });
    }
    match value {
        Value::Array(items) => Ok(Value::Array(items.iter().map(|e| without_attachment_references(e, depth + 1)).collect::<Result<_, _>>()?)),
        Value::Object(entry) => {
            if entry.contains_key("attachmentRef") {
                return Ok(unavailable_attachment(entry));
            }
            let mut out = Obj::new();
            for (key, field) in entry {
                out.insert(key.clone(), without_attachment_references(field, depth + 1)?);
            }
            Ok(Value::Object(out))
        }
        _ => Ok(value.clone()),
    }
}

fn first_response_budget(value: Option<&Value>) -> Option<Value> {
    let map = record(value);
    let positive = |key: &str| map.get(key).filter(|v| v.as_f64().is_some_and(|n| n.is_finite() && n > 0.0)).cloned();
    Some(serde_json::json!({ "transportMs": positive("transportMs")?, "semanticMs": positive("semanticMs")? }))
}

fn hidden_custom_models(entry: &Obj) -> Vec<Value> {
    let mut hidden: Vec<String> = Vec::new();
    let mut add = |id: &str| {
        if !hidden.iter().any(|h| h == id) {
            hidden.push(id.to_owned());
        }
    };
    if let Some(Value::Array(rows)) = entry.get("models") {
        for row in rows {
            if let (Some(id), Some(Value::Bool(true))) = (row.get("id").and_then(Value::as_str), row.get("hidden")) {
                add(id);
            }
        }
    }
    for (id, over) in record(entry.get("modelOverrides")) {
        if over.get("hidden") == Some(&Value::Bool(true)) {
            add(&id);
        }
    }
    hidden.into_iter().map(Value::String).collect()
}

/// `publicProviderConfig(providers, isProviderAllowed)`: what a server learns about this PC's
/// providers. No base URL, account, label, model list or any other stored field; a custom provider
/// adds only its registered name and the ids of models hidden on this PC. The answer deserializes
/// as `mixdog_app_protocol::v2::model_proxy::ProxyProviderInfo` per provider.
pub fn public_provider_config(providers: &Value, is_allowed: &dyn Fn(&str) -> bool) -> Value {
    let mut out = Obj::new();
    for (name, raw) in record(Some(providers)) {
        if !is_allowed(&name) {
            continue;
        }
        let entry = record(Some(&raw));
        let traits = record(entry.get("modelProxy"));
        let mut proxy = Obj::new();
        for key in ["inputExcludesCache", "nativePdf"] {
            if let Some(Value::Bool(b)) = traits.get(key) {
                proxy.insert(key.into(), Value::Bool(*b));
            }
        }
        if traits.get("consumesReadWindows") == Some(&Value::Bool(true)) {
            proxy.insert("consumesReadWindows".into(), Value::Bool(true));
        }
        if traits.get("takesImages") == Some(&Value::Bool(false)) {
            proxy.insert("takesImages".into(), Value::Bool(false));
        }
        if let Some(budget) = first_response_budget(traits.get("firstResponseBudget")) {
            proxy.insert("firstResponseBudget".into(), budget);
        }
        let mut item = Obj::new();
        item.insert("enabled".into(), Value::Bool(entry.get("enabled") == Some(&Value::Bool(true))));
        if entry.get("type").and_then(Value::as_str) == Some("custom") {
            item.insert("type".into(), "custom".into());
            if let Some(label) = entry.get("name").and_then(Value::as_str) {
                let label = redacted_text(mixdog_js::js_trim(label), 200);
                if !label.is_empty() {
                    item.insert("name".into(), Value::String(label));
                }
            }
            item.insert("hiddenModels".into(), Value::Array(hidden_custom_models(&entry)));
        }
        if let Some(state) = entry.get("authState").and_then(Value::as_str).filter(|s| ["present", "absent", "unreadable"].contains(s)) {
            item.insert("authState".into(), state.into());
        }
        item.insert("modelProxy".into(), Value::Object(proxy));
        out.insert(name, Value::Object(item));
    }
    Value::Object(out)
}

#[cfg(test)]
#[path = "model_proxy_tests.rs"]
mod tests;
