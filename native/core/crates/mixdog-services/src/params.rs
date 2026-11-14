//! The arguments of a service request. `CoreRequest::params` already is the method's params object
//! (the server took it out of the JSON-RPC envelope), so a service reads its fields from it
//! directly; a nested `params` member is read only where the method's protocol params declare one (`import/*`).

use serde_json::Value;

/// The method's arguments, `None` when the request carries something other than an object.
pub(crate) fn object(params: &Value) -> Option<&Value> {
    params.is_object().then_some(params)
}
