//! PowerShell-specific text of the shell tool: the one-line hint for a failed bash-ism
//! (`result-format.mjs` `_powershellBashismHint`) and the rewrite of the deprecated
//! `wmic process … get …` probe into a bounded PowerShell/CIM command
//! (`shell-policy.mjs` `maybeRewriteWmicProcessCommand`).

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::js_trim;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

const UNIX_EQUIVALENTS: [(&str, &str); 7] = [
    ("head", "Select-Object -First N"),
    ("tail", "Select-Object -Last N"),
    ("wc", "Measure-Object -Line"),
    ("grep", "the grep tool"),
    ("sed", "the edit tool"),
    ("awk", "ForEach-Object / the edit tool"),
    ("pgrep", "Get-Process -Name <name>"),
];

fn missing_command_names(err: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    if lazy_re!(r"\bCommandNotFoundException\b", "").is_match(err) {
        for m in lazy_re!(r"\bObjectNotFound: \(([\w.-]+):String\)", "g").captures_iter(err) {
            names.extend(m.get(1).map(str::to_owned));
        }
    }
    for m in lazy_re!(r"^([\w.-]+): ?\r?\n?((?:.*\r?\n){0,4})", "gm").captures_iter(err) {
        let (name, rest) = (m.get(1).unwrap_or(""), m.get(2).unwrap_or(""));
        if rest.contains(&format!("'{name}'")) {
            names.push(name.to_owned());
        }
    }
    names
}

/// A one-line PowerShell equivalent for a failed command whose stderr is the shell's own
/// bash-ism error; empty when nothing applies. Only meaningful on Windows.
pub fn powershell_bashism_hint(command: &str, stderr: &str) -> String {
    let parser_rejected =
        lazy_re!(r"^ParserError:|\b(?:RedirectionNotSupported|MissingFileSpecification)\b", "m").is_match(stderr);
    if lazy_re!(r"<\s*/dev/null", "").is_match(command) && parser_rejected {
        return "hint: PowerShell has no `<` redirection; drop </dev/null.".to_owned();
    }
    if lazy_re!(r#"<<-?\s*['"]?\w+"#, "").is_match(command) && parser_rejected {
        return "hint: PowerShell has no heredoc; use @'\\n…\\n'@ | python - (or node -).".to_owned();
    }
    if lazy_re!(r"2>\s*/dev/null", "").is_match(command) && lazy_re!(r"dev\\null", "i").is_match(stderr) {
        return "hint: use 2>$null in PowerShell.".to_owned();
    }
    for name in missing_command_names(stderr) {
        let key = name.to_lowercase();
        let Some((_, equivalent)) = UNIX_EQUIVALENTS.iter().find(|(k, _)| *k == key) else { continue };
        let at_word = JsRegex::new_static(&format!(r"(^|[\s|;&(]){key}(\s|$)"), "");
        if at_word.is_match(command) {
            return format!("hint: no `{key}` in PowerShell; use {equivalent}.");
        }
    }
    String::new()
}

/// The rewritten command, its hard deadline and the note that tells the caller what ran.
#[derive(Debug, PartialEq, Eq)]
pub struct WmicRewrite {
    pub command: String,
    pub timeout_ms: u64,
    pub note: String,
}

const DEFAULT_FIELDS: [&str; 5] = ["ProcessId", "Name", "CreationDate", "ExecutablePath", "CommandLine"];
const FIELD_MAP: [(&str, &str); 9] = [
    ("processid", "ProcessId"),
    ("name", "Name"),
    ("creationdate", "CreationDate"),
    ("executablepath", "ExecutablePath"),
    ("commandline", "CommandLine"),
    ("parentprocessid", "ParentProcessId"),
    ("workingsetsize", "WorkingSetSize"),
    ("threadcount", "ThreadCount"),
    ("handlecount", "HandleCount"),
];

fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn ps_array(values: &[String]) -> String {
    format!("@({})", values.iter().map(|v| ps_quote(v)).collect::<Vec<_>>().join(", "))
}

