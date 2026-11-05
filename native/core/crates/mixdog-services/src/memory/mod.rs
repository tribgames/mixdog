//! Memory over Postgres: curated core memory (`memory` tool), generated
//! history and `recall`, session transcript search, and the embeddings behind
//! semantic recall.

pub mod clean;
pub mod core;
pub mod embed;
pub mod error;
pub mod ingest;
pub mod ingest_shape;
pub mod ko_morph;
pub mod pg;
pub mod project;
pub mod query_terms;
pub mod recall;
pub mod reply;
pub mod runtime;
pub mod schema;
pub mod sensitive;
pub mod service;
pub mod session_search;

#[cfg(test)]
mod tests;
