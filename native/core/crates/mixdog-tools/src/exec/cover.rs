//! Which shell commands the built-in tools cover whole (`bash-tool/tool-cover.mjs`). A statement is covered
//! only when its command, every flag and every operand are on the allow-list below, each entry of which has a
//! replacement call that returns the same information; everything else (an unknown flag or filter, a filter that
//! computes or writes, a wildcard, a variable, several paths, a device, a path the tool would read differently, a
//! value outside the replacement's schema) is not covered and keeps running in the shell. The replacement text is
//! the parsed form itself, checked against the replacing tool's input schema.
//!
//! Covered forms (P = one plain path to an existing regular text file; N = 1..500):
//!   read:   `cat P`; `head [-n] N P`; `tail [-n] N P`; `tail -n +K P`; `Get-Content|gc|cat|type [-Path|-LiteralPath] P
//!           [-TotalCount|-First|-Head N | -Tail|-Last N]`; a read without a window piped to `head`, `tail`,
//!           `Select-Object -First|-Last N`
//!   search: `grep|rg [-i] [-n] PATTERN P`, `Select-String [-Pattern] PATTERN [-Path] P [-CaseSensitive]`, and a plain read of
//!           P piped to `grep PATTERN` / `Select-String PATTERN`
//!   list:   `ls D` (D a directory of at most 100 entries, none a pruned dependency folder)
//! Not covered, by decision: any git command, any redirect, more than one statement.

use std::sync::LazyLock;

use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::fs::EntryKind;
use mixdog_core_api::domain::fs::ReadRange;
use mixdog_core_api::domain::tool::ToolContext;
use mixdog_js::js_trim;
use mixdog_protocol::JsonValue;
use regex::Regex;
use serde_json::json;

use super::benign::split_pipeline_segments;
use super::benign::split_segments;
use super::benign::tokenize;

/// The replacement a covered command names: a tool and its arguments, in the order the text shows them.
#[derive(Debug, PartialEq)]
pub(crate) struct Call {
    pub tool: &'static str,
    pub args: JsonValue,
}

impl Call {
    fn text(&self) -> String {
        format!("{} {}", self.tool, mixdog_js::json_stringify(&self.args))
    }
}

/// The refusal text for a covered command (before the tool-failure framing).
pub(crate) fn blocked_text(calls: &[Call]) -> String {
    let named: Vec<String> = calls.iter().map(Call::text).collect();
    format!("Blocked: the built-in tools cover this command, so it was not run. Call instead: {}", named.join("; "))
}

/// The tool a replacement can name, as the session offers it.
pub const COVERING_TOOLS: [&str; 3] = ["read", "grep", "list"];

// The read tool's default window; a covered window never exceeds it, so the replacement is never paged where the command was not.
const WINDOW_MAX: u64 = 500;
const WHOLE_FILE_BYTES: u64 = 16 * 1024;
const PEEK_BYTES: u64 = 8 * 1024;
const LIST_MAX: usize = 100;

static SIMPLE_PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_][A-Za-z0-9_ .:=@%/-]*$").expect("a fixed pattern"));
// Shell-significant or wildcard characters a covered path may not contain.
static UNSAFE_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*?\[\]{}$`,;|&<>()]").expect("a fixed pattern"));
// The read tool takes `path:12` and `path#L12` as a line coordinate.
static LINE_COORDINATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)#L[0-9]|:[0-9]+(?:-[0-9]+)?(?::|$)").expect("a fixed pattern"));
static DRIVE_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:").expect("a fixed pattern"));
static BARE_COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-[0-9]+$").expect("a fixed pattern"));
static ATTACHED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-n?([0-9]+)$").expect("a fixed pattern"));
static ATTACHED_SKIP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-n(\+[0-9]+)$").expect("a fixed pattern"));
static COUNT_ARG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\+?[0-9]+$").expect("a fixed pattern"));
static SKIP_ARG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\+[1-9][0-9]*$").expect("a fixed pattern"));
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+$").expect("a fixed pattern"));
static POWERSHELL_WILDCARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\[*?]").expect("a fixed pattern"));
static HOME_OR_SPLAT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[~@]").expect("a fixed pattern"));

