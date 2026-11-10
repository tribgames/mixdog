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
fn edit_path_key(args: &JsonValue, cwd: &Path) -> Option<String> {
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
}

impl Preceding {
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

/// The calls of one assistant turn that have started.
#[derive(Default)]
pub(crate) struct Barriers {
    started: Vec<Started>,
}

impl Barriers {
    pub(crate) fn preceding_for(&self, name: &str, args: &JsonValue, cwd: &Path) -> Preceding {
        let git_mutation = is_git_mutation(name, args);
        let mutation = is_mutation(name, args);
        let shell = is_shell(name);
        let edits = if is_edit(name) {
            let key = edit_path_key(args, cwd);
            self.started
                .iter()
                .filter(|s| match (&s.edit, &key) {
                    (None, _) => false,
                    (Some(_), None) | (Some(None), _) => true,
                    (Some(theirs), Some(ours)) => theirs.as_ref() == Some(ours),
                })
                .map(|s| s.done.clone())
                .collect()
        } else {
            Vec::new()
        };
        let git = if shell || mutation { self.started.iter().filter(|s| s.git_mutation).map(|s| s.done.clone()).collect() } else { Vec::new() };
        let patches = if shell || git_mutation {
            self.started.iter().filter(|s| s.mutation).map(|s| (s.id.clone(), s.done.clone(), s.failed.clone())).collect()
        } else {
            Vec::new()
        };
        Preceding { has: [is_edit(name), shell || mutation, shell || git_mutation], edits, git, patches }
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
    }
}