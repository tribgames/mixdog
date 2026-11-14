//! The pure rules the Browser Use host applies to every URL and every string that leaves it: one Rust implementation, with
//! no async runtime and no workspace-hack, so that the Electron main process links exactly these rules
//! (`native/mixdog-main-native`) and the daemon links them through `mixdog-browser-policy`, which re-exports the modules.
//!
//! - [`url_policy`]: scheme, embedded credentials, agent-input secret tokens (lifted only for the exact link of a mail the
//!   runtime read), cloud metadata endpoints, private networks and the optional domain allow-list.
//! - [`redaction`]: secret detection and redaction of text, URLs and Set-Cookie lines.
//! - [`suffix`]: the public-suffix trie (tldts 7.4.19) that decides a registrable domain.
//!
//! Every pattern compiles through `mixdog_js::JsRegex` (V8 semantics: ASCII-only `\b`, `\w`, `\d`; `\s` with U+FEFF), never the
//! `regex` crate.

pub mod redaction;
pub mod suffix;
pub mod url_policy;
