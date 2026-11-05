//! The benign no-match exit (`bash-tool/benign-exit.mjs`): search-style commands and
//! `git diff --exit-code` use exit 1 as a signal (no match, has diff), not a failure. Benign only
//! when the exit status provably comes from a search-style stage: the last segment of a `;`/`&&`
//! chain whose last pipeline stage is a search head. The quote-aware splitters are those of
//! `shell-analysis.mjs`.

use std::sync::LazyLock;

use super::scan::JsRegex;
use super::scan::cs;
use super::scan::js_trim;

/// Whether a backslash escapes the character after it: anything outside quotes, only `"` or `\`
/// inside double quotes, never inside single quotes.
fn starts_escape(quote: Option<char>, next: Option<char>) -> bool {
    match quote {
        Some('\'') => false,
        Some(_) => matches!(next, Some('"' | '\\')),
        None => true,
    }
}

fn push_trimmed(parts: &mut Vec<String>, current: &mut String) {
    let trimmed = js_trim(current);
    if !trimmed.is_empty() {
        parts.push(trimmed.to_owned());
    }
    current.clear();
}

/// `shellSplitSegments`: on newlines, `;`, `&&` and `||`.
pub fn split_segments(command: &str) -> Vec<String> {
    let chars: Vec<char> = command.chars().collect();
    let (mut parts, mut current) = (Vec::new(), String::new());
    let (mut quote, mut escaped) = (None, false);
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if escaped {
            current.push(ch);
            escaped = false;
        } else if ch == '\\' && starts_escape(quote, chars.get(i + 1).copied()) {
            current.push(ch);
            escaped = true;
        } else if let Some(q) = quote {
            current.push(ch);
            if ch == q {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
        } else if ch == '\n' || ch == ';' {
            push_trimmed(&mut parts, &mut current);
        } else if (ch == '&' || ch == '|') && chars.get(i + 1) == Some(&ch) {
            push_trimmed(&mut parts, &mut current);
            i += 1;
        } else {
            current.push(ch);
        }
        i += 1;
    }
    push_trimmed(&mut parts, &mut current);
    parts
}

/// `shellSplitPipelineSegments`: on `|` and `|&`.
pub fn split_pipeline_segments(segment: &str) -> Vec<String> {
    let chars: Vec<char> = segment.chars().collect();
    let (mut parts, mut current) = (Vec::new(), String::new());
    let (mut quote, mut escaped) = (None, false);
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if escaped {
            current.push(ch);
            escaped = false;
        } else if ch == '\\' && starts_escape(quote, chars.get(i + 1).copied()) {
            current.push(ch);
            escaped = true;
        } else if let Some(q) = quote {
            current.push(ch);
            if ch == q {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            current.push(ch);
        } else if ch == '|' {
            push_trimmed(&mut parts, &mut current);
            if chars.get(i + 1) == Some(&'&') {
                i += 1;
            }
        } else {
            current.push(ch);
        }
        i += 1;
    }
    push_trimmed(&mut parts, &mut current);
    parts
}

static ESCAPABLE: LazyLock<JsRegex> = LazyLock::new(|| cs(r#"^[\s"'$`;&|<>()*?]$"#));

/// `shellTokenize`; `None` for unbalanced quotes.
pub fn tokenize(segment: &str) -> Option<Vec<String>> {
    let chars: Vec<char> = segment.chars().collect();
    let (mut tokens, mut current) = (Vec::new(), String::new());
    let mut quote: Option<char> = None;
    let push = |tokens: &mut Vec<String>, current: &mut String| {
        if !current.is_empty() {
            tokens.push(std::mem::take(current));
        }
    };
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\\' && quote != Some('\'') {
            let next = chars.get(i + 1).copied();
            let escapes = if quote == Some('"') {
                next == Some('"')
            } else {
                next.is_some_and(|n| ESCAPABLE.is_match(&n.to_string()))
            };
            if !escapes {
                current.push(ch);
            } else if let Some(n) = next {
                current.push(n);
                i += 1;
            }
        } else if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if super::scan::is_js_space(ch) {
            push(&mut tokens, &mut current);
        } else if ch == '>' {
            push(&mut tokens, &mut current);
            if chars.get(i + 1) == Some(&'>') {
                tokens.push(">>".into());
                i += 1;
            } else {
                tokens.push(">".into());
            }
        } else {
            current.push(ch);
        }
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    push(&mut tokens, &mut current);
    Some(tokens)
}

/// `stripShellProbeWrappers`.
pub fn strip_probe_wrappers(tokens: Vec<String>) -> Vec<String> {
    let mut out = tokens;
    while out.first().is_some_and(|t| super::scan::is_assignment(t)) {
        out.remove(0);
    }
    let mut idx = 0;
    while idx < out.len() {
        let tok = out[idx].to_lowercase();
        if tok.is_empty() {
            idx += 1;
        } else if matches!(tok.as_str(), "sudo" | "nohup" | "exec") {
            out.remove(idx);
        } else if tok == "command" {
            out.remove(idx);
            while idx < out.len() && out[idx].starts_with('-') {
                out.remove(idx);
            }
        } else if tok == "env" {
            out.remove(idx);
            while idx < out.len() {
                let lower = out[idx].to_lowercase();
                if super::scan::is_assignment(&out[idx]) || lower == "-i" {
                    out.remove(idx);
                } else if lower == "-u" && idx + 1 < out.len() {
                    out.drain(idx..idx + 2);
                } else {
                    break;
                }
            }
        } else {
            break;
        }
    }
    out
}

static AMBIGUOUS: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r"\$\(|\$\{|<\(|>\(|`|\\\s*(?:\||&|;|\n)"));
static OR_CHAIN: LazyLock<JsRegex> = LazyLock::new(|| cs(r"\|\|"));

