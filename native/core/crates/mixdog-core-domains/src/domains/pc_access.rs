//! The `pcAccess` domain: "PC access" (the secure-desktop service as Computer Use setup on Windows
//! grants it), read and approved through the core. It is `apps/desktop/src/main/pc-access.ts` in the core: each
//! moment maps onto one installer operation.
//!
//! - `pcAccess/readiness` reads the install state, which paired phones' keys the service holds or lacks,
//!   whether a phone's delegated enroll was refused in a way only elevation fixes (`needsEnroll`), and the
//!   revocations still owed. It never prompts and changes nothing.
//! - `pcAccess/approve` (the person is at the PC) is one authorized install-or-enroll: an install (or update)
//!   when the service is absent, outdated, or revocations are unknown, writing exactly the keys of the phones
//!   paired now; else one enroll of every paired phone's missing key. The owed revocations are applied in the
//!   same call and settled only once it succeeded. Both methods are Local-only.
//! - [`PcAccessService::approve_with_credential`] is Approve's twin for when nobody is at the PC: the same
//!   decisions authorized by the Windows password the phone typed (a batch logon, no UAC prompt).
//! - [`PcAccessService::delivered`] (a paired phone delivered its key) is a delegated enroll, unelevated and
//!   with no PC prompt; [`PcAccessService::unpair`] wraps a pairing removal so the revoke is tried before any
//!   delivery runs; [`PcAccessService::revoke_owed`] drains every pending revoke through delegation. The remote
//!   runtime's events reach them through [`PcAccessEvents`].
//!
//! The rule is `pc-access.ts`'s: a revocation is never lost, a pending one blocks every new enrollment, and only
//! a phone paired now is ever enrolled. What the desktop kept in its own pending-revokes file is the remote
//! roster's owed access here (`mixdog_remote::access::legacy_revokes` folds the old file in once), and the
//! roster owes a removed phone's key in the same write as the removal, so the record the desktop made before an
//! unpair (and its refusal when that failed) is the removal itself. The installer is reached through
//! [`PcAccessInstaller`], the one instance the phone's screen control also uses, so its single in-flight latch
//! covers both. Approve, the password path, a delivery, an unpair and a revoke run one at a time in one queue; an
//! Approve made while another Approve runs joins it (one prompt, one answer for both).

use std::collections::HashMap;
use std::collections::HashSet;
use std::future::Future;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::sync::atomic::AtomicBool;
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

/// Why a request that waited in the queue ran nothing.
const CANCELLED: &str = "the phone\u{2019}s session ended before the request ran";
/// Why a password request was answered without running.
const CREDENTIAL_BUSY: &str = "another phone password request is already running on the PC";
const NOT_PAIRED: &str = "this phone is not paired on this PC under that access key";

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

/// How one install, enroll or revoke ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyOutcome {
    Installed,
    Updated,
    Enrolled,
    Declined,
    Failed,
    InProgress,
    OtherUser,
    Unavailable,
    Revoked,
    /// The batch-logon path refused the phone's password or account.
    BadCredentials,
    NotAdmin,
    LogonTypeDenied,
    AccountLocked,
    AccountDisabled,
    PolicyBlocked,
    /// The app-delegated path (no prompt) was refused: delegation is off, the service refused this app, or it
    /// could not be reached.
    DelegationDisabled,
    DelegationDenied,
    ServiceUnreachable,
}

