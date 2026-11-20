//! The execution authority of Computer Use: a terminal scope per session backend, which every executor (the core, the native helper,
//! the desktop's computer host) commits its external operations under.
//!
//! - A scope ([`Authority`]) never reopens once revoked. Computer Use switched off closes the creation of new scopes and revokes every
//!   existing one ([`AuthoritySwitch::close`]); switched on again, new scopes are made and an old one stays revoked. A request, or a
//!   preparation still pending, keeps the scope it began under.
//! - The core commits under the scope where it acts: a helper process is created only through the scope's launch commit
//!   ([`LaunchAuthority`], taken by the process manager at the creation itself and registered with the scope before it is let go), and
//!   every request to the desktop goes through [`ScopedDesktop`], which names the scope and refuses once it is revoked.
//! - The other executors enforce on their side: the helper takes a revocation on its control path and refuses every primitive after it;
//!   the desktop keeps a revocable context per scope (`host/computer/revokeScopes`) and refuses there. A refused later send does not
//!   retract a request already delivered, which is why the receivers enforce too.
//!
//! What this guarantees: once a scope is revoked no further operation commits under it in an executor that has taken the revocation;
//! off is confirmed when the affected executors acknowledged the revocation or exited. An operating-system effect committed before
//! (a posted message, a launched program) is not undone, and an executor that does not answer is reported as stopping, never assumed
//! stopped after some time.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostChannel;
use mixdog_core_api::HostError;
use mixdog_core_api::domain::computer::ComputerError;
use mixdog_core_api::domain::process::LaunchAuthority;
use mixdog_core_api::domain::process::LaunchCommit;
use mixdog_core_api::domain::process::LaunchScope;
use mixdog_core_api::ids::Method;
use mixdog_protocol::ProcessHandle;
use serde_json::Value;
use serde_json::json;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::computer_backend::bridge_unavailable;

/// The request that revokes scopes at the desktop: `{ scopes: [id] }`, answered once the desktop's contexts of those scopes are revoked.
pub const REVOKE_SCOPES_METHOD: &str = "host/computer/revokeScopes";
/// The field every request of a scope names it by.
pub const SCOPE_FIELD: &str = "automationScope";
const FOREGROUND_LEASE_METHOD: &str = "host/computer/foregroundLease";

static NEXT_SCOPE: AtomicU64 = AtomicU64::new(1);

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ScopeInner {
    revoked: bool,
    /// The helper processes created under the scope, by handle, in creation order.
    launched: Vec<ProcessHandle>,
    /// The latest acknowledgement of each executor that took the revocation, by executor.
    reports: BTreeMap<String, RevocationReport>,
    /// The claim generation each request of the scope's desktop work was submitted under (`HostChannel::claim_generation`; `None`
    /// for a channel that cannot tell). Only the claim that holds all of it can report the scope's desktop cleanup.
    desktop_work: std::collections::BTreeSet<Option<u64>>,
}

/// How far a revoked executor's effects settled, as it reported them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RevocationCleanup {
    /// Something is still held, pending or unfinished.
    Pending,
    /// Every effect settled and every input it held was released.
    Complete,
    /// A release or compensation failed, or an outcome is uncertain.
    Unconfirmed,
}

/// One executor's acknowledgement of a revocation, kept in its meaning: the helper's report line (`@@MIXDOG_REVOKED@@` and its JSON),
/// or the desktop's per-scope report. Admission closed is the executor's own statement; anything it did not state is unconfirmed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevocationReport {
    /// The scope (or scope epoch) the executor names.
    pub scope: Option<u64>,
    /// The executor stated that its admission is closed; false: not stated, so unconfirmed.
    pub admission_closed: bool,
    /// The individual calls admitted and unfinished when admission closed (the executor's first snapshot): a diagnostic, not a promise.
    pub unfinished_at_closure: Option<u64>,
    /// Those still unfinished at this report.
    pub unfinished: Option<u64>,
    pub cleanup: RevocationCleanup,
    /// Executors below this one whose closure is not known (an Electron domain whose handler has not applied it).
    pub unknown_executors: Vec<String>,
    /// The executor's revision of this report (the desktop's, per scope): a report is kept only when newer than the one held. None
    /// for an executor whose reports come in order on one stream (a helper).
    pub revision: Option<u64>,
}

