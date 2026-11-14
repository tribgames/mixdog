//! The `pcAccess` domain: "PC access" (the secure-desktop service as Computer Use setup on Windows
//! grants it), read and approved through the core (`apps/desktop/src/main/pc-access.ts`, the Approve
//! row). Both methods are Local-only: the person is at the PC, and the one elevation prompt is theirs.
//!
//! - `pcAccess/readiness` reads the install state, which paired phones' keys the service holds or lacks,
//!   and the revocations still owed. It never prompts and changes nothing.
//! - `pcAccess/approve` is one authorized install-or-enroll: an install (or update) when the service is
//!   absent, outdated, or revocations are unknown, writing exactly the keys of the phones paired now; else
//!   one enroll of every paired phone's missing key. The owed revocations are applied in the same call and
//!   settled only once it succeeded. The rule is `pc-access.ts`'s: a revocation is never lost, a pending
//!   one blocks every new enrollment, and only a phone paired now is ever enrolled.
//!
//! What the desktop kept in its own pending-revokes file is the remote roster's owed access here
//! (`mixdog_remote::access::legacy_revokes` folds the old file in once). The installer is reached
//! through [`PcAccessInstaller`], the one instance the phone's screen control also uses, so its single
//! in-flight latch covers both: a request made while an install runs is answered `in-progress` by the
//! installer, and an Approve made while another Approve runs joins it (one prompt, one answer for both).

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use futures::FutureExt;
use futures::future::BoxFuture;
use futures::future::Shared;
use futures::future::join_all;
use mixdog_app_protocol::v2::pc_access::PcAccessApproval;
use mixdog_app_protocol::v2::pc_access::PcAccessApproveParams;
use mixdog_app_protocol::v2::pc_access::PcAccessOutcome;
use mixdog_app_protocol::v2::pc_access::PcAccessOwed;
use mixdog_app_protocol::v2::pc_access::PcAccessReadiness;
use mixdog_app_protocol::v2::pc_access::PcAccessReadinessParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use mixdog_remote::access::runtime::RemoteError;
use mixdog_remote::access::runtime::RemoteRuntime;
use serde_json::Value;

const DOMAIN: &str = "pcAccess";

/// The installed service against the bundled one, from the installer's unelevated check; relative to a
/// phone's key when one is given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelperState {
    Installed,
    Outdated,
    NotInstalled,
    /// Installed and current, but the asked key is not enrolled.
    NotEnrolled,
    /// A service another Windows account installed.
    OtherUser,
    Unavailable,
}

/// How one install or enroll ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyOutcome {
    Installed,
    Updated,
    Enrolled,
    Declined,
    Failed,
    InProgress,
    OtherUser,
    Unavailable,
    /// Any other outcome name the installer has (a revoke, a batch-logon refusal, a delegated refusal): the UAC
    /// path should not produce it, so it reads as failed, naming it in the log-only detail.
    Other(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyChange {
    pub outcome: KeyOutcome,
    pub detail: Option<String>,
    /// The helper's exit code when a `failed` came from it exiting.
    pub exit_code: Option<i32>,
}

/// The installer operations this domain drives: one shared instance (desktop and phone), so its in-flight
/// latch is the one latch. `revoke` lists keys applied in the same elevation.
#[async_trait]
pub trait PcAccessInstaller: Send + Sync {
    /// Unelevated state check, relative to `key` when one is given.
    async fn state(&self, key: Option<&str>) -> HelperState;
    /// Installs (or updates) the helper enrolling `keys` and removing `revoke`, under one UAC prompt.
    async fn install(&self, keys: &[String], revoke: &[String]) -> KeyChange;
    /// Enrolls `keys` into the installed helper and removes `revoke`, under one UAC prompt.
    async fn enroll(&self, keys: &[String], revoke: &[String]) -> KeyChange;
}

/// A phone's delivered key as the roster holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PairedKey {
    pub client_id: String,
    pub public_key: String,
    /// The phone is being unpaired: its key is not enrolled again.
    pub unpaired: bool,
}

/// The revocations owed to the service (the roster's owed access).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Owed {
    pub keys: Vec<String>,
    pub unknown: u64,
}

/// The remote roster, as far as PC access reads and settles it.
#[async_trait]
pub trait PcAccessRoster: Send + Sync {
    async fn keys(&self) -> Result<Vec<PairedKey>, String>;
    async fn owed(&self) -> Result<Owed, String>;
    /// `keys` were revoked; with the `unknown` marker read before an install (and still the current one), the
    /// unknown state is resolved.
    async fn settle(&self, keys: Vec<String>, unknown: u64) -> Result<(), String>;
}

