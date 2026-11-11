pub mod project;
pub mod session;

/// What the replays in `crates/mixdog-core-session-replays` reach that no `pub` path offers: items declared `pub` in
/// modules that stay private, re-exported here only. Absent from every build without `test-support`, which build.rs
/// refuses in a release build.
#[cfg(feature = "test-support")]
pub mod replay_access {
    pub use crate::session::transcript::transcript_rows::{Restored, restore};
    pub use crate::session::worktree::worktree_reroot::{PromptReroot, PromptView, presented_workspace};
    pub use crate::session::worktree::worktree_setup_run::{OutputWindow, output_tail};
    pub use crate::session::worktree::worktree_state::plain;
}
