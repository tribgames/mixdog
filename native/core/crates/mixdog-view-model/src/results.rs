//! The tool result projections: summaries, terminal status, text, classification and the read-row numbers.
//!
//! `git_media` and `task_notification` hold the two result shapes the summaries read that other tools own (a git result's exit
//! header, the media job outcome, the task-notification envelope); `aggregate_detail` is the merge of per-call summaries an
//! aggregate card shows.

pub mod aggregate_detail;
pub mod classification;
pub mod git_media;
pub mod read_rows;
pub mod status;
pub mod summary;
pub mod task_notification;
pub mod text;
