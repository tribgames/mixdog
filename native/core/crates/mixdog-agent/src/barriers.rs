//! The ordering barriers of calls that start together. Every call of a batch runs at once except that
//!
//! - an `edit` waits for the earlier edits of its file (an edit whose file cannot be told waits for every earlier edit,
//!   and later edits of any file wait for it);
//! - a mutation waits for the earlier git/github mutations (repository-wide effects);
//! - a shell command or a git/github mutation waits for every earlier mutation, and is skipped, not run, when one of
//!   them failed (the shell would verify work that was not done).
//!
//! Nothing else holds a call back: not its tool's kind, not an approval card another call is waiting on.

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use serde_json::Value as JsonValue;
use tokio::sync::watch;

const MCP_TOOL_PREFIX: &str = "mcp__plugin_mixdog_mixdog__";

fn bare(name: &str) -> &str {
    name.strip_prefix(MCP_TOOL_PREFIX).unwrap_or(name)
}

/// `_isShellTool`.
pub(crate) fn is_shell(name: &str) -> bool {
    matches!(bare(name), "shell" | "bash_session")
}

/// `_isEditTool`.
pub(crate) fn is_edit(name: &str) -> bool {
    bare(name).to_lowercase() == "edit"
}

/// `_isGitMutationTool`.
pub(crate) fn is_git_mutation(name: &str, args: &JsonValue) -> bool {
    match bare(name).to_lowercase().as_str() {
        "git" => mixdog_tools::git::git_call_mutates(args),
        "github" => mixdog_tools::github::github_call_mutates(args),
        _ => false,
    }
}

/// `_isMutationTool`.
pub(crate) fn is_mutation(name: &str, args: &JsonValue) -> bool {
    matches!(bare(name).to_lowercase().as_str(), "apply_patch" | "edit") || is_git_mutation(name, args)
}

/// Shell invalidates result reuse, but a failed shell must not become a
/// failed-patch dependency for other mutating calls.
pub(crate) fn invalidates_reuse(name: &str, args: &JsonValue) -> bool {
    is_shell(name) || is_mutation(name, args) || bare(name) == "write"
}

pub(crate) fn uses_result_cache(name: &str) -> bool {
    matches!(bare(name), "read" | "grep" | "glob" | "list" | "code_graph")
}

struct Started {
    id: String,
    /// `Some(key)` for an edit: its file, or `None` when it names none.
    edit: Option<Option<String>>,
    mutation: bool,
    /// `Some(None)` for a reuse invalidator with unknown write targets (`shell`, `git` mutation, malformed edit);
    /// `Some(Some(paths))` when its writes are provably contained within `paths`.
    reuse_writes: Option<Option<Vec<String>>>,
    git_mutation: bool,
    done: watch::Receiver<bool>,
    failed: Arc<AtomicBool>,
}