impl RevocationReport {
    /// Reads a report's JSON: `{scope, admission: "closed"|"unconfirmed", unfinished_at_closure, unfinished, cleanup:
    /// "pending"|"complete"|"unconfirmed", unknown_executors?}`. A field missing or of another shape reads as unconfirmed, never
    /// as closed or zero.
    pub fn from_json(value: &Value) -> Self {
        let count = |field: &str| value.get(field).and_then(Value::as_u64);
        Self {
            scope: count("scope"),
            admission_closed: value.get("admission").and_then(Value::as_str) == Some("closed"),
            unfinished_at_closure: count("unfinished_at_closure"),
            unfinished: count("unfinished"),
            cleanup: match value.get("cleanup").and_then(Value::as_str) {
                Some("pending") => RevocationCleanup::Pending,
                Some("complete") => RevocationCleanup::Complete,
                _ => RevocationCleanup::Unconfirmed,
            },
            unknown_executors: value
                .get("unknown_executors")
                .and_then(Value::as_array)
                .map(|names| names.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
            revision: count("revision"),
        }
    }

    /// A helper's report line, without its marker; a line that is no JSON object still says the helper answered, and nothing more.
    pub fn from_line(text: &str) -> Self {
        Self::from_json(&serde_json::from_str::<Value>(text.trim()).unwrap_or(Value::Null))
    }

    /// Admission closed and nothing left unknown below it.
    pub fn closure_confirmed(&self) -> bool {
        self.admission_closed && self.unknown_executors.is_empty()
    }

    /// What is known of a scope whose executor can no longer report it (its claim, or its connection, ended): nothing. The highest
    /// revision, so no later report can replace it.
    pub fn unknowable(scope: u64) -> Self {
        let mut report = Self::from_json(&json!({ "scope": scope, "admission": "unconfirmed", "cleanup": "unconfirmed" }));
        report.revision = Some(u64::MAX);
        report
    }
}

struct ScopeState {
    id: u64,
    /// `desktop.computerControl`, read at every check: a check between the switch going off and the revocation refuses as well.
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    inner: Mutex<ScopeInner>,
    revoked: watch::Sender<bool>,
    /// Bumped at each executor report kept, so a wait for the cleanup to settle wakes on a later one.
    reported: watch::Sender<u64>,
}

/// One terminal automation scope; clones are the same scope.
#[derive(Clone)]
pub struct Authority(Arc<ScopeState>);

impl Default for Authority {
    /// A scope of its own, open until revoked: a backend made outside a pool.
    fn default() -> Self {
        Self::new(Arc::new(|| true))
    }
}

impl Authority {
    pub fn new(enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self(Arc::new(ScopeState {
            id: NEXT_SCOPE.fetch_add(1, Ordering::SeqCst),
            enabled,
            inner: Mutex::new(ScopeInner { revoked: false, launched: Vec::new(), reports: BTreeMap::new(), desktop_work: Default::default() }),
            revoked: watch::Sender::new(false),
            reported: watch::Sender::new(0),
        }))
    }

    /// What the executors name the scope by.
    pub fn id(&self) -> u64 {
        self.0.id
    }

    pub fn is_revoked(&self) -> bool {
        locked(&self.0.inner).revoked
    }

    /// Not revoked, and Computer Use on.
    pub fn is_open(&self) -> bool {
        !self.is_revoked() && (self.0.enabled)()
    }

    /// Node's refusal when the bridge is down, unless the scope is open.
    pub fn check(&self) -> Result<(), ComputerError> {
        if self.is_open() { Ok(()) } else { Err(bridge_unavailable()) }
    }

    /// Revokes the scope for good, serialized with every launch commit: a creation in progress finishes and is registered first, none
    /// starts after. True the first time.
    pub fn revoke(&self) -> bool {
        let first = {
            let mut inner = locked(&self.0.inner);
            !std::mem::replace(&mut inner.revoked, true)
        };
        self.0.revoked.send_replace(true);
        first
    }

