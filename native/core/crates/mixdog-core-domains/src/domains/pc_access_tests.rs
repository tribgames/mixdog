use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;

use async_trait::async_trait;
use mixdog_core_base::support::testing::request;
use mixdog_core_base::support::testing::value;
use serde_json::json;
use tokio::sync::Notify;

use super::*;

const KEY_A: &str = "key-a";
const KEY_B: &str = "key-b";
const KEY_C: &str = "key-c";
const KEY_D: &str = "key-d";

struct FakeInstaller {
    state: Mutex<HelperState>,
    keyed: Mutex<HashMap<String, HelperState>>,
    result: Mutex<KeyChange>,
    /// What a delegated enroll and a delegated revoke answer.
    delegated_enroll: Mutex<KeyOutcome>,
    delegated_revoke: Mutex<KeyOutcome>,
    installs: Mutex<Vec<(Vec<String>, KeyOptions)>>,
    enrolls: Mutex<Vec<(Vec<String>, KeyOptions)>>,
    delegated_enrolls: Mutex<Vec<Vec<String>>>,
    revokes: Mutex<Vec<String>>,
    /// Every installer call in order, to read the queue's ordering.
    calls: Mutex<Vec<String>>,
    /// When set, an install waits for `release` after saying it `started`.
    hold: bool,
    /// When set, a delegated enroll does the same.
    hold_delegated: AtomicBool,
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
            delegated_enroll: Mutex::new(KeyOutcome::Enrolled),
            delegated_revoke: Mutex::new(KeyOutcome::Revoked),
            installs: Mutex::new(Vec::new()),
            enrolls: Mutex::new(Vec::new()),
            delegated_enrolls: Mutex::new(Vec::new()),
            revokes: Mutex::new(Vec::new()),
            calls: Mutex::new(Vec::new()),
            hold,
            hold_delegated: AtomicBool::new(false),
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

    fn log(&self, call: &str) {
        self.calls.lock().unwrap().push(call.to_owned());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
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

    async fn install(&self, keys: &[String], options: &KeyOptions) -> KeyChange {
        self.log("install");
        self.installs.lock().unwrap().push((keys.to_vec(), options.clone()));
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

    async fn enroll(&self, keys: &[String], options: &KeyOptions) -> KeyChange {
        self.log("enroll");
        self.enrolls.lock().unwrap().push((keys.to_vec(), options.clone()));
        self.result.lock().unwrap().clone()
    }

    async fn enroll_delegated(&self, keys: &[String]) -> KeyChange {
        self.log("enroll-delegated");
        self.delegated_enrolls.lock().unwrap().push(keys.to_vec());
        if self.hold_delegated.load(std::sync::atomic::Ordering::SeqCst) {
            self.started.notify_one();
            self.release.notified().await;
        }
        change(*self.delegated_enroll.lock().unwrap())
    }

    async fn revoke_delegated(&self, key: &str) -> KeyChange {
        self.log("revoke-delegated");
        self.revokes.lock().unwrap().push(key.to_owned());
        change(*self.delegated_revoke.lock().unwrap())
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

    /// As the roster settles: the keys leave the debt, and the unknown marker only when it is still the one read.
    async fn settle(&self, keys: Vec<String>, unknown: u64) -> Result<(), String> {
        self.settled.lock().unwrap().push((keys.clone(), unknown));
        let mut owed = self.owed.lock().unwrap();
        owed.keys.retain(|key| !keys.contains(key));
        if unknown > 0 && owed.unknown == unknown {
            owed.unknown = 0;
        }
        Ok(())
    }
}

fn strings(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

fn revoking(keys: &[&str]) -> KeyOptions {
    KeyOptions { revoke: strings(keys), credential: None }
}

async fn call(service: &PcAccessService, method: &'static str) -> serde_json::Value {
    value(service, request(method, json!({}), None)).await.unwrap()
}

async fn needs_enroll(service: &PcAccessService) -> bool {
    service.inner.readiness().await.unwrap().needs_enroll
}

fn password_request(client: &str, key: &str) -> CredentialRequest {
    CredentialRequest {
        client_id: client.to_owned(),
        public_key: key.to_owned(),
        credential: PcCredential { user: None, password: "pw".to_owned() },
        cancelled: Arc::new(|| false),
    }
}

#[tokio::test]
async fn readiness_reports_owed_from_roster() {
    // A is paired and enrolled, B paired and missing, C unpaired (being removed): never counted. D is owed a revoke.
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(
        vec![paired("a", KEY_A, false), paired("b", KEY_B, false), paired("c", KEY_C, true), paired("d", KEY_D, false)],
        Owed { keys: strings(&[KEY_D]), unknown: 2 },
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
            "owed": { "keys": [KEY_D], "unknown": 2 },
            "supported": true,
            "otherUser": false,
            "needsEnroll": false,
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
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed { keys: strings(&[KEY_D]), unknown: 0 });
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
    assert_eq!(*installer.installs.lock().unwrap(), vec![(strings(&[KEY_A]), revoking(&[KEY_D]))]);
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&[KEY_D]), 0)]);
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
    assert_eq!(*installer.installs.lock().unwrap(), vec![(strings(&[KEY_A]), KeyOptions::default())]);
    assert_eq!(*roster.settled.lock().unwrap(), vec![(Vec::new(), 7)]);
}

