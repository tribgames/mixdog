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

fn conversation_save_key(session: &str) -> String {
    format!("conversation-save:{session}")
}

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

    /// The notice for a session holding conversation rows the disk does not have: one standing entry per session, told once
    /// until [`Self::conversation_save_resolved`] withdraws it.
    pub fn conversation_save_failed(&self, session: &str) {
        self.raise(&conversation_save_key(session), "conversation-save-failed", &[("session", session)]);
    }

    /// The session's unsaved rows are acknowledged: its notice leaves the section, so a window that attaches later is not
    /// shown it. Another session's notice stands.
    pub fn conversation_save_resolved(&self, session: &str) {
        self.clear(&conversation_save_key(session));
    }

    /// `offloadCopies`'s notice (`node-fix-prune-after-save.patch`): no tool-result file is pruned while the session
    /// `name` cannot be read; told once per run, naming the first such session.
    pub fn offload_prune_blocked(&self, name: &str) {
        self.raise("offload-prune-blocked", "offload-prune-blocked", &[("name", name)]);
    }
}
#[cfg(test)]
mod tests {
    use mixdog_core_api::mock::MockStatePublisher;

    use super::*;

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


    /// A key is raised once until it is cleared; an empty key or code raises nothing; params are strings as given.
    #[test]
    fn a_notice_is_raised_once_per_key_until_it_is_cleared_and_an_empty_key_or_code_raises_nothing() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        assert!(!notices.raise("", "code", &[]));
        assert!(!notices.raise("key", "", &[]));
        assert!(publisher.published().is_empty());
        assert!(notices.raise("provider-sign-in:anthropic", "provider-sign-in-expired", &[("name", "7"), ("other", "")]));
        assert_eq!(sets(&publisher, 0), [json!({ "key": "provider-sign-in:anthropic", "code": "provider-sign-in-expired", "params": { "name": "7", "other": "" } })]);
        assert!(!notices.raise("provider-sign-in:anthropic", "provider-sign-in-expired", &[("name", "again")]), "the same key shows once");
        assert_eq!(sets(&publisher, 0).len(), 1);
        notices.clear("never-raised");
        assert!(notices.raise("secret-storage", "secret-storage-failed", &[]));
        assert!(!notices.raise("secret-storage", "secret-storage-failed", &[]));
        notices.clear("secret-storage");
        assert!(notices.raise("secret-storage", "secret-storage-failed", &[]), "a clear re-arms the key");
    }

    /// The keychain holder's callback raises the one notice, once, however many failures it reports; a clear re-arms it.
    #[test]
    fn the_keychains_failure_callback_raises_one_secret_storage_notice_and_a_clear_re_arms_it() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        let failed = notices.secret_storage_failed();
        failed();
        failed();
        assert_eq!(sets(&publisher, 0), [json!({ "key": "secret-storage", "code": "secret-storage-failed", "params": {} })]);
        notices.clear("secret-storage");
        failed();
        assert_eq!(sets(&publisher, 0).len(), 2);
    }

    #[test]
    fn a_provider_shows_its_display_name_by_any_case_an_unknown_id_as_itself_and_none_as_provider() {
        for (id, name) in [
            ("anthropic-oauth", "Anthropic OAuth"),
            ("ANTHROPIC-OAUTH", "Anthropic OAuth"),
            ("openai", "OpenAI API"),
            ("gemini-api", "Gemini API"),
            ("mixdog-local", "Local Provider"),
            ("default", "Default"),
            ("my-custom-gateway", "my-custom-gateway"),
            ("", "Provider"),
        ] {
            assert_eq!(provider_display_name(id), name, "{id:?}");
        }
    }

    /// Only a turn whose provider refused the sign-in raises the notice, named by the provider's display name; no provider raises none.
    #[test]
    fn a_failed_turn_raises_the_sign_in_notice_only_for_an_auth_failure_with_a_provider() {
        for (provider, name) in [("anthropic-oauth", "Anthropic OAuth"), ("my-custom-gateway", "my-custom-gateway")] {
            let publisher = Arc::new(MockStatePublisher::default());
            let notices = DesktopNotices::new(publisher.clone());
            for kind in [Some("permission"), Some("rate_limited"), Some("transient"), None] {
                notices.turn_failed(provider, kind);
            }
            assert!(sets(&publisher, 0).is_empty(), "{provider}: no other failure raises it");
            notices.turn_failed(provider, Some("auth"));
            assert_eq!(sets(&publisher, 0), [json!({ "key": format!("provider-sign-in:{provider}"), "code": "provider-sign-in-expired", "params": { "name": name } })]);
        }
        let publisher = Arc::new(MockStatePublisher::default());
        DesktopNotices::new(publisher.clone()).turn_failed("", Some("auth"));
        assert!(publisher.published().is_empty());
    }

    /// A conversation that cannot be saved is told once per session while it stands; one session's resolution leaves the other's
    /// notice standing, and a resolved one is gone from the standing section (what a window that mounts later reads).
    #[test]
    fn a_save_warning_stands_per_session_until_that_session_is_resolved() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        notices.conversation_save_failed("a");
        notices.conversation_save_failed("a");
        notices.conversation_save_failed("b");
        assert_eq!(
            sets(&publisher, 0),
            [
                json!({ "key": "conversation-save:a", "code": "conversation-save-failed", "params": { "session": "a" } }),
                json!({ "key": "conversation-save:b", "code": "conversation-save-failed", "params": { "session": "b" } }),
            ]
        );
        notices.conversation_save_resolved("b");
        notices.conversation_save_resolved("b");
        let mut standing = std::collections::BTreeSet::new();
        for (_, key, change) in publisher.published() {
            let key = key.expect("keyed");
            match change {
                SectionChange::Set(_) => standing.insert(key),
                _ => standing.remove(&key),
            };
        }
        assert_eq!(standing.into_iter().collect::<Vec<_>>(), ["conversation-save:a"]);
        notices.conversation_save_failed("b");
        assert_eq!(sets(&publisher, 0).len(), 3, "a resolved session raises again when it fails again");
    }

    /// A connector's expired sign-in is raised under its own key and withdrawn when the sign-in is restored.
    #[test]
    fn a_connectors_expired_sign_in_is_raised_once_and_withdrawn_when_restored() {
        let publisher = Arc::new(MockStatePublisher::default());
        let notices = DesktopNotices::new(publisher.clone());
        notices.connector_sign_in_expired("acme");
        notices.connector_sign_in_expired("acme");
        assert_eq!(sets(&publisher, 0), [json!({ "key": "connector-sign-in:acme", "code": "connector-sign-in-expired", "params": { "name": "acme" } })]);
        notices.connector_sign_in_restored("acme");
        notices.connector_sign_in_expired("acme");
        assert_eq!(sets(&publisher, 0).len(), 2);
        notices.connector_sign_in_expired("");
        assert_eq!(sets(&publisher, 0).len(), 2, "no server, no notice");
    }
}