/// A JavaScript `await` of a promise that has already settled still hands the turn to the calls queued behind it, so a call with a
/// barrier starts after the calls without one; the same wait here gives the other calls their turn once, in the order they asked.
async fn settled() {
    let mut yielded = false;
    std::future::poll_fn(move |cx| {
        if yielded {
            return std::task::Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    })
    .await;
}

/// What one call must wait for before it executes.
pub(crate) struct Preceding {
    /// Which of the three barriers the call has at all; each one is awaited, settled or not.
    has: [bool; 3],
    edits: Vec<watch::Receiver<bool>>,
    git: Vec<watch::Receiver<bool>>,
    patches: Vec<(String, watch::Receiver<bool>, Arc<AtomicBool>)>,
    /// Every call the wait ends after.
    ids: Vec<String>,
}

impl Preceding {
    /// The call has no barrier at all: it starts at once.
    pub(crate) fn none(&self) -> bool {
        self.has == [false; 3]
    }

    /// The calls whose settlement lets this one go.
    pub(crate) fn ids(&self) -> Vec<String> {
        self.ids.clone()
    }

    /// Waits for the barriers in Node's order; the text the call is skipped with when an earlier mutation it depends on
    /// failed (`waitForPreceding`).
    pub(crate) async fn wait(self, name: &str) -> Option<String> {
        let [has_edits, has_git, has_patches] = self.has;
        // A sender dropped by an aborted read ends the wait too.
        if has_edits {
            for mut earlier in self.edits {
                let _ = earlier.wait_for(|settled| *settled).await;
            }
            settled().await;
        }
        if has_git {
            for mut earlier in self.git {
                let _ = earlier.wait_for(|settled| *settled).await;
            }
            settled().await;
        }
        if !has_patches {
            return None;
        }
        let mut failed = Vec::new();
        for (id, mut earlier, did_fail) in self.patches {
            let _ = earlier.wait_for(|settled| *settled).await;
            if did_fail.load(Ordering::Acquire) {
                failed.push(id);
            }
        }
        settled().await;
        (!failed.is_empty()).then(|| {
            format!("[mutation-dependency-guard] `{name}` skipped because earlier mutation call(s) failed: {}; no verification ran.", failed.join(", "))
        })
    }
}

/// The edit tool's per-file lock (`withPathLock`, `tools/builtin/path-locks.mjs`) for the runs of one assistant turn: the
/// runs of one file's edits, a group retry included, go one at a time in the order they reached it.
#[derive(Clone, Default)]
pub(crate) struct EditLocks(Arc<std::sync::Mutex<LockState>>);

/// A streamed edit's place at its file's lock, handed to it by the settlement that lets it go.
pub(crate) type Place = Arc<std::sync::Mutex<Option<EditTurn>>>;

struct Waiting {
    key: String,
    needs: Vec<String>,
    /// Weak: an edit whose run is gone takes no place.
    place: std::sync::Weak<std::sync::Mutex<Option<EditTurn>>>,
}

/// The lock's queues and the streamed calls of the turn that have settled.
#[derive(Default)]
pub(crate) struct LockState {
    tails: std::collections::HashMap<String, watch::Receiver<bool>>,
    settled: std::collections::HashSet<String>,
    /// Edits not let go yet, in call order.
    waiting: Vec<Waiting>,
}

impl LockState {
    /// Takes the place after the last one taken for `key`.
    pub(crate) fn take(&mut self, key: &str) -> EditTurn {
        let (mine, next) = watch::channel(false);
        let before = self.tails.insert(key.to_owned(), next);
        EditTurn { before, _mine: mine }
    }
}

/// A place at a file's lock; it is the holder's once `ready`, and the next place's when dropped (a cancel or a panic of its
/// holder included).
pub(crate) struct EditTurn {
    before: Option<watch::Receiver<bool>>,
    _mine: watch::Sender<bool>,
}

impl EditLocks {
    pub(crate) fn with<R>(&self, f: impl FnOnce(&mut LockState) -> R) -> R {
        f(&mut self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner))
    }

    /// The place of a streamed edit of `key` that starts once the calls `needs` settled: taken now when they have, else by
    /// the settlement of the last of them (`settle`).
    pub(crate) fn enqueue(&self, key: &str, needs: Vec<String>) -> Place {
        let place: Place = Arc::default();
        self.with(|st| {
            if needs.iter().all(|n| st.settled.contains(n)) {
                *place.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(st.take(key));
            } else {
                st.waiting.push(Waiting { key: key.to_owned(), needs, place: Arc::downgrade(&place) });
            }
        });
        place
    }

    /// The streamed call `id` settled. In one step, under the lock's state: `first` (the call's own group retry, when the
    /// batch is already waiting for it), then a place for every edit this settlement lets go, in call order. Invariant: an
    /// edit holds its place from the instant its barrier opens, so whatever reaches the file after this step (a group retry
    /// the batch reaches later) queues behind it, however late the edit's task is polled.
    pub(crate) fn settle(&self, id: &str, first: impl FnOnce(&mut LockState)) {
        self.with(|st| {
            st.settled.insert(id.to_owned());
            first(st);
            for w in std::mem::take(&mut st.waiting) {
                if !w.needs.iter().all(|n| st.settled.contains(n)) {
                    st.waiting.push(w);
                } else if let Some(place) = w.place.upgrade() {
                    let turn = st.take(&w.key);
                    *place.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(turn);
                }
            }
        });
    }
}