#[tokio::test]
async fn approve_enrolls_every_missing_phone_in_one_call() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled).with_key(KEY_C, HelperState::NotEnrolled);
    let roster = FakeRoster::new(
        vec![paired("a", KEY_A, false), paired("b", KEY_B, false), paired("c", KEY_C, false)],
        Owed { keys: strings(&[KEY_D]), unknown: 0 },
    );
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": "enrolled" }));
    assert_eq!(*installer.enrolls.lock().unwrap(), vec![(strings(&[KEY_B, KEY_C]), revoking(&[KEY_D]))]);
    assert!(installer.installs.lock().unwrap().is_empty());
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&[KEY_D]), 0)]);
}

#[tokio::test]
async fn a_refused_approve_settles_nothing_and_passes_the_refusal_on() {
    for (outcome, expected) in [
        (KeyOutcome::Declined, json!({ "outcome": "declined" })),
        (KeyOutcome::InProgress, json!({ "outcome": "in-progress" })),
        (KeyOutcome::DelegationDenied, json!({ "outcome": "failed", "detail": "delegation-denied" })),
    ] {
        let installer = FakeInstaller::new(HelperState::NotInstalled, outcome);
        let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed { keys: strings(&[KEY_D]), unknown: 1 });
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

#[tokio::test]
async fn a_delivered_key_is_enrolled_through_delegation_only_when_a_current_install_lacks_it() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false), paired("b", KEY_B, false), paired("c", KEY_C, true)], Owed::default());
    let service = PcAccessService::new(installer.clone(), roster);
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Enrolled));
    assert_eq!(*installer.delegated_enrolls.lock().unwrap(), vec![strings(&[KEY_B])]);
    // Already enrolled, unpaired, unknown to the roster: nothing is asked of the installer.
    for key in [KEY_A, KEY_C, "stranger"] {
        assert_eq!(service.delivered(key).await, Ok(Delivery::Nothing), "{key}");
    }
    assert_eq!(installer.delegated_enrolls.lock().unwrap().len(), 1);
    // No install to enroll into: nothing before setup.
    *installer.state.lock().unwrap() = HelperState::NotInstalled;
    installer.keyed.lock().unwrap().clear();
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Nothing));
    assert_eq!(installer.delegated_enrolls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_pending_revocation_blocks_a_delivery_and_is_revoked_first() {
    // The delivered key itself is owed a revoke: never enrolled.
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_B]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster);
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Nothing));

    // Unknown revocations need an elevated install: nothing is enrolled.
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: Vec::new(), unknown: 3 });
    let service = PcAccessService::new(installer.clone(), roster);
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Blocked));
    assert!(installer.delegated_enrolls.lock().unwrap().is_empty());

    // A key owed a revoke is revoked through delegation and settled one by one before the enroll.
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_D, KEY_C]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Enrolled));
    assert_eq!(installer.calls(), ["revoke-delegated", "revoke-delegated", "enroll-delegated"]);
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&[KEY_D]), 0), (strings(&[KEY_C]), 0)]);

    // A refused revoke stops everything after it: the key is not enrolled and the debt stays.
    *installer.delegated_revoke.lock().unwrap() = KeyOutcome::ServiceUnreachable;
    installer.calls.lock().unwrap().clear();
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_D, KEY_C]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Blocked));
    assert_eq!(installer.calls(), ["revoke-delegated"]);
    assert!(roster.settled.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_delegation_refusal_only_elevation_fixes_makes_the_row_offer_approve_for_the_new_phone() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed::default());
    let service = PcAccessService::new(installer.clone(), roster);
    assert!(!needs_enroll(&service).await);
    // Delegation off: the row offers Approve for the new phone.
    *installer.delegated_enroll.lock().unwrap() = KeyOutcome::DelegationDisabled;
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::DelegationDisabled));
    assert!(needs_enroll(&service).await);
    // A transient refusal clears it (the phone's next delivery tries again), and so does a success.
    *installer.delegated_enroll.lock().unwrap() = KeyOutcome::DelegationDenied;
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Failed));
    assert!(needs_enroll(&service).await);
    *installer.delegated_enroll.lock().unwrap() = KeyOutcome::ServiceUnreachable;
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Failed));
    assert!(!needs_enroll(&service).await);

    // While a delegated enroll of that key runs, the row waits for it.
    *installer.delegated_enroll.lock().unwrap() = KeyOutcome::DelegationDenied;
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Failed));
    assert!(needs_enroll(&service).await);
    installer.hold_delegated.store(true, std::sync::atomic::Ordering::SeqCst);
    let delivery = service.delivered(KEY_B);
    let readiness = async {
        installer.started.notified().await;
        let during = needs_enroll(&service).await;
        installer.release.notify_one();
        during
    };
    let (delivery, during) = tokio::join!(delivery, readiness);
    assert_eq!(delivery, Ok(Delivery::Failed));
    assert!(!during, "not while its delegated enroll runs");
    assert!(needs_enroll(&service).await);

    // An Approve that enrolled the phone clears it.
    installer.hold_delegated.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(call(&service, "pcAccess/approve").await, json!({ "outcome": "enrolled" }));
    assert!(!needs_enroll(&service).await);
}

