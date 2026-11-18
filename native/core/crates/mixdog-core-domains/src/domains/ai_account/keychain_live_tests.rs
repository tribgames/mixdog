//! `HolderLive` over keyring health, including passive focus checks and explicit unlocks.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_secrets::FailureCode;
use mixdog_secrets::SecretError;
use mixdog_secrets::SecretStore;
use mixdog_secrets::StatusTracker;
use mixdog_secrets::TrackedStore;

use super::keychain_live::HolderLive;
use super::setup_cache::KeychainLive;

/// Answers collection health probes without supplying credential values.
struct Keyring {
    answers: Mutex<Vec<Result<(), SecretError>>>,
    asked: AtomicUsize,
    interactive: Mutex<Vec<bool>>,
}

#[async_trait]
impl SecretStore for Keyring {
    async fn probe_keychain(&self, interactive: bool) -> Result<(), SecretError> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.interactive.lock().unwrap().push(interactive);
        self.answers.lock().unwrap().remove(0)
    }
    async fn get(&self, _: &str) -> Result<Option<String>, SecretError> {
        unreachable!("keyring health does not read credentials")
    }
    async fn set(&self, _: &str, _: &str) -> Result<(), SecretError> {
        unreachable!("the retry only looks up")
    }
    async fn delete(&self, _: &str) -> Result<(), SecretError> {
        unreachable!("the retry only looks up")
    }
}

fn live(linux: bool, answers: Vec<Result<(), SecretError>>) -> (HolderLive, Arc<StatusTracker>, Arc<Keyring>) {
    let tracker = StatusTracker::new(linux, Arc::new(|| {}));
    let keyring = Arc::new(Keyring { answers: Mutex::new(answers), asked: AtomicUsize::new(0), interactive: Mutex::new(Vec::new()) });
    let tracked = Arc::new(TrackedStore::new(keyring.clone(), Arc::clone(&tracker)));
    let tokens = mixdog_rt::testing::tokens();
    let live = HolderLive::new(Arc::clone(&tracker), tracked, tokens.durability_io, std::env::temp_dir());
    (live, tracker, keyring)
}

#[tokio::test]
async fn the_status_shows_the_tracked_health_and_a_prewarm_is_never_pending() {
    let (live, tracker, _) = live(true, vec![]);
    assert_eq!((live.status().state.as_str(), live.status().fallback), ("unknown", false));
    assert!(live.prewarm_ready());
    tracker.note_failure("no secret service", FailureCode::Unavailable);
    let status = live.status();
    assert_eq!((status.state.as_str(), status.fallback), ("error", true), "a confirmed missing provider is the private-file fallback");
}

#[tokio::test]
async fn a_retry_exists_only_on_linux_and_only_when_failing() {
    let (live, tracker, keyring) = live(false, vec![]);
    tracker.note_failure("the keyring is locked", FailureCode::Other);
    assert!(!live.retry(true).await, "no retry off Linux");
    assert_eq!(keyring.asked.load(Ordering::SeqCst), 0);
    let (live, _, keyring) = live_ok();
    assert!(!live.retry(true).await, "nothing to retry while ok");
    assert_eq!(keyring.asked.load(Ordering::SeqCst), 0);
}

fn live_ok() -> (HolderLive, Arc<StatusTracker>, Arc<Keyring>) {
    let (live, tracker, keyring) = live(true, vec![]);
    tracker.note_ok();
    (live, tracker, keyring)
}

#[tokio::test]
async fn a_focus_check_reports_external_lock_and_unlock_without_asking_to_unlock() {
    let (live, tracker, keyring) = live(true, vec![Err(SecretError::new("the keyring is locked")), Ok(())]);
    tracker.note_ok();
    assert!(live.refresh(true).await);
    assert_eq!(live.status().state, "locked");
    assert!(live.refresh(true).await);
    assert_eq!(live.status().state, "ok");
    assert_eq!(*keyring.interactive.lock().unwrap(), vec![false, false]);
}

#[tokio::test]
async fn an_interactive_retry_asks_the_keyring_again_and_reports_whether_it_recovered() {
    let (live, tracker, keyring) = live(true, vec![Err(SecretError::new("the keyring is locked")), Ok(())]);
    tracker.note_failure("the keyring is locked", FailureCode::Other);
    assert!(!live.retry(false).await, "a retry that may not prompt changes nothing");
    assert_eq!(keyring.asked.load(Ordering::SeqCst), 0);
    assert!(!live.retry(true).await, "still locked");
    assert_eq!(live.status().state, "locked");
    assert!(live.retry(true).await, "the collection is unlocked");
    assert_eq!(live.status().state, "ok");
    assert_eq!(*keyring.interactive.lock().unwrap(), vec![true, true]);
}
