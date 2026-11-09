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

    /// The threads that have a review start recorded, in id order.
    pub fn threads(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.bases.lock().expect("bases").keys().map(|(id, ..)| id.clone()).collect();
        ids.sort();
        ids.dedup();
        ids
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
        let git = &self.scm.git;
        // One builder for both sides of a review, so their scratch index names cannot collide.
        let tree = crate::inspect::review::work_tree_tree(
            git,
            self.scm.lane,
            &self.cancel,
            &root,
            &self.scm.scratch_dir().join("review"),
        )
        .await?;
        let pin = format!("refs/mixdog/review/{tree}");
        git.text(&self.cancel, &root, &["update-ref", &pin, &tree], &RunOptions::default()).await?;
        Ok(ObjectId(tree))
    }
}
