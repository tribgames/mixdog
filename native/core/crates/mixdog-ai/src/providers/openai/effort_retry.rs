//! Retry of a request whose mid-conversation effort updates the model
//! rejected. The verdict reads only the structured error: a 400 whose
//! `error.param` points at an `input` item that the request sent as a
//! `configuration_update`. The message text is never consulted.

use std::collections::HashSet;
use std::sync::Mutex;

use mixdog_core_api::domain::provider::ErrorResponse;
use mixdog_core_api::domain::provider::WireRequest;
use serde_json::Value;

/// Index N of an `input[N]...` parameter path.
fn input_index(param: &str) -> Option<usize> {
    let rest = param.strip_prefix("input[")?;
    rest[..rest.find(']')?].parse().ok()
}

/// The same request without its effort updates, when `response` rejected one
/// of them; `None` for any other failure, and for a request that carries no
/// update (so a second rejection never retries again).
pub fn without_effort_updates(sent: &WireRequest, response: &ErrorResponse) -> Option<WireRequest> {
    if response.status != Some(400) {
        return None;
    }
    let error: Value = serde_json::from_slice(&response.body).ok()?;
    let index = input_index(error.get("error")?.get("param")?.as_str()?)?;
    let mut body: Value = serde_json::from_slice(&sent.body).ok()?;
    let input = body.get_mut("input")?.as_array_mut()?;
    let is_update = |item: &Value| item.get("type").and_then(Value::as_str) == Some("configuration_update");
    if !input.get(index).is_some_and(is_update) {
        return None;
    }
    input.retain(|item| !is_update(item));
    Some(WireRequest {
        body: serde_json::to_vec(&body).ok()?,
        ..sent.clone()
    })
}

/// Models that rejected an effort update: no updates for them for the rest of
/// the process.
#[derive(Default, Debug)]
pub struct EffortUpdateSupport {
    rejected: Mutex<HashSet<(String, String)>>,
}

impl EffortUpdateSupport {
    pub fn mark_rejected(&self, route: &str, model: &str) {
        if let Ok(mut set) = self.rejected.lock() {
            set.insert((route.to_owned(), model.to_owned()));
        }
    }

    pub fn is_rejected(&self, route: &str, model: &str) -> bool {
        self.rejected
            .lock()
            .is_ok_and(|set| set.contains(&(route.to_owned(), model.to_owned())))
    }
}
