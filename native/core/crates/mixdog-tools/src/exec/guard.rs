//! Guards against shell-tool misuse (`bash-tool/misuse-guard.mjs`, `worktree-add-guard.mjs`), run
//! before policy, hooks and execution:
//!   1. a leading whole-second sleep of 2 s or more is rejected (a wait belongs to background +
//!      task wait);
//!   2. a plain leading `cd <dir>` moves into the `cwd` argument;
//!   3. a shell file read (cat/Get-Content/grep/ls …) gets a pointer to the read / grep / list
//!      tools — a note now;
//!   4. a command mentioning `git … worktree add` is rejected (worktrees go through the git
//!      tool; a textual check, so mentions as data are too).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_js::js_trim;

use super::benign::split_pipeline_segments;
use super::benign::split_segments;
use super::benign::tokenize;
use super::scan::decode_base64_lenient;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

pub const SHELL_FILE_READ_NOTE: &str = "Note: use the read / grep / list tools for files instead of the shell.";

const LEADING_SLEEP_MIN_SECONDS: f64 = 2.0;

/// Whole seconds of the sleep the command starts with.
fn leading_sleep_seconds(command: &str, powershell: bool) -> Option<f64> {
    let m = if powershell {
        lazy_re!(
            r"^\s*(?:start-sleep|sleep)[ \t]+(?:-s(?:e(?:c(?:o(?:n(?:d(?:s)?)?)?)?)?)?[ \t:]+)?(\d+)(?=\s*(?:$|;|&&|\r?\n))",
            "i"
        )
        .captures(command)
    } else {
        lazy_re!(r"^\s*sleep[ \t]+(\d+)(?=\s*(?:$|;|&&|\r?\n))", "").captures(command)
    }?;
    Some(mixdog_js::string_to_number(m.get(1)?))
}

fn leading_sleep_failure(command: &str, powershell: bool) -> Option<String> {
    let seconds = leading_sleep_seconds(command, powershell)?;
    if seconds < LEADING_SLEEP_MIN_SECONDS {
        return None;
    }
    let shown = mixdog_js::number_to_string(seconds);
    Some(super::shell::tool_failure(&format!(
        "Blocked: the leading sleep of {shown} s was not run. For a long-running command use background:true; its completion arrives automatically. To wait for a specific task when the result is needed now, use task wait — do not poll in a sleep loop. A deliberate delay under {} seconds is allowed.",
        LEADING_SLEEP_MIN_SECONDS as u32
    )))
}

/// `(dir, rest)` for a command that starts with a plain `cd <dir>` and more.
fn split_leading_cd(command: &str, powershell: bool) -> Option<(String, String)> {
    let m = lazy_re!(
        r#"^\s*(?:cd|set-location)\s+(?:-path\s+)?(?:"([^"$`]+)"|'([^'$`]+)'|([^\s;&|<>"'`$(){}*?[,@%#!]+))\s*(?:;|&&)\s*(\S[\s\S]*)$"#,
        "i"
    )
    .captures(command)?;
    let dir = m.get(1).or(m.get(2)).or(m.get(3))?;
    let rest = m.get(4)?;
    if lazy_re!(r"^(?:cd|set-location|pushd|popd)(?:\s|;|&|$)", "i").is_match(rest) {
        return None;
    }
    if js_trim(dir).is_empty() || dir.starts_with('-') {
        return None;
    }
    if powershell && lazy_re!(r"[*?[]", "").is_match(dir) {
        return None;
    }
    // `~user` is another account's home; a quoted `~` is a literal directory name.
    if dir.starts_with('~') && (m.get(3).is_none() || !lazy_re!(r"^~(?:[\\/]|$)", "").is_match(dir)) {
        return None;
    }
    // A POSIX backslash escapes; only single quotes keep it literal.
    if !powershell && m.get(2).is_none() && dir.contains('\\') {
        return None;
    }
    Some((dir.to_owned(), rest.to_owned()))
}

fn reader_tool(powershell: bool, name: &str) -> Option<&'static str> {
    if powershell {
        match name {
            "get-content" | "gc" | "cat" | "type" => Some("read"),
            "select-string" | "sls" | "rg" => Some("grep"),
            "get-childitem" | "gci" | "ls" | "dir" => Some("list"),
            _ => None,
        }
    } else {
        match name {
            "cat" | "head" | "tail" | "less" => Some("read"),
            "grep" | "rg" => Some("grep"),
            "ls" | "find" => Some("list"),
            _ => None,
        }
    }
}