    /// Keeps an executor's latest acknowledgement of the revocation. The closure snapshot is the executor's first; a later report
    /// that dropped it keeps the earlier one, never a fabricated zero. A revisioned report no newer than the one held is stale (a
    /// snapshot answered after a change already pushed) and changes nothing.
    pub fn record_revocation(&self, executor: &str, mut report: RevocationReport) {
        let mut inner = locked(&self.0.inner);
        if let Some(earlier) = inner.reports.get(executor) {
            if let (Some(held), Some(new)) = (earlier.revision, report.revision)
                && new <= held
            {
                return;
            }
            report.unfinished_at_closure = earlier.unfinished_at_closure.or(report.unfinished_at_closure);
            report.admission_closed |= earlier.admission_closed;
        }
        inner.reports.insert(executor.to_owned(), report);
        drop(inner);
        self.0.reported.send_modify(|count| *count += 1);
    }

    /// A request of the scope's desktop work is submitted under the claim `generation`.
    pub fn desktop_worked(&self, generation: Option<u64>) {
        locked(&self.0.inner).desktop_work.insert(generation);
    }

    /// Whether every request of the scope's desktop work went to the claim `serving` (true when it had none).
    fn desktop_work_under(&self, serving: Option<u64>) -> bool {
        locked(&self.0.inner).desktop_work.iter().all(|generation| *generation == serving)
    }

    /// The desktop's report of this scope (`report`; `None`: it did not report the scope), answered by the claim `serving` (`None`:
    /// which claim answered is not known). Kept when every request of the scope's desktop work went to that claim; otherwise the claim
    /// that took the work cannot report any more, and no later claim knows it: the scope's desktop cleanup is unconfirmed for good.
    /// A scope with no desktop work needs no report. Returns whether the desktop's closure of the scope is known.
    pub fn record_desktop(&self, executor: &str, report: Option<RevocationReport>, serving: Option<Option<u64>>) -> bool {
        let worked = !locked(&self.0.inner).desktop_work.is_empty();
        match (report, serving) {
            (Some(report), Some(serving)) if self.desktop_work_under(serving) => {
                let known = report.closure_confirmed();
                self.record_revocation(executor, report);
                known
            }
            (None, _) if !worked => true,
            (Some(report), None) if !worked => {
                let known = report.closure_confirmed();
                self.record_revocation(executor, report);
                known
            }
            _ => {
                self.record_revocation(executor, RevocationReport::unknowable(self.id()));
                false
            }
        }
    }

    /// The desktop's claim is now `current`: if the scope's desktop work went to another claim (its connection ended, or another
    /// desktop took over), and its desktop cleanup is not known complete, it is unconfirmed for good.
    pub fn desktop_claim_now(&self, executor: &str, current: Option<u64>) {
        let complete = locked(&self.0.inner).reports.get(executor).is_some_and(|report| report.cleanup == RevocationCleanup::Complete);
        if !complete && !self.desktop_work_under(current) {
            self.record_revocation(executor, RevocationReport::unknowable(self.id()));
        }
    }

    /// Changes once a later executor report is kept (seen from now on).
    pub fn watch_reports(&self) -> watch::Receiver<u64> {
        self.0.reported.subscribe()
    }

    /// Every executor's latest acknowledgement, by executor.
    pub fn revocation_reports(&self) -> Vec<(String, RevocationReport)> {
        locked(&self.0.inner).reports.iter().map(|(executor, report)| (executor.clone(), report.clone())).collect()
    }

    /// The helper processes created under the scope; complete once it is revoked.
    pub fn launched(&self) -> Vec<ProcessHandle> {
        locked(&self.0.inner).launched.clone()
    }

    /// What a helper is started under ([`mixdog_core_api::domain::process::ProcessOwner::ComputerHelper`]).
    pub fn launch_scope(&self) -> LaunchScope {
        LaunchScope(self.0.clone())
    }

    /// Resolves once the scope is revoked.
    pub async fn revoked(&self) {
        let mut seen = self.0.revoked.subscribe();
        let _ = seen.wait_for(|revoked| *revoked).await;
    }
}

struct Commit<'a>(MutexGuard<'a, ScopeInner>);

impl LaunchCommit for Commit<'_> {
    fn launched(&mut self, handle: &ProcessHandle) {
        self.0.launched.push(handle.clone());
    }
}

