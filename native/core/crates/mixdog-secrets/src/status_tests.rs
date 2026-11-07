//! The keychain health against Node's (`fixtures/keychain-status-<platform>/golden.json`,
//! `record-keychain-status.mjs`: the real `_noteKeychainOk` / `_noteKeychainFailure` /
//! `_noteSyncOutcome` / `keychainStatus` of `keychain-cjs.cjs`). The Windows recording is replayed
//! here; the Linux and macOS recordings are made on those build hosts (same recorder) and replayed by
//! the same test with their `platform`.

use std::sync::Arc;
use super::MemoryStore;
use super::SecretError;
use super::SecretStore;
use super::status::StatusTracker;
use super::status::TrackedStore;

/// The golden replay. One test per recorded platform, each compiled on its own host: the Linux and
/// macOS recordings are added with a #[cfg(target_os = ...)] test beside this one when they are made.
#[cfg(windows)]
mod golden {
    use std::sync::Arc;
    use std::sync::atomic::AtomicUsize;
    use std::sync::atomic::Ordering;

    use serde_json::Value;

    use crate::status::FailureCode;
    use crate::status::StatusTracker;

    fn code(name: Option<&str>) -> FailureCode {
        match name {
            Some("KEYRING_UNAVAILABLE") => FailureCode::Unavailable,
            Some("KEYRING_UNREACHABLE") => FailureCode::Unreachable,
            _ => FailureCode::Other,
        }
    }

    fn replay(golden: &str) {
        let golden: Value = serde_json::from_str(golden).unwrap();
        let linux = golden["platform"] == "linux";
        let notices = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&notices);
        let tracker = StatusTracker::new(linux, Arc::new(move || {
            counted.fetch_add(1, Ordering::SeqCst);
        }));
        for step in golden["steps"].as_array().unwrap() {
            let before = notices.load(Ordering::SeqCst);
            let message = step["message"].as_str().unwrap_or_default();
            let failure = code(step["code"].as_str());
            match step["step"].as_str().unwrap() {
                "fresh" => {}
                "ok" => tracker.note_ok(),
                "fail" => tracker.note_failure(message, failure),
                "syncFail" => tracker.note_sync_outcome(Some((message, failure))),
                "syncOk" => tracker.note_sync_outcome(None),
                other => panic!("unknown step {other}"),
            }
            let got = tracker.snapshot();
            let want = &step["status"];
            assert_eq!((got.state.as_str(), got.message.as_str(), got.fallback), (want["state"].as_str().unwrap(), want["message"].as_str().unwrap(), want["fallback"].as_bool().unwrap()), "{step}");
            let noticed = step.get("noticed").and_then(Value::as_u64).unwrap_or(0) as usize;
            assert_eq!(notices.load(Ordering::SeqCst) - before, noticed, "notices: {step}");
        }
    }

    #[test]
    fn the_windows_health_is_nodes() {
        replay(include_str!("../../../fixtures/keychain-status-win32/golden.json"));
    }
}

/// A store that fails or never runs, on demand.
struct Scripted(Mutex<Vec<Result<Option<String>, SecretError>>>);

use std::sync::Mutex;

#[async_trait::async_trait]
impl SecretStore for Scripted {
    async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
        self.0.lock().unwrap().remove(0)
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(0).map(|_| ())
    }
    async fn delete(&self, _: &str) -> Result<(), SecretError> {
        self.0.lock().unwrap().remove(0).map(|_| ())
    }
}

#[tokio::test]
async fn a_tracked_store_notes_each_outcome_but_not_a_call_that_never_ran() {
    let tracker = StatusTracker::new(false, Arc::new(|| {}));
    let script = Arc::new(Scripted(Mutex::new(vec![Ok(None), Err(SecretError::new("[keychain] the keyring is locked")), Err(SecretError::unrun("lane full")), Ok(Some("v".into()))])));
    let store = TrackedStore::new(script, Arc::clone(&tracker));
    assert_eq!(tracker.snapshot().state, "unknown");
    store.get("a").await.unwrap();
    assert_eq!(tracker.snapshot().state, "ok", "an absent account is still a keychain that answered");
    store.get("a").await.unwrap_err();
    assert_eq!(tracker.snapshot().state, "locked");
    store.get("a").await.unwrap_err();
    assert_eq!(tracker.snapshot().state, "locked", "a call that never ran says nothing");
    store.get("a").await.unwrap();
    assert_eq!(tracker.snapshot().state, "ok");
    let _ = MemoryStore::default();
}

#[tokio::test]
async fn the_no_provider_report_is_a_fallback_only_on_linux() {
    for (linux, fallback) in [(true, true), (false, false)] {
        let tracker = StatusTracker::new(linux, Arc::new(|| {}));
        let mut missing = SecretError::new("no secret service");
        missing.no_provider = true;
        let store = TrackedStore::new(Arc::new(Scripted(Mutex::new(vec![Err(missing)]))), Arc::clone(&tracker));
        store.get("a").await.unwrap_err();
        assert_eq!(tracker.snapshot().fallback, fallback);
    }
}