impl KeyOutcome {
    /// The installer's name for the outcome (the log-only detail of one the UAC path does not produce).
    pub fn name(self) -> &'static str {
        match self {
            Self::Installed => "installed",
            Self::Updated => "updated",
            Self::Enrolled => "enrolled",
            Self::Declined => "declined",
            Self::Failed => "failed",
            Self::InProgress => "in-progress",
            Self::OtherUser => "other-user",
            Self::Unavailable => "unavailable",
            Self::Revoked => "revoked",
            Self::BadCredentials => "bad-credentials",
            Self::NotAdmin => "not-admin",
            Self::LogonTypeDenied => "logon-type-denied",
            Self::AccountLocked => "account-locked",
            Self::AccountDisabled => "account-disabled",
            Self::PolicyBlocked => "policy-blocked",
            Self::DelegationDisabled => "delegation-disabled",
            Self::DelegationDenied => "delegation-denied",
            Self::ServiceUnreachable => "service-unreachable",
        }
    }

    /// An install, update or enroll that went through (what settles owed revocations).
    pub fn approved(self) -> bool {
        matches!(self, Self::Installed | Self::Updated | Self::Enrolled)
    }

    /// Why a delegated step did not run, beside its name in the log.
    fn delegated_reason(self) -> Option<&'static str> {
        match self {
            Self::DelegationDisabled => Some("delegation is turned off"),
            Self::DelegationDenied => Some("the service refused this app"),
            Self::ServiceUnreachable => Some("the service could not be reached"),
            _ => None,
        }
    }

    /// Delegated refusals only an elevated Approve fixes (not a transient one).
    fn needs_elevation(self) -> bool {
        matches!(self, Self::DelegationDisabled | Self::DelegationDenied)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeyChange {
    pub outcome: KeyOutcome,
    pub detail: Option<String>,
    /// The helper's exit code when a `failed` came from it exiting.
    pub exit_code: Option<i32>,
}

/// The PC account's Windows password a phone typed (`user` is empty for the account running the app).
#[derive(Clone, PartialEq, Eq)]
pub struct PcCredential {
    pub user: Option<String>,
    pub password: String,
}

impl std::fmt::Debug for PcCredential {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PcCredential(..)")
    }
}

/// What an authorized install or enroll applies besides its keys.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeyOptions {
    /// Keys to also revoke in the same authorization (the owed revocations).
    pub revoke: Vec<String>,
    /// The batch logon from a phone's password, in place of the UAC prompt.
    pub credential: Option<PcCredential>,
}

/// The installer operations this domain drives: one shared instance (desktop and phone), so its in-flight
/// latch is the one latch. Install and enroll are authorized by a UAC prompt, or by `options.credential`; the
/// delegated pair runs unelevated with no prompt.
#[async_trait]
pub trait PcAccessInstaller: Send + Sync {
    /// Unelevated state check, relative to `key` when one is given.
    async fn state(&self, key: Option<&str>) -> HelperState;
    /// Installs (or updates) the helper enrolling `keys` and removing `options.revoke`.
    async fn install(&self, keys: &[String], options: &KeyOptions) -> KeyChange;
    /// Enrolls `keys` into the installed helper and removes `options.revoke`.
    async fn enroll(&self, keys: &[String], options: &KeyOptions) -> KeyChange;
    /// Enrolls `keys` through the app's delegation: no prompt, no credential.
    async fn enroll_delegated(&self, keys: &[String]) -> KeyChange;
    /// Revokes one key through the app's delegation: no prompt, no credential.
    async fn revoke_delegated(&self, key: &str) -> KeyChange;
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

/// What the remote runtime's events call: a paired phone delivered its key (every connection delivers again), and
/// a pairing removal owed access revocations. Both return at once; the work runs in the access queue.
pub trait PcAccessEvents: Send + Sync {
    fn key_delivered(&self, public_key: &str);
    fn owed_changed(&self);
}

type Approval = Result<PcAccessApproval, String>;

/// How a delivered key's delegated enroll ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    Enrolled,
    /// Not paired now, owed a revoke, or already enrolled; or no install to enroll into.
    Nothing,
    /// A pending revocation blocks every new enrollment (unknown ones need an install).
    Blocked,
    /// Delegation is off: the readiness row offers Approve for the new phone.
    DelegationDisabled,
    Failed,
}

/// How the pending revokes ended when tried through delegation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevokeOwed {
    Revoked,
    Pending,
}

/// A phone's password request.
pub struct CredentialRequest {
    pub client_id: String,
    pub public_key: String,
    pub credential: PcCredential,
    /// True once the phone's session ended: a request still queued (not yet with the installer) then runs
    /// nothing; one already dispatched finishes.
    pub cancelled: Arc<dyn Fn() -> bool + Send + Sync>,
}

/// What a password request ends with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialOutcome {
    /// Another phone's password request was running and nothing was run (the phone may simply ask again; not an
    /// answer about its own request).
    Busy,
    Ran(KeyOutcome),
}

