//! Shared TS/Rust parity cases: `parity/<name>.json` = `{name, cases: [{id, input, expect}]}`, read here and by
//! `scripts/parity/cases.mjs`, so both implementations are pinned to one table. A mismatch names the case id.

use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;

/// This crate's manifest from the checkout's root: what marks a directory as the checkout.
const SELF_MANIFEST: &str = "native/core/crates/mixdog-testkit/Cargo.toml";

/// One row of a case file.
#[derive(Clone, Debug, PartialEq)]
pub struct Case {
    pub id: String,
    pub input: Value,
    pub expect: Value,
}

/// The directory of the case files, found from the manifest directory cargo names in the test's environment (any
/// crate of the checkout) or else the working directory. Panics when no checkout is found.
fn parity_dir() -> PathBuf {
    let start = std::env::var_os("CARGO_MANIFEST_DIR").map(PathBuf::from).or_else(|| std::env::current_dir().ok());
    let root = start
        .as_deref()
        .and_then(|dir| dir.ancestors().find(|ancestor| crate::is_dir(ancestor.join("native/core/crates/mixdog-testkit")) || crate::exists(ancestor.join(SELF_MANIFEST))))
        .unwrap_or_else(|| panic!("parity: no checkout found from {start:?}"));
    // Inside the testkit crate itself the checkout root is three levels up; either way the files sit beside its manifest.
    if root.join(SELF_MANIFEST).is_file() { root.join("native/core/crates/mixdog-testkit/parity") } else { root.join("parity") }
}

/// The cases of `parity/<name>.json`, in file order. Panics when the file is missing or malformed (a case
/// without `id`, `input` or `expect`, a duplicate id, a `name` that differs from the file's).
pub fn cases(name: &str) -> Vec<Case> {
    assert!(!name.is_empty() && !name.starts_with('.') && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_'
