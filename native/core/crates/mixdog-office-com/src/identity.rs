//! Which Office application a session host drives, as far as its messages have said. The host can replace its
//! application while the transport stays alive, so every message is read for identity before a response is settled: an
//! immediate cancellation or exit then cleans up the process that is current.

use serde_json::Value;

/// `Number.isSafeInteger` bound.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Whether the host started its application (`owned`) or found the user's running one (`attached`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ownership {
    Owned,
    Attached,
}

/// What the host has reported about its application so far.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Identity {
    pub ownership: Option<Ownership>,
    pub owns_application: Option<bool>,
    pub app_pid: Option<u64>,
}

impl Identity {
    /// Takes in one message of the host's output. A message of another session, or a field of the wrong type, changes
    /// nothing; a retired application (`cleanup.processExited`) forgets its pid and a retained one stops being owned.
    pub fn accept(&mut self, session_id: &str, message: &Value) {
        if message.get("session").and_then(Value::as_str) != Some(session_id) {
            return;
        }
        if self.ownership.is_none() && message.get("ok") == Some(&Value::Bool(true)) {
            match message.get("ownership").and_then(Value::as_str) {
                Some("owned") => self.ownership = Some(Ownership::Owned),
                Some("attached") => self.ownership = Some(Ownership::Attached),
                _ => {}
            }
        }
        if let Some(owns) = message.get("ownsApplication").and_then(Value::as_bool) {
            self.owns_application = Some(owns);
        }
        if let Some(pid) = message.get("appPid").and_then(safe_pid) {
            self.app_pid = Some(pid);
        }
        let cleanup = message.get("cleanup");
        if cleanup.and_then(|c| c.get("processExited")) == Some(&Value::Bool(true)) {
            self.app_pid = Some(0);
        }
        if cleanup.and_then(|c| c.get("applicationRetained")) == Some(&Value::Bool(true)) {
            self.owns_application = Some(false);
        }
    }
}

/// A JSON number that is a non-negative safe integer (`Number.isSafeInteger(value) && value >= 0`).
fn safe_pid(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number)).then_some(number as u64)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_late_identity_is_taken_in_and_a_first_ownership_is_kept() {
        let mut identity = Identity::default();
        identity.accept("test", &json!({"session": "test", "ok": true, "ownership": "owned", "ownsApplication": true, "appPid": 101}));
        assert_eq!(identity.ownership, Some(Ownership::Owned));
        assert_eq!(identity.owns_application, Some(true));
        assert_eq!(identity.app_pid, Some(101));
        identity.accept("test", &json!({"session": "test", "ok": true, "ownership": "attached", "appPid": 202}));
        assert_eq!(identity.ownership, Some(Ownership::Owned));
        assert_eq!(identity.app_pid, Some(202));
    }

    #[test]
    fn a_failed_response_does_not_claim_ownership_but_still_moves_the_pid() {
        let mut identity = Identity::default();
        identity.accept("s", &json!({"session": "s", "ok": false, "ownership": "owned", "appPid": 7}));
        assert_eq!(identity.ownership, None);
        assert_eq!(identity.app_pid, Some(7));
    }

    #[test]
    fn completed_and_retained_applications_leave_no_stale_ownership() {
        let mut identity = Identity::default();
        identity.accept("test", &json!({"session": "test", "ok": true, "ownership": "owned", "ownsApplication": true, "appPid": 101}));
        identity.accept("test", &json!({"session": "test", "appPid": 101, "cleanup": {"applicationRetained": true}}));
        assert_eq!(identity.owns_application, Some(false));
        identity.accept("test", &json!({"session": "test", "appPid": 101, "cleanup": {"processExited": true}}));
        assert_eq!(identity.app_pid, Some(0));
    }

    #[test]
    fn unrelated_or_malformed_identities_are_ignored_and_a_retired_pid_is_forgotten() {
        let mut identity = Identity { ownership: Some(Ownership::Owned), owns_application: None, app_pid: Some(101) };
        for message in [
            json!({"session": "other", "appPid": 202}),
            json!({"session": "owner"}),
            json!({"session": "owner", "appPid": null}),
            json!({"session": "owner", "appPid": -1}),
            json!({"session": "owner", "appPid": "202"}),
            json!({"session": "owner", "appPid": 1.5}),
            json!({"appPid": 202}),
        ] {
            identity.accept("owner", &message);
            assert_eq!(identity.app_pid, Some(101), "{message}");
        }
        identity.accept("owner", &json!({"session": "owner", "appPid": 0}));
        assert_eq!(identity.app_pid, Some(0));
    }

    #[test]
    fn a_whole_number_written_with_a_fraction_is_still_a_pid() {
        let mut identity = Identity::default();
        identity.accept("s", &json!({"session": "s", "appPid": 202.0}));
        assert_eq!(identity.app_pid, Some(202));
    }
}
