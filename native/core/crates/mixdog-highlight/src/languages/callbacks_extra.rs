//! Hooks of the languages highlight.js 10.7.3 carries beyond the core set (mathematica's `on:begin`):
//! the table `callbacks` consults after its own. None is registered yet.

use crate::engine::Hook;
use crate::engine::compile::Extension;

/// The hook of an id.
pub(crate) fn hook(_id: &str) -> Option<Hook> {
    None
}

/// The compiler extension of an id.
pub(crate) fn extension(_id: &str) -> Option<Extension> {
    None
}
