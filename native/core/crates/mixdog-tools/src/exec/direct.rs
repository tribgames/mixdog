//! Direct native spawns. Windows + PowerShell only: a simple
//! native `.exe` (`git status`, `node -e …`) skips the ~330 ms PowerShell/.NET/AMSI startup.
//! Anything that needs a shell stays on PowerShell: operators, expansion, cmdlets, aliases, and
//! `.cmd`/`.bat`/`.ps1` wrappers. The file probes run as lane jobs.
#![allow(clippy::disallowed_methods, reason = "lane job bodies are the sanctioned home of blocking file I/O (clippy.toml)")]

use std::collections::HashSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::LazyLock;

use mixdog_js::JsRegex;
use mixdog_js::is_js_space;
use mixdog_rt::LaneToken;
use mixdog_rt::SpawnIo;
use tokio_util::sync::CancellationToken;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

/// PowerShell aliases / language heads whose meaning would change if a same-named `.exe` were
/// resolved (Git `usr\bin\ls.exe` vs `Get-ChildItem`).
const POWERSHELL_RESERVED_HEADS: [&str; 80] = [
    "cat", "cd", "chdir", "clear", "cls", "copy", "cp", "del", "diff", "dir", "echo", "erase", "fc", "foreach", "help", "history", "kill", "ls", "man", "md",
    "measure", "mkdir", "mount", "move", "mv", "popd", "ps", "pushd", "pwd", "ren", "rename", "rm", "rmdir", "select", "set", "sleep", "sort", "start", "tee",
    "type", "where", "write", "gal", "gc", "gci", "gi", "gp", "gsv", "ii", "ni", "ri", "sal", "sc", "si", "sl", "sls", "sp", "sv", "begin", "break", "catch",
    "continue", "else", "elseif", "end", "exit", "filter", "finally", "function", "if", "param", "process", "return", "switch", "throw", "trap", "try",
    "until", "while", "workflow",
];

fn head_name(token: &str) -> String {
    let lower = token.to_lowercase();
    let no_ext = if lower.ends_with(".exe") { &lower[..lower.len() - 4] } else { &lower };
    no_ext.rsplit(['\\', '/']).next().unwrap_or("").to_owned()
}