fn command_name(token: &str) -> String {
    let lower = mixdog_js::js_to_lowercase(token);
    let base = lower.rsplit(['\\', '/']).next().unwrap_or("");
    base.strip_suffix(".exe").unwrap_or(base).to_owned()
}

/// Shell syntax the tools cannot reproduce: background/substitution/grouping/redirection/variables, a comment, or an
/// unterminated quote. Single quotes hide everything; double quotes still expand `$` and backticks.
fn has_shell_syntax(text: &str, powershell: bool) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut quote: Option<char> = None;
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else if q == '"' && (ch == '$' || ch == '`') {
                return true;
            }
            i += 1;
            continue;
        }
        if ch == '\\' && !powershell {
            i += 2;
            continue;
        }
        if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if "&<>(){}$`".contains(ch) || (ch == '#' && (i == 0 || mixdog_js::is_js_space(chars[i - 1]))) {
            return true;
        }
        i += 1;
    }
    quote.is_some()
}

/// `||` outside quotes: the second statement's running depends on the first's failure.
fn has_or_operator(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut quote: Option<char> = None;
    for i in 0..chars.len() {
        let ch = chars[i];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
        } else if ch == '\'' || ch == '"' {
            quote = Some(ch);
        } else if ch == '|' && chars.get(i + 1) == Some(&'|') {
            return true;
        }
    }
    false
}

fn is_flag(token: &str) -> bool {
    token.starts_with('-') && token.chars().count() > 1 && !BARE_COUNT.is_match(token)
}

fn window_count(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if !DIGITS.is_match(value) {
        return None;
    }
    value.parse::<u64>().ok().filter(|n| (1..=WINDOW_MAX).contains(n))
}

// ── files ────────────────────────────────────────────────────────────────────

struct PlainFile {
    full: AbsPath,
    size: u64,
}

/// One literal path the read/grep/list tools would open as the very same file or directory.
async fn plain_path(ctx: &ToolContext, token: &str, base: &str, directory: bool) -> Option<PlainFile> {
    if token.is_empty() || is_flag(token) || token == "--" {
        return None;
    }
    if HOME_OR_SPLAT.is_match(token) || UNSAFE_PATH.is_match(token) {
        return None;
    }
    if crate::fs::normalize_input_path(token) != token {
        return None;
    }
    let without_drive = DRIVE_PREFIX.replace(token, "");
    if LINE_COORDINATE.is_match(&without_drive) {
        return None;
    }
    let full = mixdog_js::nodepath::resolve_host(&[base, token]);
    for candidate in [token, full.as_str()] {
        if mixdog_js::device_paths::is_unc_path(candidate)
            || mixdog_js::device_paths::is_windows_device_path(candidate)
            || mixdog_js::device_paths::has_unsafe_win32_component(candidate)
            || mixdog_js::device_paths::is_blocked_device_path(candidate)
        {
            return None;
        }
    }
    let abs = AbsPath::new(full)?;
    let stat = ctx.files.stat(ctx.io.interactive, abs.clone()).await.ok()?;
    let wanted = if directory { EntryKind::Dir } else { EntryKind::File };
    (stat.kind == wanted).then_some(PlainFile { full: abs, size: stat.len })
}

async fn head_bytes(ctx: &ToolContext, file: &PlainFile) -> Option<Vec<u8>> {
    let range = ReadRange { offset: 0, max_len: Some(PEEK_BYTES) };
    ctx.files.read(ctx.io.interactive, file.full.clone(), range).await.ok().map(|b| b.bytes)
}

fn is_plain_text(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && !bytes.starts_with(&[0xef, 0xbb, 0xbf])
}