/// The answer to a password request: the outcome, and the install state relative to the phone's key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CredentialAnswer {
    pub outcome: CredentialOutcome,
    pub state: HelperState,
    pub detail: Option<String>,
}

/// What the one authorized call came to.
enum Authorized {
    Ran(KeyChange),
    NothingToDo,
}

struct Phone<'a> {
    client_id: &'a str,
    public_key: &'a str,
}

struct Inner {
    installer: Arc<dyn PcAccessInstaller>,
    roster: Arc<dyn PcAccessRoster>,
    /// One step at a time (a fair queue): an Approve, a password request, a delivery, an unpair and a revoke
    /// never overlap.
    queue: Arc<tokio::sync::Mutex<()>>,
    /// The Approve running now: a second one joins it (one prompt, one answer).
    running: Mutex<Option<(u64, Shared<BoxFuture<'static, Approval>>)>>,
    runs: AtomicU64,
    /// Missing keys whose last delegated attempt was refused in a way only elevation fixes: what the readiness
    /// row's Approve for a new phone is for.
    needs_elevation: Mutex<HashSet<String>>,
    /// Keys with a delegated enroll queued or running (the row waits for it).
    in_flight: Mutex<HashMap<String, u32>>,
    /// A phone's password request is queued or running.
    credential_busy: AtomicBool,
}

pub struct PcAccessService {
    inner: Arc<Inner>,
}

fn held<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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
        other => (PcAccessOutcome::Failed, Some(detail.unwrap_or_else(|| other.name().to_owned()))),
    };
    PcAccessApproval { outcome, detail, exit_code }
}

fn log_failure(what: &str, change: &KeyChange) {
    let reason = change.outcome.delegated_reason().map(|reason| format!(" - {reason}")).unwrap_or_default();
    let detail = change.detail.as_ref().map(|detail| format!(" ({detail})")).unwrap_or_default();
    tracing::error!("[mixdog-pc-access] {what}: {}{reason}{detail}", change.outcome.name());
}

fn failure(outcome: KeyOutcome, detail: &str) -> KeyChange {
    KeyChange { outcome, detail: Some(detail.to_owned()), exit_code: None }
}

fn plain(outcome: KeyOutcome) -> KeyChange {
    KeyChange { outcome, detail: None, exit_code: None }
}

/// How many paired keys the current install holds, and which it lacks (`not-enrolled`).
async fn enrollment(installer: &dyn PcAccessInstaller, paired: &[String]) -> (usize, Vec<String>) {
    let states = join_all(paired.iter().map(|key| installer.state(Some(key)))).await;
    let enrolled = states.iter().filter(|state| **state == HelperState::Installed).count();
    let missing = paired.iter().zip(&states).filter(|(_, state)| **state == HelperState::NotEnrolled).map(|(key, _)| key.clone()).collect();
    (enrolled, missing)
}

/// Counts a delivery as in flight until dropped (the readiness row waits for it).
struct InFlight<'a> {
    inner: &'a Inner,
    key: String,
}

impl<'a> InFlight<'a> {
    fn new(inner: &'a Inner, key: &str) -> Self {
        *held(&inner.in_flight).entry(key.to_owned()).or_insert(0) += 1;
        Self { inner, key: key.to_owned() }
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut flights = held(&self.inner.in_flight);
        if let Some(count) = flights.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                flights.remove(&self.key);
            }
        }
    }
}

/// Frees the password-request latch when the request ends, however it ends.
struct CredentialLatch<'a>(&'a AtomicBool);

impl Drop for CredentialLatch<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Inner {
    /// Runs `work` as the one step of the access queue.
    async fn serial<T>(&self, work: impl Future<Output = T>) -> T {
        let _step = self.queue.lock().await;
        work.await
    }

    /// Keys of the phones paired now (`revoking` excluded).
    async fn paired_now(&self, revoking: &[String]) -> Result<Vec<String>, String> {
        Ok(paired_keys(&self.roster.keys().await?, revoking))
    }

