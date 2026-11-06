//! `ResultReuse`: one freshness authority for a session's cached read-only tool results
//! (`session/cache/tool-result-reuse.mjs`, `read-cache.mjs`, `scoped-cache.mjs`, and the
//! invalidation in `tool-batch/record-outcome.mjs`).
//!
//! `read` results are valid while the file's stat tuple is unchanged and the file fits the
//! hashed-prefix budget; `list`/`glob` results live 30 s and drop when a mutation touches a root
//! they depend on. `grep` is keyed on the canonical form `prepareGrepArgs` gives (an invalid
//! request is never cached). `code_graph` is cached only with the dependency roots the tool
//! records while it runs, since without them an entry could not be invalidated precisely.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::env::Clock;
use mixdog_agent::env::ResultReuse;
use mixdog_agent::env::Reused;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_js::device_paths;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_protocol::JsonValue;
use serde_json::Map;

use super::grep_args::prepare_grep_args;

const MAX_PER_SESSION: usize = 100;
const TEXT_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const SCOPED_TTL_MS: i64 = 30_000;
/// The bounded validator certifies a whole file only within this budget.
const READ_PREFIX_HASH_BYTES: u64 = 65_536;
const MCP_TOOL_PREFIX: &str = "mcp__plugin_mixdog_mixdog__";
const CURSOR_NATIVE_PREFIX: &str = "cursor_native_";

fn strip_mcp(name: &str) -> &str {
    name.strip_prefix(MCP_TOOL_PREFIX).unwrap_or(name)
}

// ---- paths ----

fn is_abs(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        path.starts_with(['/', '\\']) || (b.len() >= 3 && b[1] == b':' && b[0].is_ascii_alphabetic() && (b[2] == b'/' || b[2] == b'\\'))
    } else {
        path.starts_with('/')
    }
}

/// `path.normalize`, lexically: separators folded to `/`, `.` and empty parts dropped, `..`
/// resolved (a rooted path cannot climb above its root).
fn normalize(path: &str) -> String {
    let text: String = if cfg!(windows) { path.replace('\\', "/") } else { path.to_owned() };
    let (root, rest) = {
        let b = text.as_bytes();
        if cfg!(windows) && b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
            let after = &text[2..];
            if after.starts_with('/') { (format!("{}/", &text[..2]), &text[3..]) } else { (text[..2].to_owned(), after) }
        } else if cfg!(windows) && text.starts_with("//") {
            ("//".to_owned(), &text[2..])
        } else if text.starts_with('/') {
            ("/".to_owned(), &text[1..])
        } else {
            (String::new(), text.as_str())
        }
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|p| *p != "..") {
                    parts.pop();
                } else if root.is_empty() {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    let body = parts.join("/");
    if root.is_empty() && body.is_empty() { ".".to_owned() } else { format!("{root}{body}") }
}

