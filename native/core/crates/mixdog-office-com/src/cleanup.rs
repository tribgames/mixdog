//! How the outcome of a host's cleanup is read and told. A host reports a failed cleanup on stderr as a
//! `MIXDOG_OFFICE_CLEANUP` line; a cleanup that did not finish is reported as pending and never answered by killing
//! the host, since nothing proves a shared or user-owned document is safe.

use serde_json::Value;
use serde_json::json;

/// The marker a host's stderr line carries when its own cleanup failed.
pub(crate) const MARKER: &str = "MIXDOG_OFFICE_CLEANUP";

/// What `drain` answers when the host did not exit within the grace period.
pub(crate) const PENDING_ERROR: &str = "Office cleanup is still pending; the host was not force-killed.";

/// The lines of `text`, split at `\n` or `\r\n` and nowhere else.
pub(crate) fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// The stderr lines that report a failed cleanup.
pub(crate) fn failure_lines(stderr: &str) -> Vec<String> {
    lines(stderr).filter(|line| line.contains(MARKER)).map(str::to_owned).collect()
}

/// A cleanup that finished: the host exited, with the failures it reported (none when `errors` is empty).
pub(crate) fn finished(ok: bool, errors: Vec<String>) -> Value {
    let mut cleanup = json!({"ok": ok, "hostExited": true});
    if !errors.is_empty() {
        cleanup["errors"] = json!(errors);
    }
    cleanup
}

/// A cleanup that is still under way: the host was asked to end and has not.
pub(crate) fn pending() -> Value {
    json!({"ok": false, "hostExited": false, "pending": true, "error": PENDING_ERROR})
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `message`, with `; cleanup unconfirmed: <why>` appended when `cleanup` says the host did not clean up.
pub fn cleanup_error(message: &str, cleanup: Option<&Value>) -> String {
    let Some(cleanup) = cleanup.filter(|cleanup| truthy(cleanup)) else {
        return message.to_owned();
    };
    if cleanup.get("ok").is_some_and(truthy) {
        return message.to_owned();
    }
    let error = cleanup.get("error").filter(|error| truthy(error)).and_then(Value::as_str);
    let joined = cleanup.get("errors").and_then(Value::as_array).map(|errors| {
        errors
            .iter()
            .map(|error| match error {
                Value::String(text) => text.clone(),
                Value::Null => String::new(),
                other => other.to_string(),
            })
            .collect::<Vec<_>>()
            .join("; ")
    });
    let why = error
        .map(str::to_owned)
        .or(joined.filter(|joined| !joined.is_empty()))
        .unwrap_or_else(|| "Office host did not report a clean exit".to_owned());
    format!("{message}; cleanup unconfirmed: {why}")
}

/// A crashed application answers no call, so the host cannot close its document through the dead channel and the
/// session is released: its cleanup outcome travels with the result instead.
pub(crate) fn application_gone(result: &Value) -> bool {
    if result.get("cleanup").and_then(|cleanup| cleanup.get("processExited")) == Some(&Value::Bool(true)) {
        return true;
    }
    let error = result.get("error").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    ["rpc server is unavailable", "0x800706ba", "rpc_e_disconnected", "rpc_e_serverfault"]
        .iter()
        .any(|needle| error.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clean_or_absent_cleanup_leaves_the_message_alone() {
        assert_eq!(cleanup_error("failed", None), "failed");
        assert_eq!(cleanup_error("failed", Some(&json!({"ok": true}))), "failed");
    }

    #[test]
    fn an_unconfirmed_cleanup_says_why() {
        assert_eq!(
            cleanup_error("failed", Some(&json!({"ok": false, "error": "pending"}))),
            "failed; cleanup unconfirmed: pending"
        );
        assert_eq!(
            cleanup_error("failed", Some(&json!({"ok": false, "errors": ["a", "b"]}))),
            "failed; cleanup unconfirmed: a; b"
        );
        assert_eq!(
            cleanup_error("failed", Some(&json!({"ok": false}))),
            "failed; cleanup unconfirmed: Office host did not report a clean exit"
        );
        assert_eq!(
            cleanup_error("failed", Some(&pending())),
            format!("failed; cleanup unconfirmed: {PENDING_ERROR}")
        );
    }

    #[test]
    fn lines_split_at_lf_or_crlf_only() {
        assert_eq!(lines("a\r\nb\nc\rd").collect::<Vec<_>>(), ["a", "b", "c\rd"]);
        assert_eq!(
            failure_lines("noise\r\nMIXDOG_OFFICE_CLEANUP {\"ok\":false}\nmore"),
            ["MIXDOG_OFFICE_CLEANUP {\"ok\":false}"]
        );
    }

    #[test]
    fn an_application_that_is_gone_is_told_from_the_result() {
        assert!(application_gone(&json!({"ok": false, "cleanup": {"processExited": true}})));
        for error in [
            "The RPC server is unavailable",
            "HRESULT 0x800706BA",
            "rpc_e_disconnected",
            "RPC_E_SERVERFAULT",
        ] {
            assert!(application_gone(&json!({"ok": false, "error": error})), "{error}");
        }
        assert!(!application_gone(&json!({"ok": false, "error": "document close failed"})));
        assert!(!application_gone(&json!({"ok": false})));
    }
}
