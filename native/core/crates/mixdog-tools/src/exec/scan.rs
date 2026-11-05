//! Shell command scanning shared by the destructive-command warning and the exec policy: quote and
//! heredoc stripping, a shell-aware tokenizer, wrapper peeling and extraction of the payloads a
//! command embeds (`sh -c`, `xargs`, `find -exec`, `powershell -Command`, heredocs).
//!
//! Ported from the Node product's `destructive-warning.mjs`, `shell-powershell.mjs` and
//! `shell-policy.mjs`; the patterns are ASCII-only like JavaScript's non-unicode regexes.

use std::sync::LazyLock;

pub const SHELL_NAMES: [&str; 6] = ["bash", "sh", "zsh", "dash", "ksh", "ash"];

/// Wrapper programs that transparently exec their first non-option argument.
pub const WRAPPER_NAMES: [&str; 14] = [
    "env", "sudo", "doas", "pkexec", "gsudo", "nice", "stdbuf", "chronic", "time", "timeout",
    "nohup", "setpriv", "ionice", "taskset",
];

pub use mixdog_js::Caps;
pub use mixdog_js::JsRegex;
pub use mixdog_js::is_js_space;
pub use mixdog_js::js_trim;
pub use mixdog_js::js_words;

/// Case-insensitive pattern (JavaScript `i` flag).
pub fn ci(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "i")
}

/// Case-sensitive pattern.
pub fn cs(pattern: &str) -> JsRegex {
    JsRegex::new_static(pattern, "")
}

pub fn is_shell_name(token: &str) -> bool {
    SHELL_NAMES.contains(&token)
}

pub fn is_wrapper_name(token: &str) -> bool {
    WRAPPER_NAMES.contains(&token)
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// A `#` (or PowerShell `<#`) starts a comment only at the start of a word.
fn is_comment_start(t: &[char], i: usize) -> bool {
    i == 0 || {
        let p = t[i - 1];
        is_js_space(p) || matches!(p, ';' | '&' | '|' | '(')
    }
}

static PS_HERE_SQ: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r"^@'[ \t]*\r?\n[\s\S]*?\r?\n'@"));
static PS_HERE_DQ: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r#"^@"[ \t]*\r?\n[\s\S]*?\r?\n"@"#));
static HEREDOC_START: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r#"^<<-?\s*['"]?([A-Za-z0-9_]+)['"]?"#));

/// `\n<delim>\b` searched from `from`; the match's start and end.
fn find_delimiter(t: &[char], from: usize, delim: &str) -> Option<(usize, usize)> {
    let d: Vec<char> = delim.chars().collect();
    let mut i = from;
    while i < t.len() {
        if t[i] == '\n' && t[i + 1..].starts_with(&d) {
            let end = i + 1 + d.len();
            if end >= t.len() || !is_word(t[end]) {
                return Some((i, end));
            }
        }
        i += 1;
    }
    None
}

fn closing_quote(t: &[char], from: usize, quote: char, escapes: bool) -> Option<usize> {
    let mut j = from;
    while j < t.len() && t[j] != quote {
        j += if escapes && t[j] == '\\' { 2 } else { 1 };
    }
    (j < t.len()).then_some(j)
}

fn index_of(t: &[char], needle: &[char], from: usize) -> Option<usize> {
    (from..t.len()).find(|&i| t[i..].starts_with(needle))
}

fn rest_string(t: &[char], i: usize) -> String {
    t[i..].iter().collect()
}

