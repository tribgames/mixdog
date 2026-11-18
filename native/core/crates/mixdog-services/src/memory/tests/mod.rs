//! End-to-end tests over a temporary Postgres cluster. They need a bundled
//! runtime directory (`bin/`, `lib/`, `share/`, pgvector) named by
//! `MIXDOG_PG_RUNTIME`; the cluster lives in a temp dir and is stopped on drop.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup")]

pub mod awaiting;
mod boot;
#[cfg(node_twin)]
mod cold_recall;
#[cfg(node_twin)]
mod core_key;
#[cfg(node_twin)]
mod model_compression;
#[cfg(node_twin)]
mod status;
mod core_key_start_up;
mod core_memory;
mod embeddings;
pub mod fakes;
#[cfg(node_twin)]
mod ingest;
mod ingest_rows;
mod jobs;
mod lifecycle;
#[cfg(node_twin)]
mod recall;
mod recall_cancel;
mod recall_scopes;
mod reindex;
mod sensitive;
mod service;
mod shared_pg;
mod session_search;
mod session_search_writes;
mod status_readout;
mod transcript_tail;
#[cfg(node_twin)]
mod session_search_golden;
pub mod support;

