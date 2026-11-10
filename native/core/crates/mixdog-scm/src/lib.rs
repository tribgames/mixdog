//! SCM engine (DS §5): the read-only inspector, git mutations and the commit transaction,
//! the GitHub CLI client and its login flow, managed worktrees, and the pushed review.

pub mod commit_tx;
pub mod desktop;
pub mod engine;
pub mod error;
pub mod exec;
pub mod feeds;
pub mod gh;
pub mod git;
pub mod git_launch;
pub mod inspect;
pub mod locks;
pub mod mutate;
pub mod phone_review;
pub mod promise_all;
pub mod repo;
pub(crate) mod seam;
pub mod service;
pub mod stage_select;
pub mod tracked;
pub mod worktree;

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod phone_parity_tests;
#[cfg(test)]
mod review_dispatch_tests;
#[cfg(test)]
mod testing;