    /// Paired keys the current install lacks (`not-enrolled`, check exit 7).
    async fn missing_keys(&self, revoking: &[String]) -> Result<Vec<String>, String> {
        let paired = self.paired_now(revoking).await?;
        Ok(enrollment(self.installer.as_ref(), &paired).await.1)
    }

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
        // Only a refusal elevation fixes: not while a delegated enroll runs, nor for a transient one (the phone's
        // next delivery tries again). Unknown revocations come first: an install resolves them.
        let needs_enroll = is_installed(state) && owed.unknown == 0 && {
            let elevation = held(&self.needs_elevation);
            let flights = held(&self.in_flight);
            missing.iter().any(|key| elevation.contains(key) && !flights.contains_key(key))
        };
        Ok(PcAccessReadiness {
            installed: is_installed(state),
            outdated: state == HelperState::Outdated,
            enrolled_keys: u32::try_from(enrolled).unwrap_or(u32::MAX),
            missing_keys: missing,
            owed: PcAccessOwed { keys: owed.keys, unknown: u32::try_from(owed.unknown).unwrap_or(u32::MAX) },
            supported: state != HelperState::Unavailable,
            other_user: state == HelperState::OtherUser,
            needs_enroll,
        })
    }

    /// Every pending revoke through delegation: the first refusal (after which nothing may be enrolled), or `None`
    /// once all of them are confirmed and settled.
    async fn drain_delegated(&self, keys: &[String]) -> Result<Option<KeyChange>, String> {
        for key in keys {
            let result = self.installer.revoke_delegated(key).await;
            if result.outcome != KeyOutcome::Revoked {
                log_failure("delegated pending revoke", &result);
                return Ok(Some(result));
            }
            self.roster.settle(vec![key.clone()], 0).await?;
        }
        Ok(None)
    }

    /// Every pending revoke, now, through delegation.
    async fn revoke_owed_now(&self) -> Result<RevokeOwed, String> {
        let owed = self.roster.owed().await?;
        if owed.keys.is_empty() {
            return Ok(RevokeOwed::Revoked);
        }
        // Nothing can run now: the record waits for the next install or enroll.
        if matches!(self.installer.state(None).await, HelperState::NotInstalled | HelperState::Unavailable | HelperState::OtherUser) {
            return Ok(RevokeOwed::Pending);
        }
        Ok(if self.drain_delegated(&owed.keys).await?.is_some() { RevokeOwed::Pending } else { RevokeOwed::Revoked })
    }

    /// The one authorized install-or-enroll, for Approve (UAC, no `credential`) and for a phone's Windows password
    /// (`credential`, with the `phone` that sent it): the same state decisions and the same revocation rules, so the
    /// credential path bypasses none of them. Every owed revoke (and any an unknown record lost) is applied in the
    /// same call, and the owed record is settled only once that call succeeded. Runs inside the access queue.
    async fn authorize(
        &self,
        credential: Option<&PcCredential>,
        phone: Option<Phone<'_>>,
        cancelled: &(dyn Fn() -> bool + Send + Sync),
    ) -> Result<Authorized, String> {
        let state = self.installer.state(None).await;
        match state {
            HelperState::Unavailable => return Ok(Authorized::Ran(plain(KeyOutcome::Unavailable))),
            HelperState::OtherUser => return Ok(Authorized::Ran(plain(KeyOutcome::OtherUser))),
            _ => {}
        }
        // The request's session ended while it waited in the queue: nothing runs.
        let aborted = || Authorized::Ran(failure(KeyOutcome::Failed, CANCELLED));
        if cancelled() {
            return Ok(aborted());
        }
        let owed = self.roster.owed().await?;
        // Only the phone this connection is, still paired, under the key it delivered.
        if let Some(phone) = &phone {
            let records = self.roster.keys().await?;
            let paired = records
                .iter()
                .any(|record| record.client_id == phone.client_id && record.public_key == phone.public_key && !record.unpaired);
            if owed.keys.iter().any(|key| key == phone.public_key) || !paired {
                return Ok(Authorized::Ran(failure(KeyOutcome::Failed, NOT_PAIRED)));
            }
        }
        let options = KeyOptions { revoke: owed.keys.clone(), credential: credential.cloned() };
        if !is_installed(state) || owed.unknown != 0 {
            // The install writes exactly these keys: every owed revoke, and any an unknown record lost, is applied.
            let keys = self.paired_now(&owed.keys).await?;
            if cancelled() {
                return Ok(aborted());
            }
            let result = self.installer.install(&keys, &options).await;
            if result.outcome.approved() {
                self.roster.settle(owed.keys, owed.unknown).await?;
                held(&self.needs_elevation).clear();
            }
            return Ok(Authorized::Ran(result));
        }
        let missing = self.missing_keys(&owed.keys).await?;
        if missing.is_empty() {
            return Ok(Authorized::NothingToDo);
        }
        if cancelled() {
            return Ok(aborted());
        }
        // One authorized call for every missing phone: the helper applies the revokes and the enrolls in one write.
        let result = self.installer.enroll(&missing, &options).await;
        if result.outcome.approved() {
            self.roster.settle(owed.keys, 0).await?;
            let mut elevation = held(&self.needs_elevation);
            for key in &missing {
                elevation.remove(key);
            }
        }
        Ok(Authorized::Ran(result))
    }

    /// The readiness row's Approve, inside the queue.
    async fn approve_once(&self) -> Approval {
        match self.authorize(None, None, &|| false).await? {
            Authorized::NothingToDo => Ok(approval(PcAccessOutcome::Nothing)),
            Authorized::Ran(change) => Ok(approval_of(change)),
        }
    }

    /// A delegated enroll of a delivered key, inside the queue.
    async fn deliver(&self, public_key: &str) -> Result<Delivery, String> {
        let owed = self.roster.owed().await?;
        if owed.keys.iter().any(|key| key == public_key) {
            return Ok(Delivery::Nothing);
        }
        // Only a phone paired now: a removed (or being removed) pairing never enrolls again.
        if !self.paired_now(&owed.keys).await?.iter().any(|key| key == public_key) {
            return Ok(Delivery::Nothing);
        }
        // Only a current install lacking this key: nothing before setup, nothing once enrolled.
        if self.installer.state(Some(public_key)).await != HelperState::NotEnrolled {
            return Ok(Delivery::Nothing);
        }
        // A pending revocation blocks every new enrollment; unknown ones need an install.
        if owed.unknown != 0 {
            return Ok(Delivery::Blocked);
        }
        let blocker = self.drain_delegated(&owed.keys).await?;
        let blocked = blocker.is_some();
        let result = match blocker {
            Some(refused) => refused,
            None => self.installer.enroll_delegated(&[public_key.to_owned()]).await,
        };
        {
            let mut elevation = held(&self.needs_elevation);
            if result.outcome.needs_elevation() {
                elevation.insert(public_key.to_owned());
            } else {
                elevation.remove(public_key);
            }
        }
        if blocked {
            return Ok(Delivery::Blocked);
        }
        match result.outcome {
            KeyOutcome::Enrolled => Ok(Delivery::Enrolled),
            KeyOutcome::DelegationDisabled => Ok(Delivery::DelegationDisabled),
            _ => {
                log_failure("delegated enroll", &result);
                Ok(Delivery::Failed)
            }
        }
    }
}