/// `_normalizeCacheKey`: forward slashes, no trailing slash, Windows paths folded to lower case,
/// a POSIX drive letter lowered. No realpath: a symlink is its own key.
fn cache_key(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    if cfg!(windows) {
        s = s.to_lowercase();
    } else {
        let b = s.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_uppercase() && b[1] == b':' && b[2] == b'/' {
            s = format!("{}{}", s[..1].to_lowercase(), &s[1..]);
        }
    }
    if s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

pub(crate) fn resolve(base: &str, path: &str) -> String {
    if is_abs(path) {
        return normalize(path);
    }
    let base = if base.is_empty() {
        std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        base.to_owned()
    };
    normalize(&format!("{base}/{path}"))
}

fn normalize_abs(path: &str, cwd: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    Some(cache_key(&resolve(cwd, path)))
}

// ---- stat tuples ----

#[derive(Clone, PartialEq, Debug)]
struct Stat {
    size: u64,
    times: [u128; 2],
    ino: u64,
    dev: u64,
}

fn stat_tuple(abs: &str) -> Option<Stat> {
    if device_paths::is_unc_path(abs)
        || device_paths::is_windows_device_path(abs)
        || device_paths::has_unsafe_win32_component(abs)
        || device_paths::is_blocked_device_path(abs)
    {
        return None;
    }
    let meta = std::fs::metadata(abs).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let ns = |s: i64, n: i64| (s as i128 * 1_000_000_000 + n as i128).max(0) as u128;
        Some(Stat {
            size: meta.size(),
            times: [ns(meta.mtime(), meta.mtime_nsec()), ns(meta.ctime(), meta.ctime_nsec())],
            ino: meta.ino(),
            dev: meta.dev(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Some(Stat {
            size: meta.file_size(),
            times: [meta.last_write_time() as u128, meta.creation_time() as u128],
            ino: 0,
            dev: 0,
        })
    }
}

fn cacheable(stat: &Option<Stat>) -> bool {
    stat.as_ref().is_some_and(|s| s.size <= READ_PREFIX_HASH_BYTES)
}

// ---- bounded text cache ----

struct Entry<T> {
    key: String,
    content: String,
    ts: i64,
    first: Option<String>,
    meta: T,
}

/// Insertion-ordered map bounded in entries and retained UTF-16 bytes; a hit moves to the back.
struct Bounded<T> {
    entries: Vec<Entry<T>>,
}

impl<T> Bounded<T> {
    fn new() -> Self {
        Self { entries: Vec::new() }
    }

    fn position(&self, key: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.key == key)
    }

    fn remove(&mut self, key: &str) -> Option<Entry<T>> {
        self.position(key).map(|i| self.entries.remove(i))
    }

    fn bytes(e: &Entry<T>) -> usize {
        (utf16_len(&e.key) + utf16_len(&e.content)) * 2
    }

    /// `setBoundedTextCacheEntry`: false when the entry alone exceeds the byte budget.
    fn set(&mut self, entry: Entry<T>) -> bool {
        self.remove(&entry.key);
        let incoming = Self::bytes(&entry);
        if incoming > TEXT_CACHE_MAX_BYTES {
            return false;
        }
        let mut retained = incoming + self.entries.iter().map(Self::bytes).sum::<usize>();
        while self.entries.len() >= MAX_PER_SESSION || retained > TEXT_CACHE_MAX_BYTES {
            let oldest = self.entries.remove(0);
            retained -= Self::bytes(&oldest);
        }
        self.entries.push(entry);
        true
    }
}

// ---- read cache ----

struct ReadMeta {
    /// Each constituent file with the stat the body was read against.
    stats: Vec<(String, Option<Stat>)>,
}

fn arg<'a>(args: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    args.get(name).filter(|v| !v.is_null())
}

/// `args?.x ?? ''` as the template literal shows it.
fn text_of(args: &JsonValue, name: &str) -> String {
    arg(args, name).map(value_to_string).unwrap_or_default()
}

fn path_arg(args: &JsonValue) -> Option<&JsonValue> {
    arg(args, "path").or_else(|| arg(args, "file_path"))
}

struct ElemOpts {
    off: String,
    lim: String,
    mode: String,
    n: String,
    line: String,
    context: String,
    full: String,
}

fn elem_opts(args: &JsonValue) -> ElemOpts {
    ElemOpts {
        off: text_of(args, "offset"),
        lim: text_of(args, "limit"),
        mode: text_of(args, "mode"),
        n: text_of(args, "n"),
        line: text_of(args, "line"),
        context: text_of(args, "context"),
        full: text_of(args, "full"),
    }
}

/// The key and stats of an array-form path: top-level options are per-element defaults.
fn array_key(args: &JsonValue, cwd: &str) -> Option<(String, Vec<(String, Option<Stat>)>)> {
    let elems = path_arg(args)?.as_array()?;
    let base = u8::from(arg(args, "file_path").is_some_and(JsonValue::is_array) && arg(args, "path").is_none());
    let top = elem_opts(args);
    let pages = text_of(args, "pages");
    let full = text_of(args, "full");
    let mut parts = Vec::new();
    let mut stats: Vec<(String, Option<Stat>)> = Vec::new();
    for elem in elems {
        let (abs, own) = match elem {
            JsonValue::String(s) => (normalize_abs(s, cwd)?, elem_opts(&JsonValue::Null)),
            JsonValue::Object(_) => {
                let p = elem.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).or_else(|| elem.get("file_path").and_then(|v| v.as_str()))?;
                (normalize_abs(p, cwd)?, elem_opts(elem))
            }
            _ => return None,
        };
        let pick = |own: &str, top: &str| if own.is_empty() { top.to_owned() } else { own.to_owned() };
        parts.push(format!(
            "{abs}|o={}|l={}|m={}|n={}|line={}|ctx={}|f={}",
            pick(&own.off, &top.off),
            pick(&own.lim, &top.lim),
            pick(&own.mode, &top.mode),
            pick(&own.n, &top.n),
            pick(&own.line, &top.line),
            pick(&own.context, &top.context),
            pick(&own.full, &top.full),
        ));
        if !stats.iter().any(|(a, _)| *a == abs) {
            let stat = stat_tuple(&abs);
            stats.push((abs, stat));
        }
    }
    let key = format!(
        "[ARR]{}|p={pages}|f={full}|to={}|tl={}|tm={}|tn={}|tline={}|tctx={}|tf={}|base={base}",
        parts.join("||"),
        top.off,
        top.lim,
        top.mode,
        top.n,
        top.line,
        top.context,
        top.full,
    );
    Some((key, stats))
}

