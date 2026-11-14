//! The rules the Browser Use host applies to every URL and every string that leaves it, and the per-command timing
//! record, as one Rust implementation of `apps/desktop/src/main/browser/{url-policy,url-admission,redaction,timing}.ts`.
//!
//! - [`url_policy`], [`redaction`], [`suffix`]: the pure rules, in `mixdog-browser-rules` (re-exported here; the desktop's
//!   Node-API module links that crate alone).
//! - [`url_admission`]: the same rules plus the address a name resolves to; every address of the answer is checked, as
//!   `dns.lookup(host, { all: true })` returned them, and an answer is never kept for a later request.
//! - [`timing`]: the `BrowserCommandTiming` record of one command and the merge of host-reported phase times into it.
//!
//! There is no TypeScript twin: the desktop calls the same rules through `native/mixdog-main-native`. Every case of
//! `native/core/fixtures/browser-parity/*.json` is replayed by `tests/parity.rs` and by the desktop tests of the same names.
//!
//! Every pattern compiles through `mixdog_js::JsRegex` (V8 semantics: ASCII-only `\b`, `\w`, `\d`; `\s` with U+FEFF), never the
//! `regex` crate.

pub use mixdog_browser_rules::{redaction, suffix, url_policy};

pub mod timing;
pub mod url_admission;
