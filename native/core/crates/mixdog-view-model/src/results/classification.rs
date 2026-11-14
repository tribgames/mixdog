//! The single conversion point from the tool-return string convention to a structural kind
//! (`agent/orchestrator/session/result-classification.mjs`).
//!
//! Only the very start of a result counts: a mid-body `Error:` is not an error. Error prefixes are case-insensitive;
//! zero-match prefixes are exact strings from the documented formatters.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_to_lowercase;
use mixdog_js::js_trim_start;

/// Exact zero-result prefixes of the documented tool formatters.
const ZERO_MATCH_PREFIXES: [&str; 11] = [
    "(no matches)",
    "(no files found)",
    "(no symbol matches",
    "(no symbols)",
    "(no references)",
    "(no callers)",
    "(no call sites)",
    "(no imports)",
    "(no dependents)",
    "(no entries match filter)",
    "(no lines in range",
];

const READ_ONLY_NAVIGATION_TOOLS: [&str; 6] = ["find", "glob", "grep", "list", "read", "code_graph"];

static NAVIGATION_MISS: LazyLock<JsRegex> = LazyLock::new(|| {
    JsRegex::new_static(
        r#"\b(?:enoent|enotdir)\b|path does not exist|directory does not exist|no such (?:file|path)|not found at this path|file not found\b|symbol "[^"\n]*" not found in "#,
        "i",
    )
});
static ACCESS_DENIED: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\b(?:eacces|eperm)\b|access is denied|permission denied|operation not permitted", "i"));
static ERROR_PREFIX: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error(?:\s+\[code\b|\s*:)", "i"));
static BRACKET_ERROR: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[error", "i"));
static SHELL_TOOL_FAILED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error:\s*\[shell-tool-failed\]", "i"));
static SHELL_RUN_FAILED: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^error:\s*\[shell-run-failed\]", "i"));
static EXIT_CODE_MARK: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"\[exit code:", "i"));
static INTERRUPTED_MARK: LazyLock<JsRegex> =
    LazyLock::new(|| JsRegex::new_static(r"\[timeout:|\[signal:|timed out|aborted|interrupted", "i"));
static TIMEOUT_HEAD: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static(r"^\[(?:timeout:|signal:)", "i"));

/// What a result string says about itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultKind {
    Normal,
    Error,
    ZeroMatch,
}

impl ResultKind {
    /// The word Node uses (`'normal' | 'error' | 'zero-match'`).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Error => "error",
            Self::ZeroMatch => "zero-match",
        }
    }
}

/// `isReadOnlyNavigationMiss`: a read-only navigation tool pointing at a path or symbol that is not there.
pub fn is_read_only_navigation_miss(tool_name: &str, result: &str) -> bool {
    if !READ_ONLY_NAVIGATION_TOOLS.contains(&js_to_lowercase(tool_name).as_str()) {
        return false;
    }
    if ACCESS_DENIED.is_match(result) {
        return false;
    }
    NAVIGATION_MISS.is_match(result)
}

/// `classifyResultKind` of a string result (a non-string result is `normal`, which a caller without a string never asks).
pub fn classify_result_kind(result: &str, explicit_success: bool, tool_name: &str) -> ResultKind {
    if explicit_success {
        return ResultKind::Normal;
    }
    if is_read_only_navigation_miss(tool_name, result) {
        return ResultKind::ZeroMatch;
    }
    let trimmed = js_trim_start(result);
    if ERROR_PREFIX.is_match(trimmed) || BRACKET_ERROR.is_match(trimmed) {
        return ResultKind::Error;
    }
    if ZERO_MATCH_PREFIXES.iter().any(|prefix| trimmed.starts_with(prefix)) {
        return ResultKind::ZeroMatch;
    }
    ResultKind::Normal
}

/// `isShellFailureResult`: the shell TOOL or control-plane failed. A completed process exit is not a tool failure whatever
/// its code or output; only the tool markers and an interrupted execution (timeout, signal, abort) count.
pub fn is_shell_failure_result(result: &str) -> bool {
    let mut body = result;
    // `/^(?:\s*⚠️[^\n]*\n)+/`: leading warning lines.
    loop {
        let rest = js_trim_start(body);
        let Some(after) = rest.strip_prefix("⚠️") else { break };
        match after.find('\n') {
            Some(newline) => body = &after[newline + 1..],
            None => break,
        }
    }
    let body = js_trim_start(body);
    if SHELL_TOOL_FAILED.is_match(body) {
        return true;
    }
    if SHELL_RUN_FAILED.is_match(body) {
        let header = body.split('\n').next().unwrap_or_default();
        return !(EXIT_CODE_MARK.is_match(header) && !INTERRUPTED_MARK.is_match(header));
    }
    TIMEOUT_HEAD.is_match(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds() {
        assert_eq!(classify_result_kind("  Error: x", false, ""), ResultKind::Error);
        assert_eq!(classify_result_kind("error [code 5]: y", false, ""), ResultKind::Error);
        assert_eq!(classify_result_kind("[Error foo]", false, ""), ResultKind::Error);
        assert_eq!(classify_result_kind("(no matches)", false, ""), ResultKind::ZeroMatch);
        assert_eq!(classify_result_kind("(No matches)", false, ""), ResultKind::Normal);
        assert_eq!(classify_result_kind("a\nError: mid", false, ""), ResultKind::Normal);
        assert_eq!(classify_result_kind("Error: x", true, ""), ResultKind::Normal);
        assert_eq!(classify_result_kind("ENOENT: no such file", false, "Read"), ResultKind::ZeroMatch);
        assert_eq!(classify_result_kind("ENOENT: no such file", false, "shell"), ResultKind::Normal);
        assert_eq!(classify_result_kind("EACCES: permission denied, ENOENT", false, "read"), ResultKind::Normal);
        assert_eq!(ResultKind::ZeroMatch.as_str(), "zero-match");
    }

    #[test]
    fn shell_failures() {
        assert!(is_shell_failure_result("Error: [shell-tool-failed] boom"));
        assert!(is_shell_failure_result("⚠️ note\nError: [shell-run-failed] [timeout: 5s]"));
        assert!(!is_shell_failure_result("Error: [shell-run-failed] [exit code: 2]\nout"));
        assert!(is_shell_failure_result("Error: [shell-run-failed] [exit code: 2] timed out"));
        assert!(is_shell_failure_result("[timeout: 3s]"));
        assert!(!is_shell_failure_result("[exit code: 0]"));
    }
}
