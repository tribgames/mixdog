//! Inline-script hoisting (`shell-analysis.mjs` `planInlineScriptHoist`,
//! `planLongInlineScriptFileTransport`, `planLongShellScriptFileTransport`,
//! `bash-tool/inline-hoist.mjs`). `node -e "<body>"` / `python -c "<body>"` hand the script
//! through the host shell's quoting layer, where nested quotes and escapes are the measured top
//! cause of inline-script failures. When the body is quote-LITERAL the same run is expressible as
//! a file invocation, which has no quoting layer at all. The transform is refused whenever file
//! semantics would differ from `-e`. Oversized commands that CreateProcess would reject (about
//! 32K UTF-16 units) go through a file as well.

use std::sync::LazyLock;

use mixdog_core_api::domain::ext::ExtCall;
use mixdog_core_api::domain::ext::ExtError;
use mixdog_core_api::domain::ext::ExtFrame;
use mixdog_core_api::domain::ext::ExtPool;
use mixdog_js::JsRegex;
use mixdog_js::utf16_len;
use mixdog_protocol::ThreadId;

use super::bashism::code_mask;

macro_rules! lazy_re {
    ($pattern:expr, $flags:expr) => {{
        static RE: LazyLock<JsRegex> = LazyLock::new(|| JsRegex::new_static($pattern, $flags));
        &*RE
    }};
}

const WINDOWS_INLINE_COMMAND_FILE_THRESHOLD: usize = 24_000;

/// Whether a Node script body compiles as a CommonJS function body — the check V8's
/// `new Script(...)` makes. A body using `await` outside an `async` function does not, and then
/// `node -e` (which accepts top-level `await`) must stay inline. A checker that cannot answer
/// (no worker, overload) is an error, never a guess.
#[async_trait::async_trait]
pub trait ScriptSyntax: Send + Sync {
    async fn compiles_as_commonjs(&self, thread: &ThreadId, body: &str) -> Result<bool, ExtError>;
}

/// [`ScriptSyntax`] over the extension host: a `syntax.check` worker call compiles the exact
/// wrapper Node's `-e` path would, with `new vm.Script`.
pub struct ExtSyntax {
    pool: std::sync::Arc<dyn ExtPool>,
}

impl ExtSyntax {
    pub fn new(pool: std::sync::Arc<dyn ExtPool>) -> Self {
        Self { pool }
    }
}

#[async_trait::async_trait]
impl ScriptSyntax for ExtSyntax {
    async fn compiles_as_commonjs(&self, thread: &ThreadId, body: &str) -> Result<bool, ExtError> {
        // The wrapper is Node's `nodeBodyNeedsModuleSyntax`; the call is the worker's
        // `syntax.check` (`mixdog_exthost::check_syntax` sends the same method and params).
        let source = format!("(function (exports, require, module, __filename, __dirname) {{{body}\n}})");
        let call = ExtCall {
            thread: thread.clone(),
            method: "syntax.check".to_owned(),
            params: serde_json::json!({ "source": source, "kind": "commonjs-script" }),
            paths: Vec::new(),
        };
        let mut stream = self.pool.call(call)?;
        loop {
            match stream.next().await {
                Some(ExtFrame::Chunk(_)) => {}
                Some(ExtFrame::Done(answer)) => return Ok(answer?["ok"] == true),
                None => return Err(ExtError::UnknownWorker),
            }
        }
    }
}

/// A planned file transport.
pub struct Hoist {
    pub extension: &'static str,
    pub body: String,
    prefix: String,
    suffix: String,
    exe: String,
    kept_flags: String,
    kind: Kind,
}

enum Kind {
    /// `node "<file>"`, spliced where the inline invocation was.
    Invocation { normalize_slashes: bool },
    /// The whole command becomes a PowerShell script read back with `Invoke-Expression`.
    Script,
}