/// A file the read tool returns in one window with nothing dropped.
async fn is_whole_file(ctx: &ToolContext, file: &PlainFile) -> bool {
    if file.size > WHOLE_FILE_BYTES {
        return false;
    }
    let Ok(read) = ctx.files.read(ctx.io.interactive, file.full.clone(), ReadRange::default()).await else { return false };
    let bytes = read.bytes;
    if !is_plain_text(&bytes) || std::str::from_utf8(&bytes).is_err() {
        return false;
    }
    // A last line without its newline is a line too.
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
    let unterminated = u64::from(bytes.last().is_some_and(|b| *b != b'\n'));
    newlines + unterminated <= WINDOW_MAX
}

// ── schemas ──────────────────────────────────────────────────────────────────

fn conforms(value: &JsonValue, schema: &JsonValue) -> bool {
    if let Some(options) = schema.get("anyOf").and_then(JsonValue::as_array) {
        return options.iter().any(|option| conforms(value, option));
    }
    if let Some(allowed) = schema.get("enum").and_then(JsonValue::as_array)
        && !allowed.contains(value)
    {
        return false;
    }
    match schema.get("type").and_then(JsonValue::as_str) {
        Some("string") => value.is_string(),
        Some("integer") => {
            let Some(n) = value.as_f64().filter(|n| n.fract() == 0.0) else { return false };
            n >= schema.get("minimum").and_then(JsonValue::as_f64).unwrap_or(f64::NEG_INFINITY)
                && n <= schema.get("maximum").and_then(JsonValue::as_f64).unwrap_or(f64::INFINITY)
        }
        Some("boolean") => value.is_boolean(),
        Some("array") => {
            let Some(items) = value.as_array() else { return false };
            let empty = json!({});
            items.len() as u64 >= schema.get("minItems").and_then(JsonValue::as_u64).unwrap_or(0)
                && items.len() as u64 <= schema.get("maxItems").and_then(JsonValue::as_u64).unwrap_or(u64::MAX)
                && items.iter().all(|item| conforms(item, schema.get("items").unwrap_or(&empty)))
        }
        Some("object") => {
            let Some(map) = value.as_object() else { return false };
            if let Some(required) = schema.get("required").and_then(JsonValue::as_array)
                && required.iter().any(|key| key.as_str().is_some_and(|k| !map.contains_key(k)))
            {
                return false;
            }
            map.iter().all(|(key, item)| match schema.get("properties").and_then(|p| p.get(key)) {
                Some(property) => conforms(item, property),
                None => schema.get("additionalProperties") != Some(&JsonValue::Bool(false)),
            })
        }
        _ => true,
    }
}

fn input_schema(tool: &str) -> JsonValue {
    static SCHEMAS: LazyLock<[(&str, JsonValue); 3]> = LazyLock::new(|| {
        let schema = |def: &str| serde_json::from_str::<JsonValue>(def).expect("an embedded tool definition")["inputSchema"].clone();
        [
            ("read", schema(include_str!("../fs/specs/read.json"))),
            ("grep", schema(include_str!("../fs/specs/grep.json"))),
            ("list", schema(include_str!("../fs/specs/list.json"))),
        ]
    });
    SCHEMAS.iter().find(|(name, _)| *name == tool).map(|(_, schema)| schema.clone()).unwrap_or(JsonValue::Null)
}

fn call_is_valid(call: &Call) -> bool {
    conforms(&call.args, &input_schema(call.tool))
}

// ── read ─────────────────────────────────────────────────────────────────────

/// What a read statement asks for.
#[derive(Clone, Default)]
struct ReadSpec {
    file: String,
    first: Option<u64>,
    last: Option<u64>,
    skip: Option<u64>,
}

/// What a search statement asks for.
struct SearchSpec {
    file: String,
    pattern: String,
    ignore_case: bool,
}