#[tokio::test]
async fn the_password_path_decides_like_approve_and_answers_about_its_own_key() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false), paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    let answer = service.approve_with_credential(password_request("b", KEY_B)).await.unwrap();
    assert_eq!(answer, CredentialAnswer { outcome: CredentialOutcome::Ran(KeyOutcome::Enrolled), state: HelperState::NotEnrolled, detail: None });
    // One enroll of the missing phone with the revoke and the password; settled.
    let enrolls = installer.enrolls.lock().unwrap().clone();
    assert_eq!(enrolls.len(), 1);
    assert_eq!(enrolls[0].0, strings(&[KEY_B]));
    assert_eq!(enrolls[0].1, KeyOptions { revoke: strings(&[KEY_D]), credential: Some(PcCredential { user: None, password: "pw".into() }) });
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&[KEY_D]), 0)]);
    // With nothing missing it is an enrolled answer, not a refusal.
    installer.keyed.lock().unwrap().clear();
    let nothing = service.approve_with_credential(password_request("b", KEY_B)).await.unwrap();
    assert_eq!(nothing.outcome, CredentialOutcome::Ran(KeyOutcome::Enrolled));
    assert_eq!(installer.enrolls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn the_password_path_installs_with_the_password_and_passes_the_logon_refusals_on() {
    let installer = FakeInstaller::new(HelperState::NotInstalled, KeyOutcome::BadCredentials);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    let answer = service.approve_with_credential(password_request("a", KEY_A)).await.unwrap();
    assert_eq!(answer.outcome, CredentialOutcome::Ran(KeyOutcome::BadCredentials));
    assert_eq!(installer.installs.lock().unwrap()[0].1.credential, Some(PcCredential { user: None, password: "pw".into() }));
    assert!(roster.settled.lock().unwrap().is_empty(), "a refused logon settles nothing");
}

#[tokio::test]
async fn the_password_path_refuses_a_phone_that_is_not_paired_under_that_key() {
    let installer = FakeInstaller::new(HelperState::NotInstalled, KeyOutcome::Installed);
    let roster = FakeRoster::new(
        vec![paired("a", KEY_A, false), paired("c", KEY_C, true), paired("d", KEY_D, false)],
        Owed { keys: strings(&[KEY_D]), unknown: 0 },
    );
    let service = PcAccessService::new(installer.clone(), roster);
    for (client, key) in [("a", KEY_B), ("zzz", KEY_A), ("c", KEY_C), ("d", KEY_D)] {
        let answer = service.approve_with_credential(password_request(client, key)).await.unwrap();
        assert_eq!(answer.outcome, CredentialOutcome::Ran(KeyOutcome::Failed), "{client}");
        assert_eq!(answer.detail.as_deref(), Some(NOT_PAIRED));
    }
    assert!(installer.installs.lock().unwrap().is_empty() && installer.enrolls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_password_request_whose_session_ended_in_the_queue_runs_nothing() {
    let installer = FakeInstaller::new(HelperState::NotInstalled, KeyOutcome::Installed);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false)], Owed::default());
    let service = PcAccessService::new(installer.clone(), roster);
    let mut request = password_request("a", KEY_A);
    request.cancelled = Arc::new(|| true);
    let answer = service.approve_with_credential(request).await.unwrap();
    assert_eq!(answer.outcome, CredentialOutcome::Ran(KeyOutcome::Failed));
    assert_eq!(answer.detail.as_deref(), Some(CANCELLED));
    assert!(installer.calls().is_empty());
}

