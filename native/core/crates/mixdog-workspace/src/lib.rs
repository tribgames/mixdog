#![cfg_attr(test, allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "test setup"))]
//! Workspace domain (DS §4): text codec, file-match ranking and the watch registry.
//! The OS watcher, search sessions, transfers and LSP are not implemented yet.

pub mod browse;
pub mod catalog;
pub mod claims;
pub mod desktop_grants;
pub mod editorcfg;
pub mod error;
pub mod feedpub;
pub mod fsops;
pub mod glob;
pub mod grants;
pub mod ident;
pub mod inplace;
pub mod killpoint;
pub mod lanes;
pub mod lease_end;
pub mod localfs;
pub mod lsp;
pub mod lspcaps;
pub mod lspwire;
pub mod media_lease;
pub mod nodeerr;
pub mod openedpath;
pub mod pageserver;
pub mod pathguard;
pub mod preview;
pub mod rank;
pub mod readwindow;
pub mod recovery;
pub mod release;
#[cfg(feature = "replay-controls")]
pub mod replay_controls;
pub mod search;
pub mod sensitive;
pub mod serverdownload;
pub mod servertrash;
pub mod service;
pub mod text;
pub mod textsearch;
pub mod transfer;
pub mod visualize_pane;
pub mod walk;
pub mod watch;
pub mod watcher;
pub mod zip;

pub use serverdownload::RemoteFileReader;