/// PowerShell-only constructs. A command with none can be spawned directly; deliberately
/// over-inclusive — a false positive only declines the direct spawn.
pub fn has_powershell_only_syntax(command: &str) -> bool {
    if mixdog_js::js_trim(command).is_empty() {
        return false;
    }
    static PATTERNS: LazyLock<Vec<JsRegex>> = LazyLock::new(|| {
        [
            (r"\$(?:null|true|false|env:|_\b|args\b|host\b|profile\b|pwd\b|psversiontable\b|psscriptroot\b|lastexitcode\b|erroractionpreference\b)", "i"),
            (r"\$[A-Za-z_]\w*\s*=", ""),
            // A verb joined to the previous character by a path/word char is part of a name.
            (r"(?<![\w\-./\\:])(?:get|set|new|remove|select|where|foreach|invoke|out|write|start|stop|test|measure|sort|join|split|convert|import|export|add|copy|move|rename|resolve|compare|clear|push|pop)-[A-Za-z]+\b", "i"),
            (r"\[[A-Za-z_][\w.]*\]::", ""),
            (r"(?:^|\s)-(?:eq|ne|gt|lt|ge|le|match|notmatch|like|notlike|contains|replace|not|and|or|is|as|ErrorAction|Recurse|Force|Encoding|TotalCount|Tail|Pattern|Path|LiteralPath)\b", ""),
            (r"2>\s*\$", ""),
            (r"\|\s*[%?]\s*\{", ""),
            (r#"@['"][\s\S]*?['"]@"#, ""),
            (r"`\s*$", "m"),
        ]
        .iter()
        .map(|(p, f)| JsRegex::new_static(p, f))
        .collect()
    });
    PATTERNS.iter().any(|p| p.is_match(command))
}

/// Operators / expansion that require the host shell. Single-quoted regions stay literal;
/// double-quoted `$` / backtick would expand.
pub fn command_needs_shell(command: &str) -> bool {
    let chars: Vec<char> = command.chars().collect();
    let mut quote: Option<char> = None;
    for (i, &ch) in chars.iter().enumerate() {
        match quote {
            Some('\'') => {
                if ch == '\'' {
                    quote = None;
                }
                continue;
            }
            Some(_) => {
                if ch == '"' {
                    quote = None;
                } else if ch == '`' || ch == '$' {
                    return true;
                }
                continue;
            }
            None => {}
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }
        if "|&;<>()\n\r{}".contains(ch) || ch == '`' {
            return true;
        }
        // A bare `~` expands to the home directory and `@name` splats.
        if (ch == '~' || ch == '@') && (i == 0 || is_js_space(chars[i - 1])) {
            return true;
        }
        if "*?[]".contains(ch) || ch == '$' {
            return true;
        }
        if ch == '#' && (i == 0 || is_js_space(chars[i - 1])) {
            return true;
        }
    }
    quote.is_some()
}

/// Quote-aware argv split for native CreateProcess; keeps Windows backslashes literal. `strict`
/// reproduces PowerShell's own parse: a form where PowerShell and this splitter could disagree
/// returns `None` so the command runs through the shell unchanged.
pub fn tokenize_direct_argv(command: &str, strict: bool) -> Option<Vec<String>> {
    let text: Vec<char> = command.chars().collect();
    let (mut tokens, mut current) = (Vec::new(), String::new());
    let (mut quote, mut started, mut leading) = (None::<char>, false, false);
    let mut i = 0;
    while i < text.len() {
        let ch = text[i];
        let next = text.get(i + 1).copied();
        if let Some(q) = quote {
            if q == '"' && ch == '\\' && next == Some('"') {
                if strict {
                    return None;
                }
                current.push('"');
                i += 2;
                continue;
            }
            if ch == q {
                // A doubled quote inside a string is a literal quote.
                if next == Some(q) {
                    current.push(q);
                    i += 2;
                    continue;
                }
                quote = None;
                if strict && leading && next.is_some_and(|n| !is_js_space(n)) {
                    return None;
                }
                i += 1;
                continue;
            }
            current.push(ch);
            i += 1;
            continue;
        }
        if ch == '\'' || ch == '"' {
            // A string that opens an argument ends it; one opened mid-argument joins its neighbours.
            leading = !started;
            quote = Some(ch);
            started = true;
            i += 1;
            continue;
        }
        if is_js_space(ch) {
            if started {
                tokens.push(std::mem::take(&mut current));
            }
            started = false;
            i += 1;
            continue;
        }
        current.push(ch);
        started = true;
        i += 1;
    }
    if quote.is_some() {
        return None;
    }
    if started {
        tokens.push(current);
    }
    Some(tokens)
}

fn is_file(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

fn is_usable_exe(path: &Path) -> bool {
    path.to_string_lossy().to_lowercase().ends_with(".exe") && is_file(path)
}

/// `path.resolve(base, name)` on Windows: joined, `.`/`..` folded.
fn resolve_against(base: &Path, name: &str) -> PathBuf {
    let joined = base.join(name);
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `resolveDirectExe`: the `.exe` a bare command name or path stands for, or `None` when the
/// shell must resolve it (a `.cmd`/`.bat`/`.ps1`/`.com` shim wins in PowerShell).
pub fn resolve_direct_exe_blocking(token: &str, cwd: &Path, path_value: &str, max_directories: usize) -> Option<PathBuf> {
    let name = mixdog_js::js_trim(token);
    if name.is_empty() || name.contains('\0') {
        return None;
    }
    if lazy_re!(r"\.(cmd|bat|ps1|com)$", "i").is_match(name) {
        return None;
    }
    let drive = lazy_re!(r"^[A-Za-z]:", "").is_match(name);
    if name.contains(['\\', '/']) || drive {
        let rooted = name.starts_with(['/', '\\']) || lazy_re!(r"^[A-Za-z]:[\\/]", "").is_match(name);
        let resolved = if rooted { PathBuf::from(name) } else { resolve_against(cwd, name) };
        return is_usable_exe(&resolved).then_some(resolved);
    }
    search_path(name, path_value, max_directories)
}

fn search_path(name: &str, path_value: &str, max_directories: usize) -> Option<PathBuf> {
    let explicit_exe = name.to_lowercase().ends_with(".exe");
    let mut seen: HashSet<String> = HashSet::new();
    for dir in path_value.split(';') {
        if dir.is_empty() {
            continue;
        }
        if !seen.insert(dir.to_lowercase()) {
            continue;
        }
        if seen.len() > max_directories {
            break;
        }
        let dir = Path::new(dir);
        if explicit_exe {
            let candidate = dir.join(name);
            if is_usable_exe(&candidate) {
                return Some(candidate);
            }
            continue;
        }
        // PowerShell takes the first directory holding ANY runnable form of the name: a
        // `.com`/`.ps1` there outranks the `.exe`, a `.cmd`/`.bat` shim in an earlier directory
        // shadows a later `.exe`; all of these stay with the shell.
        let has = |ext: &str| is_file(&dir.join(format!("{name}{ext}")));
        if has(".com") || has(".ps1") {
            return None;
        }
        let candidate = dir.join(format!("{name}.exe"));
        if is_usable_exe(&candidate) {
            return Some(candidate);
        }
        if has(".bat") || has(".cmd") {
            return None;
        }
    }
    None
}

/// What a direct spawn runs.
#[derive(Debug, PartialEq, Eq)]
pub struct DirectExe {
    pub exe: PathBuf,
    pub argv: Vec<String>,
}

/// `planDirectExeSpawn`'s decision before any file is touched: the token list, or `None` when the
/// command needs the shell.
pub fn direct_exe_tokens(command: &str, windows: bool, powershell: bool, disabled_by_env: bool) -> Option<Vec<String>> {
    if !windows || !powershell || disabled_by_env {
        return None;
    }
    let text = mixdog_js::js_trim(command);
    if text.is_empty() || command_needs_shell(text) || has_powershell_only_syntax(text) {
        return None;
    }
    let tokens = tokenize_direct_argv(text, true)?;
    let head = tokens.first()?;
    if tokens.iter().any(|t| t == "--%") {
        return None;
    }
    let name = head_name(head);
    if name.is_empty() || POWERSHELL_RESERVED_HEADS.contains(&name.as_str()) || lazy_re!(r"^[A-Za-z]+-[A-Za-z]+$", "").is_match(head) {
        return None;
    }
    Some(tokens)
}

/// `MIXDOG_SHELL_DIRECT_EXE=0|false|no|off` turns direct spawns off.
pub fn disabled_by_env() -> bool {
    std::env::var("MIXDOG_SHELL_DIRECT_EXE").is_ok_and(|raw| lazy_re!(r"^(0|false|no|off)$", "i").is_match(mixdog_js::js_trim(&raw)))
}

/// `planDirectExeSpawn`: resolves the head on a lane job. Not kept between calls: a program
/// installed or a shim added in a PATH directory changes the answer, as Node resolves it each time.
pub async fn plan_direct_exe(
    lane: SpawnIo,
    cancel: &CancellationToken,
    command: &str,
    windows: bool,
    powershell: bool,
    cwd: &Path,
    path_value: &str,
) -> Option<DirectExe> {
    let tokens = direct_exe_tokens(command, windows, powershell, disabled_by_env())?;
    let (head, cwd, path_value) = (tokens[0].clone(), cwd.to_owned(), path_value.to_owned());
    let job = lane.submit(cancel, move |_| resolve_direct_exe_blocking(&head, &cwd, &path_value, 64)).ok()?;
    let exe = job.await.ok()??;
    Some(DirectExe { exe, argv: tokens[1..].to_vec() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_head_that_is_a_powershell_word_or_cmdlet_stays_with_the_shell() {
        assert!(direct_exe_tokens("git status", true, true, false).is_some());
        assert!(direct_exe_tokens("git status", false, true, false).is_none());
        assert!(direct_exe_tokens("git status", true, false, false).is_none());
        assert!(direct_exe_tokens("git status", true, true, true).is_none());
        assert!(direct_exe_tokens("ls -la", true, true, false).is_none());
        assert!(direct_exe_tokens("Get-Process", true, true, false).is_none());
        assert!(direct_exe_tokens("git log | head", true, true, false).is_none());
        assert!(direct_exe_tokens("tool --% raw", true, true, false).is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn a_native_exe_runs_without_the_shell_and_returns_its_exit_status_and_stdout() {
        use crate::exec::tests::{body, ctx, real_rig};
        use mixdog_core_api::domain::tool::Tool;
        let rig = real_rig();
        let mut config = rig.runtime.config.clone_for_test();
        config.windows = true;
        config.powershell = true;
        config.shell = std::sync::Arc::new(crate::exec::FixedShell("no-such-powershell.exe".into()));
        let shell = crate::exec::ShellTool::new(crate::exec::ExecRuntime::new(config));
        let cmd = Path::new(&std::env::var("SystemRoot").unwrap()).join("System32").join("cmd.exe");
        let command = format!("\"{}\" /d /c \"echo ok& exit 3\"", cmd.display());
        let text = body(shell.call(&ctx(&rig, "d1"), serde_json::json!({ "command": command })).await);
        // `echo ok` writes the line with its line end.
        assert_eq!(text, "[exit code: 3]\n\nok\n");
    }

    fn argv(command: &str, strict: bool) -> Option<Vec<&'static str>> {
        tokenize_direct_argv(command, strict).map(|v| v.into_iter().map(|s| &*Box::leak(s.into_boxed_str())).collect())
    }

    #[test]
    fn a_plain_command_runs_directly_and_one_with_shell_syntax_needs_the_shell() {
        for command in
            ["git status", "git log --oneline -5", "ls -la", "echo '$HOME'", "echo a~b", "echo a#b", "tool \"a b\" c", "tool 'it''s'", "tool a\tb", "", "   "]
        {
            assert!(!command_needs_shell(command), "{command:?}");
        }
        for command in [
            "git log | head",
            "a && b",
            "a; b",
            "echo $HOME",
            "echo \"$HOME\"",
            "echo ~",
            "echo @args",
            "echo # c",
            "tool *.txt",
            "tool [ab]",
            "tool a?b",
            "tool 2>&1",
            "tool (a)",
            "tool {a}",
            "tool a>b",
            "tool a\nb",
            "& tool",
            "tool \"unterminated",
            "tool 'unterminated",
        ] {
            assert!(command_needs_shell(command), "{command:?}");
        }
    }

    #[test]
    fn powershell_only_syntax_is_recognised_by_cmdlet_names_variables_and_parameters() {
        for command in [
            "Get-Process",
            "Get-ChildItem",
            "$x = 1",
            "$env:PATH",
            "tool -eq 1",
            "tool -Path x",
            "tool -Force",
            "x | % { $_ }",
            "tool 2>$null",
            "[System.IO.Path]::GetTempPath()",
        ] {
            assert!(has_powershell_only_syntax(command), "{command:?}");
        }
        for command in ["git status", "a-b", "path/get-thing", "tool 2>&1", "echo $HOME"] {
            assert!(!has_powershell_only_syntax(command), "{command:?}");
        }
    }

    #[test]
    fn quotes_group_words_and_a_doubled_quote_is_one_quote_character() {
        assert_eq!(argv("node -e \"console.log(1)\"", false), Some(vec!["node", "-e", "console.log(1)"]));
        assert_eq!(argv("tool 'a b' c", false), Some(vec!["tool", "a b", "c"]));
        assert_eq!(argv("tool \"a \"\"b\"\" c\"", false), Some(vec!["tool", "a \"b\" c"]));
        assert_eq!(argv("tool 'it''s'", false), Some(vec!["tool", "it's"]));
        assert_eq!(argv("tool x\"y z\"w", false), Some(vec!["tool", "xy zw"]));
        assert_eq!(argv("\"C:\\Program Files\\x\\y.exe\" a", false), Some(vec!["C:\\Program Files\\x\\y.exe", "a"]));
        assert_eq!(argv("tool 한글 \"한 글\"", false), Some(vec!["tool", "한글", "한 글"]));
        assert_eq!(argv("   ", false), Some(vec![]));
        assert_eq!(argv("tool \"unterminated", false), None);
    }

    #[test]
    fn strict_tokenising_refuses_what_only_a_shell_reads_the_same_way() {
        assert_eq!(argv("tool \"x\\\"y\"", false), Some(vec!["tool", "x\"y"]));
        assert_eq!(argv("tool \"x\\\"y\"", true), None);
        assert_eq!(argv("tool \"x\"y", false), Some(vec!["tool", "xy"]));
        assert_eq!(argv("tool \"x\"y", true), None);
        assert_eq!(argv("tool x\"y z\"w", true), Some(vec!["tool", "xy zw"]));
    }

    fn resolver() -> (tempfile::TempDir, impl Fn(&str, &[&str]) -> Option<String>) {
        let root = tempfile::tempdir().unwrap();
        for file in [
            "d1/a.exe",
            "d2/b.exe",
            "d2/b.cmd",
            "d3/c.exe",
            "d3/c.ps1",
            "d4/e.bat",
            "d5/e.exe",
            "d6/f.com",
            "d6/f.exe",
            "d7/g.cmd",
            "d8/g.exe",
            "d9/h.exe",
            "d9/sub/i.exe",
            "d10/j.cmd",
        ] {
            let path = root.path().join(file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"").unwrap();
        }
        let base = root.path().to_owned();
        let resolve = move |token: &str, path: &[&str]| {
            let dirs = path.iter().map(|n| base.join(n).to_string_lossy().into_owned()).collect::<Vec<_>>().join(";");
            resolve_direct_exe_blocking(token, &base, &dirs, 64).map(|p| p.strip_prefix(&base).unwrap().to_string_lossy().replace('\\', "/"))
        };
        (root, resolve)
    }

    #[test]
    fn a_bare_token_resolves_to_the_exe_on_the_path() {
        let (_root, resolve) = resolver();
        assert_eq!(resolve("a", &["d1"]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("a.exe", &["d1"]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("  a  ", &["d1"]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("a", &["d1", "d1", "D1"]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("x", &["d1"]), None);
        assert_eq!(resolve("", &["d1"]), None);
    }

    #[test]
    fn a_script_of_the_name_is_never_resolved_and_an_earlier_one_shadows_a_later_exe() {
        let (_root, resolve) = resolver();
        for (token, dir) in [("c", "d3"), ("f", "d6"), ("b.cmd", "d2"), ("c.ps1", "d3"), ("j", "d10"), ("a.cmd", "d1")] {
            assert_eq!(resolve(token, &[dir]), None, "{token}");
        }
        assert_eq!(resolve("e", &["d5", "d4"]).as_deref(), Some("d5/e.exe"));
        assert_eq!(resolve("e", &["d4", "d5"]), None, "an earlier script of the name shadows a later exe");
        assert_eq!(resolve("g", &["d8", "d7"]).as_deref(), Some("d8/g.exe"));
        assert_eq!(resolve("g", &["d7", "d8"]), None);
    }

    #[test]
    fn a_token_with_a_separator_is_a_path_from_the_working_folder() {
        let (_root, resolve) = resolver();
        assert_eq!(resolve("d9/h.exe", &["d1"]).as_deref(), Some("d9/h.exe"));
        if cfg!(windows) {
            assert_eq!(resolve("d9\\h.exe", &[]).as_deref(), Some("d9/h.exe"));
        }
        assert_eq!(resolve("./d1/a.exe", &[]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("d9/../d1/a.exe", &[]).as_deref(), Some("d1/a.exe"));
        assert_eq!(resolve("d9/h", &[]), None, "a path names the file exactly");
    }
}
