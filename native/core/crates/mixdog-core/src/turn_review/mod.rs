//! The turn review: one component that every tool write, worker turn, review base and client
//! method feeds and reads (Node `runtime/shared/turn-snapshot.mjs`, `turn-changes.mjs`,
//! `turn-snapshot-store.mjs`, `bounded-line-diff.mjs`, `review-diff.mjs`, `tools/patch/ui-diff.mjs`).
//!
//! In memory, per process: each session's tracker of own segments, its turn, parked worker
//! reviews, and the call card diffs not yet picked up. On disk, in Node's own files under
//! `<data>/turn-snapshots`: the turn Git baselines and session scopes, and every retained turn's
//! frozen change record with its replayable patches ([`store`]).
//!
//! Not here: the session-wide review (first-seen baselines against the disk) and the Git worktree
//! capture behind [`ports::ReviewWorktrees`].

mod api;
mod apply;
mod call_diff;
mod content;
mod disk;
mod freeze;
pub mod line_diff;
mod named;
pub mod nodepath;
mod patch;
pub mod ports;
mod reads;
mod review_diff;
mod scm_ports;
mod seams;
mod service;
mod store;
mod tracker;
mod undo;

#[cfg(test)]
mod tests;

pub use call_diff::call_ui_diff;
pub use disk::LaneDisk;
pub use scm_ports::ScmGit;
pub use scm_ports::ScmWorktrees;
pub use seams::AgentTurnReviews;
pub use seams::ThreadCwd;
pub use seams::ToolReviewRecorder;
pub use service::Config;
pub use service::TurnReview;
pub use store::Store;
