//! End-to-end tests over a temporary Postgres cluster. They need a bundled
//! runtime directory (`bin/`, `lib/`, `share/`, pgvector) named by
//! `MIXDOG_PG_RUNTIME`; the cluster lives in a temp dir and is stopped on drop.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

pub mod awaiting;
mod boot;
mod core_memory;
mod embeddings;
pub mod fakes;
mod ingest;
mod jobs;
mod recall;
mod reindex;
mod sensitive;
mod service;
mod session_search;
mod session_search_golden;
pub mod support;