const OPERAND_FLAGS: [&str; 7] = ["-path", "-literalpath", "-pattern", "-e", "--regexp", "-f", "--file"];
const VALUE_FLAGS: [&str; 8] = ["-encoding", "-filter", "-include", "-exclude", "-g", "--glob", "-t", "--type"];
const TEXT_FILTERS: [&str; 23] = [
    "select-object", "select", "select-string", "sls", "where-object", "sort-object", "sort",
    "measure-object", "format-table", "format-list", "ft", "fl", "out-string", "out-host", "head",
    "tail", "grep", "egrep", "rg", "wc", "uniq", "cut", "findstr",
];
const FIND_WRITERS: [&str; 8] = ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"];

fn command_name(token: &str) -> String {
    let lower = token.to_lowercase();
    let base = lower.rsplit(['\\', '/']).next().unwrap_or("");
    base.strip_suffix(".exe").unwrap_or(base).to_owned()
}

/// The path/pattern operands of a stage, or `None` when it writes a file.
fn stage_operands(args: &[String]) -> Option<Vec<String>> {
    let mut operands = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        if token == ">" || token == ">>" {
            let target = args.get(i + 1).map_or("", String::as_str);
            if !lazy_re!(r"^(?:&\d|\$null|/dev/null|nul)$", "i").is_match(target) {
                return None;
            }
            i += 2;
            continue;
        }
        let flag = token.to_lowercase();
        if flag.starts_with('-') && flag.chars().count() > 1 {
            if OPERAND_FLAGS.contains(&flag.as_str()) && i + 1 < args.len() {
                i += 1;
                operands.push(args[i].clone());
            } else if VALUE_FLAGS.contains(&flag.as_str()) {
                i += 1;
            }
            i += 1;
            continue;
        }
        // A bare count (`head -n 5`, `tail -n +5`) is a flag value, not an operand.
        if !lazy_re!(r"^[+-]?\d+$", "").is_match(token) {
            operands.push(token.clone());
        }
        i += 1;
    }
    Some(operands)
}

/// Whether the command's first statement starts with a read-only file command on a path.
fn is_shell_file_read(command: &str, powershell: bool) -> bool {
    let segments = split_segments(command);
    let Some(first) = segments.first() else { return false };
    let stages = split_pipeline_segments(first);
    let Some(tokens) = tokenize(stages.first().map_or("", String::as_str)) else { return false };
    let Some(head) = tokens.first() else { return false };
    let name = command_name(head);
    let Some(tool) = reader_tool(powershell, &name) else { return false };
    for stage in stages.iter().skip(1) {
        let first_word = js_trim(stage).split(is_js_space).next().unwrap_or("");
        if !TEXT_FILTERS.contains(&command_name(first_word).as_str()) {
            return false;
        }
    }
    let args = &tokens[1..];
    if name == "find" {
        let lowered: Vec<String> = args.iter().map(|t| t.to_lowercase()).collect();
        let names = lowered.iter().any(|t| ["-name", "-iname", "-path", "-regex"].contains(&t.as_str()));
        return names && !lowered.iter().any(|t| FIND_WRITERS.contains(&t.as_str()));
    }
    let Some(operands) = stage_operands(args) else { return false };
    // A search names its pattern and then the path it reads; with one operand it reads piped input.
    operands.len() >= if tool == "grep" { 2 } else { 1 }
}

// ---- worktree-add-guard.mjs ----

fn normalize_worktree(text: &str, joiner: &str) -> String {
    let continued = lazy_re!(r"[\\`]\r?\n", "g").replace_all_with(text, |_| joiner.to_owned());
    let hex = lazy_re!(r"\\x([0-9a-fA-F]{2})", "g").replace_all_with(&continued, |m| {
        u8::from_str_radix(m.get(1).unwrap_or("0"), 16).map_or(String::new(), |b| char::from(b).to_string())
    });
    let dollar = lazy_re!(r#"\$(?=['"])"#, "g").replace_all_with(&hex, |_| String::new());
    let escapes = lazy_re!(r"[`^]", "g").replace_all_with(&dollar, |_| String::new());
    let quotes = lazy_re!("['\"\u{2018}\u{2019}\u{201a}\u{201b}\u{201c}\u{201d}\u{201e}]", "g")
        .replace_all_with(&escapes, |_| String::new());
    lazy_re!(r"\s+", "g").replace_all_with(&quotes, |_| " ".to_owned())
}

/// `text.split(/[\s,]+/)`.
fn split_tokens(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut in_sep) = (0, false);
    for (i, c) in text.char_indices() {
        let sep = c == ',' || is_js_space(c);
        if sep && !in_sep {
            out.push(&text[start..i]);
            in_sep = true;
        } else if !sep && in_sep {
            start = i;
            in_sep = false;
        }
    }
    out.push(if in_sep { "" } else { &text[start..] });
    out
}

