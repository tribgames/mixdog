//! The ordering barriers of calls that start together, as Node's eager dispatcher keeps them
//! (`session/eager-dispatch/barriers.mjs`). Every call of a batch runs at once except that
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

/// The file an edit targets, resolved and case-folded (`_editPathKey`); `None` when the call does not say.
pub(crate) fn edit_path_key(args: &JsonValue, cwd: &Path) -> Option<String> {
    let raw = args.get("file_path").or_else(|| args.get("path")).or_else(|| args.get("file"))?.as_str()?;
    let text = mixdog_js::js_trim(raw);
    (!text.is_empty()).then(|| crate::tools::resolve_lexically(text, cwd).replace('\\', "/").to_lowercase())
}

struct Started {
    id: String,
    /// `Some(key)` for an edit: its file, or `None` when it names none.
    edit: Option<Option<String>>,
    mutation: bool,
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
            format!(
                "[mutation-dependency-guard] `{name}` skipped because earlier mutation call(s) failed: {}; no verification ran.",
                failed.join(", ")
            )
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

impl Barriers {
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
}