fn base64_utf16le(script: &str) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |acc, (i, b)| acc | (u32::from(*b) << (16 - 8 * i)));
        for k in 0..4 {
            if k <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * k)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn wmic_fields(normalized: &str) -> Vec<String> {
    let defaults = || DEFAULT_FIELDS.iter().map(|f| (*f).to_owned()).collect();
    let Some(m) = lazy_re!(r#"\bget\s+([\s\S]+?)(?:\s+/format:\w+)?\s*["']?\s*$"#, "i").captures(normalized)
    else {
        return defaults();
    };
    let mut fields: Vec<String> = Vec::new();
    for raw in m.get(1).unwrap_or("").split(|c: char| c == ',' || mixdog_js::is_js_space(c)) {
        let key: String = js_trim(raw).chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if let Some((_, field)) = FIELD_MAP.iter().find(|(k, _)| *k == key.to_lowercase()) {
            if !fields.iter().any(|f| f == field) {
                fields.push((*field).to_owned());
            }
        }
    }
    if fields.is_empty() { defaults() } else { fields }
}

/// `None` for a command that is not a plain `wmic process` call (composite commands keep their
/// surrounding context); `Err` for the probe without a `get`.
pub fn rewrite_wmic_process(text: &str) -> Option<Result<WmicRewrite, String>> {
    if !lazy_re!(
        r#"^\s*(?:&\s*)?(?:cmd(?:\.exe)?\s+/c\s+["']?)?(?:\S*[\\/])?wmic(?:\.exe)?\s+process\b"#,
        "i"
    )
    .is_match(text)
        || lazy_re!(r"[|&;]|\$\(|`", "").is_match(text)
    {
        return None;
    }
    if !lazy_re!(r"\bget\b", "i").is_match(text) {
        return Some(Err("wmic process commands are disabled because WMIC can stall for minutes; use PowerShell Get-CimInstance/Get-Process instead.".to_owned()));
    }
    let normalized = text.replace("\\\"", "\"");
    let mut names: Vec<String> = Vec::new();
    for m in lazy_re!(r#"\bname\s*=\s*['"]([^'"]+)['"]"#, "gi").captures_iter(&normalized) {
        let name = m.get(1).unwrap_or("").to_owned();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    let mut pids: Vec<u64> = Vec::new();
    for m in lazy_re!(r"\bprocessid\s*=\s*(\d+)", "gi").captures_iter(&normalized) {
        if let Some(pid) = m.get(1).and_then(|p| p.parse().ok()) {
            if !pids.contains(&pid) {
                pids.push(pid);
            }
        }
    }
    let fields = wmic_fields(&normalized);
    let mut setup = vec![format!("$fields = {}", ps_array(&fields))];
    let mut filters = Vec::new();
    if !names.is_empty() {
        setup.push(format!("$names = {}", ps_array(&names)));
        filters.push("($names -contains $_.Name)");
    }
    if !pids.is_empty() {
        let list = pids.iter().map(u64::to_string).collect::<Vec<_>>().join(", ");
        setup.push(format!("$pids = @({list})"));
        filters.push("($pids -contains [int]$_.ProcessId)");
    }
    let filter = if filters.is_empty() { String::new() } else { format!(" | Where-Object {{ {} }}", filters.join(" -or ")) };
    let mut script = setup;
    script.push("$ErrorActionPreference = 'Stop'".to_owned());
    script.push(format!("Get-CimInstance Win32_Process{filter} | Select-Object -Property $fields | Format-List"));
    Some(Ok(WmicRewrite {
        command: format!("powershell.exe -NoProfile -EncodedCommand {}", base64_utf16le(&script.join("; "))),
        timeout_ms: 30_000,
        note: "[auto-rewrite: deprecated wmic process query -> PowerShell Get-CimInstance; timeout capped at 30000ms]".to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/psfix_node_vectors.json")).unwrap()
    }

    /// Node's `maybeRewriteWmicProcessCommand` on 12 commands: the result must be equal.
    #[test]
    fn the_wmic_rewrite_equals_nodes() {
        let vectors = vectors();
        let cases = vectors["wmic"].as_array().unwrap();
        assert_eq!(cases.len(), 12);
        for case in cases {
            let command = case["command"].as_str().unwrap();
            let got = rewrite_wmic_process(command);
            let want = &case["result"];
            match got {
                None => assert!(want.is_null(), "{command:?}"),
                Some(Err(error)) => assert_eq!(want["error"].as_str(), Some(error.as_str()), "{command:?}"),
                Some(Ok(r)) => {
                    assert_eq!(want["command"].as_str(), Some(r.command.as_str()), "{command:?}");
                    assert_eq!(want["timeoutMs"].as_u64(), Some(r.timeout_ms), "{command:?}");
                    assert_eq!(want["note"].as_str(), Some(r.note.as_str()), "{command:?}");
                }
            }
        }
    }

    /// Node's `_powershellBashismHint` on 10 command/stderr pairs.
    #[test]
    fn the_bashism_hint_equals_nodes() {
        let vectors = vectors();
        let cases = vectors["hints"].as_array().unwrap();
        assert_eq!(cases.len(), 10);
        for case in cases {
            let (command, stderr) = (case["command"].as_str().unwrap(), case["stderr"].as_str().unwrap());
            assert_eq!(powershell_bashism_hint(command, stderr), case["hint"].as_str().unwrap(), "{command:?} {stderr:?}");
        }
    }
}
