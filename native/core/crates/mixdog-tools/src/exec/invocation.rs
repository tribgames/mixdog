//! How a command reaches the child (`bash-tool/invocation-plan.mjs`): PowerShell gets a UTF-8
//! console preamble and the `mixdog-skill-node` function (so Korean output and skill scripts work),
//! a recognised filter pipeline gets a tee that keeps the unfiltered producer output for a
//! rescue, and a POSIX bash/zsh command is delivered through the environment behind a snapshot of
//! the user's shell state. The text builders here are pure; the files and the snapshot shell are
//! run by `snapshot.rs` and `spill.rs`.

use std::sync::LazyLock;

use mixdog_js::JsRegex;
use sha2::Digest;
use sha2::Sha256;

use super::benign::split_pipeline_segments;
use super::benign::split_segments;
use super::benign::strip_probe_wrappers;
use super::benign::tokenize;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

/// `$OutputEncoding` feeds native-program stdin: BOM-less, since Windows PowerShell 5.1 prepends
/// a U+FEFF preamble for `[Text.Encoding]::UTF8` (it breaks `python -`).
pub const POWERSHELL_UTF8_PREFIX: &str =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=New-Object System.Text.UTF8Encoding $false;";

/// What every PowerShell run executes as its `-Command` (Node's `STANDBY_BOOTSTRAP`,
/// `shell-warm-standby.mjs`); the script itself arrives on stdin. Input and output are UTF-8
/// before the script compiles, so a parse error is reported as `ParserError: <message>` in UTF-8
/// instead of PowerShell's own text in the console code page, and a script whose last command
/// failed exits 1.
pub const POWERSHELL_BOOTSTRAP: &str = r#"$null = . ([scriptblock]::Create('$null')); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { $__mixdogScript = [scriptblock]::Create([Console]::In.ReadToEnd() + "`nif (-not `$?) { exit 1 }") } catch { [Console]::Error.WriteLine('ParserError: ' + $_.Exception.GetBaseException().Message); exit 1 }; . $__mixdogScript"#;

pub const SKILL_LAUNCHER_COMMAND: &str = "mixdog-skill-node";
const SKILL_ARGV_ENV: &str = "MIXDOG_SKILL_ARGV";
const SKILL_ARGV_TAG: &str = "mixdog1";

/// The runtime a skill script is handed to: this daemon's executable on the skill entry.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SkillRuntime {
    /// Node's `process.platform` of the host (`win32`, `linux`, `darwin`).
    pub platform: String,
    pub interpreter: String,
    pub entry: String,
    /// Electron's node mode (`ELECTRON_RUN_AS_NODE`) is set for the one child.
    pub electron: bool,
}

fn ps_quote(value: &str) -> String {
    // PowerShell also treats the typographic single quotes as quote characters.
    let doubled: String = value
        .chars()
        .flat_map(|c| {
            let n = if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}') { 2 } else { 1 };
            std::iter::repeat_n(c, n)
        })
        .collect();
    format!("'{doubled}'")
}

fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn batch_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('%', "%%"))
}

/// One-line PowerShell definition of `mixdog-skill-node`, prepended to every PowerShell command.
pub fn render_powershell_skill_function(rt: &SkillRuntime) -> String {
    let mut names = vec![SKILL_ARGV_ENV];
    let mut values = vec!["$__mxa"];
    if rt.electron {
        names.push("ELECTRON_RUN_AS_NODE");
        values.push("'1'");
    }
    let saves = names.iter().enumerate().map(|(i, n)| format!("$__mxo{i} = $env:{n}")).collect::<Vec<_>>().join("; ");
    let sets: Vec<String> = names.iter().enumerate().map(|(i, n)| format!("$env:{n} = {};", values[i])).collect();
    let restores = names.iter().enumerate().map(|(i, n)| format!("$env:{n} = $__mxo{i}")).collect::<Vec<_>>().join("; ");
    let mut guarded = vec!["try {".to_owned()];
    guarded.extend(sets);
    guarded.push(format!("& {} {}", ps_quote(&rt.interpreter), ps_quote(&rt.entry)));
    guarded.push("} finally {".to_owned());
    guarded.push(restores);
    guarded.push("}".to_owned());
    let body = [
        format!("$__mxa = '{SKILL_ARGV_TAG}'"),
        "foreach ($__mxv in $args) { foreach ($__mxe in @($__mxv)) { if ($null -ne $__mxe) { $__mxa += ',' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__mxe)) } } }".to_owned(),
        saves,
        guarded.join(" "),
        "if ($LASTEXITCODE) { exit $LASTEXITCODE }".to_owned(),
    ];
    format!("function {SKILL_LAUNCHER_COMMAND} {{ {} }}", body.join("; "))
}

