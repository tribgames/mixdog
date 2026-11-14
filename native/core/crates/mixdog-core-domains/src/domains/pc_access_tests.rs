use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::json;
use tokio::sync::Notify;

use super::*;

const KEY_A: &str = "key-a";
const KEY_B: &str = "key-b";
const KEY_C: &str = "key-c";

struct FakeInstaller {
    state: Mutex<HelperState>,
    keyed: Mutex<HashMap<String, HelperState>>,
    result: Mutex<KeyChange>,
    installs: Mutex<Vec<(Vec<String>, Vec<String>)>>,
    enrolls: Mutex<Vec<(Vec<String>, Vec<String>)>>,
    /// When set, an install waits for `release` after saying it `started`.
    hold: bool,
    started: Notify,
    release: Notify,
}

fn change(outcome: KeyOutcome) -> KeyChange {
    KeyChange { outcome, detail: None, exit_code: None }
}

impl FakeInstaller {
    fn build(state: HelperState, outcome: KeyOutcome, hold: bool) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(state),
            keyed: Mutex::new(HashMap::new()),
            result: Mutex::new(change(outcome)),
            installs: Mutex::new(Vec::new()),
            enrolls: Mutex::new(Vec::new()),
            hold,
            started: Notify::new(),
            release: Notify::new(),
        })
    }

    fn new(state: HelperState, outcome: KeyOutcome) -> Arc<Self> {
        Self::build(state, outcome, false)
    }

    fn holding(state: HelperState, outcome: KeyOutcome) -> Arc<Self> {
        Self::build(state, outcome, true)
    }

    fn with_key(self: Arc<Self>, key: &str, state: HelperState) -> Arc<Self> {
        self.keyed.lock().unwrap().insert(key.to_owned(), state);
        self
    }
}

#[async_trait]
impl PcAccessInstaller for FakeInstaller {
    async fn state(&self, key: Option<&str>) -> HelperState {
        match key {
            Some(key) => self.keyed.lock().unwrap().get(key).copied().unwrap_or(*self.state.lock().unwrap()),
            None => *self.state.lock().unwrap(),
        }
    }

    async fn install(&self, keys: &[String], revoke: &[String]) -> KeyChange {
        self.installs.lock().unwrap().push((keys.to_vec(), revoke.to_vec()));
        if self.hold {
            self.started.notify_one();
            self.release.notified().await;
        }
        let result = self.result.lock().unwrap().clone();
        if result.outcome == KeyOutcome::Installed {
            *self.state.lock().unwrap() = HelperState::Installed;
        }
        result
    }

    async fn enroll(&self, keys: &[String], revoke: &[String]) -> KeyChange {
        self.enrolls.lock().unwrap().push((keys.to_vec(), revoke.to_vec()));
        self.result.lock().unwrap().clone()
    }
}

struct FakeRoster {
    keys: Vec<PairedKey>,
    owed: Mutex<Owed>,
    settled: Mutex<Vec<(Vec<String>, u64)>>,
}

fn paired(id: &str, key: &str, unpaired: bool) -> PairedKey {
    PairedKey { client_id: id.to_owned(), public_key: key.to_owned(), unpaired }
}

impl FakeRoster {
    fn new(keys: Vec<PairedKey>, owed: Owed) -> Arc<Self> {
        Arc::new(Self { keys, owed: Mutex::new(owed), settled: Mutex::new(Vec::new()) })
    }
}

#[async_trait]
impl PcAccessRoster for FakeRoster {
    async fn keys(&self) -> Result<Vec<PairedKey>, String> {
        Ok(self.keys.clone())
    }

    async fn owed(&self) -> Result<Owed, String> {
        Ok(self.owed.lock().unwrap().clone())
    }

    async fn settle(&self, keys: Vec<String>, unknown: u64) -> Result<(), String> {
        self.settled.lock().unwrap().push((keys, unknown));
        Ok(())
    }
}

