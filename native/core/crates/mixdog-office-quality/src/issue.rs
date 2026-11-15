//! `assurance-issue.mjs`: the shape every review record carries.

use serde_json::{Value, json};

/// `issue(code, path, message)`: a warning of the `format-review` source.
pub fn issue(code: &str, path: &str, message: &str) -> Value {
    issue_with(code, path, message, "format-review", "warning")
}

/// `issue(code, path, message, source, severity)`.
pub fn issue_with(code: &str, path: &str, message: &str, source: &str, severity: &str) -> Value {
    json!({ "severity": severity, "code": code, "path": path, "message": message, "source": source })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_keeps_node_key_order_and_defaults() {
        assert_eq!(
            mixdog_js::json_stringify(&issue("a", "/b", "c")),
            r#"{"severity":"warning","code":"a","path":"/b","message":"c","source":"format-review"}"#
        );
        assert_eq!(issue_with("a", "/", "m", "post-save-gate", "error")["severity"], "error");
    }
}
