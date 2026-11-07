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

/// `PROVIDER_DISPLAY_NAMES` (`runtime/shared/provider-display-name.mjs`).
const PROVIDER_DISPLAY_NAMES: [(&str, &str); 23] = [
    ("openai-oauth", "OpenAI OAuth"),
    ("anthropic-oauth", "Anthropic OAuth"),
    ("grok-oauth", "Grok OAuth"),
    ("muse-code-oauth", "Muse Code"),
    ("command-code-oauth", "Command Code"),
    ("mimo-oauth", "MiMo"),
    ("cursor-oauth", "Cursor OAuth"),
    ("devin-oauth", "Devin"),
    ("antigravity-oauth", "Antigravity OAuth"),
    ("openai", "OpenAI API"),
    ("openai-api", "OpenAI API"),
    ("anthropic", "Anthropic API"),
    ("anthropic-api", "Anthropic API"),
    ("gemini", "Gemini API"),
    ("gemini-api", "Gemini API"),
    ("xai", "xAI API"),
    ("xai-api", "xAI API"),
    ("deepseek", "DeepSeek API"),
    ("deepseek-api", "DeepSeek API"),
    ("opencode-go-oauth", "OpenCode Go OAuth"),
    ("openrouter", "OpenRouter"),
    ("mixdog-local", "Local Provider"),
    ("default", "Default"),
];

/// `providerDisplayName(provider)`: an unknown id displays as itself, none as `Provider`.
pub fn provider_display_name(provider: &str) -> String {
    let lower = provider.to_lowercase();
    match PROVIDER_DISPLAY_NAMES.iter().find(|(id, _)| *id == lower) {
        Some((_, name)) => (*name).to_owned(),
        None if provider.is_empty() => "Provider".to_owned(),
        None => provider.to_owned(),
    }
}

impl DesktopNotices {
    /// A turn on `provider` failed (`failTurn`, turn.mjs:561-567): the provider refused the sign-in
    /// (`kind` is `auth`), so the desktop says so once per provider until a turn on it succeeds.
    pub fn turn_failed(&self, provider: &str, kind: Option<&str>) {
        if !provider.is_empty() && kind == Some("auth") {
            self.raise(&format!("provider-sign-in:{provider}"), "provider-sign-in-expired", &[("name", &provider_display_name(provider))]);
        }
    }

    /// A turn on `provider` finished normally (`completeTurn`, turn.mjs:537).
    pub fn turn_completed(&self, provider: &str) {
        if !provider.is_empty() {
            self.clear(&format!("provider-sign-in:{provider}"));
        }
    }

    /// `signInExpired(serverName)` (oauth-request.mjs:7-9).
    pub fn connector_sign_in_expired(&self, server: &str) {
        if !server.is_empty() {
            self.raise(&format!("connector-sign-in:{server}"), "connector-sign-in-expired", &[("name", server)]);
        }
    }

    /// `clearDesktopNotice(signInNoticeKey(serverName))` (oauth-request.mjs:102, :137).
    pub fn connector_sign_in_restored(&self, server: &str) {
        if !server.is_empty() {
            self.clear(&format!("connector-sign-in:{server}"));
        }
    }

    /// `_recordSaveFailure`'s notice (live-state.mjs:101): told once per run, whichever session.
    pub fn conversation_save_failed(&self) {
        self.raise("conversation-save", "conversation-save-failed", &[]);
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
    fn raisers() -> Value {
        serde_json::from_str(include_str!("../../../../fixtures/desktop-notice-raisers/golden.json")).expect("fixture")
    }

    #[test]
    fn provider_names_are_nodes() {
        for row in raisers()["displayNames"].as_array().expect("names") {
            assert_eq!(json!(provider_display_name(row["id"].as_str().unwrap_or_default())), row["name"], "{row}");
        }
    }

    /// `failTurn` of the real turn module: a turn's auth failure raises the provider's notice named
    /// by its display name; no other failure kind, and no provider, raises one.
    #[test]
    fn a_failed_turn_raises_the_sign_in_notice_only_for_auth_as_node_does() {
        for step in raisers()["providerSteps"].as_array().expect("steps") {
            assert!(step["threw"].is_null() || step["threw"] == "", "{step}");
            let kind = match step["failure"].as_str().expect("failure") {
                "401 auth" => Some("auth"),
                "403 permission" => Some("permission"),
                "429 rate limit" => Some("rate_limited"),
                "500 transient" => Some("transient"),
                _ => None,
            };
            let publisher = Arc::new(MockStatePublisher::default());
            DesktopNotices::new(publisher.clone()).turn_failed(step["provider"].as_str().expect("provider"), kind);
            assert_eq!(Value::Array(sets(&publisher, 0)), step["delivered"], "{step}");
        }
    }

    /// `_recordSaveFailure`: raised at the first failure, whichever session, never again.
    #[test]
    fn a_failed_save_is_told_once_per_run() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        for step in raisers()["saveSteps"].as_array().expect("steps") {
            let seen = publisher.published().len();
            if step["step"] != "no id" {
                notices.conversation_save_failed();
            }
            assert_eq!(Value::Array(sets(&publisher, seen)), step["delivered"], "{step}");
        }
    }

    /// A normal turn end withdraws the provider's notice; the next auth failure shows it again.
    #[test]
    fn a_completed_turn_clears_the_provider_notice() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        notices.turn_failed("anthropic-oauth", Some("auth"));
        notices.turn_failed("anthropic-oauth", Some("auth"));
        assert_eq!(sets(&publisher, 0).len(), 1);
        notices.turn_completed("anthropic-oauth");
        notices.turn_failed("anthropic-oauth", Some("auth"));
        assert_eq!(sets(&publisher, 0).len(), 2);
    }
}