fn scalar_key(args: &JsonValue, cwd: &str) -> Option<(String, String)> {
    let p = path_arg(args)?;
    let JsonValue::String(p) = p else {
        return None;
    };
    let abs = normalize_abs(p, cwd)?;
    let alias = arg(args, "file_path").is_some_and(JsonValue::is_string) && arg(args, "path").is_none();
    let raw_off = text_of(args, "offset");
    let mut off = raw_off.clone();
    if alias && !raw_off.is_empty() {
        let n = mixdog_js::to_number(arg(args, "offset")?);
        if n.is_finite() {
            off = mixdog_js::number_to_string((n.trunc() - 1.0).max(0.0));
        }
    }
    let key = format!(
        "{abs}|o={off}|l={}|m={}|n={}|p={}|f={}|line={}|ctx={}|base={}",
        text_of(args, "limit"),
        text_of(args, "mode"),
        text_of(args, "n"),
        text_of(args, "pages"),
        text_of(args, "full"),
        text_of(args, "line"),
        text_of(args, "context"),
        u8::from(alias),
    );
    Some((key, abs))
}

// ---- scoped cache ----

struct ScopedMeta {
    dep_roots: Vec<String>,
}

fn has_glob_magic(s: &str) -> bool {
    s.contains(['*', '?', '[', '{'])
}

fn canonical_args(args: &JsonValue) -> String {
    match args {
        JsonValue::Null => String::new(),
        JsonValue::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            let mut sorted = Map::new();
            for k in keys {
                let v = &map[k];
                if v.is_null() || v.as_str() == Some("") {
                    continue;
                }
                sorted.insert(k.clone(), v.clone());
            }
            mixdog_js::json_stringify(&JsonValue::Object(sorted))
        }
        other => value_to_string(other),
    }
}

const GLOB_ARG_ALIASES: [(&str, &[&str]); 2] = [
    ("pattern", &["glob", "file_pattern", "filePattern", "name", "include", "includes", "files"]),
    ("path", &["root", "directory", "dir"]),
];

fn empty_arg(v: Option<&JsonValue>) -> bool {
    v.is_none_or(|v| v.is_null() || v.as_str() == Some(""))
}

const GREP_ARG_ALIASES: [(&str, &[&str]); 3] = [
    ("pattern", &["query", "regex", "regexp", "needle", "search", "literal"]),
    ("glob", &["file_pattern", "filePattern", "include", "includes", "files"]),
    ("path", &["root", "directory", "dir"]),
];

/// An empty canonical field takes the first alias spelling present; every alias is then dropped
/// so spellings never split the key (`_adoptAliases`).
fn adopt_aliases(next: &mut Map<String, JsonValue>, table: &[(&str, &[&str])]) {
    for (key, aliases) in table {
        if empty_arg(next.get(*key)) {
            let found = aliases.iter().find_map(|a| next.get(*a).filter(|v| !v.is_null() && v.as_str() != Some("")).cloned());
            if let Some(v) = found {
                next.insert((*key).to_owned(), v);
            }
        }
    }
    for (_, aliases) in table {
        for a in *aliases {
            next.shift_remove(*a);
        }
    }
}

/// A glob's alias spellings collapse to the canonical field so they never split the key.
fn canonical_glob(args: &JsonValue) -> JsonValue {
    let JsonValue::Object(map) = args else {
        return args.clone();
    };
    let mut next = map.clone();
    adopt_aliases(&mut next, &GLOB_ARG_ALIASES);
    JsonValue::Object(next)
}