/// The sh launcher: Electron node mode is set only inside it, for the one child it execs.
pub fn render_posix_skill_launcher(rt: &SkillRuntime) -> String {
    let mut lines = vec![
        "#!/bin/sh".to_owned(),
        "# Mixdog skill-script launcher, generated for one installation. Do not edit.".to_owned(),
    ];
    if rt.electron {
        lines.push("ELECTRON_RUN_AS_NODE=1".to_owned());
        lines.push("export ELECTRON_RUN_AS_NODE".to_owned());
    }
    lines.push(format!("exec {} {} \"$@\"", posix_quote(&rt.interpreter), posix_quote(&rt.entry)));
    format!("{}\n", lines.join("\n"))
}

/// The `.cmd` launcher, same contract as the sh launcher.
pub fn render_windows_skill_launcher(rt: &SkillRuntime) -> String {
    // cmd decodes a batch file in the console code page line by line, so a non-ASCII path needs
    // UTF-8 for the lines after chcp; the caller's code page is restored before exit.
    let unicode = !format!("{}{}", rt.interpreter, rt.entry).is_ascii();
    let mut lines = vec![
        "@echo off".to_owned(),
        "rem Mixdog skill-script launcher, generated for one installation. Do not edit.".to_owned(),
        "setlocal EnableExtensions DisableDelayedExpansion".to_owned(),
    ];
    if unicode {
        lines.push("for /f \"tokens=2 delims=:.\" %%C in ('chcp') do set \"MIXDOG_SKILL_CP=%%C\"".to_owned());
        lines.push("chcp 65001 >nul".to_owned());
    }
    if rt.electron {
        lines.push("set \"ELECTRON_RUN_AS_NODE=1\"".to_owned());
    }
    lines.push(format!("{} {} %*", batch_quote(&rt.interpreter), batch_quote(&rt.entry)));
    lines.push("set \"MIXDOG_SKILL_EXIT=%ERRORLEVEL%\"".to_owned());
    if unicode {
        lines.push("if defined MIXDOG_SKILL_CP chcp %MIXDOG_SKILL_CP% >nul".to_owned());
    }
    lines.push("exit /b %MIXDOG_SKILL_EXIT%".to_owned());
    format!("{}\r\n", lines.join("\r\n"))
}

/// The launcher files of a runtime: the sh script everywhere, plus the `.cmd` on Windows.
pub fn skill_launcher_files(rt: &SkillRuntime) -> Vec<(String, String)> {
    let mut files = vec![(SKILL_LAUNCHER_COMMAND.to_owned(), render_posix_skill_launcher(rt))];
    if rt.platform == "win32" {
        files.push((format!("{SKILL_LAUNCHER_COMMAND}.cmd"), render_windows_skill_launcher(rt)));
    }
    files
}

