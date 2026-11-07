//! Desktop notices (`src/runtime/shared/desktop-notice-host.mjs`): the few problems the desktop tells
//! the user as a toast (sign-in expired, secure storage failing, a conversation not saved), raised
//! wherever they are detected. They are the `notice` section (DS §2.4, key = notice key): a raise is
//! the entry's publication, a clear its removal, so a client that attaches later reads the standing
//! ones from its snapshot (Node's pending list for notices no window received).
//!
//! A notice is raised once per key until [`DesktopNotices::clear`] re-arms it, so a retry or a poll
//! never repeats it. The value is Node's `RaisedDesktopNotice`: `{key, code, params}` with string
//! params; the renderer words it by `code`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use mixdog_core_api::state::{SectionChange, StatePublisher};
use mixdog_core_base::state::change_of;
use mixdog_protocol::SectionName;
use serde_json::{Map, Value, json};

/// The key and code of the keychain's notice (`keychain-cjs.cjs` `_noticeSecretStoreFailure`).
const SECRET_STORAGE_KEY: &str = "secret-storage";
const SECRET_STORAGE_CODE: &str = "secret-storage-failed";

pub struct DesktopNotices {
    publisher: Arc<dyn StatePublisher>,
    /// Held across a publication so the section's revisions follow the order of the raises.
    raised: Mutex<HashSet<String>>,
}

impl DesktopNotices {
    pub fn new(publisher: Arc<dyn StatePublisher>) -> Arc<Self> {
        Arc::new(Self { publisher, raised: Mutex::new(HashSet::new()) })
    }

    /// `raiseDesktopNotice(key, code, params)`: false when `key` or `code` is empty or the key is
    /// already raised.
    pub fn raise(&self, key: &str, code: &str, params: &[(&str, &str)]) -> bool {
        if key.is_empty() || code.is_empty() {
            return false;
        }
        let mut raised = self.raised.lock().unwrap_or_else(PoisonError::into_inner);
        if !raised.insert(key.to_owned()) {
            return false;
        }
        let params: Map<String, Value> = params.iter().map(|(name, value)| ((*name).to_owned(), json!(value))).collect();
        let notice = json!({ "key": key, "code": code, "params": params });
        self.publisher.publish(SectionName::Notice, Some(key.to_owned()), change_of(&notice));
        true
    }

    /// `clearDesktopNotice(key)`: the condition behind `key` is over, the next raise shows again.
    pub fn clear(&self, key: &str) {
        let mut raised = self.raised.lock().unwrap_or_else(PoisonError::into_inner);
        if raised.remove(key) {
            self.publisher.publish(SectionName::Notice, Some(key.to_owned()), SectionChange::Removed);
        }
    }

    /// The keychain holder's notice, for `mixdog_secrets::default_store_with_status`: raised on
    /// every failure the tracker reports, shown once (`secret-storage` stays raised).
    pub fn secret_storage_failed(self: &Arc<Self>) -> Arc<dyn Fn() + Send + Sync> {
        let notices = Arc::clone(self);
        Arc::new(move || {
            notices.raise(SECRET_STORAGE_KEY, SECRET_STORAGE_CODE, &[]);
        })
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockStatePublisher;
    use mixdog_secrets::{FailureCode, StatusTracker};

    use super::*;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/desktop-notice/golden.json")).expect("fixture")
    }

    /// The notices published since `seen` entries.
    fn sets(publisher: &MockStatePublisher, seen: usize) -> Vec<Value> {
        publisher
            .published()
            .into_iter()
            .skip(seen)
            .filter_map(|(section, key, change)| {
                assert_eq!(section, SectionName::Notice);
                match change {
                    SectionChange::Set(bytes) => {
                        let value: Value = serde_json::from_slice(&bytes).expect("json");
                        assert_eq!(Some(value["key"].as_str().expect("key").to_owned()), key, "the entry is keyed by the notice key");
                        Some(value)
                    }
                    _ => None,
                }
            })
            .collect()
    }

    /// `String(value ?? '')`.
    fn coerced(value: &Value) -> String {
        match value {
            Value::Null => String::new(),
            Value::String(text) => text.clone(),
            other => other.to_string(),
        }
    }

    /// Every raise and clear of the real host (`fixtures/desktop-notice/golden.json`): what the
    /// raise answers and which notices reach the section, key dedupe and re-arming included.
    #[test]
    fn raising_and_clearing_follow_the_node_host() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        for step in golden()["hostSteps"].as_array().expect("steps") {
            let seen = publisher.published().len();
            let args = step["args"].as_array().expect("args");
            let text = |at: usize| args.get(at).and_then(Value::as_str).unwrap_or_default().to_owned();
            if step["op"] == "raise" {
                let params: Vec<(String, String)> =
                    args.get(2).and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), coerced(v))).collect()).unwrap_or_default();
                let refs: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                assert_eq!(json!(notices.raise(&text(0), &text(1), &refs)), step["returned"], "{step}");
            } else {
                notices.clear(&text(0));
            }
            assert_eq!(Value::Array(sets(&publisher, seen)), step["delivered"], "{step}");
        }
    }

    /// A cleared notice leaves the section.
    #[test]
    fn clearing_removes_the_entry_only_when_it_was_raised() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        notices.clear("secret-storage");
        assert!(publisher.published().is_empty());
        assert!(notices.raise("secret-storage", "secret-storage-failed", &[]));
        notices.clear("secret-storage");
        let published = publisher.published();
        assert_eq!(published.len(), 2);
        assert_eq!((published[1].0, published[1].1.as_deref(), &published[1].2), (SectionName::Notice, Some("secret-storage"), &SectionChange::Removed));
    }

    /// The keychain's notice through the real status tracker: shown on the first failure that is
    /// not a "no provider / unreachable" report, once, and again after a clear.
    #[test]
    fn the_keychain_raises_what_the_node_holder_raises() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        let tracker = StatusTracker::new(false, notices.secret_storage_failed());
        for step in golden()["keychainSteps"].as_array().expect("steps") {
            let seen = publisher.published().len();
            match step["step"].as_str().expect("name") {
                "failure" | "second failure" | "failure after ok" | "failure after clear" => tracker.note_failure("storage exploded", FailureCode::Other),
                "no provider" => tracker.note_failure("no keyring provider on this host", FailureCode::Unavailable),
                "unreachable" => tracker.note_failure("gdbus gave an unparsable reply", FailureCode::Unreachable),
                "ok" => tracker.note_ok(),
                "cleared" => notices.clear("secret-storage"),
                other => panic!("step {other}"),
            }
            assert_eq!(Value::Array(sets(&publisher, seen)), step["delivered"], "{step}");
        }
    }
}