/// Single left-to-right scan so each construct is recognised by what the shell would see at that
/// position. Any construct that cannot be closed is left in the output verbatim, so uncertain
/// text stays visible to the policy checks instead of being dropped.
pub fn strip_quoted_and_heredoc(s: &str) -> String {
    let t: Vec<char> = s.chars().collect();
    let n = t.len();
    let mut pending: Vec<String> = Vec::new();
    let mut out = String::new();
    let mut i = 0;
    while i < n {
        let ch = t[i];
        if ch == '\\' {
            out.push(ch);
            if i + 1 < n {
                out.push(t[i + 1]);
            }
            i += 2;
            continue;
        }
        if ch == '@' && i + 1 < n && (t[i + 1] == '\'' || t[i + 1] == '"') {
            let re = if t[i + 1] == '\'' { &PS_HERE_SQ } else { &PS_HERE_DQ };
            let rest = rest_string(&t, i);
            if let Some(m) = re.find(&rest) {
                out.push_str(if t[i + 1] == '\'' { "''" } else { "\"\"" });
                i += rest[m].chars().count();
                continue;
            }
        }
        if ch == '<' && i + 1 < n && t[i + 1] == '<' && (i == 0 || t[i - 1] != '<') {
            let rest = rest_string(&t, i);
            if let Some(caps) = HEREDOC_START.captures(&rest) {
                let whole = caps.get(0).map_or(0, |m| m.chars().count());
                let delim = caps.get(1).unwrap_or_default().to_owned();
                if find_delimiter(&t, i + whole, &delim).is_some() {
                    pending.push(delim);
                    out.push_str("<<HEREDOC>>");
                    i += whole;
                    continue;
                }
            }
        }
        if ch == '<' && i + 1 < n && t[i + 1] == '#' && is_comment_start(&t, i) {
            if let Some(end) = index_of(&t, &['#', '>'], i + 2) {
                out.push(' ');
                i = end + 2;
                continue;
            }
        }
        if ch == '#' && is_comment_start(&t, i) {
            i = (i..n).find(|&k| t[k] == '\n').unwrap_or(n);
            continue;
        }
        if ch == '\'' || ch == '"' || (ch == '$' && i + 1 < n && t[i + 1] == '\'') {
            let ansi_c = ch == '$';
            let quote = if ansi_c { '\'' } else { ch };
            let open = if ansi_c { i + 2 } else { i + 1 };
            if let Some(close) = closing_quote(&t, open, quote, ch != '\'') {
                if ansi_c {
                    out.push('$');
                }
                out.push(quote);
                out.push(quote);
                i = close + 1;
                continue;
            }
        }
        if ch == '\n' && !pending.is_empty() {
            let mut at = i;
            let mut found = true;
            for delim in &pending {
                match find_delimiter(&t, at, delim) {
                    Some((_, end)) => at = end,
                    None => {
                        found = false;
                        break;
                    }
                }
            }
            pending.clear();
            if found {
                i = at;
                continue;
            }
        }
        out.push(ch);
        i += 1;
    }
    out
}

static HEREDOC_BODY: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r#"<<-?\s*['"]?([A-Za-z0-9_]+)['"]?"#));

/// Heredoc bodies (shell-exec contexts route the body through scanning).
pub fn extract_heredoc_bodies(s: &str) -> Vec<String> {
    let t: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut from = 0;
    loop {
        let rest = rest_string(&t, from);
        let Some(m) = HEREDOC_BODY.captures(&rest) else { break };
        let whole = m.range();
        let start = from + s_chars(&rest[..whole.start]);
        let body_start = start + rest[whole].chars().count();
        match find_delimiter(&t, body_start, m.get(1).unwrap_or_default()) {
            Some((at, end)) => {
                out.push(t[body_start..at].iter().collect());
                from = end;
            }
            None => from = start + 1,
        }
        if from >= t.len() {
            break;
        }
    }
    out
}

fn s_chars(s: &str) -> usize {
    s.chars().count()
}