impl LaunchAuthority for ScopeState {
    fn begin(&self) -> Option<Box<dyn LaunchCommit + '_>> {
        let inner = locked(&self.inner);
        (!inner.revoked).then(|| Box::new(Commit(inner)) as Box<dyn LaunchCommit + '_>)
    }
}

struct SwitchState {
    closed: bool,
    scopes: Vec<Weak<ScopeState>>,
}

/// Where scopes are made: closed while Computer Use is off.
pub struct AuthoritySwitch {
    enabled: Arc<dyn Fn() -> bool + Send + Sync>,
    state: Mutex<SwitchState>,
}

impl AuthoritySwitch {
    pub fn new(enabled: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        Self { enabled, state: Mutex::new(SwitchState { closed: false, scopes: Vec::new() }) }
    }

    /// A new scope, or Node's refusal while the switch is closed or Computer Use is off.
    pub fn scope(&self) -> Result<Authority, ComputerError> {
        let mut state = locked(&self.state);
        if state.closed || !(self.enabled)() {
            return Err(bridge_unavailable());
        }
        state.scopes.retain(|scope| scope.strong_count() > 0);
        let scope = Authority::new(self.enabled.clone());
        state.scopes.push(Arc::downgrade(&scope.0));
        Ok(scope)
    }

    /// Off: no scope is made until [`Self::open`], and every scope made so far is revoked. Returns the scopes this revoked.
    pub fn close(&self) -> Vec<Authority> {
        let scopes = {
            let mut state = locked(&self.state);
            state.closed = true;
            std::mem::take(&mut state.scopes)
        };
        scopes.iter().filter_map(Weak::upgrade).map(Authority).filter(Authority::revoke).collect()
    }

    /// On again: new scopes are made; the revoked ones stay revoked.
    pub fn open(&self) {
        locked(&self.state).closed = false;
    }
}

/// What the revocation of a scope at the desktop answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopRevocation {
    /// The desktop revoked its contexts of the scopes.
    Acknowledged,
    /// No desktop serves the computer host: nothing of the scopes can still be delivered there.
    NoDesktop,
    /// The desktop did not confirm (an older desktop without the method, or a failed request): stopping, not stopped.
    Unconfirmed,
}

/// Revokes `scopes` at the desktop's computer host, through the unscoped channel, and keeps the desktop's report of each on it as
/// `executor`'s ([`Authority::record_desktop`]): the answer (`reports: [{scope, revision, admission, unfinished_at_closure, cleanup,
/// unknown_executors}]`) reports only the scopes its connection served, and it counts for a scope only when every request of the
/// scope's desktop work went to the claim that answered. Acknowledged only when the desktop's closure of every scope is known; an
/// answer without `reports` (an older desktop) or a failed request is unconfirmed. Where no desktop serves, a scope whose desktop
/// work went to a claim that is gone is unconfirmed, the others need nothing.
pub async fn revoke_at_desktop_reports(desktop: &dyn HostChannel, scopes: &[Authority], executor: &str) -> DesktopRevocation {
    let all = |report: &dyn Fn(&Authority) -> bool| scopes.iter().map(report).collect::<Vec<bool>>().into_iter().all(|known| known);
    let gone = || if all(&|scope| scope.record_desktop(executor, None, None)) { DesktopRevocation::NoDesktop } else { DesktopRevocation::Unconfirmed };
    if scopes.is_empty() || !desktop.serves(HostCapability::Computer) {
        return gone();
    }
    let ids: Vec<u64> = scopes.iter().map(Authority::id).collect();
    // The answering claim is the one the revocation request itself selects.
    let before = desktop.claim_generation(HostCapability::Computer, Method(REVOKE_SCOPES_METHOD));
    match desktop.request(HostCapability::Computer, Method(REVOKE_SCOPES_METHOD), json!({ "scopes": ids })).await {
        Ok(answer) => {
            // The claim that answered: the one serving before and after the request; a change between them leaves it unknown.
            let serving = (desktop.claim_generation(HostCapability::Computer, Method(REVOKE_SCOPES_METHOD)) == before).then_some(before);
            let Some(reports) = answer.get("reports").and_then(Value::as_array) else {
                all(&|scope| scope.record_desktop(executor, None, None));
                return DesktopRevocation::Unconfirmed;
            };
            let reports: Vec<RevocationReport> = reports.iter().map(RevocationReport::from_json).collect();
            let known = all(&|scope| {
                let report = reports.iter().find(|report| report.scope == Some(scope.id())).cloned();
                scope.record_desktop(executor, report, serving)
            });
            if known { DesktopRevocation::Acknowledged } else { DesktopRevocation::Unconfirmed }
        }
        Err(HostError::Core(CoreError::CapabilityUnavailable { detail, .. })) if matches!(&*detail, "noClaimant" | "claimantClosed") => gone(),
        Err(_) => {
            all(&|scope| scope.record_desktop(executor, None, None));
            DesktopRevocation::Unconfirmed
        }
    }
}

