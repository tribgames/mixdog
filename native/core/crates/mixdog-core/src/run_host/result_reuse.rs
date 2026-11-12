//! `ResultReuse`: one freshness authority for a session's cached read-only tool results
//! (`session/cache/tool-result-reuse.mjs`, `read-cache.mjs`, `scoped-cache.mjs`, and the
//! invalidation in `tool-batch/record-outcome.mjs`).
//!
//! `read` results are valid while the file's stat tuple is unchanged and the file fits the
//! hashed-prefix budget; `list`/`glob` results live 30 s and drop when a mutation touches a root
//! they depend on. `grep` is keyed on the canonical form `prepareGrepArgs` gives (an invalid
//! request is never cached). `code_graph` is cached only with the dependency roots the tool
//! records while it runs, since without them an entry could not be invalidated precisely.

use mixdog_core_run::run_host::guards::{is_git_mutation, is_shell_tool, strip_mcp};
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use mixdog_agent::env::Clock;
use mixdog_agent::env::ResultReuse;
use mixdog_agent::env::Reused;
use mixdog_core_api::domain::provider::ToolCall;
use mixdog_core_api::domain::tool::ToolIo;
use mixdog_js::device_paths;
use mixdog_js::utf16_len;
use mixdog_js::value_to_string;
use mixdog_protocol::JsonValue;
use mixdog_rt::{CancellationToken, InLane, InteractiveIo, LaneToken};
use mixdog_tools::fs::ReadState;
use serde_json::Map;

use super::grep_args::prepare_grep_args;

const MAX_PER_SESSION: usize = 100;
const TEXT_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const SCOPED_TTL_MS: i64 = 30_000;
/// The bounded validator certifies a whole file only within this budget.
const READ_PREFIX_HASH_BYTES: u64 = 65_536;
const CURSOR_NATIVE_PREFIX: &str = "cursor_native_";

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