/// Some `git` word comes before a `worktree … add`; options between them are skipped.
fn git_then_worktree_add(text: &str) -> bool {
    let tokens = split_tokens(text);
    let mut git_seen = false;
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i];
        if !git_seen {
            git_seen = lazy_re!(r"\bgit\b", "i").is_match(token);
            i += 1;
            continue;
        }
        if token.starts_with('-') || !lazy_re!(r"(?:^|[^\w-])worktree$", "i").is_match(token) {
            i += 1;
            continue;
        }
        let mut next = i + 1;
        while next < tokens.len() && tokens[next].starts_with('-') {
            next += 1;
        }
        if next < tokens.len() && lazy_re!(r"^add\b", "i").is_match(tokens[next]) {
            return true;
        }
        i = next;
    }
    false
}

/// `addsUnmanagedWorktree`: the command would (or might) run `git … worktree add`.
pub fn adds_unmanaged_worktree(command: &str) -> bool {
    let mut texts = vec![command.to_owned()];
    for m in lazy_re!(r#"(?:^|[\s'"])[-/]e(?:c|n[a-z]*)?\s+['"]?([A-Za-z0-9+/]{4,}={0,2})"#, "gi")
        .captures_iter(command)
    {
        let bytes = decode_base64_lenient(m.get(1).unwrap_or("").as_bytes());
        let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        texts.push(String::from_utf16_lossy(&units));
    }
    texts.iter().any(|text| {
        ["", " "].iter().any(|joiner| {
            let normalized = normalize_worktree(text, joiner);
            // A backslash is a POSIX escape (`a\dd` is `add`) or a Windows path separator.
            let dropped = lazy_re!(r"\\(?=[A-Za-z])", "g").replace_all_with(&normalized, |_| String::new());
            git_then_worktree_add(&dropped) || git_then_worktree_add(&normalized.replace('\\', "/"))
        })
    })
}

const SHELL_WORKTREE_ADD_BLOCK: &str = "Blocked: this shell command mentions `git … worktree add`, which does not run from the shell; Mixdog manages worktrees so they are cleaned up. To create one, use the git tool: command \"git worktree add --detach <path> [<commit>]\" makes a read-only snapshot (removed when the turn ends; delegated workers too), and the Lead uses \"git worktree add -b <branch> <path>\" or action:\"worktree\" for a branch worktree. The check is textual: to search for that text use the grep tool, and keep the phrase out of shell commands (echo, commit messages, heredocs).";

/// What the guards decided for one call.
#[derive(Debug, PartialEq, Eq)]
pub enum Guarded {
    /// The call is refused; the text is the whole result.
    Refused(String),
    /// The call runs with this command and cwd (a leading `cd` moved into `cwd`) and these
    /// lines added to its result.
    Run { command: String, cwd: Option<String>, notes: Vec<String> },
}

/// Applies the four guards to a shell call.
pub fn guard_shell_call(command: &str, cwd: Option<&str>, background: bool, powershell: bool) -> Guarded {
    let mut notes = Vec::new();
    let (mut command, mut cwd) = (command.to_owned(), cwd.map(str::to_owned));
    if cwd.is_none() {
        if let Some((dir, rest)) = split_leading_cd(&command, powershell) {
            notes.push(format!("Moved `cd {dir}` into cwd."));
            command = rest;
            cwd = Some(dir);
        }
    }
    if !background {
        if let Some(failure) = leading_sleep_failure(&command, powershell) {
            return Guarded::Refused(failure);
        }
    }
    if adds_unmanaged_worktree(&command) {
        return Guarded::Refused(super::shell::tool_failure(SHELL_WORKTREE_ADD_BLOCK));
    }
    if is_shell_file_read(&command, powershell) {
        notes.push(SHELL_FILE_READ_NOTE.to_owned());
    }
    Guarded::Run { command, cwd, notes }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Node's `guardShellCall` on 58 calls × both shell families, notes and refusals equal.
    #[test]
    fn the_guard_equals_nodes() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("testdata/guard_node_vectors.json")).unwrap();
        assert_eq!(vectors.len(), 116);
        for v in &vectors {
            let args = &v["args"];
            let command = args["command"].as_str().unwrap();
            let powershell = v["shellType"] == "powershell";
            let got = guard_shell_call(
                command,
                args["cwd"].as_str(),
                args["background"] == true,
                powershell,
            );
            let want = &v["result"];
            match got {
                Guarded::Refused(text) => assert_eq!(want["failure"].as_str(), Some(text.as_str()), "{args} {powershell}"),
                Guarded::Run { command, cwd, notes } => {
                    assert!(want["failure"].is_null(), "{args} {powershell}: {want}");
                    assert_eq!(want["args"]["command"].as_str(), Some(command.as_str()), "{args} {powershell}");
                    assert_eq!(want["args"]["cwd"].as_str(), cwd.as_deref(), "{args} {powershell}");
                    let want_notes: Vec<&str> =
                        want["notes"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
                    assert_eq!(want_notes, notes, "{args} {powershell}");
                }
            }
        }
    }
}