/// `_canonicalGrepArgs`: the guard's canonical request, then keyed by what runs. Omitted or
/// `content_with_context` output with no explicit context is automatic context (the adaptive
/// renderer, which an explicit -B/-A window of the same size does not use); `context: 0` is bare
/// content; context flags mean nothing in count/files. None for an invalid request.
fn canonical_grep(args: &JsonValue) -> Option<JsonValue> {
    let JsonValue::Object(mut adopted) = prepare_grep_args(args).ok()? else {
        return None;
    };
    adopt_aliases(&mut adopted, &GREP_ARG_ALIASES);
    adopted.shift_remove("mode");
    let requested = adopted.get("output_mode").and_then(|m| m.as_str()).map_or("", mixdog_js::js_trim).to_owned();
    if requested == "files_with_matches" || requested == "count" {
        adopted.insert("output_mode".to_owned(), JsonValue::String(requested));
        for key in ["-A", "-B", "context"] {
            adopted.shift_remove(key);
        }
        return Some(JsonValue::Object(adopted));
    }
    let explicit = ["-A", "-B", "context"].iter().any(|k| adopted.contains_key(*k));
    let auto = (requested.is_empty() || requested == "content_with_context") && !explicit;
    adopted.insert("output_mode".to_owned(), JsonValue::String(if auto { "content_with_context" } else { "content" }.to_owned()));
    if adopted.get("context").is_some_and(|c| c.is_number() && c.as_f64() == Some(0.0))
        && !adopted.contains_key("-A")
        && !adopted.contains_key("-B")
    {
        adopted.shift_remove("context");
    }
    Some(JsonValue::Object(adopted))
}

fn scoped_key(tool: &str, args: &JsonValue, cwd: &str) -> String {
    let cwd_part = if cwd.is_empty() { String::new() } else { cache_key(cwd) };
    format!("{tool}|cwd={cwd_part}|{}", canonical_args(args))
}

fn extract_glob_root(value: &str) -> String {
    if !has_glob_magic(value) {
        return value.to_owned();
    }
    match value.rfind(['/', '\\']) {
        Some(slash) if slash > 0 => value[..slash].to_owned(),
        _ => ".".to_owned(),
    }
}

fn normalize_scoped_abs(value: &str, cwd: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    Some(cache_key(&resolve(cwd, &extract_glob_root(value))))
}

fn collect_paths(value: Option<&JsonValue>, out: &mut Vec<String>) {
    match value {
        Some(JsonValue::String(s)) if !s.is_empty() => out.push(s.clone()),
        Some(JsonValue::Array(items)) => items.iter().for_each(|i| collect_paths(Some(i), out)),
        _ => {}
    }
}

fn dependency_roots(tool: &str, args: &JsonValue, cwd: &str) -> Vec<String> {
    let mut roots: Vec<String> = Vec::new();
    let mut add = |value: &str| {
        if let Some(abs) = normalize_scoped_abs(value, cwd)
            && !roots.contains(&abs)
        {
            roots.push(abs);
        }
    };
    let mut raw = Vec::new();
    for name in ["file", "path", "root"] {
        collect_paths(args.get(name), &mut raw);
    }
    if raw.is_empty() {
        if !cwd.is_empty() {
            add(cwd);
        }
        return roots;
    }
    for p in &raw {
        add(p);
    }
    if tool == "glob" {
        let mut patterns = Vec::new();
        collect_paths(args.get("pattern"), &mut patterns);
        for pattern in patterns.iter().filter(|p| has_glob_magic(p)) {
            let root = extract_glob_root(pattern);
            if is_abs(&root) {
                add(&root);
            } else {
                for p in &raw {
                    add(&normalize(&format!("{p}/{root}")));
                }
            }
        }
    }
    roots
}

fn path_touches_root(abs: &str, root: &str) -> bool {
    let dir = |p: &str| if p.ends_with('/') { p.to_owned() } else { format!("{p}/") };
    abs == root || abs.starts_with(&dir(root)) || root.starts_with(&dir(abs))
}

// ---- mutation classes ----

fn is_shell_tool(name: &str) -> bool {
    matches!(strip_mcp(name), "shell" | "bash_session")
}

const GITHUB_READ_ACTIONS: [&str; 15] = [
    "repo.list",
    "repo.view",
    "issue.list",
    "issue.view",
    "issue.comments",
    "pr.list",
    "pr.view",
    "pr.comments",
    "workflow.list",
    "run.list",
    "run.view",
    "run.logs",
    "release.list",
    "release.view",
    "notification.list",
];

