//! Per-method input validation at the protocol boundary: each group owns some methods and answers for them.

// These boundary functions return the canonical ErrorData wire DTO by value.
// Its largest inline variant contains two JsonValue values (144 bytes in the
// current diagnostic); strings/collections retain their existing owned storage.
// Boxing every refusal would add an allocation and change public validation
// signatures solely to satisfy a size heuristic. Keep the wire/API representation
// and limit this design allowance to this validation subtree.
#![allow(clippy::result_large_err, reason = "Boundary validation returns canonical ErrorData by value without an extra error allocation or public API change")]

use serde_json::Value;

use crate::error::ErrorData;

pub mod capability;
pub mod capability_settings;
pub mod custom_provider;
pub mod model;
pub mod normalize;
pub mod prompt;
pub mod workspace_names;
pub mod worktree_import;

/// A method group either declines ownership or returns its canonical verdict.
type ValidationGroup = fn(&str, Option<&Value>) -> Option<Result<(), ErrorData>>;

/// What the typed groups other than the capability table refuse in `params` of `method`: the refusal that names a field a call
/// left out, which the table's argument count must not hide.
pub(crate) fn typed_refusal(method: &str, params: Option<&Value>) -> Option<ErrorData> {
    let groups: [ValidationGroup; 5] = [
        capability_settings::check,
        custom_provider::check,
        model::check,
        workspace_names::check,
        worktree_import::check,
    ];
    groups.iter().find_map(|group| group(method, params)).and_then(Result::err)
}

/// Checks `params` of `method` against the group that owns the method; a method no group owns passes.
pub fn check(method: &str, params: Option<&Value>) -> Result<(), ErrorData> {
    let groups: [ValidationGroup; 7] = [
        prompt::check,
        capability::check,
        capability_settings::check,
        custom_provider::check,
        model::check,
        workspace_names::check,
        worktree_import::check,
    ];
    groups.iter().find_map(|group| group(method, params)).unwrap_or(Ok(()))
}
