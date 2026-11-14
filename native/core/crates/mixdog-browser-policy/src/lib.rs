//! The rules the Browser Use host applies to every URL and every string that leaves it, and the per-command timing
//! record, as one Rust implementation of `apps/desktop/src/main/browser/{url-policy,url-admission,redaction,timing}.ts`.
//!
//! - [`url_policy`]: scheme, embedded credentials, agent-input secret tokens (lifted only for the exact link of a mail the
//!   runtime read), cloud metadata endpoints, private networks and the optional domain allow-list.
//! - [`url_admission`]: the same rules plus the address a name resolves to; every address of the answer is checked, as
//!   `dns.lookup(host, { all: true })` returned them, and an answer is never kept for a later request.
//! - [`redaction`]: secret detection and redaction of text, URLs and Set-Cookie lines.
//! - [`timing`]: the `BrowserCommandTiming` record of one command and the merge of host-reported phase times into it.
//! - [`suffix`]: the public-suffix trie (tldts 7.4.19) that decides a registrable domain.
//!
//! Twins: after the TypeScript engine is deleted (s4-delete-ts-engine) only `url-policy.ts` (with the `redactBrowserUrl` and
//! `redactBrowserText` helpers it calls) stays beside this crate, because Electron needs a synchronous filter for navigation
//! and for reports the host makes itself; `url-admission` and the timing merge rules are Rust only, and their corpora serve
//! the transition. Every case of `native/core/fixtures/browser-parity/*.json` is read by `tests/parity.rs` and by the
//! TypeScript tests of the same names, so the two sides cannot drift apart unseen.
//!
//! Every pattern compiles through `mixdog_js::JsRegex` (V8 semantics: ASCII-only `\b`, `\w`, `\d`; `\s` with U+FEFF), never the
//! `regex` crate.

pub mod redaction;
pub mod suffix;
pub mod timing;
pub mod url_admission;
pub mod url_policy;