impl Hoist {
    /// The command that runs the file at `file_path`.
    pub fn replace(&self, file_path: &str) -> String {
        match self.kind {
            Kind::Invocation { normalize_slashes } => {
                let path = if normalize_slashes { file_path.replace('\\', "/") } else { file_path.to_owned() };
                format!("{}{}{} \"{path}\"{}", self.prefix, self.exe, self.kept_flags, self.suffix)
            }
            Kind::Script => {
                let escaped = file_path.replace('\\', "/").replace('\'', "''");
                // Evaluated in the host's own scope, not called as a script: `& file.ps1` turns
                // `exit N` into exit code 1 and a failing last command into 0.
                format!(
                    "Invoke-Expression ([System.IO.File]::ReadAllText('{escaped}', [System.Text.Encoding]::UTF8) + \"`n\" + '$global:__mixdogLastOk = $?'); if ($global:__mixdogLastOk -eq $false) {{ exit 1 }}"
                )
            }
        }
    }
}

const NODE_BUILTINS: [&str; 68] = [
    "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server",
    "_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_wrap",
    "_stream_writable", "_tls_common", "_tls_wrap", "assert", "assert/strict", "async_hooks", "buffer",
    "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
    "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
    "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks",
    "process", "punycode", "querystring", "readline", "readline/promises", "repl", "stream",
    "stream/consumers", "stream/promises", "stream/web", "string_decoder", "sys", "timers",
    "timers/promises", "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi",
    "worker_threads", "zlib",
];
/// Builtins that exist only behind the `node:` scheme.
const NODE_SCHEME_ONLY: [&str; 4] = ["sea", "sqlite", "test", "test/reporters"];

/// `module.isBuiltin`.
fn is_builtin(specifier: &str) -> bool {
    match specifier.strip_prefix("node:") {
        Some(name) => NODE_BUILTINS.contains(&name) || NODE_SCHEME_ONLY.contains(&name),
        None => NODE_BUILTINS.contains(&specifier),
    }
}