enum Spec {
    Read(ReadSpec),
    Search(SearchSpec),
}

/// `head` / `tail` flags.
struct Window {
    first: Option<u64>,
    last: Option<u64>,
    skip: Option<u64>,
    operands: Vec<String>,
}

fn count_window(name: &str, args: &[String]) -> Option<Window> {
    let mut out = Window { first: None, last: None, skip: None, operands: Vec::new() };
    let mut counted = false;
    let mut take = |out: &mut Window, text: &str| -> bool {
        if counted {
            return false;
        }
        counted = true;
        if let Some(digits) = text.strip_prefix('+') {
            if name != "tail" || !SKIP_ARG.is_match(text) {
                return false;
            }
            out.skip = digits.parse().ok();
            return out.skip.is_some();
        }
        let Some(count) = window_count(Some(text)) else { return false };
        if name == "head" {
            out.first = Some(count);
        } else {
            out.last = Some(count);
        }
        true
    };
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        if let Some(found) = ATTACHED.captures(token).or_else(|| ATTACHED_SKIP.captures(token)) {
            if !take(&mut out, &found[1]) {
                return None;
            }
        } else if token == "-n" {
            let next = args.get(i + 1)?;
            if !COUNT_ARG.is_match(next) {
                return None;
            }
            i += 1;
            if !take(&mut out, &args[i]) {
                return None;
            }
        } else if is_flag(token) {
            return None;
        } else {
            out.operands.push(token.clone());
        }
        i += 1;
    }
    if !counted {
        if name == "head" {
            out.first = Some(10);
        } else {
            out.last = Some(10);
        }
    }
    Some(out)
}

fn read_spec(name: &str, args: &[String], powershell: bool) -> Option<ReadSpec> {
    if !powershell {
        if name == "cat" {
            return (args.len() == 1).then(|| ReadSpec { file: args[0].clone(), ..ReadSpec::default() });
        }
        let window = count_window(name, args)?;
        return (window.operands.len() == 1).then(|| ReadSpec {
            file: window.operands[0].clone(),
            first: window.first,
            last: window.last,
            skip: window.skip,
        });
    }
    let mut spec = ReadSpec::default();
    let mut file: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let flag = mixdog_js::js_to_lowercase(&args[i]);
        let set_file = |file: &mut Option<String>, value: Option<&String>| match (file.is_some(), value) {
            (false, Some(v)) => {
                *file = Some(v.clone());
                true
            }
            _ => false,
        };
        match flag.as_str() {
            "-path" | "-literalpath" => {
                i += 1;
                if !set_file(&mut file, args.get(i)) {
                    return None;
                }
            }
            "-totalcount" | "-first" | "-head" => {
                i += 1;
                let count = window_count(args.get(i).map(String::as_str))?;
                if spec.first.is_some() {
                    return None;
                }
                spec.first = Some(count);
            }
            "-tail" | "-last" => {
                i += 1;
                let count = window_count(args.get(i).map(String::as_str))?;
                if spec.last.is_some() {
                    return None;
                }
                spec.last = Some(count);
            }
            _ => {
                if is_flag(&args[i]) || !set_file(&mut file, Some(&args[i])) {
                    return None;
                }
            }
        }
        i += 1;
    }
    spec.file = file?;
    (!(spec.first.is_some() && spec.last.is_some())).then_some(spec)
}

// ── search ───────────────────────────────────────────────────────────────────

