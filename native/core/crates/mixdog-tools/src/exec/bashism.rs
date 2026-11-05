//! Pre-execution rewrite of bash-isms that ALWAYS fail in Windows PowerShell
//! (`bash-tool/bashism-rewrite.mjs`), so the first attempt succeeds instead of costing a failed
//! call and a retry. Rewritten, only outside quotes, here-strings and comments:
//!   `<cmd> <<'EOF'\n…\nEOF` → `@'\n…\n'@ | <cmd>` (python/python3/py/node only)
//!   `2>/dev/null` `>/dev/null` `&>/dev/null` → `2>$null` `>$null` `*>$null`
//!   `</dev/null` → removed (the shell's stdin is already at EOF)
//! Anything not exactly one of these forms makes the whole command pass through untouched.
//! Callers gate on Windows and a PowerShell shell; nothing here inspects the platform.

use std::sync::LazyLock;

use mixdog_js::JsRegex;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

fn is_js_space(c: char) -> bool {
    mixdog_js::is_js_space(c)
}

fn string_of(chars: &[char]) -> String {
    chars.iter().collect()
}

fn index_of(chars: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return Some(from.min(chars.len()));
    }
    (from..chars.len().saturating_sub(needle.len() - 1)).find(|&i| chars[i..].starts_with(needle))
}

fn index_of_char(chars: &[char], c: char, from: usize) -> Option<usize> {
    (from..chars.len()).find(|&i| chars[i] == c)
}

fn ends_with_cr(line: &[char]) -> &[char] {
    line.strip_suffix(&['\r']).unwrap_or(line)
}

/// A delimiter name matched by one of the three opener alternatives.
fn opener_delimiter(m: &mixdog_js::Caps<'_>) -> Option<String> {
    (1..=3).find_map(|g| m.get(g)).map(str::to_owned)
}

