//! End-to-end tests over a temporary Postgres cluster. They need a bundled
//! runtime directory (`bin/`, `lib/`, `share/`, pgvector) named by
//! `MIXDOG_PG_RUNTIME`; the cluster lives in a temp dir and is stopped on drop.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

mod core_memory;
mod embeddings;
mod ingest;
mod jobs;
mod recall;
mod sensitive;
mod service;
mod session_search;
mod session_search_golden;
pub mod support;