fn search_spec(args: &[String], powershell: bool) -> Option<SearchSpec> {
    let mut pattern: Option<String> = None;
    let mut file: Option<String> = None;
    let mut ignore_case = powershell;
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let token = &args[i];
        let flag = mixdog_js::js_to_lowercase(token);
        if powershell {
            if flag == "-pattern" {
                if pattern.is_some() || args.get(i + 1).is_none() {
                    return None;
                }
                i += 1;
                pattern = Some(args[i].clone());
            } else if flag == "-path" || flag == "-literalpath" {
                if file.is_some() || args.get(i + 1).is_none() {
                    return None;
                }
                i += 1;
                file = Some(args[i].clone());
            } else if flag == "-casesensitive" {
                ignore_case = false;
            } else if is_flag(token) {
                return None;
            } else {
                positional.push(token.clone());
            }
        } else if token.len() > 1 && token.starts_with('-') && token[1..].chars().all(|c| c == 'i' || c == 'n') {
            ignore_case = ignore_case || token.contains('i');
        } else if is_flag(token) {
            return None;
        } else {
            positional.push(token.clone());
        }
        i += 1;
    }
    let mut positional = positional.into_iter();
    let pattern = pattern.or_else(|| positional.next());
    let file = file.or_else(|| positional.next());
    if positional.next().is_some() {
        return None;
    }
    Some(SearchSpec { file: file?, pattern: pattern?, ignore_case })
}

/// A pipeline stage after a read of one file: a window or a search of the same file.
fn filter_spec(spec: &ReadSpec, stage: &str, powershell: bool) -> Option<Spec> {
    if spec.first.is_some() || spec.last.is_some() || spec.skip.is_some() {
        return None;
    }
    let tokens = tokenize(stage)?;
    if tokens.is_empty() {
        return None;
    }
    let name = command_name(&tokens[0]);
    let rest = &tokens[1..];
    if !powershell && (name == "head" || name == "tail") {
        let window = count_window(&name, rest)?;
        if !window.operands.is_empty() || window.skip.is_some() {
            return None;
        }
        return Some(Spec::Read(ReadSpec { file: spec.file.clone(), first: window.first, last: window.last, skip: None }));
    }
    if powershell && (name == "select-object" || name == "select") {
        let flag = rest.first().map(|f| mixdog_js::js_to_lowercase(f));
        let count = window_count(rest.get(1).map(String::as_str));
        let (Some(count), Some(flag)) = (count, flag) else { return None };
        if rest.len() != 2 || (flag != "-first" && flag != "-last") {
            return None;
        }
        let first = (flag == "-first").then_some(count);
        let last = (flag == "-last").then_some(count);
        return Some(Spec::Read(ReadSpec { file: spec.file.clone(), first, last, skip: None }));
    }
    let searches: &[&str] = if powershell { &["select-string", "sls"] } else { &["grep"] };
    if searches.contains(&name.as_str()) && rest.len() == 1 && !is_flag(&rest[0]) {
        return Some(Spec::Search(SearchSpec { file: spec.file.clone(), pattern: rest[0].clone(), ignore_case: powershell }));
    }
    None
}

/// The call for a parsed read or search, or `None` when the files or the pattern are not exactly covered.
async fn call_for(ctx: &ToolContext, spec: Spec, base: &str) -> Option<Call> {
    let path = match &spec {
        Spec::Read(read) => read.file.as_str(),
        Spec::Search(search) => search.file.as_str(),
    };
    let file = plain_path(ctx, path, base, false).await?;
    if !is_plain_text(&head_bytes(ctx, &file).await?) {
        return None;
    }
    match spec {
        Spec::Search(search) => {
            // Every match of a file this small fits one unpaged answer.
            if !SIMPLE_PATTERN.is_match(&search.pattern) || !is_whole_file(ctx, &file).await {
                return None;
            }
            let pattern = if search.ignore_case { format!("(?i){}", search.pattern) } else { search.pattern };
            Some(Call { tool: "grep", args: json!({ "pattern": pattern, "path": search.file, "context": 0, "limit": 0 }) })
        }
        Spec::Read(read) => {
            if let Some(first) = read.first {
                return Some(Call { tool: "read", args: json!({ "file_path": read.file, "limit": first }) });
            }
            if let Some(last) = read.last {
                return Some(Call { tool: "read", args: json!({ "file_path": read.file, "tail": last }) });
            }
            if !is_whole_file(ctx, &file).await {
                return None;
            }
            let args = match read.skip {
                None => json!({ "file_path": read.file }),
                Some(skip) => json!({ "file_path": read.file, "offset": skip }),
            };
            Some(Call { tool: "read", args })
        }
    }
}

