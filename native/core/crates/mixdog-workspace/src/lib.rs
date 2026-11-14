#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]
//! Workspace domain (DS §4): text codec, file-match ranking and the watch registry.
//! The OS watcher, search sessions, transfers and LSP are not implemented yet.

pub mod browse;
pub mod catalog;
pub mod claims;
pub mod editorcfg;
pub mod error;
pub mod feedpub;
pub mod fsops;
pub mod search;
pub mod service;
pub mod servertrash;
pub mod serverdownload;
pub mod glob;
pub mod grants;
pub mod desktop_grants;
pub mod ident;
pub mod localfs;
pub mod nodeerr;
pub mod textsearch;
pub mod transfer;
pub mod zip;
pub mod walk;
pub mod inplace;
pub mod openedpath;
pub mod killpoint;
pub mod lanes;
pub mod pathguard;
pub mod preview;
pub mod lsp;
pub mod lspcaps;
pub mod lspwire;
pub mod rank;
pub mod readwindow;
#[cfg(feature = "replay-controls")]
pub mod replay_controls;
pub mod release;
pub mod recovery;
pub mod text;
pub mod watch;
pub mod watcher;

pub use serverdownload::RemoteFileReader;
