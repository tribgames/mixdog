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

/// JavaScript's `\s` (and `trimStart`): Unicode space separators, line terminators, U+FEFF; not U+0085.
fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

fn word(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// `\bneedle\b`-style match of an ASCII needle in lower-cased ASCII-folded `hay`: the edges that touch a word
/// character of the needle must not touch one of the text.
fn has_word(hay: &str, needle: &str) -> bool {
    let h = hay.as_bytes();
    hay.match_indices(needle).any(|(at, _)| {
        let before = at == 0 || !word(h[at - 1]);
        let after = h.get(at + needle.len()).is_none_or(|b| !word(*b));
        before && after
    })
}

/// `NAVIGATION_MISS_RE` and the permission exclusion of `isReadOnlyNavigationMiss`, case-insensitive for ASCII only
/// (a non-ASCII character never folds onto an ASCII one in a non-`u` regex).
fn is_read_only_navigation_miss(tool: &str, text: &str) -> bool {
    if !READ_ONLY_NAVIGATION_TOOLS.contains(&tool.to_lowercase().as_str()) {
        return false;
    }
    let t = text.to_ascii_lowercase();
    if has_word(&t, "eacces")
        || has_word(&t, "eperm")
        || t.contains("access is denied")
        || t.contains("permission denied")
        || t.contains("operation not permitted")
    {
        return false;
    }
    has_word(&t, "enoent")
        || has_word(&t, "enotdir")
        || ["path does not exist", "directory does not exist", "no such file", "no such path", "not found at this path"]
            .iter()
            .any(|p| t.contains(p))
        || has_word(&t, "file not found")
        || symbol_not_found(&t)
}

/// `symbol "[^"\n]*" not found in `.
fn symbol_not_found(t: &str) -> bool {
    t.match_indices("symbol \"").any(|(at, m)| {
        let rest = &t[at + m.len()..];
        rest.find(['"', '\n']).is_some_and(|end| rest[end..].starts_with('"') && rest[end + 1..].starts_with(" not found in "))
    })
}

/// `/^error(?:\s+\[code\b|\s*:)/i` or `/^\[error/i`, on the text with its leading whitespace removed.
fn is_error_text(trimmed: &str) -> bool {
    let b = trimmed.as_bytes();
    if b.first() == Some(&b'[') {
        return b.len() >= 6 && b[1..6].eq_ignore_ascii_case(b"error");
    }
    if b.len() < 5 || !b[..5].eq_ignore_ascii_case(b"error") {
        return false;
    }
    let rest = &trimmed[5..];
    let after_space = rest.trim_start_matches(js_space);
    if after_space.starts_with(':') {
        return true;
    }
    after_space.len() < rest.len()
        && after_space.starts_with("[code")
        && after_space.as_bytes().get(5).is_none_or(|b| !word(*b))
}

/// `classifyResultKind(text, false, tool)`.
pub fn classify_result_kind(text: &str, tool: &str) -> ResultKind {
    if is_read_only_navigation_miss(tool, text) {
        return ResultKind::ZeroMatch;
    }
    let trimmed = text.trim_start_matches(js_space);
    if is_error_text(trimmed) {
        return ResultKind::Error;
    }
    if ZERO_MATCH_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
        return ResultKind::ZeroMatch;
    }
    ResultKind::Normal
}
