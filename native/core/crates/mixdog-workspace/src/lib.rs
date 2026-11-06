#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]
//! Workspace domain (DS §4): text codec, file-match ranking and the watch registry.
//! The OS watcher, search sessions, transfers and LSP are not implemented yet.

pub mod catalog;
pub mod claims;
pub mod editorcfg;
pub mod error;
pub mod feedpub;
pub mod fsops;
pub mod search;
pub mod service;
pub mod servertrash;
pub mod glob;
pub mod ident;
pub mod localfs;
pub mod textsearch;
pub mod transfer;
pub mod zip;
pub mod walk;
pub mod inplace;
pub mod killpoint;
pub mod lanes;
pub mod pathguard;
pub mod lsp;
pub mod lspcaps;
pub mod lspwire;
pub mod rank;
pub mod recovery;
pub mod text;
pub mod watch;
pub mod watcher;