/// A comment ends at the newline; later lines are still live commands.
fn strip_shell_comment(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            out.push(ch);
            if ch == q {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
            out.push(ch);
        } else if ch == '#'
            && (i == 0 || {
                let p = chars[i - 1];
                super::scan::is_js_space(p) || matches!(p, ';' | '&' | '|' | '(')
            })
        {
            match (i..chars.len()).find(|&k| chars[k] == '\n') {
                None => break,
                Some(nl) => i = nl - 1,
            }
        } else {
            out.push(ch);
        }
        i += 1;
    }
    out
}

const SEARCH_HEADS: [&str; 6] = ["select-string", "sls", "grep", "egrep", "fgrep", "findstr"];
const GIT_DIFF_EXIT_SIGNAL_FLAGS: [&str; 3] = ["--exit-code", "--quiet", "--check"];
const GIT_GLOBAL_VALUE_OPTS: [&str; 7] =
    ["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"];

fn normalize_head(token: &str) -> String {
    let lower = token.to_lowercase();
    let no_ext = lower.strip_suffix(".exe").unwrap_or(&lower);
    no_ext.rsplit(['\\', '/']).next().unwrap_or("").to_owned()
}

/// `_isBenignSearchExitOne`.
pub fn is_benign_search_exit_one(command: &str, exit_code: i32, signal: bool, stderr: &str) -> bool {
    if signal || exit_code != 1 || !js_trim(stderr).is_empty() {
        return false;
    }
    let text = strip_shell_comment(command);
    if AMBIGUOUS.is_match(&text) {
        return false;
    }
    let segments = split_segments(&text);
    let Some(last_segment) = segments.last() else { return false };
    if segments.len() > 1 && OR_CHAIN.is_match(&text) {
        return false;
    }
    let stages = split_pipeline_segments(last_segment);
    let last = stages.last().unwrap_or(last_segment);
    let Some(raw) = tokenize(last) else { return false };
    let tokens = strip_probe_wrappers(raw);
    let Some(first) = tokens.first() else { return false };
    let head = normalize_head(first);
    if SEARCH_HEADS.contains(&head.as_str()) {
        return true;
    }
    if head != "git" {
        return false;
    }
    let mut i = 1;
    while i < tokens.len() && tokens[i].starts_with('-') {
        i += if GIT_GLOBAL_VALUE_OPTS.contains(&tokens[i].as_str()) && !tokens[i].contains('=') { 2 } else { 1 };
    }
    match tokens.get(i).map(String::as_str) {
        Some("grep") => true,
        Some("diff") => tokens[i + 1..].iter().any(|t| GIT_DIFF_EXIT_SIGNAL_FLAGS.contains(&t.as_str())),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Node's own cases (`destructive-warning.test.mjs`, benign search exit).
    #[test]
    fn comments_end_at_newline_and_only_start_a_word() {
        assert!(is_benign_search_exit_one("grep x f # note", 1, false, ""));
        assert!(is_benign_search_exit_one("grep x f;# note", 1, false, ""));
        assert!(!is_benign_search_exit_one("grep x f # note\nfalse", 1, false, ""));
        assert!(is_benign_search_exit_one("false; echo a#b; grep x f", 1, false, ""));
        assert!(!is_benign_search_exit_one("grep x f; echo a#b", 1, false, ""));
    }

    #[test]
    fn only_a_provable_search_stage_with_exit_one_is_benign() {
        assert!(is_benign_search_exit_one("cat f | grep x", 1, false, "  \n"));
        assert!(is_benign_search_exit_one("git --no-pager diff --exit-code", 1, false, ""));
        assert!(is_benign_search_exit_one("git -C d grep x", 1, false, ""));
        assert!(is_benign_search_exit_one("C:\\bin\\Grep.EXE x f", 1, false, ""));
        assert!(!is_benign_search_exit_one("git diff", 1, false, ""));
        assert!(!is_benign_search_exit_one("grep x f || true", 1, false, ""));
        assert!(!is_benign_search_exit_one("grep x f", 2, false, ""));
        assert!(!is_benign_search_exit_one("grep x f", 1, true, ""));
        assert!(!is_benign_search_exit_one("grep x f", 1, false, "err"));
        assert!(!is_benign_search_exit_one("echo $(grep x f)", 1, false, ""));
        assert!(!is_benign_search_exit_one("grep 'x f", 1, false, ""));
    }
}