/// `_isGitMutationTool`: an unknown github action counts as a mutation.
fn is_git_mutation(name: &str, args: &JsonValue) -> bool {
    match strip_mcp(name).to_lowercase().as_str() {
        "git" => mixdog_tools::git::git_call_mutates(args),
        "github" => !args.get("action").and_then(|a| a.as_str()).is_some_and(|a| GITHUB_READ_ACTIONS.contains(&a)),
        _ => false,
    }
}

/// `_isMutationTool(name, args) || _isShellTool(name)`: the work a todo list tracks — file
/// edits, command execution and mutating git/github requests.
pub(crate) fn is_mutating_call(name: &str, args: &JsonValue) -> bool {
    let lowered = strip_mcp(name).to_lowercase();
    lowered == "apply_patch" || lowered == "edit" || is_git_mutation(name, args) || is_shell_tool(name)
}

/// Touched paths of a patch (`*** Update/Add/Delete File:` lines and unified-diff headers), as
/// written in it.
pub(crate) fn touched_paths(patch: &str) -> Vec<String> {
    fn strip_metadata(raw: &str) -> String {
        let mut text = mixdog_js::js_trim(raw).to_owned();
        if let Some(tab) = text.find('\t') {
            text = text[..tab].trim_end().to_owned();
        }
        if let Some(q @ ('"' | '\'')) = text.chars().next()
            && text.len() > 1
            && let Some(end) = text[1..].find(q)
        {
            text = text[1..1 + end].to_owned();
        }
        text
    }
    fn push(raw: &str, out: &mut Vec<String>) {
        let mut touched = strip_metadata(raw);
        if touched.is_empty() || touched == "/dev/null" {
            return;
        }
        touched = touched.trim_matches(['"', '\'']).replace('\\', "/");
        if let Some(rest) = touched.strip_prefix("a/").or_else(|| touched.strip_prefix("b/")) {
            touched = rest.to_owned();
        }
        if touched.is_empty() || touched == "/dev/null" || out.contains(&touched) {
            return;
        }
        out.push(touched);
    }
    let lines: Vec<&str> = patch.split('\n').collect();
    let mut out = Vec::new();
    for line in &lines {
        for marker in ["*** Update File:", "*** Add File:", "*** Delete File:"] {
            if let Some(rest) = line.strip_prefix(marker) {
                push(rest, &mut out);
            }
        }
    }
    let mut i = 0;
    while i + 1 < lines.len() {
        let (minus, plus) = (lines[i], lines[i + 1]);
        if minus.starts_with("--- ") && plus.starts_with("+++ ") {
            let from = mixdog_js::js_trim(&minus[4..]);
            let to = mixdog_js::js_trim(&plus[4..]);
            let from = from.strip_prefix("a/").unwrap_or(from);
            let to = to.strip_prefix("b/").unwrap_or(to);
            if to == "/dev/null" {
                if from != "/dev/null" {
                    push(from, &mut out);
                }
            } else {
                push(to, &mut out);
            }
            i += 1;
        }
        i += 1;
    }
    out
}

// ---- the seam ----

struct Inner {
    read: Bounded<ReadMeta>,
    scoped: Bounded<ScopedMeta>,
}

pub struct ToolResultReuse {
    session_id: String,
    cwd: String,
    /// Cursor's native file protocol needs source content, not a receipt that it was seen.
    needs_read_body: bool,
    clock: Arc<dyn Clock>,
    inner: Mutex<Inner>,
}