/// Marks each character `true` when it is live PowerShell code and `false` when it sits in a
/// string, here-string, comment or after a backtick. `None` when the text cannot be tokenised
/// with confidence (unterminated string, `$(` inside a double quote).
pub fn code_mask(text: &[char]) -> Option<Vec<bool>> {
    let mut mask = vec![false; text.len()];
    // Bash heredoc bodies start on the line after their `<<DELIM` opener and are opaque text.
    let mut pending: Vec<String> = Vec::new();
    let mut i = 0;
    let at = |k: usize| text.get(k).copied();
    while i < text.len() {
        let ch = text[i];
        if ch == '`' {
            i += 2;
            continue;
        }
        if ch == '<' && at(i + 1) == Some('<') {
            mask[i] = true;
            mask[i + 1] = true;
            let rest = string_of(&text[i..]);
            if let Some(m) = lazy_re!(r#"^<<-?[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))"#, "").captures(&rest) {
                pending.extend(opener_delimiter(&m));
            }
            i += 2;
            continue;
        }
        if ch == '\n' && !pending.is_empty() {
            mask[i] = true;
            i += 1;
            for delimiter in std::mem::take(&mut pending) {
                loop {
                    if i >= text.len() {
                        return None;
                    }
                    let nl = index_of_char(text, '\n', i);
                    let stop = nl.unwrap_or(text.len());
                    let terminator = string_of(ends_with_cr(&text[i..stop])) == delimiter;
                    i = nl.map_or(text.len(), |n| n + 1);
                    if terminator {
                        break;
                    }
                }
            }
            continue;
        }
        if ch == '<' && at(i + 1) == Some('#') {
            let end = index_of(text, &['#', '>'], i + 2)?;
            i = end + 2;
            continue;
        }
        if ch == '#' && (i == 0 || matches!(text[i - 1], ';' | '(' | '{' | '|') || is_js_space(text[i - 1])) {
            i = index_of_char(text, '\n', i).unwrap_or(text.len());
            continue;
        }
        if ch == '@' && matches!(at(i + 1), Some('\'' | '"')) {
            let quote = text[i + 1];
            let rest = string_of(&text[(i + 2).min(text.len())..]);
            if let Some(open) = lazy_re!(r"^[ \t]*\r?\n", "").find(&rest) {
                let open_len = rest[..open.end].chars().count();
                let needle = ['\n', quote, '@'];
                let from = (i + 2 + open_len).saturating_sub(1);
                let close = index_of(text, &needle, from)?;
                i = close + 3;
                continue;
            }
        }
        if ch == '\'' {
            i += 1;
            loop {
                let end = index_of_char(text, '\'', i)?;
                if at(end + 1) == Some('\'') {
                    i = end + 2;
                    continue;
                }
                i = end + 1;
                break;
            }
            continue;
        }
        if ch == '"' {
            i += 1;
            loop {
                if i >= text.len() {
                    return None;
                }
                let c = text[i];
                if c == '`' {
                    i += 2;
                    continue;
                }
                if c == '$' && at(i + 1) == Some('(') {
                    return None;
                }
                if c == '"' {
                    if at(i + 1) == Some('"') {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        mask[i] = true;
        i += 1;
    }
    Some(mask)
}

/// The text with every non-code character replaced by NUL, offsets unchanged.
fn code_only(text: &[char], mask: &[bool]) -> String {
    text.iter().zip(mask).map(|(c, live)| if *live { *c } else { '\0' }).collect()
}

/// Byte offset → character index in `s`.
fn char_at_byte(s: &str, byte: usize) -> usize {
    s[..byte].chars().count()
}

enum Heredoc {
    Skip,
    Done(Vec<char>, String),
}

/// One heredoc → here-string rewrite, or `Skip` when the heredoc is not one of the exactly-safe
/// shapes.
fn rewrite_one_heredoc(text: &[char], at: usize) -> Heredoc {
    let tail = string_of(&text[at..]);
    let Some(opener) =
        lazy_re!(r#"^<<(?![<-])[ \t]*(?:'([A-Za-z_]\w*)'|"([A-Za-z_]\w*)"|([A-Za-z_]\w*))"#, "").captures(&tail)
    else {
        return Heredoc::Skip;
    };
    let Some(delimiter) = opener_delimiter(&opener) else { return Heredoc::Skip };
    let opener_len = tail[..opener.range().end].chars().count();
    let expanding = opener.get(3).is_some();
    let quoted = opener.get(1).or(opener.get(2)).is_some();
    let line_start = (0..at).rev().find(|&k| text[k] == '\n').map_or(0, |k| k + 1);
    let line_end = index_of_char(text, '\n', at).unwrap_or(text.len());
    let before = &text[line_start..at];
    let rest_chars = ends_with_cr(&text[(at + opener_len).min(line_end)..line_end]);
    let rest = string_of(rest_chars);
    if lazy_re!(r#"['"`$<]"#, "").is_match(&rest) || line_end >= text.len() {
        return Heredoc::Skip;
    }
    // The stage is what follows the last live `;` / `&&` on the opener line.
    let Some(before_mask) = code_mask(before) else { return Heredoc::Skip };
    let mut stage_from = 0;
    let mut i = 0;
    while i < before.len() {
        if before_mask[i] {
            if before[i] == ';' {
                stage_from = i + 1;
            } else if before[i] == '&' && before.get(i + 1) == Some(&'&') {
                i += 1;
                stage_from = i + 1;
            } else if before[i] == '|' || before[i] == '&' {
                return Heredoc::Skip;
            }
        }
        i += 1;
    }
    let stage = mixdog_js::js_trim(&string_of(&before[stage_from..])).to_owned();
    let python = lazy_re!(r"^(?:python3?|py)(?:\.exe)?(?:\s+-[uBsSEIOqbd]+)*(?:\s+-)?$", "i");
    let node = lazy_re!(r"^node(?:\.exe)?(?:\s+--[\w-]+(?:=[\w.-]+)?)*(?:\s+-)?$", "i");
    if !python.is_match(&stage) && !node.is_match(&stage) {
        return Heredoc::Skip;
    }
    // The body: the lines up to the first line that is exactly the delimiter.
    let body_start = line_end + 1;
    let (mut cursor, mut term_start, mut term_end) = (body_start, None, text.len());
    while cursor <= text.len() {
        let nl = index_of_char(text, '\n', cursor);
        let stop = nl.unwrap_or(text.len());
        if string_of(ends_with_cr(&text[cursor.min(stop)..stop])) == delimiter {
            term_start = Some(cursor);
            term_end = stop;
            break;
        }
        let Some(nl) = nl else { break };
        cursor = nl + 1;
    }
    let Some(term_start) = term_start else { return Heredoc::Skip };
    let mut body = string_of(&text[body_start..term_start]);
    if let Some(stripped) = body.strip_suffix("\r\n").or_else(|| body.strip_suffix('\n')) {
        body = stripped.to_owned();
    }
    // `'@` at a line start would end the here-string early; an unquoted heredoc body is only
    // literal when bash would expand nothing in it.
    if lazy_re!(r"^'@", "m").is_match(&body) {
        return Heredoc::Skip;
    }
    if expanding && lazy_re!(r"[$`]|\\[\\$`\n]|\\$", "").is_match(&body) {
        return Heredoc::Skip;
    }
    let prefix = string_of(&before[..stage_from]);
    let gap = if !prefix.is_empty() && !prefix.chars().last().is_some_and(is_js_space) { " " } else { "" };
    let rest_part = if rest.is_empty() { String::new() } else { format!(" {}", mixdog_js::js_trim(&rest)) };
    let replacement = format!("{prefix}{gap}@'\n{body}\n'@ | {stage}{rest_part}");
    let mut out: Vec<char> = text[..line_start].to_vec();
    out.extend(replacement.chars());
    out.extend_from_slice(&text[term_end..]);
    let shown = if quoted { format!("'{delimiter}'") } else { delimiter.clone() };
    Heredoc::Done(out, format!("[rewritten: \"{stage} <<{shown}\" → \"@'…'@ | {stage}\"]"))
}

fn rewrite_heredocs(text: &str, notes: &mut Vec<String>) -> Option<String> {
    let mut current: Vec<char> = text.chars().collect();
    for _ in 0..20 {
        let mask = code_mask(&current)?;
        let at = (0..current.len().saturating_sub(1))
            .find(|&i| current[i] == '<' && current[i + 1] == '<' && mask[i]);
        let Some(at) = at else { return Some(string_of(&current)) };
        match rewrite_one_heredoc(&current, at) {
            Heredoc::Skip => return None,
            Heredoc::Done(next, note) => {
                notes.push(note);
                current = next;
            }
        }
    }
    None
}

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

/// All edits are computed on the code-only view and applied back to front.
fn collect_edits(text: &[char], mask: &[bool], notes: &mut Vec<String>) -> Vec<Edit> {
    let code = code_only(text, mask);
    let code_chars: Vec<char> = code.chars().collect();
    let mut edits = Vec::new();
    for m in lazy_re!(r"(>>?)[ \t]*/dev/null(?![\w/.\\-])", "g").captures_iter(&code) {
        let whole = m.range();
        let index = char_at_byte(&code, whole.start);
        let end = char_at_byte(&code, whole.end);
        // `&>` (both streams) and a 1>/2> stream prefix belong to the redirection.
        let before = index.checked_sub(1).map(|k| code_chars[k]);
        let two_back = index.checked_sub(2).map(|k| code_chars[k]);
        let prefixed = before == Some('&')
            || (matches!(before, Some('1' | '2'))
                && !two_back.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_'));
        let start = if prefixed { index - 1 } else { index };
        let stream = match (prefixed, before) {
            (true, Some('&')) => "*".to_owned(),
            (true, Some(c)) => c.to_string(),
            _ => String::new(),
        };
        let next = format!("{stream}{}$null", m.get(1).unwrap_or(">"));
        notes.push(format!("[rewritten: \"{}\" → \"{next}\"]", string_of(&text[start..end])));
        edits.push(Edit { start, end, text: next });
    }
    for m in lazy_re!(r"[ \t]*(?<!<)<[ \t]*/dev/null(?![\w/.\\-])", "g").find_iter(&code) {
        edits.push(Edit { start: char_at_byte(&code, m.start), end: char_at_byte(&code, m.end), text: String::new() });
        notes.push("[rewritten: \"</dev/null\" → \"\" (stdin is already at EOF)]".to_owned());
    }
    edits.sort_by(|a, b| b.start.cmp(&a.start));
    edits
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `rewritePowerShellBashisms` on 43 commands: rewritten text and note must be equal.
    #[test]
    fn the_rewrite_equals_nodes() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("testdata/bashism_node_vectors.json")).unwrap();
        assert_eq!(vectors.len(), 43);
        for v in &vectors {
            let command = v["command"].as_str().unwrap();
            let got = rewrite_powershell_bashisms(command);
            match (&v["result"], got) {
                (serde_json::Value::Null, None) => {}
                (want, Some((text, note))) if !want.is_null() => {
                    assert_eq!(want["command"].as_str(), Some(text.as_str()), "{command:?}");
                    assert_eq!(want["note"].as_str(), Some(note.as_str()), "{command:?}");
                }
                (want, got) => panic!("{command:?}: want {want:?}, got {got:?}"),
            }
        }
    }
}

/// `(command, note)` when something was rewritten, else `None`.
pub fn rewrite_powershell_bashisms(command: &str) -> Option<(String, String)> {
    if !command.contains("/dev/null") && !command.contains("<<") {
        return None;
    }
    let mut notes = Vec::new();
    let text = rewrite_heredocs(command, &mut notes)?;
    let chars: Vec<char> = text.chars().collect();
    let mask = code_mask(&chars)?;
    let mut out = chars.clone();
    for edit in collect_edits(&chars, &mask, &mut notes) {
        out.splice(edit.start..edit.end, edit.text.chars());
    }
    let out = string_of(&out);
    if out == command {
        return None;
    }
    let mut seen = Vec::new();
    for note in notes {
        if !seen.contains(&note) {
            seen.push(note);
        }
    }
    Some((out, seen.join("\n")))
}