fn strings(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

async fn call(service: &PcAccessService, method: &'static str) -> serde_json::Value {
    value(service, request(method, json!({}), None)).await.unwrap()
}

#[tokio::test]
async fn readiness_reports_owed_from_roster() {
    // A is paired and enrolled, B paired and missing, C unpaired (being removed): never counted. D is owed a revoke.
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(
        vec![paired("a", KEY_A, false), paired("b", KEY_B, false), paired("c", KEY_C, true), paired("d", "key-d", false)],
        Owed { keys: strings(&["key-d"]), unknown: 2 },
    );
    let service = PcAccessService::new(installer.clone(), roster);
    let readiness = call(&service, "pcAccess/readiness").await;
    assert_eq!(
        readiness,
        json!({
            "installed": true,
            "outdated": false,
            "enrolledKeys": 1,
            "missingKeys": [KEY_B],
            "owed": { "keys": ["key-d"], "unknown": 2 },
            "supported": true,
            "otherUser": false,
        })
    );
    assert!(installer.installs.lock().unwrap().is_empty() && installer.enrolls.lock().unwrap().is_empty(), "reading never prompts");

    // Outdated: not installed as far as Approve goes, every paired phone is what it would enroll.
    *installer.state.lock().unwrap() = HelperState::Outdated;
    let outdated = call(&service, "pcAccess/readiness").await;
    assert_eq!((outdated["installed"].clone(), outdated["outdated"].clone(), outdated["enrolledKeys"].clone()), (json!(false), json!(true), json!(0)));
    assert_eq!(outdated["missingKeys"], json!([KEY_A, KEY_B]));

    // Where the helper cannot be asked, or another account owns it: nothing to approve.
    *installer.state.lock().unwrap() = HelperState::Unavailable;
    let unavailable = call(&service, "pcAccess/readiness").await;
    assert_eq!((unavailable["supported"].clone(), unavailable["missingKeys"].clone()), (json!(false), json!([])));
    *installer.state.lock().unwrap() = HelperState::OtherUser;
    let other = call(&service, "pcAccess/readiness").await;
    assert_eq!((other["otherUser"].clone(), other["supported"].clone(), other["missingKeys"].clone()), (json!(true), json!(true), json!([])));
}

#[tokio::test]
async fn approve_joins_running_install() {
    let installer = FakeInstaller::holding(HelperState::NotInstalled, KeyOutcome::Installed);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed { keys: strings(&["key-d"]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    let first = service.approve();
    let second = async {
        installer.started.notified().await;
        // The install is running (its prompt is open): this Approve joins it instead of asking again.
        let (joined, ()) = tokio::join!(service.approve(), async { installer.release.notify_one() });
        joined
    };
    let (first, second) = tokio::join!(first, second);
    let expected = PcAccessApproval { outcome: PcAccessOutcome::Installed, detail: None, exit_code: None };
    assert_eq!((first.unwrap(), second.unwrap()), (expected.clone(), expected));
    // One install: it wrote the paired key and applied the owed revoke; the revoke was settled once.
    assert_eq!(*installer.installs.lock().unwrap(), vec![(strings(&[KEY_A]), strings(&["key-d"]))]);
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&["key-d"]), 0)]);
    // Finished: the next Approve is a new one, and finds nothing left to do.
    let after = call(&service, "pcAccess/approve").await;
    assert_eq!(after, json!({ "outcome": "nothing" }));
}

#[tokio::test]
async fn approve_installs_with_unknown_revocations_and_settles_the_marker() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Updated);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false), paired("c", KEY_C, true)], Owed { keys: Vec::new(), unknown: 7 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": "updated" }));
    // Installed, but revocations may be missing: the full key set is written from the pairings now.
    assert_eq!(*installer.installs.lock().unwrap(), vec![(strings(&[KEY_A]), Vec::new())]);
    assert_eq!(*roster.settled.lock().unwrap(), vec![(Vec::new(), 7)]);
}

#[tokio::test]
async fn approve_enrolls_every_missing_phone_in_one_call() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled).with_key(KEY_C, HelperState::NotEnrolled);
    let roster = FakeRoster::new(
        vec![paired("a", KEY_A, false), paired("b", KEY_B, false), paired("c", KEY_C, false)],
        Owed { keys: strings(&["key-d"]), unknown: 0 },
    );
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": "enrolled" }));
    assert_eq!(*installer.enrolls.lock().unwrap(), vec![(strings(&[KEY_B, KEY_C]), strings(&["key-d"]))]);
    assert!(installer.installs.lock().unwrap().is_empty());
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&["key-d"]), 0)]);
}

#[tokio::test]
async fn a_refused_approve_settles_nothing_and_passes_the_refusal_on() {
    for (outcome, expected) in [
        (KeyOutcome::Declined, json!({ "outcome": "declined" })),
        (KeyOutcome::InProgress, json!({ "outcome": "in-progress" })),
        (KeyOutcome::Other("delegation-denied".into()), json!({ "outcome": "failed", "detail": "delegation-denied" })),
    ] {
        let installer = FakeInstaller::new(HelperState::NotInstalled, outcome);
        let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed { keys: strings(&["key-d"]), unknown: 1 });
        let service = PcAccessService::new(installer, roster.clone());
        assert_eq!(call(&service, "pcAccess/approve").await, expected);
        assert!(roster.settled.lock().unwrap().is_empty(), "an owed revocation is never dropped by a call that did not succeed");
    }
    let failed = KeyChange { outcome: KeyOutcome::Failed, detail: Some("the helper exited with 9".into()), exit_code: Some(9) };
    let installer = FakeInstaller::new(HelperState::NotInstalled, KeyOutcome::Failed);
    *installer.result.lock().unwrap() = failed;
    let service = PcAccessService::new(installer, FakeRoster::new(Vec::new(), Owed::default()));
    assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": "failed", "detail": "the helper exited with 9", "exitCode": 9 }));
}

#[tokio::test]
async fn approve_on_another_account_or_without_support_prompts_nothing() {
    for (state, expected) in [(HelperState::OtherUser, "other-user"), (HelperState::Unavailable, "unavailable")] {
        let installer = FakeInstaller::new(state, KeyOutcome::Installed);
        let service = PcAccessService::new(installer.clone(), FakeRoster::new(vec![paired("a", KEY_A, false)], Owed::default()));
        assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": expected }));
        assert!(installer.installs.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn the_service_claims_exactly_its_two_methods() {
    let service = PcAccessService::new(FakeInstaller::new(HelperState::Installed, KeyOutcome::Installed), FakeRoster::new(Vec::new(), Owed::default()));
    assert_eq!(service.methods(), &["pcAccess/readiness", "pcAccess/approve"]);
    assert!(service.call(request("pcAccess/other", json!({}), None)).await.is_err());
}