impl ToolResultReuse {
    /// `cwd` is the session's working directory; `needs_read_body` is true on a Cursor route.
    pub fn new(session_id: &str, cwd: &Path, needs_read_body: bool, clock: Arc<dyn Clock>) -> Self {
        Self {
            session_id: session_id.to_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            needs_read_body,
            clock,
            inner: Mutex::new(Inner { read: Bounded::new(), scoped: Bounded::new() }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The session closed: nothing it cached survives.
    pub fn purge(&self) {
        let mut inner = self.lock();
        inner.read = Bounded::new();
        inner.scoped = Bounded::new();
    }

    /// Compaction removed prior tool results from the context: start a fresh read epoch.
    pub fn reset_after_compaction(&self) {
        self.lock().read = Bounded::new();
    }

    fn clear_scoped(inner: &mut Inner) {
        inner.scoped = Bounded::new();
    }

    fn clear_scoped_paths(inner: &mut Inner, touched: &[String], cwd: &str) {
        let abs: Vec<String> = touched.iter().filter_map(|p| normalize_abs(p, cwd)).collect();
        if abs.is_empty() {
            Self::clear_scoped(inner);
            return;
        }
        inner.scoped.entries.retain(|e| !e.meta.dep_roots.iter().any(|r| abs.iter().any(|a| path_touches_root(a, r))));
    }

    fn invalidate_path(inner: &mut Inner, path: &str, cwd: &str) {
        if let Some(abs) = normalize_abs(path, cwd) {
            inner.read.entries.retain(|e| !e.meta.stats.iter().any(|(a, _)| *a == abs));
        }
    }

    fn lookup_read(&self, call: &ToolCall) -> Option<Reused> {
        let mut inner = self.lock();
        let key = match path_arg(&call.arguments) {
            Some(JsonValue::Array(_)) => array_key(&call.arguments, &self.cwd)?.0,
            _ => scalar_key(&call.arguments, &self.cwd)?.0,
        };
        let entry = inner.read.remove(&key)?;
        let fresh = entry.meta.stats.iter().all(|(abs, stored)| {
            let now = stat_tuple(abs);
            stored.is_some() && *stored == now && cacheable(&now)
        });
        if !fresh {
            return None;
        }
        let reused = Reused { content: entry.content.clone(), first_tool_use_id: entry.first.clone().unwrap_or_default() };
        inner.read.entries.push(entry);
        if self.needs_read_body
            && call.name == "read"
            && ["[file unchanged:", "[cross-turn-dedup]", "[intra-turn-dedup]"].iter().any(|p| reused.content.starts_with(p))
        {
            return None;
        }
        Some(reused)
    }

    fn lookup_scoped(&self, tool: &str, call: &ToolCall, touch: bool) -> Option<Reused> {
        let now = self.clock.now_ms();
        let mut inner = self.lock();
        let key = scoped_key(tool, &canonical_scoped(tool, &call.arguments)?, &self.cwd);
        let index = inner.scoped.position(&key)?;
        if now - inner.scoped.entries[index].ts >= SCOPED_TTL_MS {
            inner.scoped.entries.remove(index);
            return None;
        }
        let entry = &inner.scoped.entries[index];
        let reused = Reused { content: entry.content.clone(), first_tool_use_id: entry.first.clone().unwrap_or_default() };
        if touch {
            let entry = inner.scoped.entries.remove(index);
            inner.scoped.entries.push(entry);
        }
        Some(reused)
    }

    fn store_read(&self, call: &ToolCall, content: &str, tool_use_id: &str) {
        let mut inner = self.lock();
        let (key, stats) = match path_arg(&call.arguments) {
            Some(JsonValue::Array(_)) => {
                let Some((key, stats)) = array_key(&call.arguments, &self.cwd) else {
                    return;
                };
                (key, stats)
            }
            _ => {
                let Some((key, abs)) = scalar_key(&call.arguments, &self.cwd) else {
                    return;
                };
                let stat = stat_tuple(&abs);
                (key, vec![(abs, stat)])
            }
        };
        if !stats.iter().all(|(_, s)| cacheable(s)) {
            return;
        }
        inner.read.set(Entry {
            key,
            content: content.to_owned(),
            ts: self.clock.now_ms(),
            first: (!tool_use_id.is_empty()).then(|| tool_use_id.to_owned()),
            meta: ReadMeta { stats },
        });
    }

    /// `store` with the dependency roots the tool recorded while it ran (`output.meta
    /// ["dependencyRoots"]`): `code_graph` is cached only with them, and they replace the roots
    /// guessed from its path arguments.
    pub fn store_with_roots(&self, call: &ToolCall, content: &str, tool_use_id: &str, roots: Option<&[String]>) {
        if self.session_id.is_empty() || content.is_empty() {
            return;
        }
        match strip_mcp(&call.name) {
            "read" => self.store_read(call, content, tool_use_id),
            tool @ ("glob" | "list" | "code_graph" | "grep") => self.store_scoped(tool, call, content, tool_use_id, roots),
            _ => {}
        }
    }

    fn store_scoped(&self, tool: &str, call: &ToolCall, content: &str, tool_use_id: &str, roots: Option<&[String]>) {
        let recorded = roots.filter(|r| !r.is_empty());
        if tool == "code_graph" && recorded.is_none() {
            return;
        }
        let Some(args) = canonical_scoped(tool, &call.arguments) else {
            return;
        };
        let mut inner = self.lock();
        inner.scoped.set(Entry {
            key: scoped_key(tool, &args, &self.cwd),
            content: content.to_owned(),
            ts: self.clock.now_ms(),
            first: (!tool_use_id.is_empty()).then(|| tool_use_id.to_owned()),
            meta: ScopedMeta {
                dep_roots: match recorded {
                    Some(list) => {
                        let mut out: Vec<String> = Vec::new();
                        for abs in list.iter().filter_map(|r| normalize_scoped_abs(r, &self.cwd)) {
                            if !out.contains(&abs) {
                                out.push(abs);
                            }
                        }
                        out
                    }
                    None => dependency_roots(tool, &args, &self.cwd),
                },
            },
        });
    }

    fn patch_base(&self, call: &ToolCall) -> String {
        match call.arguments.get("base_path").and_then(|b| b.as_str()) {
            Some(base) if !base.is_empty() => {
                if is_abs(base) {
                    base.to_owned()
                } else {
                    PathBuf::from(&self.cwd).join(base).to_string_lossy().into_owned()
                }
            }
            _ => self.cwd.clone(),
        }
    }
}

/// The arguments the scoped key is built from; None for a tool this cache does not hold.
fn canonical_scoped(tool: &str, args: &JsonValue) -> Option<JsonValue> {
    match tool {
        "glob" => Some(canonical_glob(args)),
        "grep" => canonical_grep(args),
        "list" | "code_graph" => Some(args.clone()),
        _ => None,
    }
}

impl ResultReuse for ToolResultReuse {
    fn lookup(&self, call: &ToolCall, touch: bool) -> Option<Reused> {
        if call.id.starts_with(CURSOR_NATIVE_PREFIX) || self.session_id.is_empty() {
            return None;
        }
        match strip_mcp(&call.name) {
            "read" => self.lookup_read(call),
            tool @ ("glob" | "list" | "code_graph" | "grep") => self.lookup_scoped(tool, call, touch),
            _ => None,
        }
    }

    fn store(&self, call: &ToolCall, content: &str, tool_use_id: &str, output: &mixdog_core_api::domain::tool::ToolOutput) {
        let roots = mixdog_tools::code_graph::dependency_roots(output);
        self.store_with_roots(call, content, tool_use_id, roots.as_deref());
    }

    fn after_call(&self, call: &ToolCall, failed: bool) {
        if self.session_id.is_empty() {
            return;
        }
        let mut inner = self.lock();
        let name = strip_mcp(&call.name);
        if name == "apply_patch" {
            let base = self.patch_base(call);
            let touched = touched_paths(call.arguments.get("patch").and_then(|p| p.as_str()).unwrap_or_default());
            // A failed patch leaves the files' state unknown, so it drops everything.
            if failed || touched.is_empty() {
                inner.read = Bounded::new();
                Self::clear_scoped(&mut inner);
            } else {
                for p in &touched {
                    Self::invalidate_path(&mut inner, p, &base);
                }
                Self::clear_scoped_paths(&mut inner, &touched, &base);
            }
        } else if name.eq_ignore_ascii_case("edit") {
            let mut paths = Vec::new();
            collect_paths(path_arg(&call.arguments), &mut paths);
            if paths.is_empty() {
                Self::clear_scoped(&mut inner);
            } else {
                Self::clear_scoped_paths(&mut inner, &paths, &self.cwd);
            }
        }
        if is_shell_tool(&call.name) || is_git_mutation(&call.name, &call.arguments) {
            Self::clear_scoped(&mut inner);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Fixed(i64);
    impl Clock for Fixed {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    fn call(name: &str, args: JsonValue) -> ToolCall {
        ToolCall { id: "c1".into(), name: name.into(), arguments: args, native_type: None }
    }

    fn reuse(dir: &Path, now: i64) -> ToolResultReuse {
        ToolResultReuse::new("sess_1", dir, false, Arc::new(Fixed(now)))
    }

    #[test]
    fn a_read_is_reused_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        assert!(r.lookup(&c, true).is_none());
        r.store_with_roots(&c, "one", "t1", None);
        let hit = r.lookup(&c, true).unwrap();
        assert_eq!((hit.content.as_str(), hit.first_tool_use_id.as_str()), ("one", "t1"));
        // another offset is another key
        assert!(r.lookup(&call("read", json!({"path": "a.txt", "offset": 3})), true).is_none());
        std::fs::write(&file, "two!").unwrap();
        assert!(r.lookup(&c, true).is_none());
    }

    #[test]
    fn a_file_alias_offset_is_keyed_zero_based() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let (key, _) = scalar_key(&json!({"file_path": "a.txt", "offset": 5}), dir.path().to_str().unwrap()).unwrap();
        assert!(key.contains("|o=4|"), "{key}");
        assert!(key.ends_with("|base=1"));
    }

    #[test]
    fn a_patch_drops_the_files_it_touches_and_the_scoped_entries_over_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.txt"), "one").unwrap();
        let r = reuse(dir.path(), 0);
        let read = call("read", json!({"path": "src/a.txt"}));
        let list = call("list", json!({"path": "src"}));
        r.store_with_roots(&read, "one", "t1", None);
        r.store_with_roots(&list, "a.txt", "t2", None);
        assert!(r.lookup(&list, true).is_some());
        r.after_call(&call("apply_patch", json!({"patch": "--- a/src/a.txt\n+++ b/src/a.txt\n@@\n-x\n+y\n"})), false);
        assert!(r.lookup(&read, true).is_none());
        assert!(r.lookup(&list, true).is_none());
    }

    #[test]
    fn scoped_entries_expire_after_thirty_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(0i64));
        struct Shared(Arc<Mutex<i64>>);
        impl Clock for Shared {
            fn now_ms(&self) -> i64 {
                *self.0.lock().unwrap()
            }
        }
        let r = ToolResultReuse::new("s", dir.path(), false, Arc::new(Shared(clock.clone())));
        let c = call("glob", json!({"pattern": "*.rs", "root": "."}));
        r.store_with_roots(&c, "a.rs", "t", None);
        // `root` is an alias of `path`: either spelling is one key
        assert!(r.lookup(&call("glob", json!({"pattern": "*.rs", "path": "."})), true).is_some());
        *clock.lock().unwrap() = 30_000;
        assert!(r.lookup(&c, true).is_none());
    }

    #[test]
    fn shell_and_git_mutations_clear_scoped_entries() {
        let dir = tempfile::tempdir().unwrap();
        let r = reuse(dir.path(), 0);
        let list = call("list", json!({}));
        r.store_with_roots(&list, "x", "t", None);
        r.after_call(&call("git", json!({"command": "git status"})), false);
        assert!(r.lookup(&list, true).is_some());
        r.after_call(&call("shell", json!({"command": "rm x"})), false);
        assert!(r.lookup(&list, true).is_none());
    }

    #[test]
    fn grep_spellings_share_an_entry_and_invalid_requests_never_hit() {
        let dir = tempfile::tempdir().unwrap();
        let r = reuse(dir.path(), 0);
        let stored = call("grep", json!({"pattern": "foo", "path": "src", "head_limit": 5}));
        r.store_with_roots(&stored, "hit", "t", None);
        // alias spellings, numeric strings and `limit` all reach one canonical request
        let same = call("grep", json!({"query": "foo", "root": "src", "limit": "5"}));
        assert_eq!(r.lookup(&same, true).unwrap().content, "hit");
        // explicit context is a different request from the automatic window
        assert!(r.lookup(&call("grep", json!({"pattern": "foo", "path": "src", "head_limit": 5, "context": 2})), true).is_none());
        // count ignores context flags
        r.store_with_roots(&call("grep", json!({"pattern": "z", "output_mode": "count"})), "n", "t2", None);
        assert!(r.lookup(&call("grep", json!({"pattern": "z", "mode": "count", "-A": 3})), true).is_some());
        // invalid: stored nothing, looked up nothing
        let bad = call("grep", json!({"pattern": "z", "head_limit": -1}));
        r.store_with_roots(&bad, "x", "t3", None);
        assert!(r.lookup(&bad, true).is_none());
    }

    #[test]
    fn touched_paths_follow_the_diff_headers() {
        let patch = "*** Update File: a.txt\n--- a/b.txt\n+++ b/b.txt\n--- a/c.txt\n+++ /dev/null\n";
        assert_eq!(touched_paths(patch), ["a.txt", "b.txt", "c.txt"]);
    }

    #[test]
    fn lexical_normalize_resolves_dots() {
        assert_eq!(normalize("/a/b/../c/./d"), "/a/c/d");
        assert_eq!(cache_key("/a/b/"), "/a/b");
    }
}