/// The desktop channel as one scope uses it: every request and notification names the scope, and none is sent once the scope is
/// revoked; an answer that arrives after the revocation is dropped, so a capture taken before it is not handed on after it. Only the
/// teardown of a foreground lease (its release, a helper gone) still passes.
pub struct ScopedDesktop {
    inner: Arc<dyn HostChannel>,
    authority: Authority,
}

impl ScopedDesktop {
    pub fn wrap(inner: Arc<dyn HostChannel>, authority: Authority) -> Arc<dyn HostChannel> {
        Arc::new(Self { inner, authority })
    }

    fn teardown(method: Method, params: &Value) -> bool {
        method.as_str() == FOREGROUND_LEASE_METHOD && params.get("op").and_then(Value::as_str) != Some("acquire")
    }

    /// The scope's params for a request of `capability`; a request of the scope's work (not teardown) is stamped with the claim it is
    /// submitted under ([`Authority::desktop_worked`]).
    fn scoped(&self, capability: HostCapability, method: Method, mut params: Value) -> Result<(Value, bool), CoreError> {
        let teardown = Self::teardown(method, &params);
        if !teardown && self.authority.is_revoked() {
            return Err(revoked());
        }
        if !teardown {
            self.authority.desktop_worked(self.inner.claim_generation(capability, method));
        }
        if let Value::Object(fields) = &mut params {
            fields.insert(SCOPE_FIELD.into(), json!(self.authority.id()));
        }
        Ok((params, teardown))
    }

    fn answered(&self, teardown: bool, answer: Result<Value, HostError>) -> Result<Value, HostError> {
        if !teardown && self.authority.is_revoked() { Err(revoked().into()) } else { answer }
    }
}

fn revoked() -> CoreError {
    CoreError::CapabilityUnavailable { capability: "desktopHost".into(), detail: "revoked".into() }
}

#[async_trait]
impl HostChannel for ScopedDesktop {
    async fn request(&self, capability: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
        let (params, teardown) = self.scoped(capability, method, params)?;
        let answer = self.inner.request(capability, method, params).await;
        self.answered(teardown, answer)
    }

    async fn request_scoped(&self, capability: HostCapability, method: Method, params: Value, cancel: &CancellationToken) -> Result<Value, HostError> {
        let (params, teardown) = self.scoped(capability, method, params)?;
        let answer = self.inner.request_scoped(capability, method, params, cancel).await;
        self.answered(teardown, answer)
    }

    fn serves(&self, capability: HostCapability) -> bool {
        self.inner.serves(capability)
    }

    fn claim_generation(&self, capability: HostCapability, method: Method) -> Option<u64> {
        self.inner.claim_generation(capability, method)
    }

    fn serves_method(&self, capability: HostCapability, method: Method) -> bool {
        self.inner.serves_method(capability, method)
    }

    fn notify(&self, capability: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
        let (params, _) = self.scoped(capability, method, params)?;
        self.inner.notify(capability, method, params)
    }