// ── list ─────────────────────────────────────────────────────────────────────

/// `ls D`: the list tool shows the same entries when D has no dotfile-independent difference (a pruned dependency
/// folder) and fits one page.
async fn list_call(ctx: &ToolContext, args: &[String], base: &str) -> Option<Call> {
    if args.len() != 1 {
        return None;
    }
    let dir = plain_path(ctx, &args[0], base, true).await?;
    let entries = ctx.files.list_dir(ctx.io.interactive, dir.full).await.ok()?;
    let names: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.path.as_path().file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|name| !name.starts_with('.'))
        .collect();
    if names.len() > LIST_MAX || names.iter().any(|name| crate::fs::common::NOISE_DIRS.contains(&name.as_str())) {
        return None;
    }
    Some(Call { tool: "list", args: json!({ "path": args[0] }) })
}

// ── statements and commands ──────────────────────────────────────────────────

/// The tool call replacing one statement, or `None` when it is not covered.
async fn cover_statement(ctx: &ToolContext, statement: &str, powershell: bool, base: &str) -> Option<Call> {
    let stages = split_pipeline_segments(statement);
    if stages.is_empty() || tokenize(&stages[0]).is_none_or(|t| t.is_empty()) {
        return None;
    }
    let text = js_trim(statement);
    if stages.iter().any(|stage| has_shell_syntax(stage, powershell)) {
        return None;
    }
    // The tokenizer reads `\*` as an escaped star, but in PowerShell it is a path separator and a wildcard.
    if powershell && POWERSHELL_WILDCARD.is_match(text) {
        return None;
    }
    let tokens = tokenize(&stages[0])?;
    let name = command_name(&tokens[0]);
    let args = &tokens[1..];
    if name == "ls" && !powershell {
        return if stages.len() == 1 { list_call(ctx, args, base).await } else { None };
    }
    let readers: &[&str] = if powershell { &["get-content", "gc", "cat", "type"] } else { &["cat", "head", "tail"] };
    let searchers: &[&str] = if powershell { &["select-string", "sls"] } else { &["grep", "rg"] };
    let spec = if readers.contains(&name.as_str()) {
        Spec::Read(read_spec(&name, args, powershell)?)
    } else if searchers.contains(&name.as_str()) {
        Spec::Search(search_spec(args, powershell)?)
    } else {
        return None;
    };
    if stages.len() > 2 {
        return None;
    }
    let spec = if stages.len() == 2 {
        match &spec {
            Spec::Read(read) => filter_spec(read, &stages[1], powershell)?,
            Spec::Search(_) => return None,
        }
    } else {
        spec
    };
    call_for(ctx, spec, base).await
}

/// The tool call that replaces `command` (a one-element list), or `None` when the command is more than one statement or
/// its statement is not on the allow-list. Relative paths are judged against the session directory.
pub(crate) async fn covering_tool_calls(ctx: &ToolContext, command: &str, powershell: bool) -> Option<Vec<Call>> {
    if has_or_operator(command) {
        return None;
    }
    let statements = split_segments(command);
    if statements.len() != 1 {
        return None;
    }
    // The splitters drop a dangling operator (`cat f &&`, `cat f |`), which the shell refuses as a syntax error: the one
    // statement must be the whole text.
    let text = js_trim(command);
    if js_trim(&statements[0]) != text || text.ends_with(['|', '&']) {
        return None;
    }
    let base = ctx.cwd.as_path().to_string_lossy().into_owned();
    let call = cover_statement(ctx, &statements[0], powershell, &base).await?;
    call_is_valid(&call).then(|| vec![call])
}
