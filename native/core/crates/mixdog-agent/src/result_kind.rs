//! `classifyResultKind(result, false, toolName)` (`session/result-classification.mjs`): how Node turns the text a tool
//! returned into `error`, `zero-match` or `normal`. A tool that returns `Error: …` instead of failing (the delegated-agent
//! tool, the skill tools, text results of MCP servers) is an error call only through this; it is what puts such a call
//! in `history/tool-failures.jsonl`.

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResultKind {
    Normal,
    Error,
    ZeroMatch,
}

use regex::Regex;
use std::sync::LazyLock;

// The expressions are Node's, flag for flag: `i` without `u` folds ASCII only (`(?i-u:…)`), `\b` is the ASCII word boundary
// (`(?-u:\b)`), and `\s` is JavaScript's (Unicode space separators, line terminators and U+FEFF, not U+0085).
const JS_SPACE: &str = r"[\p{White_Space}\x{FEFF}--\x{85}]";

/// `NAVIGATION_MISS_RE`.
static NAVIGATION_MISS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i-u:(?-u:\b)(?:enoent|enotdir)(?-u:\b)|path does not exist|directory does not exist|no such (?:file|path)|not found at this path|file not found(?-u:\b))|(?i-u:symbol ")[^"\n]*(?i-u:" not found in )"#,
    )
    .unwrap()
});

/// The permission exclusion of `isReadOnlyNavigationMiss`.
static PERMISSION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u:(?-u:\b)(?:eacces|eperm)(?-u:\b)|access is denied|permission denied|operation not permitted)").unwrap()
});

/// `/^error(?:\s+\[code\b|\s*:)/i`.
static ERROR_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"^(?i-u:error)(?:{JS_SPACE}+(?i-u:\[code)(?-u:\b)|{JS_SPACE}*:)")).unwrap());

/// `/^\[error/i`.
static BRACKET_ERROR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?i-u:\[error)").unwrap());

static LEADING_SPACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"^{JS_SPACE}+")).unwrap());

/// `isReadOnlyNavigationMiss(toolName, result)`.
fn is_read_only_navigation_miss(tool: &str, text: &str) -> bool {
    READ_ONLY_NAVIGATION_TOOLS.contains(&tool.to_lowercase().as_str()) && !PERMISSION.is_match(text) && NAVIGATION_MISS.is_match(text)
}

/// `classifyResultKind(text, false, tool)`.
pub fn classify_result_kind(text: &str, tool: &str) -> ResultKind {
    if is_read_only_navigation_miss(tool, text) {
        return ResultKind::ZeroMatch;
    }
    let trimmed = LEADING_SPACE.find(text).map_or(text, |m| &text[m.end()..]);
    if ERROR_PREFIX.is_match(trimmed) || BRACKET_ERROR.is_match(trimmed) {
        return ResultKind::Error;
    }
    if ZERO_MATCH_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return ResultKind::ZeroMatch;
    }
    ResultKind::Normal
}