/// `node -e` resolves a package name from the working directory; a hoisted file resolves it from
/// the temp directory it lives in. Any package specifier, `require.resolve`, or a specifier that
/// is not a string literal therefore keeps the `-e` form.
fn imports_package(body: &str) -> bool {
    if lazy_re!(r"\brequire\s*\.\s*resolve\b", "").is_match(body) {
        return true;
    }
    let calls = lazy_re!(r"\b(?:require|import)\s*\(", "g").find_iter(body).count();
    let literal = lazy_re!(r#"\b(?:require|import)\s*\(\s*['"][^'"]+['"]"#, "g").find_iter(body).count();
    if calls != literal {
        return true;
    }
    for m in lazy_re!(
        r#"(?:\brequire\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)['"]([^'"]+)['"]"#,
        "g"
    )
    .captures_iter(body)
    {
        if !is_builtin(m.get(1).unwrap_or("")) {
            return true;
        }
    }
    false
}

/// The hoisted file's extension and the interpreter flags that survive (`--input-type` only
/// describes an inline body).
fn file_shape(exe: &str, raw_flags: &str) -> (&'static str, String) {
    let is_node = exe.to_lowercase().starts_with("node");
    let extension = if !is_node {
        ".py"
    } else if lazy_re!(r"--input-type=module", "").is_match(raw_flags) {
        ".mjs"
    } else {
        ".cjs"
    };
    (extension, lazy_re!(r"\s+--input-type=\w+", "g").replace_all_with(raw_flags, |_| String::new()))
}

const PYTHON_STDLIB: &str = "__future__ abc argparse array ast asyncio atexit base64 bdb binascii bisect builtins bz2 cProfile calendar cmath cmd code codecs codeop collections colorsys compileall concurrent configparser contextlib contextvars copy copyreg csv ctypes curses dataclasses datetime dbm decimal difflib dis doctest email encodings ensurepip enum errno faulthandler fcntl filecmp fileinput fnmatch fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp gzip hashlib heapq hmac html http imaplib inspect io ipaddress itertools json keyword linecache locale logging lzma mailbox marshal math mimetypes mmap modulefinder msvcrt multiprocessing netrc nt ntpath numbers opcode operator optparse os pathlib pdb pickle pickletools pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile pyclbr pydoc pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string stringprep struct subprocess symtable sys sysconfig syslog tabnanny tarfile tempfile termios textwrap threading time timeit tkinter token tokenize tomllib trace traceback tracemalloc tty turtle types typing unicodedata unittest urllib uuid venv warnings wave weakref webbrowser winreg winsound wsgiref xml xmlrpc zipapp zipfile zipimport zlib zoneinfo";

fn in_stdlib(name: &str) -> bool {
    PYTHON_STDLIB.split(' ').any(|m| m == name)
}

/// `python -c` puts the working directory first on `sys.path`; a script file puts its own (temp)
/// directory there. Only a body whose every import is a standard-library module resolves
/// identically from both.
fn python_imports_outside_stdlib(body: &str) -> bool {
    if lazy_re!(r"\b(?:__import__|importlib|exec|eval|compile|runpy)\b", "").is_match(body) {
        return true;
    }
    for m in lazy_re!(r"(?:^|[;:\n])[ \t]*from[ \t]+([.\w]+)[ \t]+import\b", "g").captures_iter(body) {
        let module = m.get(1).unwrap_or("");
        if module.starts_with('.') || !in_stdlib(module.split('.').next().unwrap_or("")) {
            return true;
        }
    }
    for m in lazy_re!(r"(?:^|[;:\n])[ \t]*import[ \t]+([^;\n]+)", "g").captures_iter(body) {
        for part in m.get(1).unwrap_or("").split(',') {
            let first = lazy_re!(r"\s+as\s+", "").find(mixdog_js::js_trim(part));
            let trimmed = mixdog_js::js_trim(part);
            let before_as = first.map_or(trimmed, |r| &trimmed[..r.start]);
            let name = mixdog_js::js_trim(before_as).split('.').next().unwrap_or("");
            if !name.is_empty() && !in_stdlib(name) {
                return true;
            }
        }
    }
    false
}

/// `node -e` accepts ESM syntax and top-level `await`; the `.cjs` file a hoist writes does not.
async fn node_body_needs_module_syntax(
    body: &str,
    syntax: &dyn ScriptSyntax,
    thread: &ThreadId,
) -> Result<bool, ExtError> {
    if lazy_re!(r#"(?:^|[;{}\n])[ \t]*(?:import[ \t]*[\w$*{'"]|export[ \t])"#, "").is_match(body) {
        return Ok(true);
    }
    if !lazy_re!(r"\bawait\b", "").is_match(body) {
        return Ok(false);
    }
    // An `await` is top-level exactly when the body no longer compiles as CommonJS.
    Ok(!syntax.compiles_as_commonjs(thread, body).await?)
}

/// Posix: is `index` in live shell code — not inside a quote, `$'…'`, comment, or a heredoc body
/// (any heredoc earlier in the text declines, since its body cannot be bounded here).
fn posix_live_at(text: &[char], index: usize) -> bool {
    let find = |c: char, from: usize| (from..text.len()).find(|&k| text[k] == c);
    let closer = |from: usize, quote: char| {
        let mut j = from;
        while j < text.len() && text[j] != quote {
            j += if text[j] == '\\' { 2 } else { 1 };
        }
        (j < text.len()).then_some(j)
    };
    let mut i = 0;
    while i < index {
        let ch = text[i];
        let skip_to = |end: Option<usize>| match end {
            Some(e) if e < index => Some(e + 1),
            _ => None,
        };
        if ch == '\\' {
            i += 2;
        } else if ch == '\'' {
            match skip_to(find('\'', i + 1)) {
                Some(next) => i = next,
                None => return false,
            }
        } else if ch == '$' && text.get(i + 1) == Some(&'\'') {
            match skip_to(closer(i + 2, '\'')) {
                Some(next) => i = next,
                None => return false,
            }
        } else if ch == '"' {
            match skip_to(closer(i + 1, '"')) {
                Some(next) => i = next,
                None => return false,
            }
        } else if ch == '#'
            && (i == 0 || mixdog_js::is_js_space(text[i - 1]) || matches!(text[i - 1], ';' | '&' | '|' | '('))
        {
            match find('\n', i) {
                Some(nl) if nl < index => i = nl,
                _ => return false,
            }
        } else if ch == '<' && text.get(i + 1) == Some(&'<') && text.get(i + 2) != Some(&'<') {
            return false;
        } else {
            i += 1;
        }
    }
    true
}

/// A node/python invocation may be turned into a file run only when the shell itself runs it:
/// live code at command position (not an argument of docker/ssh/wsl/ts-node/…, which would run
/// the file somewhere that cannot see it).
fn is_shell_invocation_at(text: &[char], index: usize, powershell: bool) -> bool {
    if powershell {
        if !code_mask(text).is_some_and(|m| m.get(index).copied().unwrap_or(false)) {
            return false;
        }
    } else if !posix_live_at(text, index) {
        return false;
    }
    let boundary = |c: char| !(mixdog_js::is_js_space(c) || matches!(c, ';' | '|' | '&' | '(' | ')' | '{' | '}' | '<' | '>' | '\'' | '"'));
    let mut start = index;
    while start > 0 && boundary(text[start - 1]) {
        start -= 1;
    }
    if start < index && !matches!(text[index - 1], '\\' | '/') {
        return false;
    }
    let before: String = text[..start].iter().collect();
    let assignments = lazy_re!(r"(?:^|[\s;|&(){}])[A-Za-z_]\w*=[^\s;|&(){}]*[ \t]+$", "");
    let mut head = before;
    while let Some(m) = assignments.find(&head) {
        let lead: String = head[m.start..].chars().next().filter(|c| mixdog_js::is_js_space(*c) || ";|&(){}".contains(*c)).map(String::from).unwrap_or_default();
        head = format!("{}{}", &head[..m.start], lead);
    }
    let trimmed = head.trim_end_matches([' ', '\t']);
    if trimmed.is_empty() {
        return true;
    }
    let Some(last) = trimmed.chars().last() else { return true };
    if !";|&({\n".contains(last) {
        return false;
    }
    // A line continuation joins the next line onto this command's arguments.
    !(last == '\n' && lazy_re!(r"[\\`]\r?\n$", "").is_match(trimmed))
}

fn byte_to_char(s: &str, byte: usize) -> usize {
    s[..byte].chars().count()
}

/// `planInlineScriptHoist`.
pub async fn plan_inline_script_hoist(
    command: &str,
    powershell: bool,
    syntax: &dyn ScriptSyntax,
    thread: &ThreadId,
) -> Result<Option<Hoist>, ExtError> {
    if mixdog_js::js_trim(command).is_empty() {
        return Ok(None);
    }
    let Some(m) = lazy_re!(
        r#"\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+"((?:[^"\\]|\\.)*)""#,
        ""
    )
    .captures(command) else {
        return Ok(None);
    };
    let whole = m.range();
    let (Some(exe), raw_flags, body) = (m.get(1), m.get(2).unwrap_or(""), m.get(4).unwrap_or("")) else {
        return Ok(None);
    };
    if lazy_re!(r"[$`\\]", "").is_match(body) {
        return Ok(None);
    }
    // What may follow the closing quote for the run to be the same as a file run.
    if !lazy_re!(r"^[ \t]*(?:$|[\r\n|;&)<>]|\d+>)", "").is_match(&command[whole.end..]) {
        return Ok(None);
    }
    if lazy_re!(r#"(?:require|import)\s*\(\s*['"]\.{1,2}/|from\s+['"]\.{1,2}/|import\.meta|__dirname|__filename|__file__|require\.main|module\.(?:filename|parent)|sys\.argv\s*\[\s*0\s*\]|sys\.path\s*\[\s*0\s*\]|argv\s*\[\s*1\s*\]"#, "")
        .is_match(body)
    {
        return Ok(None);
    }
    if powershell && lazy_re!("[\u{201C}\u{201D}\u{201E}\u{201F}]", "").is_match(body) {
        return Ok(None);
    }
    let is_node = exe.to_lowercase().starts_with("node");
    if is_node && imports_package(body) {
        return Ok(None);
    }
    if is_node
        && !lazy_re!(r"--input-type=module", "").is_match(raw_flags)
        && node_body_needs_module_syntax(body, syntax, thread).await?
    {
        return Ok(None);
    }
    if !is_node && python_imports_outside_stdlib(body) {
        return Ok(None);
    }
    let chars: Vec<char> = command.chars().collect();
    if !is_shell_invocation_at(&chars, byte_to_char(command, whole.start), powershell) {
        return Ok(None);
    }
    let (extension, kept_flags) = file_shape(exe, raw_flags);
    Ok(Some(Hoist {
        extension,
        body: body.to_owned(),
        prefix: command[..whole.start].to_owned(),
        suffix: command[whole.end..].to_owned(),
        exe: exe.to_owned(),
        kept_flags,
        kind: Kind::Invocation { normalize_slashes: false },
    }))
}

/// `planLongInlineScriptFileTransport`: the body itself leaves the command line.
pub fn plan_long_inline_script_file_transport(command: &str, windows: bool, powershell: bool) -> Option<Hoist> {
    if !windows || utf16_len(command) < WINDOWS_INLINE_COMMAND_FILE_THRESHOLD {
        return None;
    }
    let m = lazy_re!(
        r#"\b(node(?:\.exe)?|python3?|py)((?:\s+--?[\w-]+(?:=[^\s"']+)?)*)\s+(-e|--eval|-c)\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)')"#,
        "i"
    )
    .captures(command)?;
    let whole = m.range();
    let (exe, raw_flags) = (m.get(1)?, m.get(2).unwrap_or(""));
    if !lazy_re!(r"^[ \t]*(?:$|[\r\n|;&)<>]|\d+>)", "").is_match(&command[whole.end..]) {
        return None;
    }
    let chars: Vec<char> = command.chars().collect();
    if !is_shell_invocation_at(&chars, byte_to_char(command, whole.start), powershell) {
        return None;
    }
    let (extension, kept_flags) = file_shape(exe, raw_flags);
    let body = match m.get(4) {
        None => {
            let single = m.get(5).unwrap_or("");
            if powershell && lazy_re!("[\u{2018}\u{2019}\u{201A}\u{201B}]", "").is_match(single) {
                return None;
            }
            if powershell { single.replace("''", "'") } else { single.replace("''", "") }
        }
        Some(double) => {
            // Inside double quotes the shell rewrites `$…`, backtick and backslash escapes before
            // the child sees them, so the verbatim body would be a different script.
            let smart = lazy_re!("[\u{201C}\u{201D}\u{201E}\u{201F}]", "").is_match(double);
            if lazy_re!(r#"[$`]|\\""#, "").is_match(double) || (if powershell { smart } else { double.contains("\\\\") }) {
                return None;
            }
            double.to_owned()
        }
    };
    Some(Hoist {
        extension,
        body,
        prefix: command[..whole.start].to_owned(),
        suffix: command[whole.end..].to_owned(),
        exe: exe.to_owned(),
        kept_flags,
        kind: Kind::Invocation { normalize_slashes: true },
    })
}

/// `planLongShellScriptFileTransport`: a generic oversized PowerShell command runs from a file.
pub fn plan_long_shell_script_file_transport(command: &str, windows: bool, powershell: bool) -> Option<Hoist> {
    if !windows
        || !powershell
        || utf16_len(command) < WINDOWS_INLINE_COMMAND_FILE_THRESHOLD
        || lazy_re!(r"\$(?:PSScriptRoot|PSCommandPath|MyInvocation)\b|^\s*(?:param\s*\(|#requires\b)", "im").is_match(command)
    {
        return None;
    }
    Some(Hoist {
        extension: ".ps1",
        body: command.to_owned(),
        prefix: String::new(),
        suffix: String::new(),
        exe: String::new(),
        kept_flags: String::new(),
        kind: Kind::Script,
    })
}

/// `hoistInlineScript`'s planning: the first plan that applies.
pub async fn plan_hoist(
    command: &str,
    windows: bool,
    powershell: bool,
    syntax: &dyn ScriptSyntax,
    thread: &ThreadId,
) -> Result<Option<Hoist>, ExtError> {
    if let Some(plan) = plan_inline_script_hoist(command, powershell, syntax, thread).await? {
        return Ok(Some(plan));
    }
    Ok(plan_long_inline_script_file_transport(command, windows, powershell)
        .or_else(|| plan_long_shell_script_file_transport(command, windows, powershell)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stands in for the worker's `new vm.Script`: accepts a body whose `await` follows an
    /// `async` keyword — enough for the recorded cases. The real checker is `ExtSyntax`.
    struct AsyncOnly;
    #[async_trait::async_trait]
    impl ScriptSyntax for AsyncOnly {
        async fn compiles_as_commonjs(&self, _: &ThreadId, body: &str) -> Result<bool, ExtError> {
            Ok(body.contains("async"))
        }
    }

    /// Node's `planInlineScriptHoist` on recorded commands: the hoisted text for a fixed file path
    /// and the file body/extension must be equal.
    #[tokio::test]
    async fn the_inline_hoist_equals_nodes() {
        let vectors: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("testdata/hoist_node_vectors.json")).unwrap();
        assert_eq!(vectors.len(), 96);
        for v in &vectors {
            let command = v["command"].as_str().unwrap();
            let powershell = v["shellType"] == "powershell";
            let got = plan_inline_script_hoist(command, powershell, &AsyncOnly, &ThreadId::from("t"))
                .await
                .unwrap();
            match (&v["result"], got) {
                (serde_json::Value::Null, None) => {}
                (want, Some(h)) if !want.is_null() => {
                    assert_eq!(want["extension"].as_str(), Some(h.extension), "{command:?}");
                    assert_eq!(want["body"].as_str(), Some(h.body.as_str()), "{command:?}");
                    assert_eq!(want["replaced"].as_str(), Some(h.replace("C:/tmp/x.file").as_str()), "{command:?}");
                }
                (want, got) => panic!("{command:?} ({powershell}): want {want}, got {:?}", got.map(|h| h.replace("P"))),
            }
        }
    }

    #[test]
    fn long_commands_go_through_a_file_on_windows() {
        let body = "x".repeat(WINDOWS_INLINE_COMMAND_FILE_THRESHOLD);
        let command = format!("node -e \"{body}\"");
        assert!(plan_long_inline_script_file_transport(&command, true, true).is_some());
        assert!(plan_long_inline_script_file_transport(&command, false, true).is_none());
        let script = plan_long_shell_script_file_transport(&format!("Write-Output '{body}'"), true, true).unwrap();
        assert_eq!(script.extension, ".ps1");
        assert_eq!(
            script.replace("C:\\t\\a'b.ps1"),
            "Invoke-Expression ([System.IO.File]::ReadAllText('C:/t/a''b.ps1', [System.Text.Encoding]::UTF8) + \"`n\" + '$global:__mixdogLastOk = $?'); if ($global:__mixdogLastOk -eq $false) { exit 1 }"
        );
        assert!(plan_long_shell_script_file_transport(&format!("$PSScriptRoot {body}"), true, true).is_none());
    }
}
