//! Memory over Postgres: curated core memory (`memory` tool), generated
//! history and `recall`, session transcript search, and the embeddings behind
//! semantic recall.

pub mod boot;
pub mod clean;
pub mod core;
pub mod cycles;
pub mod embed;
pub mod error;
pub mod ingest;
pub mod ingest_shape;
pub mod ko_morph;
pub mod pg;
pub mod project;
pub mod query_terms;
pub mod recall;
pub mod reindex;
pub mod reply;
pub mod runtime;
pub mod schema;
pub mod sensitive;
pub mod service;
pub mod session_search;
pub mod thread_search;
pub mod tool;
pub mod trace;
pub mod transcript;

#[cfg(test)]
mod tests;

/// Aborts a task when dropped: a wait for the task that is itself abandoned (the stop's bound passed) ends the task too. Aborting a task that already ended
/// does nothing.
pub(crate) struct AbortOnDrop(pub(crate) tokio::task::AbortHandle);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