/// Shell-aware tokenizer. Quoted spans stay intact; separators become their own token.
pub fn tokenize(s: &str) -> Vec<String> {
    let src: Vec<char> = s.chars().collect();
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    while i < src.len() {
        let c = src[i];
        if c == '\'' {
            match (i + 1..src.len()).find(|&k| src[k] == '\'') {
                None => {
                    cur.push(c);
                    i += 1;
                }
                Some(e) => {
                    cur.extend(&src[i..=e]);
                    i = e + 1;
                }
            }
            continue;
        }
        if c == '"' {
            let mut j = i + 1;
            while j < src.len() {
                if src[j] == '\\' && j + 1 < src.len() {
                    j += 2;
                    continue;
                }
                if src[j] == '"' {
                    break;
                }
                j += 1;
            }
            if j >= src.len() {
                cur.push(c);
                i += 1;
            } else {
                cur.extend(&src[i..=j]);
                i = j + 1;
            }
            continue;
        }
        if c == '\\' && i + 1 < src.len() {
            cur.push(src[i]);
            cur.push(src[i + 1]);
            i += 2;
            continue;
        }
        if cur.is_empty() && c == '#' {
            i = (i..src.len()).find(|&k| src[k] == '\n').unwrap_or(src.len());
            continue;
        }
        if cur.is_empty() && c == '<' && i + 1 < src.len() && src[i + 1] == '#' {
            if let Some(end) = index_of(&src, &['#', '>'], i + 2) {
                i = end + 2;
                continue;
            }
        }
        if c == ' ' || c == '\t' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            i += 1;
            continue;
        }
        if c == '\n' || c == ';' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            tokens.push(c.to_string());
            i += 1;
            continue;
        }
        if c == '&' || c == '|' {
            if !cur.is_empty() {
                tokens.push(std::mem::take(&mut cur));
            }
            if i + 1 < src.len() && src[i + 1] == c {
                tokens.push(format!("{c}{c}"));
                i += 2;
            } else {
                tokens.push(c.to_string());
                i += 1;
            }
            continue;
        }
        cur.push(c);
        i += 1;
    }
    if !cur.is_empty() {
        tokens.push(cur);
    }
    tokens
}

pub fn split_segments(tokens: &[String]) -> Vec<Vec<String>> {
    let mut segs = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    for t in tokens {
        if matches!(t.as_str(), ";" | "&" | "&&" | "|" | "||" | "\n") {
            if !cur.is_empty() {
                segs.push(std::mem::take(&mut cur));
            }
        } else {
            cur.push(t.clone());
        }
    }
    if !cur.is_empty() {
        segs.push(cur);
    }
    segs
}

pub fn strip_quotes(t: &str) -> &str {
    let b = t.as_bytes();
    if b.len() >= 2 {
        let (a, z) = (b[0], b[b.len() - 1]);
        if (a == b'\'' && z == b'\'') || (a == b'"' && z == b'"') {
            return &t[1..t.len() - 1];
        }
    }
    t
}

static ASSIGNMENT: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^[A-Za-z_][A-Za-z0-9_]*="));
static DURATION: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^(?:\d+[smhd]?|\d+m\d+s?)$"));
static LONG_OPT: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^--[A-Za-z0-9][A-Za-z0-9_-]*$"));

pub fn is_assignment(t: &str) -> bool {
    ASSIGNMENT.is_match(t)
}

fn is_flag(t: &str) -> bool {
    t.starts_with('-') || t.starts_with('+')
}

/// Skips env-var assignments and known wrapper commands (with their option arguments) so the
/// underlying program reaches classification.
pub fn peel_wrappers(tokens: &[String]) -> &[String] {
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        if is_assignment(t) {
            i += 1;
            continue;
        }
        if is_wrapper_name(t) {
            i += 1;
            while i < tokens.len() && (is_flag(&tokens[i]) || DURATION.is_match(&tokens[i])) {
                if LONG_OPT.is_match(&tokens[i])
                    && i + 1 < tokens.len()
                    && !is_flag(&tokens[i + 1])
                    && !is_assignment(&tokens[i + 1])
                {
                    i += 2;
                    continue;
                }
                i += 1;
            }
            continue;
        }
        break;
    }
    &tokens[i..]
}