/// The roster of the live remote runtime.
pub struct RuntimeRoster(pub Arc<RemoteRuntime>);

fn message(error: RemoteError) -> String {
    error.to_string()
}

#[async_trait]
impl PcAccessRoster for RuntimeRoster {
    async fn keys(&self) -> Result<Vec<PairedKey>, String> {
        let records = self.0.controller_keys().await.map_err(message)?;
        Ok(records
            .into_iter()
            .map(|record| PairedKey { client_id: record.client_id, public_key: record.public_key, unpaired: record.unpaired })
            .collect())
    }

    async fn owed(&self) -> Result<Owed, String> {
        let owed = self.0.owed_controller_keys().await.map_err(message)?;
        Ok(Owed { keys: owed.keys, unknown: owed.unknown })
    }

    async fn settle(&self, keys: Vec<String>, unknown: u64) -> Result<(), String> {
        self.0.settle_owed(keys, unknown).await.map_err(message)
    }
}

type Approval = Result<PcAccessApproval, String>;

struct Inner {
    installer: Arc<dyn PcAccessInstaller>,
    roster: Arc<dyn PcAccessRoster>,
    /// The Approve running now: a second one joins it (one prompt, one answer).
    running: Mutex<Option<(u64, Shared<BoxFuture<'static, Approval>>)>>,
    runs: AtomicU64,
}

pub struct PcAccessService {
    inner: Arc<Inner>,
}

fn is_installed(state: HelperState) -> bool {
    matches!(state, HelperState::Installed | HelperState::NotEnrolled)
}

/// Keys of the phones paired now: not unpaired, not waiting to be revoked.
fn paired_keys(records: &[PairedKey], revoking: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    for record in records.iter().filter(|record| !record.unpaired) {
        if !revoking.contains(&record.public_key) && !keys.contains(&record.public_key) {
            keys.push(record.public_key.clone());
        }
    }
    keys
}

fn approval(outcome: PcAccessOutcome) -> PcAccessApproval {
    PcAccessApproval { outcome, detail: None, exit_code: None }
}

/// The row's answer for an installer outcome (`approvalOf`): success names what ran; a refusal passes on; anything
/// the UAC path should not produce reads as failed, naming it in the detail.
fn approval_of(change: KeyChange) -> PcAccessApproval {
    let KeyChange { outcome, detail, exit_code } = change;
    let (outcome, detail) = match outcome {
        KeyOutcome::Installed => (PcAccessOutcome::Installed, detail),
        KeyOutcome::Updated => (PcAccessOutcome::Updated, detail),
        KeyOutcome::Enrolled => (PcAccessOutcome::Enrolled, detail),
        KeyOutcome::Declined => (PcAccessOutcome::Declined, detail),
        KeyOutcome::Failed => (PcAccessOutcome::Failed, detail),
        KeyOutcome::InProgress => (PcAccessOutcome::InProgress, detail),
        KeyOutcome::OtherUser => (PcAccessOutcome::OtherUser, detail),
        KeyOutcome::Unavailable => (PcAccessOutcome::Unavailable, detail),
        KeyOutcome::Other(name) => (PcAccessOutcome::Failed, Some(detail.unwrap_or(name))),
    };
    PcAccessApproval { outcome, detail, exit_code }
}

fn succeeded(outcome: PcAccessOutcome) -> bool {
    matches!(outcome, PcAccessOutcome::Installed | PcAccessOutcome::Updated | PcAccessOutcome::Enrolled)
}

/// Paired keys the current install lacks (`not-enrolled`), and how many it holds.
async fn enrollment(installer: &dyn PcAccessInstaller, paired: &[String]) -> (usize, Vec<String>) {
    let states = join_all(paired.iter().map(|key| installer.state(Some(key)))).await;
    let enrolled = states.iter().filter(|state| **state == HelperState::Installed).count();
    let missing = paired.iter().zip(&states).filter(|(_, state)| **state == HelperState::NotEnrolled).map(|(key, _)| key.clone()).collect();
    (enrolled, missing)
}

impl Inner {
    async fn readiness(&self) -> Result<PcAccessReadiness, String> {
        let state = self.installer.state(None).await;
        let owed = self.roster.owed().await?;
        let records = self.roster.keys().await?;
        let paired = paired_keys(&records, &owed.keys);
        let (enrolled, missing) = if is_installed(state) {
            enrollment(self.installer.as_ref(), &paired).await
        } else if matches!(state, HelperState::Unavailable | HelperState::OtherUser) {
            (0, Vec::new())
        } else {
            // Not installed (or outdated): the install enrolls every phone paired now.
            (0, paired)
        };
        Ok(PcAccessReadiness {
            installed: is_installed(state),
            outdated: state == HelperState::Outdated,
            enrolled_keys: u32::try_from(enrolled).unwrap_or(u32::MAX),
            missing_keys: missing,
            owed: PcAccessOwed { keys: owed.keys, unknown: u32::try_from(owed.unknown).unwrap_or(u32::MAX) },
            supported: state != HelperState::Unavailable,
            other_user: state == HelperState::OtherUser,
        })
    }