#[tokio::test]
async fn one_password_request_runs_at_a_time_and_another_is_answered_busy() {
    let installer = FakeInstaller::holding(HelperState::NotInstalled, KeyOutcome::Installed);
    let roster = FakeRoster::new(vec![paired("a", KEY_A, false), paired("b", KEY_B, false)], Owed::default());
    let service = PcAccessService::new(installer.clone(), roster);
    let first = service.approve_with_credential(password_request("a", KEY_A));
    let second = async {
        installer.started.notified().await;
        let busy = service.approve_with_credential(password_request("b", KEY_B)).await;
        installer.release.notify_one();
        busy
    };
    let (first, busy) = tokio::join!(first, second);
    assert_eq!(first.unwrap().outcome, CredentialOutcome::Ran(KeyOutcome::Installed));
    let busy = busy.unwrap();
    assert_eq!((busy.outcome, busy.detail.as_deref()), (CredentialOutcome::Busy, Some(CREDENTIAL_BUSY)));
    assert_eq!(installer.installs.lock().unwrap().len(), 1, "the busy one ran nothing");
    // Free again afterwards (the install is in place: there is nothing left to enroll).
    assert_eq!(service.approve_with_credential(password_request("b", KEY_B)).await.unwrap().outcome, CredentialOutcome::Ran(KeyOutcome::Enrolled));
}