static AWK_SYSTEM_SQ: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r"system\s*\(\s*'([\s\S]*?)'\s*\)"));
static AWK_SYSTEM_DQ: LazyLock<JsRegex> =
    LazyLock::new(|| cs(r#"system\s*\(\s*"([\s\S]*?)"\s*\)"#));

/// Leaf commands that embed an inner command or payload, surfaced as a synthetic command string.
fn collect_leaf_embedded_payloads(peeled: &[String], out: &mut Vec<String>) {
    let leaf = peeled[0].as_str();
    match leaf {
        "xargs" | "parallel" => {
            let mut j = 1;
            while j < peeled.len() && is_flag(&peeled[j]) {
                if LONG_OPT.is_match(&peeled[j])
                    && j + 1 < peeled.len()
                    && !is_flag(&peeled[j + 1])
                {
                    j += 2;
                    continue;
                }
                j += 1;
            }
            if j < peeled.len() {
                out.push(peeled[j..].iter().map(|t| strip_quotes(t)).collect::<Vec<_>>().join(" "));
            }
        }
        "find" => {
            let mut j = 1;
            while j < peeled.len() {
                if peeled[j] == "-exec" || peeled[j] == "-execdir" {
                    let mut cmd = Vec::new();
                    let mut k = j + 1;
                    while k < peeled.len() && !matches!(peeled[k].as_str(), ";" | "\\;" | "+") {
                        cmd.push(strip_quotes(&peeled[k]));
                        k += 1;
                    }
                    if !cmd.is_empty() {
                        out.push(cmd.join(" "));
                    }
                    j = k;
                }
                j += 1;
            }
        }
        "awk" => {
            let mut j = 1;
            while j < peeled.len() {
                let t = peeled[j].as_str();
                if matches!(t, "-f" | "-v" | "-F") {
                    j += 2;
                    continue;
                }
                if t.starts_with('-') {
                    j += 1;
                    continue;
                }
                let body = strip_quotes(t);
                let sq = AWK_SYSTEM_SQ.captures(body);
                let dq = AWK_SYSTEM_DQ.captures(body);
                let pick = match (sq, dq) {
                    (Some(a), Some(b)) => {
                        Some(if a.range().start <= b.range().start { a } else { b })
                    }
                    (a, b) => a.or(b),
                };
                if let Some(m) = pick {
                    out.push(m.get(1).unwrap_or_default().to_owned());
                }
                break;
            }
        }
        "perl" | "node" | "python" | "python3" => {
            let flag = if leaf == "python" || leaf == "python3" { "-c" } else { "-e" };
            let mut j = 1;
            while j < peeled.len() {
                let t = peeled[j].as_str();
                if t == flag || (leaf == "perl" && t == "-E") {
                    if let Some(arg) = peeled.get(j + 1) {
                        if !arg.is_empty() {
                            out.push(strip_quotes(arg).to_owned());
                        }
                    }
                    break;
                }
                if t.starts_with('-') {
                    j += 1;
                    continue;
                }
                break;
            }
        }
        _ => {}
    }
}

static COMBINED_C: LazyLock<JsRegex> = LazyLock::new(|| cs(r"^-[a-zA-Z]+c$"));

/// `-c <payload>` (and `--command <payload>`) of shell invocations, including combined short
/// flags like `-lc`, plus the payloads leaf commands embed.
pub fn extract_shell_c_inner(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    for seg in split_segments(&tokenize(s)) {
        let peeled = peel_wrappers(&seg);
        if peeled.is_empty() {
            continue;
        }
        if !is_shell_name(&peeled[0]) {
            collect_leaf_embedded_payloads(peeled, &mut out);
            continue;
        }
        let mut i = 1;
        while i < peeled.len() {
            let t = peeled[i].as_str();
            if t == "-c" || t == "--command" || COMBINED_C.is_match(t) {
                if let Some(arg) = peeled.get(i + 1) {
                    if !arg.is_empty() {
                        out.push(strip_quotes(arg).to_owned());
                    }
                }
                break;
            }
            if matches!(t, "--rcfile" | "--init-file" | "-O" | "+O") {
                i += 2;
                continue;
            }
            if is_flag(t) {
                i += 1;
                continue;
            }
            break;
        }
    }
    out
}

const POWERSHELL_FLAGS: &str =
    r"\s+-(?:NoProfile|NonInteractive|WindowStyle\s+\S+|ExecutionPolicy\s+\S+|Sta|Mta|NoLogo|NoExit)";
const POWERSHELL_TRAILING: &str = r"[ \t]*(?:$|[\r\n;|&<>]|\d+>)";

static POWERSHELL_DOUBLE: LazyLock<JsRegex> =LazyLock::new(|| {
    ci(&format!(
        r#"\b(powershell(?:\.exe)?|pwsh(?:\.exe)?)((?:{POWERSHELL_FLAGS})*)\s+(?:-Command|-c)\s+"((?:[^"\\]|\\.|"")+?)"(?:{POWERSHELL_TRAILING})"#
    ))
});
static POWERSHELL_SINGLE: LazyLock<JsRegex> =LazyLock::new(|| {
    ci(&format!(
        r#"\b(powershell(?:\.exe)?|pwsh(?:\.exe)?)((?:{POWERSHELL_FLAGS})*)\s+(?:-Command|-c)\s+'((?:[^'\\]|\\.|'')+?)'(?:{POWERSHELL_TRAILING})"#
    ))
});

fn unescape_powershell_body(body: &str) -> String {
    body.replace("\"\"", "\"")
        .replace("\\\"", "\"")
        .replace("''", "'")
        .replace("\\'", "'")
}

/// Inline `powershell -Command "…"` bodies, for policy scan parity.
pub fn extract_powershell_command_inner(command: &str) -> Vec<String> {
    let mut out = Vec::new();
    for re in [&*POWERSHELL_DOUBLE, &*POWERSHELL_SINGLE] {
        for caps in re.captures_iter(command) {
            let unescaped = unescape_powershell_body(caps.get(3).unwrap_or_default());
            if !js_trim(&unescaped).is_empty() {
                out.push(unescaped);
            }
        }
    }
    out
}

static ENCODED_COMMAND: LazyLock<JsRegex> =LazyLock::new(|| {
    ci(concat!(
        r#"(?:^|\s)(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:[-/](?:NoP(?:rofile)?|NoL(?:ogo)?|NonI(?:nteractive)?|Sta|Mta|(?:ExecutionPolicy|Ep|Ex)\s+\S+|(?:WindowStyle|Win|W)\s+\S+|(?:InputFormat|Inp|If)\s+\S+|(?:OutputFormat|Out|Of)\s+\S+|Command|(?:File|Fi)\s+\S+|(?:Version|Ver)\s+\S+)\s+)*"#,
        r#"[-/](?:EncodedCommand|enc|e)\s+["']?([A-Za-z0-9+/=]+)["']?"#
    ))
});

fn base64_value(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Node's lenient `Buffer.from(text, 'base64')`: stops at the first `=`, ignores a dangling sextet.
pub fn decode_base64_lenient(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in text {
        let Some(v) = base64_value(c) else { break };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// The decoded text of every `-EncodedCommand` payload (UTF-16LE), joined by newlines.
pub fn decode_powershell_encoded_command(command: &str) -> Option<String> {
    let decoded: Vec<String> = ENCODED_COMMAND
        .captures_iter(command)
        .map(|caps| {
            let bytes = decode_base64_lenient(caps.get(1).unwrap_or_default().as_bytes());
            let units: Vec<u16> = bytes
                .chunks_exact(2)
                .map(|p| u16::from_le_bytes([p[0], p[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        })
        .collect();
    (!decoded.is_empty()).then(|| decoded.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_comments_and_heredoc_bodies_are_blanked() {
        assert_eq!(strip_quoted_and_heredoc("echo 'shutdown now'"), "echo ''");
        assert_eq!(strip_quoted_and_heredoc("echo \"a\\\"b\" # shutdown"), "echo \"\" ");
        assert_eq!(
            strip_quoted_and_heredoc("cat <<EOF\nshutdown\nEOF\nls"),
            "cat <<HEREDOC>>\nls"
        );
        assert_eq!(strip_quoted_and_heredoc("echo 'open"), "echo 'open");
    }

    #[test]
    fn shell_payloads_are_extracted() {
        assert_eq!(extract_shell_c_inner("sudo bash -lc 'rm -rf /'"), vec!["rm -rf /"]);
        assert_eq!(extract_shell_c_inner("find . -exec rm -rf {} ;"), vec!["rm -rf {}"]);
        assert_eq!(
            extract_powershell_command_inner("pwsh -NoProfile -Command \"Remove-Item x\""),
            vec!["Remove-Item x"]
        );
    }

    #[test]
    fn an_encoded_command_is_decoded() {
        // "shutdown" in UTF-16LE.
        let units: Vec<u8> = "shutdown".encode_utf16().flat_map(u16::to_le_bytes).collect();
        let b64 = {
            const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
            let mut s = String::new();
            for chunk in units.chunks(3) {
                let n = chunk.iter().enumerate().fold(0u32, |a, (i, b)| a | (u32::from(*b) << (16 - 8 * i)));
                for k in 0..=chunk.len() {
                    s.push(A[((n >> (18 - 6 * k)) & 63) as usize] as char);
                }
            }
            s
        };
        assert_eq!(
            decode_powershell_encoded_command(&format!("powershell -enc {b64}")).as_deref(),
            Some("shutdown")
        );
    }
}