impl PcAccessService {
    pub fn new(installer: Arc<dyn PcAccessInstaller>, roster: Arc<dyn PcAccessRoster>) -> Self {
        Self {
            inner: Arc::new(Inner {
                installer,
                roster,
                queue: Arc::new(tokio::sync::Mutex::new(())),
                running: Mutex::new(None),
                runs: AtomicU64::new(0),
                needs_elevation: Mutex::new(HashSet::new()),
                in_flight: Mutex::new(HashMap::new()),
                credential_busy: AtomicBool::new(false),
            }),
        }
    }

    /// Runs the Approve, or joins the one running.
    async fn approve(&self) -> Approval {
        let inner = &self.inner;
        let joined = {
            let mut running = held(&inner.running);
            match running.as_ref() {
                Some((_, run)) => run.clone(),
                None => {
                    let id = inner.runs.fetch_add(1, Ordering::SeqCst);
                    let owner = inner.clone();
                    let run: BoxFuture<'static, Approval> = async move {
                        let answer = owner.serial(owner.approve_once()).await;
                        let mut running = held(&owner.running);
                        if running.as_ref().is_some_and(|(current, _)| *current == id) {
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

    /// The phone's fallback when nobody is at the PC: the same install-or-enroll as Approve, authorized by the
    /// Windows password the phone typed (the batch logon, no UAC prompt). Refused (`failed`) unless the request's
    /// client is a phone paired now that delivered exactly the request's key. One password request runs at a time,
    /// from any phone: another is answered `busy`, not queued (a guess is never stored for later). The outcome is
    /// the installer's (`bad-credentials`, `not-admin`, ... included) and its state is relative to the phone's key.
    /// The credential is passed to the installer and kept nowhere.
    pub async fn approve_with_credential(&self, request: CredentialRequest) -> Result<CredentialAnswer, String> {
        let inner = &self.inner;
        let CredentialRequest { client_id, public_key, credential, cancelled } = request;
        if inner.credential_busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
            return Ok(CredentialAnswer {
                outcome: CredentialOutcome::Busy,
                state: inner.installer.state(Some(&public_key)).await,
                detail: Some(CREDENTIAL_BUSY.to_owned()),
            });
        }
        let _latch = CredentialLatch(&inner.credential_busy);
        inner
            .serial(async {
                let phone = Phone { client_id: &client_id, public_key: &public_key };
                let result = inner.authorize(Some(&credential), Some(phone), cancelled.as_ref()).await?;
                // Whatever the call enrolled, the answer is about this phone.
                let state = inner.installer.state(Some(&public_key)).await;
                Ok(match result {
                    Authorized::NothingToDo => CredentialAnswer { outcome: CredentialOutcome::Ran(KeyOutcome::Enrolled), state, detail: None },
                    Authorized::Ran(change) => CredentialAnswer { outcome: CredentialOutcome::Ran(change.outcome), state, detail: change.detail },
                })
            })
            .await
    }

    /// A paired phone delivered its key: enroll it through delegation unless a pending revocation blocks it.
    pub async fn delivered(&self, public_key: &str) -> Result<Delivery, String> {
        let _flight = InFlight::new(&self.inner, public_key);
        self.inner.serial(self.inner.deliver(public_key)).await
    }

    /// Settings -> Connection's Remove, as one queued transaction: `unpair` runs (the roster owes the removed
    /// phone's key in the same write as the removal, and a removal that could not be recorded is refused by it),
    /// its answer returns, and, still in the queue, the revoke is tried before any delivery runs. A failed `unpair`
    /// keeps what the roster owes.
    pub async fn unpair<T, E>(&self, unpair: impl Future<Output = Result<T, E>> + Send) -> Result<T, E> {
        let step = self.inner.queue.clone().lock_owned().await;
        let result = unpair.await;
        if result.is_ok() {
            let inner = self.inner.clone();
            drop(mixdog_rt::spawn("pc-access-revoke-after-unpair", mixdog_rt::TaskClass::Work, async move {
                let _step = step;
                if let Err(error) = inner.revoke_owed_now().await {
                    tracing::error!("[mixdog-pc-access] revoke after unpair failed (still pending): {error}");
                }
            }));
        }
        result
    }

    /// Tries every pending revoke now (delegated); what is owed is the roster's record.
    pub async fn revoke_owed(&self) -> Result<RevokeOwed, String> {
        self.inner.serial(self.inner.revoke_owed_now()).await
    }
}

impl PcAccessEvents for PcAccessService {
    fn key_delivered(&self, public_key: &str) {
        let inner = self.inner.clone();
        let key = public_key.to_owned();
        drop(mixdog_rt::spawn("pc-access-delivered", mixdog_rt::TaskClass::Work, async move {
            let _flight = InFlight::new(&inner, &key);
            if let Err(error) = inner.serial(inner.deliver(&key)).await {
                tracing::error!("[mixdog-pc-access] enroll after delivery failed: {error}");
            }
        }));
    }

    fn owed_changed(&self) {
        let inner = self.inner.clone();
        drop(mixdog_rt::spawn("pc-access-owed", mixdog_rt::TaskClass::Work, async move {
            if let Err(error) = inner.serial(inner.revoke_owed_now()).await {
                tracing::error!("[mixdog-pc-access] owed revoke failed (still pending): {error}");
            }
        }));
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
