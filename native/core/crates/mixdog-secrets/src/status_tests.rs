//! The keychain health: how each outcome of a keychain call moves the state a user sees, and when it raises a notice.

use std::sync::Arc;
use super::MemoryStore;
use super::SecretError;
use super::SecretStore;
use super::status::StatusTracker;
use super::status::TrackedStore;

/// The recorded replay of the reference runtime's health on Windows.
#[cfg(all(windows, node_twin))]
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

fn tracker_with_notices(linux: bool) -> (Arc<StatusTracker>, Arc<std::sync::atomic::AtomicUsize>) {
    let notices = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = Arc::clone(&notices);
    let tracker = StatusTracker::new(linux, Arc::new(move || {
        counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }));
    (tracker, notices)
}

#[test]
fn the_state_follows_the_words_of_the_failure() {
    use crate::status::FailureCode;
    let (tracker, _) = tracker_with_notices(false);
    assert_eq!(tracker.snapshot().state, "unknown");
    for (message, code, state) in [
        ("keychain is not installed", FailureCode::Other, "missing"),
        ("the keyring is locked", FailureCode::Other, "locked"),
        ("operation timed out", FailureCode::Other, "locked"),
        ("something else broke", FailureCode::Other, "error"),
        ("cannot reach the keyring", FailureCode::Unreachable, "unreachable"),
    ] {
        tracker.note_failure(message, code);
        assert_eq!(tracker.snapshot().state, state, "{message}");
    }
    tracker.note_ok();
    assert_eq!(tracker.snapshot().state, "ok");
}

#[test]
fn a_failure_raises_one_notice_unless_it_is_only_the_absence_of_a_keychain() {
    use crate::status::FailureCode;
    let (tracker, notices) = tracker_with_notices(false);
    let count = || notices.load(std::sync::atomic::Ordering::SeqCst);
    tracker.note_failure("something else broke", FailureCode::Other);
    assert_eq!(count(), 1);
    tracker.note_failure("cannot reach the keyring", FailureCode::Unreachable);
    assert_eq!(count(), 1, "an unreachable keyring raises nothing more");
    tracker.note_ok();
    assert_eq!(count(), 1, "a success raises nothing");
}

#[test]
fn only_linux_reports_the_private_file_as_a_fallback_and_only_after_a_failure() {
    use crate::status::FailureCode;
    for (linux, fallback) in [(true, true), (false, false)] {
        let (tracker, _) = tracker_with_notices(linux);
        assert!(!tracker.snapshot().fallback);
        tracker.note_failure("no provider", FailureCode::Unavailable);
        assert_eq!(tracker.snapshot().fallback, fallback, "linux: {linux}");
    }
}

#[test]
fn a_blocking_call_outcome_feeds_the_health_on_linux_only() {
    use crate::status::FailureCode;
    let (linux, _) = tracker_with_notices(true);
    linux.note_sync_outcome(Some(("the keyring is locked", FailureCode::Other)));
    assert_eq!(linux.snapshot().state, "locked");
    linux.note_sync_outcome(None);
    assert_eq!(linux.snapshot().state, "ok");
    let (other, _) = tracker_with_notices(false);
    other.note_sync_outcome(Some(("the keyring is locked", FailureCode::Other)));
    assert_eq!(other.snapshot().state, "unknown");
}