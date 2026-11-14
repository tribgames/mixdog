//! Per-method input validation at the protocol boundary: each group owns some methods and answers for them.

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

/// What the typed groups other than the capability table refuse in `params` of `method`: the refusal that names a field a call
/// left out, which the table's argument count must not hide.
pub(crate) fn typed_refusal(method: &str, params: Option<&Value>) -> Option<ErrorData> {
    let groups: [fn(&str, Option<&Value>) -> Option<Result<(), ErrorData>>; 5] = [
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
    let groups: [fn(&str, Option<&Value>) -> Option<Result<(), ErrorData>>; 7] = [
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