impl EditTurn {
    /// Waits until the place before this one is given up.
    pub(crate) async fn ready(&mut self) {
        if let Some(before) = &mut self.before {
            let _ = before.wait_for(|_| false).await;
        }
    }

    /// Whether a place before this one is still held.
    #[cfg(feature = "test-support")]
    pub(crate) fn waits(&self) -> bool {
        self.before.as_ref().is_some_and(|b| b.has_changed().is_ok())
    }
}

/// The calls of one assistant turn that have started.
#[derive(Default)]
pub(crate) struct Barriers {
    started: Vec<Started>,
    pub(crate) locks: EditLocks,
}

#[cfg(test)]
mod tests {
    use futures::FutureExt;

    use super::*;

    /// The holder of a file's lock gives it up when its task is cancelled or panics.
    #[tokio::test]
    async fn a_cancelled_or_panicking_holder_releases_the_file() {
        let locks = EditLocks::default();
        let (mut first, mut second, mut third) = locks.with(|st| (st.take("k"), st.take("k"), st.take("k")));
        first.ready().now_or_never().expect("the first place is free");
        assert!(second.ready().now_or_never().is_none(), "the second place waits while the first is held");
        let cancelled = tokio::spawn(async move {
            let _held = first;
            std::future::pending::<()>().await;
        });
        cancelled.abort();
        assert!(cancelled.await.unwrap_err().is_cancelled());
        second.ready().now_or_never().expect("a cancelled holder released the file");
        assert!(third.ready().now_or_never().is_none());
        let panicked = tokio::spawn(async move {
            let _held = second;
            panic!("the holder panics");
        });
        assert!(panicked.await.unwrap_err().is_panic());
        third.ready().now_or_never().expect("a panicking holder released the file");
    }

