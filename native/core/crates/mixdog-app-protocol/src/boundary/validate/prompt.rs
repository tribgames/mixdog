//! Input validation for the `prompt` methods.

use serde_json::Value;

use crate::error::ErrorData;

/// `None`: this group does not own `method`.
pub fn check(_method: &str, _params: Option<&Value>) -> Option<Result<(), ErrorData>> {
    None
}