    /// The one authorized install-or-enroll (`authorizeInstall`, without the phone's password): every owed revoke
    /// (and any an unknown record lost) is applied in the same call, and the owed record is settled only once that
    /// call succeeded.
    async fn authorize(&self) -> Result<PcAccessApproval, String> {
        let state = self.installer.state(None).await;
        match state {
            HelperState::Unavailable => return Ok(approval(PcAccessOutcome::Unavailable)),
            HelperState::OtherUser => return Ok(approval(PcAccessOutcome::OtherUser)),
            _ => {}
        }
        let owed = self.roster.owed().await?;
        let records = self.roster.keys().await?;
        let paired = paired_keys(&records, &owed.keys);
        if !is_installed(state) || owed.unknown != 0 {
            // The install writes exactly these keys: every owed revoke, and any an unknown record lost, is applied.
            let answer = approval_of(self.installer.install(&paired, &owed.keys).await);
            if succeeded(answer.outcome) {
                self.roster.settle(owed.keys, owed.unknown).await?;
            }
            return Ok(answer);
        }
        let (_, missing) = enrollment(self.installer.as_ref(), &paired).await;
        if missing.is_empty() {
            return Ok(approval(PcAccessOutcome::Nothing));
        }
        // One authorized call for every missing phone: the helper applies the revokes and the enrolls in one write.
        let answer = approval_of(self.installer.enroll(&missing, &owed.keys).await);
        if succeeded(answer.outcome) {
            self.roster.settle(owed.keys, 0).await?;
        }
        Ok(answer)
    }
}

impl PcAccessService {
    pub fn new(installer: Arc<dyn PcAccessInstaller>, roster: Arc<dyn PcAccessRoster>) -> Self {
        Self { inner: Arc::new(Inner { installer, roster, running: Mutex::new(None), runs: AtomicU64::new(0) }) }
    }

    /// Runs the Approve, or joins the one running.
    async fn approve(&self) -> Approval {
        let inner = &self.inner;
        let joined = {
            let mut running = inner.running.lock().unwrap_or_else(PoisonError::into_inner);
            match running.as_ref() {
                Some((_, run)) => run.clone(),
                None => {
                    let id = inner.runs.fetch_add(1, Ordering::SeqCst);
                    let owner = inner.clone();
                    let run: BoxFuture<'static, Approval> = async move {
                        let answer = owner.authorize().await;
                        let mut running = owner.running.lock().unwrap_or_else(PoisonError::into_inner);
                        if running.as_ref().is_some_and(|(held, _)| *held == id) {
                            *running = None;
                        }
                        answer
                    }
                    .boxed();
                    let run = run.shared();
                    *running = Some((id, run.clone()));
                    run
                }
            }
        };
        joined.await
    }
}

fn reply<T: serde::Serialize>(answer: &T) -> Result<Reply, CoreError> {
    serde_json::to_value(answer).map(Reply::Value).map_err(|error| failed(DOMAIN, error.to_string()))
}

#[async_trait]
impl DomainService for PcAccessService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "pcAccess/readiness" => {
                let _params: PcAccessReadinessParams = decode(&req)?;
                reply(&self.inner.readiness().await.map_err(|error| failed(DOMAIN, error))?)
            }
            "pcAccess/approve" => {
                let _params: PcAccessApproveParams = decode(&req)?;
                reply(&self.approve().await.map_err(|error| failed(DOMAIN, error))?)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["pcAccess/readiness", "pcAccess/approve"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "pc_access_tests.rs"]
mod tests;
