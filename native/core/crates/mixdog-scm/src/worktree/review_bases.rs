//! Where a review starts: the tree of the work tree captured at the start of a turn or session,
//! kept per thread (and checkpoint). The thread layer records a base when a turn begins (and
//! re-records the durable ones after a restart); `review/diff/get` and the pushed review read
//! it back through [`ReviewBases`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_app_protocol::v2::domain::ReviewScope;
use mixdog_core_api::domain::repo::ObjectId;
use mixdog_protocol::ThreadId;

use crate::engine::Repo;
use crate::error::ScmFailure;
use crate::git::RunOptions;
use crate::service::ReviewBases;

type Key = (String, &'static str, Option<String>);

fn scope_tag(scope: ReviewScope) -> &'static str {
    match scope {
        ReviewScope::Turn => "turn",
        ReviewScope::Session => "session",
        ReviewScope::Repo => "repo",
    }
}

#[derive(Default)]
pub struct CapturedBases {
    bases: Mutex<HashMap<Key, (PathBuf, ObjectId)>>,
}

impl CapturedBases {
    pub fn new() -> Self {
        Self::default()
    }

    /// Remembers the tree a scope started from. A turn is addressed by its checkpoint id.
    pub fn record(&self, thread: &ThreadId, scope: ReviewScope, checkpoint: Option<&str>, cwd: PathBuf, base: ObjectId) {
        self.bases.lock().expect("bases").insert(
            (thread.as_str().to_owned(), scope_tag(scope), checkpoint.map(str::to_owned)),
            (cwd, base),
        );
    }

    /// Forgets everything of a thread (it was deleted).
    pub fn forget(&self, thread: &ThreadId) {
        self.bases.lock().expect("bases").retain(|(id, ..), _| id != thread.as_str());
    }
}

#[async_trait]
impl ReviewBases for CapturedBases {
    async fn base(&self, thread: &ThreadId, scope: ReviewScope, checkpoint: Option<&str>) -> Option<(PathBuf, ObjectId)> {
        self.bases
            .lock()
            .expect("bases")
            .get(&(thread.as_str().to_owned(), scope_tag(scope), checkpoint.map(str::to_owned)))
            .cloned()
    }
}

impl Repo {
    /// The tree of the work tree as it is now, untracked files included and ignored ones left
    /// out, built in a scratch index so the user's index is never touched. A ref pins it, so
    /// the object survives garbage collection for as long as the review needs it.
    pub async fn capture_review_base(&self) -> Result<ObjectId, ScmFailure> {
        let root = self.root()?.to_path_buf();
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let scratch = self.scm.scratch_dir().join("review");
        std::fs::create_dir_all(&scratch)?;
        let index = scratch.join(format!(
            "{}-{}.index",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let options = RunOptions {
            index_file: Some(index.clone()),
            ..RunOptions::default()
        };
        let git = &self.scm.git;
        let built = async {
            let head = git
                .outcome(&self.cancel, &root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], &RunOptions::default())
                .await?;
            let read_tree: Vec<String> = if head.success() {
                vec!["read-tree".into(), head.stdout_text().trim().to_owned()]
            } else {
                vec!["read-tree".into(), "--empty".into()]
            };
            let args: Vec<&str> = read_tree.iter().map(String::as_str).collect();
            git.text(&self.cancel, &root, &args, &options).await?;
            git.text(&self.cancel, &root, &["add", "-A"], &options).await?;
            let tree = git.text(&self.cancel, &root, &["write-tree"], &options).await?.trim().to_owned();
            let pin = format!("refs/mixdog/review/{tree}");
            git.text(&self.cancel, &root, &["update-ref", &pin, &tree], &RunOptions::default()).await?;
            Ok::<_, ScmFailure>(tree)
        }
        .await;
        let _ = std::fs::remove_file(&index);
        Ok(ObjectId(built?))
    }
}