/// The private per-installation launcher directory under the data dir.
pub fn skill_launcher_dir(rt: &SkillRuntime, data_dir: &str) -> String {
    let key = serde_json::json!([rt.platform, rt.interpreter, rt.entry, rt.electron]).to_string();
    let hex: String = Sha256::digest(key.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let sep = if rt.platform == "win32" { '\\' } else { '/' };
    let base = data_dir.trim_end_matches(['/', '\\']);
    format!("{base}{sep}skill-launchers{sep}{hex}")
}

/// Defines `mixdog-skill-node` in front of a PowerShell command unless it is already there.
pub fn prefix_powershell_skill_function(command: &str, rt: Option<&SkillRuntime>) -> String {
    let Some(rt) = rt else { return command.to_owned() };
    let function = render_powershell_skill_function(rt);
    if mixdog_js::js_trim_start(command).starts_with(&format!("{function}\n")) {
        command.to_owned()
    } else {
        format!("{function}\n{command}")
    }
}

/// The UTF-8 console preamble, then the skill function, then the command.
pub fn prefix_powershell_utf8(command: &str, rt: Option<&SkillRuntime>) -> String {
    let trimmed = mixdog_js::js_trim_start(command);
    let body = match trimmed.strip_prefix(POWERSHELL_UTF8_PREFIX) {
        Some(rest) => lazy_re!(r"^[ \t]*\r?\n", "").replace_all_with(rest, |_| String::new()).to_string(),
        None => command.to_owned(),
    };
    format!("{POWERSHELL_UTF8_PREFIX}\n{}", prefix_powershell_skill_function(&body, rt))
}

// ---- filter-swallow rescue (shell-analysis.mjs buildPowerShellFilterTeePlan) ----

const PURE_FILTER_HEADS: [&str; 9] =
    ["select-string", "sls", "select-object", "select", "where-object", "where", "foreach-object", "%", "findstr"];

fn tee_stage_head(tokens: &[String]) -> String {
    let lower = tokens.first().map_or(String::new(), |t| t.to_lowercase());
    let base = lower.rsplit(['\\', '/']).next().unwrap_or("");
    base.strip_suffix(".exe").unwrap_or(base).to_owned()
}

/// The splitters are not grouping-aware, so a `;` or `|` inside (), {} or [] would be cut
/// mid-group and the rewrite would break the parse.
fn grouping_balanced(text: &str) -> bool {
    let mut stack: Vec<char> = Vec::new();
    let (mut quote, mut escaped) = (None::<char>, false);
    for ch in text.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => quote = Some(ch),
            '(' | '{' | '[' => stack.push(ch),
            ')' | '}' | ']' => {
                let open = match ch {
                    ')' => '(',
                    '}' => '{',
                    _ => '[',
                };
                if stack.pop() != Some(open) {
                    return false;
                }
            }
            _ => {}
        }
    }
    stack.is_empty() && quote.is_none()
}

fn stage_redirects_to_file(tokens: &[String]) -> bool {
    tokens.iter().enumerate().any(|(i, t)| {
        (t == ">" || t == ">>") && !tokens.get(i + 1).map_or("", String::as_str).starts_with('&')
    })
}

/// A recognised filter pipeline rewritten to spill its unfiltered producer stream.
#[derive(Debug, PartialEq, Eq)]
pub struct TeePlan {
    pub command: String,
    pub tee_path: String,
}