/// Node's `statSync`: one metadata call per path argument, taken inside an io-interactive lane job.
#[allow(clippy::disallowed_methods, reason = "takes the lane's proof: it runs inside a lane job body")]
fn stat_tuple(_lane: &InLane<InteractiveIo>, abs: &str) -> Option<Stat> {
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

/// The stat tuples of `paths`, in one lane job. A stat that cannot be taken (the lane refused or
/// went away) reads as a missing file, which is a cache miss and never a stale hit.
async fn stats_of(io: &ToolIo, paths: Vec<String>) -> Vec<Option<Stat>> {
    let missing = vec![None; paths.len()];
    let Ok(job) = io.interactive.submit(&CancellationToken::new(), move |lane| paths.iter().map(|path| stat_tuple(lane, path)).collect::<Vec<_>>()) else {
        return missing;
    };
    job.await.unwrap_or(missing)
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
        self.set_within(entry, MAX_PER_SESSION, TEXT_CACHE_MAX_BYTES).0
    }

    /// The bounded put, with the keys it dropped in drop order (`onEvict`'s calls): the replaced key first.
    fn set_within(&mut self, entry: Entry<T>, max_entries: usize, max_bytes: usize) -> (bool, Vec<String>) {
        let mut dropped: Vec<String> = self.remove(&entry.key).map(|e| e.key).into_iter().collect();
        let incoming = Self::bytes(&entry);
        if incoming > max_bytes {
            return (false, dropped);
        }
        let mut retained = incoming + self.entries.iter().map(Self::bytes).sum::<usize>();
        while self.entries.len() >= max_entries || retained > max_bytes {
            let oldest = self.entries.remove(0);
            retained -= Self::bytes(&oldest);
            dropped.push(oldest.key);
        }
        self.entries.push(entry);
        (true, dropped)
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
fn array_key(args: &JsonValue, cwd: &str) -> Option<(String, Vec<String>)> {
    let elems = path_arg(args)?.as_array()?;
    let base = u8::from(arg(args, "file_path").is_some_and(JsonValue::is_array) && arg(args, "path").is_none());
    let top = elem_opts(args);
    let pages = text_of(args, "pages");
    let full = text_of(args, "full");
    let mut parts = Vec::new();
    let mut paths: Vec<String> = Vec::new();
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
        if !paths.contains(&abs) {
            paths.push(abs);
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
    Some((key, paths))
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

/// What one session has cached (`_bySession` and `_scopedBySession`): it outlives the runs of its turns.
struct Inner {
    read: Bounded<ReadMeta>,
    scoped: Bounded<ScopedMeta>,
}

impl Inner {
    fn new() -> Self {
        Self { read: Bounded::new(), scoped: Bounded::new() }
    }
}

type SessionCache = Arc<Mutex<Inner>>;

/// One run's view of its session's cache.
pub struct ToolResultReuse {
    io: ToolIo,
    session_id: String,
    cwd: String,
    /// Cursor's native file protocol needs source content, not a receipt that it was seen.
    needs_read_body: bool,
    clock: Arc<dyn Clock>,
    inner: SessionCache,
    /// The session's read snapshots, which a compaction resets together with the cached results.
    snapshots: Option<Arc<ReadState>>,
}

impl ToolResultReuse {
    /// A cache of its own. `cwd` is the session's working directory; `needs_read_body` is true on a Cursor route.
    pub fn new(io: ToolIo, session_id: &str, cwd: &Path, needs_read_body: bool, clock: Arc<dyn Clock>) -> Self {
        Self::over(Arc::new(Mutex::new(Inner::new())), None, io, session_id, cwd, needs_read_body, clock)
    }

    fn over(inner: SessionCache, snapshots: Option<Arc<ReadState>>, io: ToolIo, session_id: &str, cwd: &Path, needs_read_body: bool, clock: Arc<dyn Clock>) -> Self {
        Self { io, session_id: session_id.to_owned(), cwd: cwd.to_string_lossy().into_owned(), needs_read_body, clock, inner, snapshots }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Compaction removed prior tool results from the context: start a fresh read epoch.
    pub fn reset_after_compaction(&self) {
        self.lock().read = Bounded::new();
        if let Some(snapshots) = &self.snapshots {
            snapshots.forget_snapshots(&self.session_id);
        }
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

    async fn lookup_read(&self, call: &ToolCall) -> Option<Reused> {
        let key = match path_arg(&call.arguments) {
            Some(JsonValue::Array(_)) => array_key(&call.arguments, &self.cwd)?.0,
            _ => scalar_key(&call.arguments, &self.cwd)?.0,
        };
        let held: Vec<String> = {
            let inner = self.lock();
            let at = inner.read.position(&key)?;
            inner.read.entries[at].meta.stats.iter().map(|(abs, _)| abs.clone()).collect()
        };
        // The stats are taken off the state lock, in a lane job; the entry is judged against them.
        let current = stats_of(&self.io, held).await;
        let mut inner = self.lock();
        let entry = inner.read.remove(&key)?;
        let fresh = entry.meta.stats.len() == current.len()
            && entry.meta.stats.iter().zip(&current).all(|((_, stored), now)| stored.is_some() && stored == now && cacheable(now));
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

    async fn store_read(&self, call: &ToolCall, content: &str, tool_use_id: &str) {
        let (key, paths) = match path_arg(&call.arguments) {
            Some(JsonValue::Array(_)) => {
                let Some(keyed) = array_key(&call.arguments, &self.cwd) else {
                    return;
                };
                keyed
            }
            _ => {
                let Some((key, abs)) = scalar_key(&call.arguments, &self.cwd) else {
                    return;
                };
                (key, vec![abs])
            }
        };
        let taken = stats_of(&self.io, paths.clone()).await;
        let stats: Vec<(String, Option<Stat>)> = paths.into_iter().zip(taken).collect();
        if !stats.iter().all(|(_, s)| cacheable(s)) {
            return;
        }
        self.lock().read.set(Entry {
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
    pub async fn store_with_roots(&self, call: &ToolCall, content: &str, tool_use_id: &str, roots: Option<&[String]>) {
        if self.session_id.is_empty() || content.is_empty() {
            return;
        }
        match strip_mcp(&call.name) {
            "read" => self.store_read(call, content, tool_use_id).await,
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

impl ToolResultReuse {
    async fn lookup_with(&self, call: &ToolCall, touch: bool) -> Option<Reused> {
        if call.id.starts_with(CURSOR_NATIVE_PREFIX) || self.session_id.is_empty() {
            return None;
        }
        match strip_mcp(&call.name) {
            "read" => self.lookup_read(call).await,
            tool @ ("glob" | "list" | "code_graph" | "grep") => self.lookup_scoped(tool, call, touch),
            _ => None,
        }
    }

    fn after_call_now(&self, call: &ToolCall, failed: bool) {
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

#[async_trait::async_trait]
impl ResultReuse for ToolResultReuse {
    async fn lookup(&self, call: &ToolCall, touch: bool) -> Option<Reused> {
        self.lookup_with(call, touch).await
    }

    async fn store(&self, call: &ToolCall, content: &str, tool_use_id: &str, output: &mixdog_core_api::domain::tool::ToolOutput) {
        let roots = mixdog_tools::code_graph::dependency_roots(output);
        self.store_with_roots(call, content, tool_use_id, roots.as_deref()).await;
    }

    async fn after_call(&self, call: &ToolCall, failed: bool) {
        self.after_call_now(call, failed);
    }

    fn after_compaction(&self) {
        self.reset_after_compaction();
    }
}

/// The result caches of the sessions, for the lifetime of each session: Node keeps them in module maps keyed by the
/// session id (`read-cache.mjs` `_bySession`, `scoped-cache.mjs` `_scopedBySession`), so a turn that starts after another
/// of the same session finds what the earlier one read. They end with the session (`clearReadDedupSession`: a close, a
/// delete, a working-folder change), a compaction (`resetReadStateAfterCompaction`: the read cache only), the process, and, entry by
/// entry, the 100-entry / 8 MiB bound of each cache.
#[derive(Default)]
pub struct LiveReuses {
    sessions: Mutex<std::collections::HashMap<String, SessionCache>>,
    snapshots: std::sync::OnceLock<Arc<ReadState>>,
}

impl LiveReuses {
    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, SessionCache>> {
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ties the caches to the read state: a session it releases (closed) or forgets (deleted) loses its caches
    /// (`registerSessionPurgeHook` and `releaseSessionReadCaches`), and a compaction resets its snapshots with them.
    pub fn bind(self: &Arc<Self>, read_state: &Arc<ReadState>) {
        let _ = self.snapshots.set(read_state.clone());
        let live = Arc::downgrade(self);
        read_state.on_released(Arc::new(move |session_id| {
            if let Some(live) = live.upgrade() {
                live.clear_session(session_id);
            }
        }));
    }

    /// The cache of the run that starts: the one its session already holds, or a new one.
    pub fn run(&self, io: ToolIo, session_id: &str, cwd: &Path, needs_read_body: bool, clock: Arc<dyn Clock>) -> Arc<ToolResultReuse> {
        let inner = self.lock().entry(session_id.to_owned()).or_insert_with(|| Arc::new(Mutex::new(Inner::new()))).clone();
        Arc::new(ToolResultReuse::over(inner, self.snapshots.get().cloned(), io, session_id, cwd, needs_read_body, clock))
    }

    /// `clearReadDedupSession(session_id)`: the read and scoped caches of the session are empty, for the run in
    /// progress too. A session no run holds loses its entry.
    pub fn clear_session(&self, session_id: &str) {
        let mut sessions = self.lock();
        let Some(cache) = sessions.get(session_id) else { return };
        *cache.lock().unwrap_or_else(|e| e.into_inner()) = Inner::new();
        if Arc::strong_count(cache) == 1 {
            sessions.remove(session_id);
        }
    }

    /// `resetReadStateAfterCompaction(session_id)`, for a compaction that ran outside a turn.
    pub fn compacted(&self, session_id: &str) {
        if let Some(cache) = self.lock().get(session_id) {
            cache.lock().unwrap_or_else(|e| e.into_inner()).read = Bounded::new();
        }
        if let Some(snapshots) = self.snapshots.get() {
            snapshots.forget_snapshots(session_id);
        }
    }
}

#[cfg(test)]
#[path = "result_reuse_budget_tests.rs"]
mod budget_tests;

#[cfg(test)]
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup builds fixture trees")]
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

    fn io() -> ToolIo {
        let tokens = mixdog_rt::testing::tokens();
        ToolIo { interactive: tokens.interactive_io, durability: tokens.durability_io, maintenance: tokens.maintenance_io }
    }

    fn reuse(dir: &Path, now: i64) -> ToolResultReuse {
        ToolResultReuse::new(io(), "sess_1", dir, false, Arc::new(Fixed(now)))
    }

    #[tokio::test]
    async fn a_read_is_reused_until_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "one").unwrap();
        let r = reuse(dir.path(), 0);
        let c = call("read", json!({"path": "a.txt"}));
        assert!(r.lookup(&c, true).await.is_none());
        r.store_with_roots(&c, "one", "t1", None).await;
        let hit = r.lookup(&c, true).await.unwrap();
        assert_eq!((hit.content.as_str(), hit.first_tool_use_id.as_str()), ("one", "t1"));
        // another offset is another key
        assert!(r.lookup(&call("read", json!({"path": "a.txt", "offset": 3})), true).await.is_none());
        std::fs::write(&file, "two!").unwrap();
        assert!(r.lookup(&c, true).await.is_none());
    }

    #[test]
    fn a_file_alias_offset_is_keyed_zero_based() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "x").unwrap();
        let (key, _) = scalar_key(&json!({"file_path": "a.txt", "offset": 5}), dir.path().to_str().unwrap()).unwrap();
        assert!(key.contains("|o=4|"), "{key}");
        assert!(key.ends_with("|base=1"));
    }

    #[tokio::test]
    async fn a_patch_drops_the_files_it_touches_and_the_scoped_entries_over_them() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/a.txt"), "one").unwrap();
        let r = reuse(dir.path(), 0);
        let read = call("read", json!({"path": "src/a.txt"}));
        let list = call("list", json!({"path": "src"}));
        r.store_with_roots(&read, "one", "t1", None).await;
        r.store_with_roots(&list, "a.txt", "t2", None).await;
        assert!(r.lookup(&list, true).await.is_some());
        r.after_call_now(&call("apply_patch", json!({"patch": "--- a/src/a.txt\n+++ b/src/a.txt\n@@\n-x\n+y\n"})), false);
        assert!(r.lookup(&read, true).await.is_none());
        assert!(r.lookup(&list, true).await.is_none());
    }

    #[tokio::test]
    async fn scoped_entries_expire_after_thirty_seconds() {
        let dir = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(0i64));
        struct Shared(Arc<Mutex<i64>>);
        impl Clock for Shared {
            fn now_ms(&self) -> i64 {
                *self.0.lock().unwrap()
            }
        }
        let r = ToolResultReuse::new(io(), "s", dir.path(), false, Arc::new(Shared(clock.clone())));
        let c = call("glob", json!({"pattern": "*.rs", "root": "."}));
        r.store_with_roots(&c, "a.rs", "t", None).await;
        // `root` is an alias of `path`: either spelling is one key
        assert!(r.lookup(&call("glob", json!({"pattern": "*.rs", "path": "."})), true).await.is_some());
        *clock.lock().unwrap() = 30_000;
        assert!(r.lookup(&c, true).await.is_none());
    }

    #[tokio::test]
    async fn shell_and_git_mutations_clear_scoped_entries() {
        let dir = tempfile::tempdir().unwrap();
        let r = reuse(dir.path(), 0);
        let list = call("list", json!({}));
        r.store_with_roots(&list, "x", "t", None).await;
        r.after_call_now(&call("git", json!({"command": "git status"})), false);
        assert!(r.lookup(&list, true).await.is_some());
        r.after_call_now(&call("shell", json!({"command": "rm x"})), false);
        assert!(r.lookup(&list, true).await.is_none());
    }

    #[tokio::test]
    async fn grep_spellings_share_an_entry_and_invalid_requests_never_hit() {
        let dir = tempfile::tempdir().unwrap();
        let r = reuse(dir.path(), 0);
        let stored = call("grep", json!({"pattern": "foo", "path": "src", "head_limit": 5}));
        r.store_with_roots(&stored, "hit", "t", None).await;
        // alias spellings, numeric strings and `limit` all reach one canonical request
        let same = call("grep", json!({"query": "foo", "root": "src", "limit": "5"}));
        assert_eq!(r.lookup(&same, true).await.unwrap().content, "hit");
        // explicit context is a different request from the automatic window
        assert!(r.lookup(&call("grep", json!({"pattern": "foo", "path": "src", "head_limit": 5, "context": 2})), true).await.is_none());
        // count ignores context flags
        r.store_with_roots(&call("grep", json!({"pattern": "z", "output_mode": "count"})), "n", "t2", None).await;
        assert!(r.lookup(&call("grep", json!({"pattern": "z", "mode": "count", "-A": 3})), true).await.is_some());
        // invalid: stored nothing, looked up nothing
        let bad = call("grep", json!({"pattern": "z", "head_limit": -1}));
        r.store_with_roots(&bad, "x", "t3", None).await;
        assert!(r.lookup(&bad, true).await.is_none());
    }

    #[tokio::test]
    async fn clearing_a_session_empties_the_caches_of_its_live_runs_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "one").unwrap();
        let live = LiveReuses::default();
        let mine = live.run(io(), "sess_1", dir.path(), false, Arc::new(Fixed(0)));
        let other = live.run(io(), "sess_2", dir.path(), false, Arc::new(Fixed(0)));
        let read = call("read", json!({"path": "a.txt"}));
        let list = call("list", json!({}));
        for r in [&mine, &other] {
            r.store_with_roots(&read, "one", "t1", None).await;
            r.store_with_roots(&list, "a.txt", "t2", None).await;
        }
        live.clear_session("sess_1");
        assert!(mine.lookup(&read, true).await.is_none(), "the read cache is cleared");
        assert!(mine.lookup(&list, true).await.is_none(), "so is the scoped cache");
        assert!(other.lookup(&read, true).await.is_some() && other.lookup(&list, true).await.is_some(), "another session keeps its entries");
        // A session no run holds loses its entry; one that is held keeps it, so the run goes on in the session's cache.
        assert!(live.lock().contains_key("sess_1"));
        drop(mine);
        live.clear_session("sess_1");
        assert!(!live.lock().contains_key("sess_1"));
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