    #[test]
    fn may_affect_read_distinguishes_disjoint_and_overlapping_targets() {
        let cwd = Path::new("/ws");
        let edit_a = serde_json::json!({ "file_path": "src/a.rs", "old_string": "x", "new_string": "y" });
        let write_a = serde_json::json!({ "file_path": "src/a.rs", "content": "hi" });
        let patch_a = serde_json::json!({ "patch": "*** Update File: src/a.rs\n@@\n-x\n+y\n" });
        let patch_move = serde_json::json!({ "patch": "*** Update File: src/a.rs\n*** Move to: src/b.rs\n@@\n-x\n+y\n" });
        let shell = serde_json::json!({ "command": "cargo test" });
        let git_mut = serde_json::json!({ "command": "git checkout -- ." });

        // Unknown write scopes (`shell`, mutating `git`) conservatively affect every read.
        assert!(may_affect_read("shell", &shell, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));
        assert!(may_affect_read("shell", &shell, "glob", &serde_json::json!({ "pattern": "docs/*.md" }), cwd));
        assert!(may_affect_read("git", &git_mut, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));

        // Disjoint declared targets do not overlap.
        assert!(!may_affect_read("edit", &edit_a, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));
        assert!(!may_affect_read("write", &write_a, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));
        assert!(!may_affect_read("apply_patch", &patch_a, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));
        assert!(!may_affect_read("edit", &edit_a, "glob", &serde_json::json!({ "pattern": "docs/*.md" }), cwd));
        assert!(!may_affect_read("edit", &edit_a, "list", &serde_json::json!({ "path": "docs" }), cwd));
        assert!(!may_affect_read("edit", &edit_a, "list", &serde_json::json!({ "path": "src2" }), cwd));
        assert!(!may_affect_read("edit", &edit_a, "grep", &serde_json::json!({ "pattern": "foo", "path": "docs" }), cwd));
        assert!(!may_affect_read("edit", &edit_a, "find", &serde_json::json!({ "query": "foo", "path": "docs" }), cwd));

        // Same file, ancestor directory, move target, or unknown reader conservatively overlap.
        assert!(may_affect_read("edit", &edit_a, "read", &serde_json::json!({ "file_path": "src/a.rs" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "read", &serde_json::json!({ "file_path": "./src/../src/A.RS" }), cwd));
        assert!(may_affect_read("apply_patch", &patch_move, "read", &serde_json::json!({ "file_path": "src/b.rs" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "glob", &serde_json::json!({ "pattern": "src/*.rs" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "glob", &serde_json::json!({ "pattern": "*.rs" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "glob", &serde_json::json!({ "pattern": "docs/*/../src/*.rs" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "list", &serde_json::json!({ "path": "src" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "grep", &serde_json::json!({ "pattern": "foo", "path": "src" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "code_graph", &serde_json::json!({ "mode": "overview" }), cwd));
        assert!(may_affect_read("edit", &edit_a, "peek", &serde_json::json!({}), cwd));
    }
}

/// The file an edit targets, resolved and case-folded (`_editPathKey`); `None` when the call does not say.
pub(crate) fn edit_path_key(args: &JsonValue, cwd: &Path) -> Option<String> {
    let raw = args.get("file_path").or_else(|| args.get("path")).or_else(|| args.get("file"))?.as_str()?;
    let text = mixdog_js::js_trim(raw);
    (!text.is_empty()).then(|| norm_path(text, cwd))?
}

fn norm_path(raw: &str, cwd: &Path) -> Option<String> {
    let text = mixdog_js::js_trim(raw);
    if text.is_empty() {
        return None;
    }
    let resolved = crate::tools::resolve_lexically(text, cwd).replace('\\', "/");
    if resolved.split('/').any(|part| part == "..") {
        return None;
    }
    let mut folded = resolved.to_lowercase();
    while folded.len() > 1 && folded.ends_with('/') {
        let bytes = folded.as_bytes();
        if bytes.len() == 3 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
            break;
        }
        folded.pop();
    }
    Some(folded)
}

fn has_glob_magic(text: &str) -> bool {
    text.contains(['*', '?', '[', '{'])
}

fn is_same_or_within(ancestor: &str, path: &str) -> bool {
    if ancestor == path {
        return true;
    }
    if ancestor == "/" {
        return path.starts_with('/');
    }
    if ancestor.ends_with('/') {
        return path.starts_with(ancestor);
    }
    path.strip_prefix(ancestor).is_some_and(|rest| rest.starts_with('/'))
}

pub(crate) fn paths_overlap(a: &str, b: &str) -> bool {
    is_same_or_within(a, b) || is_same_or_within(b, a)
}

fn strip_patch_metadata(raw: &str) -> String {
    let mut text = mixdog_js::js_trim(raw).to_owned();
    if let Some(before) = text.strip_suffix("***") {
        let trimmed = mixdog_js::js_trim_end(before);
        if trimmed.len() < before.len() {
            text = trimmed.to_owned();
        }
    }
    if let Some(tab) = text.find('\t') {
        text = mixdog_js::js_trim_end(&text[..tab]).to_owned();
    }
    if let Some(q @ ('"' | '\'')) = text.chars().next()
        && text.len() > 1
        && let Some(end) = text[1..].find(q)
    {
        text = text[1..1 + end].to_owned();
    }
    text.trim_matches(['"', '\'']).replace('\\', "/")
}

fn patch_touched_paths(patch: &str) -> Vec<String> {
    let text = patch.strip_prefix('\u{FEFF}').unwrap_or(patch).replace("\r\n", "\n");
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out = Vec::new();
    let mut push = |raw: &str, strip_ab: bool| {
        let mut path = strip_patch_metadata(raw);
        if strip_ab && let Some(rest) = path.strip_prefix("a/").or_else(|| path.strip_prefix("b/")) {
            path = rest.to_owned();
        }
        if !path.is_empty() && path != "/dev/null" && !out.contains(&path) {
            out.push(path);
        }
    };
    for line in &lines {
        for marker in ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"] {
            if let Some(rest) = line.strip_prefix(marker) {
                push(rest, false);
            }
        }
        for marker in ["rename from ", "rename to "] {
            if let Some(rest) = line.strip_prefix(marker) {
                push(rest, false);
            }
        }
    }
    let mut i = 0;
    while i + 1 < lines.len() {
        let (minus, plus) = (lines[i], lines[i + 1]);
        if minus.starts_with("--- ") && plus.starts_with("+++ ") {
            push(&minus[4..], true);
            push(&plus[4..], true);
            i += 1;
        }
        i += 1;
    }
    out
}

/// The declared filesystem paths written by `name`/`args`, or `None` when the call's write scope cannot be bounded
/// (such as `shell`, `git` mutations, or unparseable arguments).
pub(crate) fn write_targets(name: &str, args: &JsonValue, cwd: &Path) -> Option<Vec<String>> {
    match bare(name).to_lowercase().as_str() {
        "edit" | "write" => {
            let mut out = Vec::new();
            for key in ["file_path", "path", "file"] {
                match args.get(key) {
                    None | Some(JsonValue::Null) => {}
                    Some(JsonValue::String(raw)) => {
                        let text = mixdog_js::js_trim(raw);
                        if text.is_empty() || has_glob_magic(text) {
                            return None;
                        }
                        let path = norm_path(text, cwd)?;
                        if !out.contains(&path) {
                            out.push(path);
                        }
                    }
                    Some(_) => return None,
                }
            }
            (!out.is_empty()).then_some(out)
        }
        "apply_patch" => {
            let patch = args.get("patch")?.as_str()?;
            let base = match args.get("base_path") {
                None | Some(JsonValue::Null) => cwd.to_path_buf(),
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    if text.is_empty() { cwd.to_path_buf() } else { std::path::PathBuf::from(crate::tools::resolve_lexically(text, cwd)) }
                }
                Some(_) => return None,
            };
            let raw_paths = patch_touched_paths(patch);
            if raw_paths.is_empty() {
                return None;
            }
            let mut out = Vec::with_capacity(raw_paths.len());
            for raw in raw_paths {
                let path = norm_path(&raw, &base)?;
                if !out.contains(&path) {
                    out.push(path);
                }
            }
            Some(out)
        }
        _ => None,
    }
}

fn read_item_path(item: &JsonValue) -> Option<&str> {
    if let Some(s) = item.as_str() {
        return Some(s);
    }
    match (item.get("file_path").filter(|v| !v.is_null()), item.get("path").filter(|v| !v.is_null())) {
        (Some(v), None) | (None, Some(v)) => v.as_str(),
        _ => None,
    }
}

fn glob_base_dir(raw: &str) -> String {
    let normalized = raw.replace('\\', "/");
    let abs_slash = normalized.starts_with('/');
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if has_glob_magic(part) {
            break;
        }
        parts.push(part);
    }
    let mut joined = parts.join("/");
    if joined.len() == 2 && joined.as_bytes()[1] == b':' && joined.as_bytes()[0].is_ascii_alphabetic() {
        joined.push('/');
    }
    if joined.is_empty() { if abs_slash { "/".to_owned() } else { ".".to_owned() } } else { joined }
}

/// The declared filesystem paths/roots read by `name`/`args`, or `None` when the call's read scope cannot be bounded.
pub(crate) fn read_targets(name: &str, args: &JsonValue, cwd: &Path) -> Option<Vec<String>> {
    match bare(name).to_lowercase().as_str() {
        "read" => {
            let target = match (args.get("file_path").filter(|v| !v.is_null()), args.get("path").filter(|v| !v.is_null())) {
                (Some(v), None) | (None, Some(v)) => v,
                _ => return None,
            };
            let mut raw_paths = Vec::new();
            match target {
                JsonValue::String(s) => raw_paths.push(s.as_str()),
                JsonValue::Array(items) if !items.is_empty() => {
                    for item in items {
                        raw_paths.push(read_item_path(item)?);
                    }
                }
                _ => return None,
            }
            let mut out = Vec::with_capacity(raw_paths.len());
            for raw in raw_paths {
                let text = mixdog_js::js_trim(raw);
                if text.is_empty() || has_glob_magic(text) {
                    return None;
                }
                // Reject path:line coordinates conservatively rather than misparsing colons.
                let after_drive = text.get(2..).unwrap_or("");
                if after_drive.contains(':') {
                    return None;
                }
                let path = norm_path(text, cwd)?;
                if !out.contains(&path) {
                    out.push(path);
                }
            }
            Some(out)
        }
        "glob" => {
            let base_dir = match args.get("path") {
                None | Some(JsonValue::Null) => cwd.to_path_buf(),
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    if text.is_empty() {
                        cwd.to_path_buf()
                    } else {
                        let norm = text.replace('\\', "/");
                        if norm.split('/').any(|p| p == "..") {
                            return None;
                        }
                        let base = if has_glob_magic(&norm) { glob_base_dir(&norm) } else { norm };
                        std::path::PathBuf::from(crate::tools::resolve_lexically(&base, cwd))
                    }
                }
                Some(_) => return None,
            };
            let pattern_val = args.get("pattern").filter(|v| !v.is_null());
            if args.get("patterns").is_some_and(|v| !v.is_null()) || pattern_val.is_none() {
                let roots = mixdog_tools::fs::glob_result_roots(args)?;
                if roots.is_empty() {
                    return None;
                }
                let mut out = Vec::with_capacity(roots.len());
                for root in roots {
                    let path = norm_path(&root, cwd)?;
                    if !out.contains(&path) {
                        out.push(path);
                    }
                }
                return Some(out);
            }
            let raw_patterns: Vec<&str> = match pattern_val {
                Some(JsonValue::String(s)) => vec![s.as_str()],
                Some(JsonValue::Array(items)) if !items.is_empty() => {
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        out.push(item.as_str()?);
                    }
                    out
                }
                _ => return None,
            };
            let mut out = Vec::new();
            for raw in raw_patterns {
                let text = mixdog_js::js_trim(raw);
                if text.is_empty() || text.starts_with('!') {
                    continue;
                }
                let norm = text.replace('\\', "/");
                if norm.split('/').any(|p| p == "..") {
                    return None;
                }
                let prefix = glob_base_dir(&norm);
                let path = norm_path(&prefix, &base_dir)?;
                if !out.contains(&path) {
                    out.push(path);
                }
            }
            if out.is_empty() {
                out.push(norm_path(".", &base_dir)?);
            }
            Some(out)
        }
        "list" => {
            let root = match args.get("path") {
                None | Some(JsonValue::Null) => ".".to_owned(),
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    if text.is_empty() {
                        ".".to_owned()
                    } else if has_glob_magic(text) {
                        glob_base_dir(text)
                    } else {
                        text.to_owned()
                    }
                }
                Some(_) => return None,
            };
            Some(vec![norm_path(&root, cwd)?])
        }
        "find" => {
            let root = match args.get("path") {
                None | Some(JsonValue::Null) => ".",
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    if text.is_empty() { "." } else { text }
                }
                Some(_) => return None,
            };
            Some(vec![norm_path(root, cwd)?])
        }
        "grep" => {
            if let Some(glob) = args.get("glob").filter(|v| !v.is_null()) {
                let g = glob.as_str()?;
                let g = mixdog_js::js_trim(g).replace('\\', "/");
                let has_drive = g.as_bytes().get(1) == Some(&b':');
                if g.starts_with('/') || has_drive || g.split('/').any(|p| p == "..") {
                    return None;
                }
            }
            let raw_paths: Vec<&str> = match args.get("path") {
                None | Some(JsonValue::Null) => vec!["."],
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    vec![if text.is_empty() { "." } else { text }]
                }
                Some(JsonValue::Array(items)) if !items.is_empty() => {
                    let mut out = Vec::with_capacity(items.len());
                    for item in items {
                        let text = mixdog_js::js_trim(item.as_str()?);
                        out.push(if text.is_empty() { "." } else { text });
                    }
                    out
                }
                Some(_) => return None,
            };
            let mut out = Vec::with_capacity(raw_paths.len());
            for raw in raw_paths {
                let path = norm_path(raw, cwd)?;
                if !out.contains(&path) {
                    out.push(path);
                }
            }
            Some(out)
        }
        "code_graph" => {
            let root = match args.get("cwd") {
                None | Some(JsonValue::Null) => ".",
                Some(JsonValue::String(raw)) => {
                    let text = mixdog_js::js_trim(raw);
                    if text.is_empty() { "." } else { text }
                }
                Some(_) => return None,
            };
            Some(vec![norm_path(root, cwd)?])
        }
        _ => None,
    }
}

/// Whether a mutating or reuse-invalidating call (`writer`) may affect what `reader` observes.
/// Returns `false` only when both calls declare concrete paths that are provably disjoint.
pub(crate) fn may_affect_read(writer_name: &str, writer_args: &JsonValue, reader_name: &str, reader_args: &JsonValue, cwd: &Path) -> bool {
    let Some(written) = write_targets(writer_name, writer_args, cwd) else {
        return true;
    };
    let Some(read) = read_targets(reader_name, reader_args, cwd) else {
        return true;
    };
    written.iter().any(|w| read.iter().any(|r| paths_overlap(w, r)))
}

impl Barriers {
    pub(crate) fn has_reuse_invalidator_for(&self, name: &str, args: &JsonValue, cwd: &Path) -> bool {
        let read = read_targets(name, args, cwd);
        self.started.iter().any(|call| {
            let Some(written) = &call.reuse_writes else {
                return false;
            };
            match (written, &read) {
                (Some(written), Some(read)) => written.iter().any(|w| read.iter().any(|r| paths_overlap(w, r))),
                _ => true,
            }
        })
    }

    pub(crate) fn preceding_for(&self, name: &str, args: &JsonValue, cwd: &Path) -> Preceding {
        let git_mutation = is_git_mutation(name, args);
        let mutation = is_mutation(name, args);
        let shell = is_shell(name);
        let key = is_edit(name).then(|| edit_path_key(args, cwd));
        let same_file = |s: &&Started| match (&s.edit, &key) {
            (None, _) | (_, None) => false,
            (Some(_), Some(None)) | (Some(None), _) => true,
            (Some(theirs), Some(Some(ours))) => theirs.as_ref() == Some(ours),
        };
        let edits = self.started.iter().filter(same_file).map(|s| s.done.clone()).collect();
        let git = if shell || mutation { self.started.iter().filter(|s| s.git_mutation).map(|s| s.done.clone()).collect() } else { Vec::new() };
        let patches = if shell || git_mutation {
            self.started.iter().filter(|s| s.mutation).map(|s| (s.id.clone(), s.done.clone(), s.failed.clone())).collect()
        } else {
            Vec::new()
        };
        let ids = self
            .started
            .iter()
            .filter(|s| same_file(s) || ((shell || mutation) && s.git_mutation) || ((shell || git_mutation) && s.mutation))
            .map(|s| s.id.clone())
            .collect();
        Preceding { has: [is_edit(name), shell || mutation, shell || git_mutation], edits, git, patches, ids }
    }

    /// Chains the call's settlement into the barriers later calls wait on.
    pub(crate) fn register(&mut self, id: &str, name: &str, args: &JsonValue, cwd: &Path, done: watch::Receiver<bool>, failed: Arc<AtomicBool>) {
        self.started.push(Started {
            id: id.to_owned(),
            edit: is_edit(name).then(|| edit_path_key(args, cwd)),
            mutation: is_mutation(name, args),
            reuse_writes: invalidates_reuse(name, args).then(|| write_targets(name, args, cwd)),
            git_mutation: is_git_mutation(name, args),
            done,
            failed,
        });
    }

    pub(crate) fn clear(&mut self) {
        self.started.clear();
        self.locks = EditLocks::default();
    }
}