/// `buildPowerShellFilterTeePlan`: applies only to the exactly-recognised shape (single line, no
/// backticks / `$(…)` / here-strings, ≥ 2 stages, stage 0 not a filter, the rest all pure
/// filters, no file redirects); any ambiguity returns `None` and the command runs untouched.
/// `token` is 8 hex characters; the spill file is `<tmp_dir><sep>mixdog-tee-<token>.log`.
pub fn build_powershell_filter_tee_plan(command: &str, token: &str, tmp_dir: &str, sep: char) -> Option<TeePlan> {
    if mixdog_js::js_trim(command).is_empty()
        || command.contains(['\r', '\n'])
        || lazy_re!(r"tee-object", "i").is_match(command)
        || lazy_re!(r#"[`]|\$\(|\$\{|@['"]|<\(|>\("#, "").is_match(command)
    {
        return None;
    }
    let segments = split_segments(command);
    let last = segments.last()?;
    let trimmed = mixdog_js::js_trim_end(command);
    if !trimmed.ends_with(last.as_str()) {
        return None;
    }
    let head = &trimmed[..trimmed.len() - last.len()];
    if !grouping_balanced(last) || !grouping_balanced(head) {
        return None;
    }
    // Behind `&&` / `||` the rewrite's leading assignment is not a pipeline.
    if lazy_re!(r"(?:&&|\|\|)\s*$", "").is_match(head) {
        return None;
    }
    let stages = split_pipeline_segments(last);
    if stages.len() < 2 {
        return None;
    }
    let mut tokenized = Vec::new();
    for stage in &stages {
        if !grouping_balanced(stage) {
            return None;
        }
        let tokens = tokenize(stage)?;
        if tokens.is_empty() || stage_redirects_to_file(&tokens) {
            return None;
        }
        let stripped = strip_probe_wrappers(tokens);
        if stripped.is_empty() {
            return None;
        }
        tokenized.push(stripped);
    }
    if PURE_FILTER_HEADS.contains(&tee_stage_head(&tokenized[0]).as_str()) {
        return None;
    }
    if tokenized[1..].iter().any(|t| !PURE_FILTER_HEADS.contains(&tee_stage_head(t).as_str())) {
        return None;
    }
    let tee_path = format!("{tmp_dir}{sep}mixdog-tee-{token}.log");
    if tee_path.contains('\'') {
        return None;
    }
    let exit_ref = format!("$__mixdogProducerExit{token}");
    let producer = format!("& {{ $global:LASTEXITCODE = 0; {}; {exit_ref}.Value = $global:LASTEXITCODE }}", stages[0]);
    let rewritten = format!(
        "{head}{exit_ref} = [ref]0; {producer} | Tee-Object -FilePath '{tee_path}' | {}; exit {exit_ref}.Value",
        stages[1..].join(" | ")
    );
    Some(TeePlan { command: rewritten, tee_path })
}

/// The tail of a tee spill (BOM-sniffed: Windows PowerShell 5.1 writes UTF-16LE, pwsh 7 UTF-8),
/// `None` when empty.
pub fn decode_tee_capture(bytes: &[u8], utf16: bool) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let text = if utf16 {
        let units: Vec<u16> = bytes.chunks_exact(2).map(|p| u16::from_le_bytes([p[0], p[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    let text = text.strip_prefix('\u{feff}').map_or(text.clone(), str::to_owned);
    (!mixdog_js::js_trim(&text).is_empty()).then_some(text)
}

/// The note appended when a failed run's trailing filters matched nothing.
pub fn filter_rescue_note(tail: &str) -> String {
    format!(
        "\n\n[filter-swallowed output rescue] the command failed but its trailing filter(s) matched nothing, so the visible output was empty. Unfiltered pipeline output (tail):\n{tail}"
    )
}

// ---- POSIX snapshot (shell-snapshot.mjs) ----

/// POSIX single-quote escape: close, escaped quote, reopen.
pub fn shell_quote(s: &str) -> String {
    posix_quote(s)
}

/// The rc file a shell's state is captured from.
pub fn config_file(shell_path: &str, home: &str) -> String {
    let lower = shell_path.to_lowercase();
    let name = if lower.contains("zsh") {
        ".zshrc"
    } else if lower.contains("bash") {
        ".bashrc"
    } else {
        ".profile"
    };
    format!("{home}{}{name}", if cfg!(windows) { '\\' } else { '/' })
}

/// The one-shot login-shell script that dumps functions, options and aliases to
/// `snapshot_file`. `config`: the rc file to source, when it exists.
pub fn snapshot_script(shell_path: &str, snapshot_file: &str, config: Option<&str>, launcher_dir: &str) -> String {
    let is_zsh = shell_path.to_lowercase().contains("zsh");
    let source_cfg = match config {
        Some(file) => format!("source {} < /dev/null 2>/dev/null || true", shell_quote(file)),
        None => "# no user config file".to_owned(),
    };
    let fn_dump = if is_zsh {
        "\n      typeset -f > /dev/null 2>&1\n      typeset +f 2>/dev/null | grep -vE '^_[^_]' | while read func; do\n        typeset -f \"$func\" >> \"$SNAPSHOT_FILE\" 2>/dev/null\n      done\n    "
    } else {
        "\n      declare -f > /dev/null 2>&1\n      declare -F 2>/dev/null | cut -d' ' -f3 | grep -vE '^_[^_]' | while read func; do\n        declare -f \"$func\" >> \"$SNAPSHOT_FILE\" 2>/dev/null\n      done\n    "
    };
    // Options are matched on their state column: a name containing "on" (monitor, onecmd) must
    // not turn an OFF option on. Job control (monitor) is never restored.
    let opt_dump = if is_zsh {
        "setopt 2>/dev/null | grep -vxE '(no)?monitor' | sed 's/^/setopt /' | head -n 1000 >> \"$SNAPSHOT_FILE\""
    } else {
        "\n      shopt -p 2>/dev/null | head -n 1000 >> \"$SNAPSHOT_FILE\"\n      set -o 2>/dev/null | awk '$2 == \"on\" && $1 != \"monitor\" {print \"set -o \" $1}' | head -n 1000 >> \"$SNAPSHOT_FILE\"\n      echo \"shopt -s expand_aliases\" >> \"$SNAPSHOT_FILE\"\n    "
    };
    let alias_dump = "\n      alias 2>/dev/null | sed 's/^alias //g' | sed 's/^/alias -- /' | head -n 1000 >> \"$SNAPSHOT_FILE\"\n  ";
    format!(
        "SNAPSHOT_FILE={snap}\n{source_cfg}\necho \"# Snapshot\" >| \"$SNAPSHOT_FILE\"\necho \"# Unset all aliases first to avoid frozen-alias issues inside functions\" >> \"$SNAPSHOT_FILE\"\necho \"unalias -a 2>/dev/null || true\" >> \"$SNAPSHOT_FILE\"\necho \"# Functions\" >> \"$SNAPSHOT_FILE\"\n{fn_dump}\necho \"# Shell options\" >> \"$SNAPSHOT_FILE\"\n{opt_dump}\necho \"# Aliases\" >> \"$SNAPSHOT_FILE\"\n{alias_dump}\n# The sourced PATH replaces the model shell's own, so it carries the\n# skill-launcher entry buildShellSpawnEnv prepends (mixdog-skill-node).\nPATH={launcher}:\"$PATH\"\n# PATH may contain $, backticks, or quotes that would re-expand if we\n# emitted it inside double quotes. Emit a shell-safe single-quoted PATH\n# export line via printf %q-style escaping inside the dump shell.\nprintf 'export PATH=' >> \"$SNAPSHOT_FILE\"\n_q=$(printf %s \"$PATH\" | sed \"s/'/'\\\\''/g\")\nprintf \"'%s'\n\" \"$_q\" >> \"$SNAPSHOT_FILE\"\nexit 0\n",
        snap = shell_quote(snapshot_file),
        launcher = shell_quote(launcher_dir),
    )
}

/// A snapshot with nothing captured (header and PATH boilerplate only) is rejected.
pub fn snapshot_has_payload(content: &str) -> bool {
    lazy_re!(r"^\s*alias\s+--\s", "m").is_match(content)
        || lazy_re!(r"^\s*[A-Za-z_][\w-]*\s*\(\s*\)\s*\{", "m").is_match(content)
        || lazy_re!(r"^\s*function\s+[A-Za-z_]", "m").is_match(content)
        || lazy_re!(r"^\s*setopt\b", "m").is_match(content)
        || lazy_re!(r"^\s*shopt\s+-s", "m").is_match(content)
        || lazy_re!(r"^\s*set\s+-o\s", "m").is_match(content)
}

/// The command with the snapshot sourced in on its own line (so the just-loaded aliases are
/// visible to it).
pub fn wrap_with_snapshot(snapshot: &str, command: &str) -> String {
    format!("source '{}' 2>/dev/null\n{command}", snapshot.replace('\'', "'\\''"))
}

/// The script the shell runs: the command is delivered through the environment, not argv, so a
/// `-f` process matcher built from the command text cannot match the wrapper running it.
pub const EVAL_SCRIPT: &str = "eval \"${MIXDOG_SHELL_SCRIPT?mixdog: shell script was not delivered to the child}\"";

#[cfg(test)]
mod tests {
    use super::*;

    fn vectors() -> serde_json::Value {
        serde_json::from_str(include_str!("testdata/invocation_node_vectors.json")).unwrap()
    }

    fn runtime(v: &serde_json::Value) -> SkillRuntime {
        SkillRuntime {
            platform: v["platform"].as_str().unwrap().to_owned(),
            interpreter: v["interpreter"].as_str().unwrap().to_owned(),
            entry: v["entry"].as_str().unwrap().to_owned(),
            electron: v["electron"].as_bool().unwrap(),
        }
    }

    /// Node's launcher renderers and launcher directory for five runtimes.
    #[test]
    fn the_skill_launchers_equal_nodes() {
        let vectors = vectors();
        let cases = vectors["skillOut"].as_array().unwrap();
        assert_eq!(cases.len(), 5);
        for case in cases {
            let rt = runtime(&case["runtime"]);
            assert_eq!(render_powershell_skill_function(&rt), case["psFunction"].as_str().unwrap(), "{rt:?}");
            assert_eq!(render_posix_skill_launcher(&rt), case["posix"].as_str().unwrap(), "{rt:?}");
            assert_eq!(render_windows_skill_launcher(&rt), case["windows"].as_str().unwrap(), "{rt:?}");
            let data = if rt.platform == "win32" { "C:\\data" } else { "/data" };
            assert_eq!(skill_launcher_dir(&rt, data), case["dir"].as_str().unwrap(), "{rt:?}");
        }
    }

    #[test]
    fn the_powershell_prefixes_stack_once() {
        let vectors = vectors();
        assert_eq!(POWERSHELL_UTF8_PREFIX, vectors["utf8Prefix"].as_str().unwrap());
        let rt = runtime(&vectors["skillOut"][2]["runtime"]);
        let once = prefix_powershell_utf8("echo hi", Some(&rt));
        assert_eq!(
            once,
            format!("{POWERSHELL_UTF8_PREFIX}\n{}\necho hi", render_powershell_skill_function(&rt))
        );
        // Prefixing an already prefixed command leaves one preamble and one function.
        assert_eq!(prefix_powershell_utf8(&once, Some(&rt)), once);
        assert_eq!(prefix_powershell_utf8("echo hi", None), format!("{POWERSHELL_UTF8_PREFIX}\necho hi"));
    }

    /// Node's `buildPowerShellFilterTeePlan` on 20 commands (token and temp dir normalised).
    #[test]
    fn the_filter_tee_plan_equals_nodes() {
        let vectors = vectors();
        let cases = vectors["tee"].as_array().unwrap();
        assert_eq!(cases.len(), 20);
        for case in cases {
            let command = case["command"].as_str().unwrap();
            let got = build_powershell_filter_tee_plan(command, "0a1b2c3d", "TMPDIR", '\\').map(|p| {
                p.command.replace("0a1b2c3d", "TOKEN")
            });
            // Node's token is random hex; both sides are normalised to TOKEN.
            let want = case["result"]["command"].as_str().map(str::to_owned);
            assert_eq!(got, want, "{command:?}");
        }
    }

    /// Node's `getSnapshotScript` for three shells with and without an rc file, and the payload test.
    #[test]
    fn the_snapshot_script_equals_nodes() {
        let vectors = vectors();
        let cases = vectors["snapScripts"].as_array().unwrap();
        assert_eq!(cases.len(), 6);
        for case in cases {
            let script = case["script"].as_str().unwrap();
            // The launcher directory is the machine-specific part of Node's recording.
            let launcher = lazy_re!(r#"\nPATH='([^']*)':"\$PATH""#, "").captures(script).unwrap();
            let launcher = launcher.get(1).unwrap().to_owned();
            let config = case["configExists"].as_bool().unwrap().then(|| case["config"].as_str().unwrap().to_owned());
            let got = snapshot_script(
                case["shell"].as_str().unwrap(),
                case["snapshot"].as_str().unwrap(),
                config.as_deref(),
                &launcher,
            );
            assert_eq!(got, script, "{}", case["shell"]);
        }
        for case in vectors["payloads"].as_array().unwrap() {
            assert_eq!(snapshot_has_payload(case["content"].as_str().unwrap()), case["ok"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn a_snapshot_is_sourced_on_its_own_line() {
        assert_eq!(
            wrap_with_snapshot("/d/it's.sh", "ls"),
            "source '/d/it'\\''s.sh' 2>/dev/null\nls"
        );
        assert_eq!(config_file("/usr/bin/zsh", "/h").ends_with(".zshrc"), true);
    }

    #[test]
    fn a_tee_capture_is_read_in_either_encoding() {
        assert_eq!(decode_tee_capture(b"", false), None);
        assert_eq!(decode_tee_capture("\u{feff}out\n".as_bytes(), false).as_deref(), Some("out\n"));
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend("hi\n".encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_tee_capture(&utf16, true).as_deref(), Some("hi\n"));
        assert_eq!(decode_tee_capture(b"  \n", false), None);
        assert!(filter_rescue_note("x").ends_with("(tail):\nx"));
    }
}