#[tokio::test]
async fn revoke_owed_drains_every_pending_key_unless_nothing_can_run() {
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled);
    let roster = FakeRoster::new(Vec::new(), Owed { keys: strings(&[KEY_D, KEY_C]), unknown: 4 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    assert_eq!(service.revoke_owed().await, Ok(RevokeOwed::Revoked));
    assert_eq!(*installer.revokes.lock().unwrap(), strings(&[KEY_D, KEY_C]));
    assert_eq!(*roster.settled.lock().unwrap(), vec![(strings(&[KEY_D]), 0), (strings(&[KEY_C]), 0)]);
    // Nothing left owed: nothing is asked.
    assert_eq!(service.revoke_owed().await, Ok(RevokeOwed::Revoked));
    assert_eq!(installer.revokes.lock().unwrap().len(), 2);

    // Without an install, or on another account's, the debt waits for the next install or enroll.
    for state in [HelperState::NotInstalled, HelperState::OtherUser, HelperState::Unavailable] {
        let installer = FakeInstaller::new(state, KeyOutcome::Enrolled);
        let roster = FakeRoster::new(Vec::new(), Owed { keys: strings(&[KEY_D]), unknown: 0 });
        let service = PcAccessService::new(installer.clone(), roster.clone());
        assert_eq!(service.revoke_owed().await, Ok(RevokeOwed::Pending));
        assert!(installer.revokes.lock().unwrap().is_empty() && roster.settled.lock().unwrap().is_empty());
    }

    // A refused revoke stays pending, and what was confirmed before it is settled.
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled);
    *installer.delegated_revoke.lock().unwrap() = KeyOutcome::DelegationDenied;
    let roster = FakeRoster::new(Vec::new(), Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer, roster.clone());
    assert_eq!(service.revoke_owed().await, Ok(RevokeOwed::Pending));
    assert!(roster.settled.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_unpair_returns_its_answer_then_tries_the_revoke_before_any_delivery_runs() {
    mixdog_rt::testing::tokens();
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    // The roster owes the removed phone's key (it did so with the removal); B just delivered.
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    let answer = service.unpair(async { Ok::<_, String>("descriptor") }).await;
    assert_eq!(answer, Ok("descriptor"));
    // A delivery queued right behind runs after the revoke, whichever is polled first.
    assert_eq!(service.delivered(KEY_B).await, Ok(Delivery::Enrolled));
    assert_eq!(installer.calls(), ["revoke-delegated", "enroll-delegated"]);
    assert!(roster.owed.lock().unwrap().keys.is_empty());
}

#[tokio::test]
async fn a_failed_unpair_tries_no_revoke_and_keeps_the_debt() {
    mixdog_rt::testing::tokens();
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled);
    let roster = FakeRoster::new(Vec::new(), Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster.clone());
    let answer = service.unpair(async { Err::<(), _>("the relay refused".to_string()) }).await;
    assert_eq!(answer, Err("the relay refused".to_string()));
    // The queue is free again and the debt is the roster's, untouched.
    assert_eq!(service.revoke_owed().await, Ok(RevokeOwed::Revoked));
    assert_eq!(installer.calls(), ["revoke-delegated"]);
}

#[tokio::test]
async fn the_runtime_events_enroll_a_delivered_key_and_revoke_what_is_owed() {
    mixdog_rt::testing::tokens();
    let installer = FakeInstaller::new(HelperState::Installed, KeyOutcome::Enrolled).with_key(KEY_B, HelperState::NotEnrolled);
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed { keys: strings(&[KEY_D]), unknown: 0 });
    let service = PcAccessService::new(installer.clone(), roster);
    service.owed_changed();
    service.key_delivered(KEY_B);
    for _ in 0..1000 {
        if installer.calls().len() >= 2 {
            break;
        }
        tokio::task::yield_now().await;
    }
    // Queued in the order they came: the revoke first, then the enroll.
    assert_eq!(installer.calls(), ["revoke-delegated", "enroll-delegated"]);
}

#[tokio::test]
async fn nothing_overlaps_in_the_access_queue() {
    // An install holds the queue (its prompt is open): a delivery waits for it, and then finds the key enrolled.
    let installer = FakeInstaller::holding(HelperState::NotInstalled, KeyOutcome::Installed);
    let roster = FakeRoster::new(vec![paired("b", KEY_B, false)], Owed::default());
    let service = PcAccessService::new(installer.clone(), roster);
    let approve = service.approve();
    let delivery = async {
        installer.started.notified().await;
        let delivery = service.delivered(KEY_B);
        tokio::pin!(delivery);
        // Still queued while the install runs.
        assert!(futures::poll!(&mut delivery).is_pending());
        assert!(installer.delegated_enrolls.lock().unwrap().is_empty());
        installer.release.notify_one();
        delivery.await
    };
    let (approved, delivery) = tokio::join!(approve, delivery);
    assert_eq!(approved.unwrap().outcome, PcAccessOutcome::Installed);
    // The install enrolled it: the delivery finds nothing to do.
    assert_eq!(delivery, Ok(Delivery::Nothing));
    assert!(installer.delegated_enrolls.lock().unwrap().is_empty());
}
