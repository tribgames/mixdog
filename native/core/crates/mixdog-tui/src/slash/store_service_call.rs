//! A store method called as a daemon RPC. A daemon-backed store can be missing a method this terminal UI calls (an older session
//! service, a protocol allowlist); reporting that as an `Err` keeps every caller on its normal failure path.

use serde_json::Value;

use super::host::SlashHost;

/// `createStoreServiceCall(store)(name, ...args)`: the call, or `Err` when the store has no such method.
pub fn service_call(host: &mut dyn SlashHost, name: &str, args: Vec<Value>) -> Result<Value, String> {
    if !host.has_store_method(name) {
        return Err(format!("project service method {name} is unavailable"));
    }
    host.store_call(name, Value::Array(args))
}