    async fn request_streamed(
        &self,
        capability: HostCapability,
        method: Method,
        params: Value,
        on_event: &mut (dyn FnMut(Value) + Send),
    ) -> Result<Value, HostError> {
        let (params, teardown) = self.scoped(capability, method, params)?;
        let answer = self.inner.request_streamed(capability, method, params, on_event).await;
        self.answered(teardown, answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scope retained across off and on stays revoked, and the switch makes a new one only once on again.
    #[test]
    fn an_old_scope_kept_across_off_and_on_stays_revoked() {
        let switch = AuthoritySwitch::new(Arc::new(|| true));
        let old = switch.scope().expect("on");
        assert!(old.is_open());
        assert_eq!(switch.close().len(), 1);
        assert!(switch.scope().is_err(), "off makes no scope");
        switch.open();
        let new = switch.scope().expect("on again");
        assert!(old.is_revoked() && !old.is_open() && old.check().is_err());
        assert!(new.is_open() && new.id() != old.id());
        assert!(old.launch_scope().0.begin().is_none(), "the old scope commits no launch");
        assert!(new.launch_scope().0.begin().is_some());
    }

    /// A revocation waits for a launch commit in progress and then finds what it created; a launch after it is refused.
    #[test]
    fn a_revocation_is_serialized_with_a_launch_commit() {
        let scope = Authority::default();
        let launch = scope.launch_scope();
        let committing = std::sync::Barrier::new(2);
        std::thread::scope(|threads| {
            let creator = threads.spawn(|| {
                let mut commit = launch.0.begin().expect("open");
                committing.wait();
                commit.launched(&ProcessHandle("helper-1".into()));
            });
            committing.wait();
            let revoker = threads.spawn(|| scope.revoke());
            creator.join().unwrap();
            assert!(revoker.join().unwrap());
        });
        assert_eq!(scope.launched(), vec![ProcessHandle("helper-1".into())]);
        assert!(launch.0.begin().is_none());
    }

    struct Recorder(Mutex<Vec<(String, Value)>>);

    #[async_trait]
    impl HostChannel for Recorder {
        async fn request(&self, _: HostCapability, method: Method, params: Value) -> Result<Value, HostError> {
            locked(&self.0).push((method.as_str().to_owned(), params));
            Ok(json!({}))
        }

        fn notify(&self, _: HostCapability, method: Method, params: Value) -> Result<(), CoreError> {
            locked(&self.0).push((method.as_str().to_owned(), params));
            Ok(())
        }
    }

    /// A desktop whose answer waits until the test lets it go.
    struct Held {
        asked: tokio::sync::Notify,
        answer: tokio::sync::Notify,
    }

    #[async_trait]
    impl HostChannel for Held {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            self.asked.notify_one();
            self.answer.notified().await;
            Ok(json!({ "blob": "pixels" }))
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    /// A capture asked before the revocation and answered after it is not handed on: the pixels are dropped. Ordered by the desktop's
    /// own barrier, not by time.
    #[tokio::test]
    async fn a_capture_answered_after_the_revocation_is_dropped() {
        let raw = Arc::new(Held { asked: tokio::sync::Notify::new(), answer: tokio::sync::Notify::new() });
        let scope = Authority::default();
        let desktop = ScopedDesktop::wrap(raw.clone(), scope.clone());
        let capture = tokio::spawn({
            let desktop = desktop.clone();
            async move { desktop.request(HostCapability::Computer, Method("host/computer/pixels"), json!({})).await }
        });
        raw.asked.notified().await;
        scope.revoke();
        raw.answer.notify_one();
        let answered = capture.await.unwrap();
        assert!(matches!(answered, Err(HostError::Core(CoreError::CapabilityUnavailable { ref detail, .. })) if &**detail == "revoked"), "{answered:?}");
    }

    /// The scoped channel names the scope, sends nothing but a lease's teardown once revoked.
    #[tokio::test]
    async fn the_scoped_desktop_names_the_scope_and_refuses_after_revocation() {
        let raw = Arc::new(Recorder(Mutex::default()));
        let scope = Authority::default();
        let desktop = ScopedDesktop::wrap(raw.clone(), scope.clone());
        desktop.request(HostCapability::Computer, Method("host/computer/displays"), json!({})).await.unwrap();
        scope.revoke();
        assert!(desktop.request(HostCapability::Computer, Method("host/computer/pixels"), json!({})).await.is_err());
        assert!(desktop.notify(HostCapability::Computer, Method("host/computer/pointerFeedback"), json!({})).is_err());
        assert!(desktop.request(HostCapability::Computer, Method("host/computer/foregroundLease"), json!({"op": "acquire"})).await.is_err());
        desktop.request(HostCapability::Computer, Method("host/computer/foregroundLease"), json!({"op": "release"})).await.unwrap();
        let sent = locked(&raw.0).clone();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0], ("host/computer/displays".to_owned(), json!({ "automationScope": scope.id() })));
        assert_eq!(sent[1].0, "host/computer/foregroundLease");
    }

    /// A desktop that answers the revocation with a fixed body.
    struct Answers(Value);

    #[async_trait]
    impl HostChannel for Answers {
        async fn request(&self, _: HostCapability, _: Method, _: Value) -> Result<Value, HostError> {
            Ok(self.0.clone())
        }

        fn notify(&self, _: HostCapability, _: Method, _: Value) -> Result<(), CoreError> {
            Ok(())
        }
    }

    /// The desktop's per-scope reports are kept in meaning: a scope with an executor whose closure is unknown, or one the answer does
    /// not report (an older desktop answering `{revoked: n}`), leaves the revocation unconfirmed; a missing count is unknown, not zero.
    #[tokio::test]
    async fn the_desktop_revocation_is_confirmed_only_by_each_scope_report() {
        let closed = |scope: u64| json!({"scope": scope, "admission": "closed", "unfinished_at_closure": 1, "cleanup": "pending"});
        let scopes = || {
            let scopes = [Authority::default(), Authority::default()];
            for scope in &scopes {
                scope.desktop_worked(None);
            }
            scopes
        };
        let both = scopes();
        let answer = json!({"reports": [closed(both[0].id()), closed(both[1].id())]});
        assert_eq!(revoke_at_desktop_reports(&Answers(answer), &both, "desktop").await, DesktopRevocation::Acknowledged);
        let (_, kept) = both[0].revocation_reports().remove(0);
        assert_eq!((kept.unfinished_at_closure, kept.cleanup), (Some(1), RevocationCleanup::Pending));

        let both = scopes();
        let unknown = json!({"reports": [closed(both[0].id()), {"scope": both[1].id(), "admission": "unconfirmed", "unknown_executors": ["renderer"], "cleanup": "pending"}]});
        assert_eq!(revoke_at_desktop_reports(&Answers(unknown), &both, "desktop").await, DesktopRevocation::Unconfirmed);
        let both = scopes();
        assert_eq!(revoke_at_desktop_reports(&Answers(json!({"revoked": 2})), &both, "desktop").await, DesktopRevocation::Unconfirmed);
        // A scope whose desktop work the answering connection did not serve is not reported by it, and stays unknown.
        let both = scopes();
        let partial = json!({"reports": [closed(both[0].id())]});
        assert_eq!(revoke_at_desktop_reports(&Answers(partial), &both, "desktop").await, DesktopRevocation::Unconfirmed);
        assert_eq!(both[1].revocation_reports()[0].1.cleanup, RevocationCleanup::Unconfirmed);
        // A scope with no desktop work needs no report.
        let idle = [Authority::default()];
        assert_eq!(revoke_at_desktop_reports(&Answers(json!({"reports": []})), &idle, "desktop").await, DesktopRevocation::Acknowledged);
        assert!(idle[0].revocation_reports().is_empty());
    }

    /// A helper's repeated acknowledgements: the first closure snapshot stays; a later line that lost it, or is no JSON, never turns it
    /// into zero or into a closure the helper did not state.
    #[test]
    fn a_helper_report_keeps_its_first_snapshot_and_reads_nothing_it_did_not_state() {
        let scope = Authority::default();
        let first = RevocationReport::from_line(r#"{"scope":1,"admission":"closed","unfinished_at_closure":2,"unfinished":2,"cleanup":"pending"}"#);
        assert!(first.closure_confirmed());
        scope.record_revocation("helper h", first);
        scope.record_revocation("helper h", RevocationReport::from_line(r#"{"scope":1,"admission":"closed","unfinished":0,"cleanup":"complete"}"#));
        let (_, kept) = scope.revocation_reports().remove(0);
        assert_eq!((kept.unfinished_at_closure, kept.unfinished, kept.cleanup), (Some(2), Some(0), RevocationCleanup::Complete));

        let garbled = RevocationReport::from_line("in_flight=3");
        assert!(!garbled.admission_closed);
        assert_eq!((garbled.unfinished_at_closure, garbled.cleanup), (None, RevocationCleanup::Unconfirmed));
    }
}
