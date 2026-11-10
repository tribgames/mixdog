//! The PC's secure-desktop helper as every screen session sees it: the current adapter, its install state, and
//! the paired phone's install request (Node: `secure-desktop-helper.ts`).
//!
//! - Install on demand only: the phone's request reaches `request_install`, which hands it to the installer
//!   with the phone's controller key. The installer joins a request already running, so there is at most one
//!   prompt.
//! - Rebuilt after an install: a client reads the install state (its secret) once, when it is built, so after
//!   an `installed` or `updated` outcome the adapter is built afresh. So it is when an install-state check
//!   reads `installed` while the adapter reports not installed: an install finished outside a request that
//!   saw it end.
//! - One holder. Each session sees the helper through its own lease. The helper serves one session at a time:
//!   the one that activated it first holds it. Only the holder's video runs are declared, only its grants and
//!   input reach the helper, and only it hears the helper's frames, challenges and issues. Another session
//!   that wants the helper meanwhile reads `owned_elsewhere()` and waits, in the order it asked. The hold
//!   passes when the holder deactivates the helper or its lease is disposed: to the first waiting session or,
//!   with none, the helper is deactivated. Every lease hears `on_desktop_changed` when the holder changes.
//! - Unique epochs, and an explicit revoke on every hold. The helper ends a grant on a declaration only when
//!   the epoch differs from its current one, so a declaration alone guarantees nothing across sessions. Every
//!   video run's epoch comes from one helper-wide counter that only rises (`mint_video_run`), and taking the
//!   hold always goes: deactivate (on a handover; the helper then releases what it held and revokes its grant
//!   and every open challenge), the new holder starts a fresh run (`on_hold`), then activate. The lease
//!   mirrors that gate: a grant passes only from the holder, for the epoch it declared in this hold, naming a
//!   challenge forwarded to it since (the latest [`CHALLENGES_OPEN`], each used once); input passes only once
//!   such a grant was relayed.
//! - One prompt per phone request, none after a refusal. A `declined` outcome latches: until the app
//!   restarts, every later install request, from any session, answers `declined` with [`DECLINED_ON_PC`] and
//!   launches nothing.
//! - Rebuilt only when the install changed: a request whose phone key was already installed and current
//!   before it (and that the adapter knows), or one that ends after the adapter was rebuilt since it began,
//!   rebuilds nothing.
//! - The swap is transparent: listeners stay on the leases, the holder's activation and declared video run
//!   are applied to the new adapter, and the desktop-changed notice fires so every session re-reads it.
//! - After a reboot the registered service is stopped: `ensure_running` starts it unelevated, with no prompt.
//! - `dispose()` of the helper: the adapter is disposed and every listener dropped; a request or check that
//!   ends later rebuilds nothing.
//!
//! Adapter methods take effect when they are called, not when the future they return is first polled: the
//! order of the calls is the order the helper is told.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::Weak;

use futures::FutureExt;
use futures::future::Shared;
use mixdog_core_api::domain::computer::ScreenInput;

use super::installer::HelperStatus;
use super::installer::InstallOutcome;
use super::installer::InstallResult;
use super::installer::InstallState;
use super::installer::SecureDesktopInstaller;
use super::router::BoxFuture;

/// A latched decline's answer to a later request.
pub(super) const DECLINED_ON_PC: &str =
    "the helper install was refused on the PC; restart Mixdog on the PC before asking again";

/// Challenges the helper keeps open: one issued every 2 s, each kept through an age of 6 s inclusive, so at
/// most floor(6 / 2) + 1 = 4, issued at 0, 2, 4 and 6 s. Older ones the helper has dropped.
const CHALLENGES_OPEN: usize = 4;

const NOT_HOLDER: &str = "the secure-desktop helper is held by another session";
const NOT_GRANTED: &str = "no grant for this hold and run was relayed";
const NO_CHALLENGE: &str = "the grant names no challenge of this hold and run";
const WRONG_RUN: &str = "the grant is for another run than this hold declared";

/// A helper call that did not go through, with the reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HelperError(pub String);

fn refused<T>(message: &str) -> BoxFuture<Result<T, HelperError>>
where
    T: Send + 'static,
{
    let error = HelperError(message.to_string());
    Box::pin(async move { Err(error) })
}

/// A frame of the helper's capture: BGRA pixels located on the virtual screen.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct HelperFrame {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub origin_x: i32,
    pub origin_y: i32,
    pub pixels: Arc<Vec<u8>>,
}

/// A helper challenge for the paired phone to sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Challenge {
    /// The connection's handshake server nonce.
    pub nonce: String,
    /// The one-shot challenge.
    pub challenge: String,
}

/// The phone's signed answer to a challenge, for the video run it was shown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Grant {
    pub challenge: String,
    pub epoch: u64,
    pub signature: String,
}

/// Removes the listener it was returned for.
pub(super) type Unsub = Box<dyn FnOnce() + Send>;

type Listener<T> = Arc<dyn Fn(&T) + Send + Sync>;

/// The helper client behind the lease, with the surface a screen session needs.
pub(super) trait HelperAdapter<F>: Send + Sync {
    fn installed(&self) -> bool;
    fn connected(&self) -> bool;
    /// The desktop the helper currently captures and injects on.
    fn desktop(&self) -> Option<String>;
    /// The Windows session the helper is attached to.
    fn session(&self) -> Option<u32>;
    /// The helper's session lock state; `None` when unknown or not connected.
    fn locked(&self) -> Option<bool>;
    /// Begins or ends the helper's capture and injection.
    fn set_active(&self, active: bool) -> BoxFuture<()>;
    /// A secure-desktop input action; settles or fails in bounded time.
    fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>>;
    /// Relays the phone's signed answer; fails when not connected.
    fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>>;
    /// The video run (epoch) the phone is shown now.
    fn set_video_run(&self, epoch: u64);
    fn latest_frame(&self) -> Option<F>;
    fn on_frame(&self, listener: Listener<F>) -> Unsub;
    fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub;
    fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub;
    /// The helper's advisory `error` codes, as they arrive.
    fn on_helper_issue(&self, listener: Listener<String>) -> Unsub;
    /// Releases the client for good.
    fn dispose(&self);
}

/// The installer, as the lease uses it.
pub(super) trait InstallPort: Send + Sync {
    /// The install state, for that phone when its key is given; never prompts.
    fn state(&self, controller_key: Option<String>) -> BoxFuture<InstallState>;
    /// One phone request, enrolling its controller key: at most one prompt, joining a request already running.
    fn request(&self, controller_key: String) -> BoxFuture<InstallResult>;
    /// Starts the current, registered service if stopped (after a reboot): unelevated, never installs,
    /// never prompts; the running status after.
    fn ensure_running(&self) -> BoxFuture<HelperStatus>;
}

impl InstallPort for SecureDesktopInstaller {
    fn state(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        SecureDesktopInstaller::state(self, controller_key)
    }

    fn request(&self, controller_key: String) -> BoxFuture<InstallResult> {
        SecureDesktopInstaller::request(self, &controller_key)
    }

    fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        SecureDesktopInstaller::ensure_running(self)
    }
}

pub(super) struct HelperDeps<F> {
    /// A fresh client and its adapter.
    pub adapter: Box<dyn Fn() -> Arc<dyn HelperAdapter<F>> + Send + Sync>,
    pub installer: Arc<dyn InstallPort>,
}

struct ListenerSet<T> {
    entries: Mutex<(u64, Vec<(u64, Listener<T>)>)>,
}

impl<T> ListenerSet<T> {
    fn new() -> Arc<Self> {
        Arc::new(Self { entries: Mutex::new((0, Vec::new())) })
    }

    fn lock(&self) -> MutexGuard<'_, (u64, Vec<(u64, Listener<T>)>)> {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn add(self: &Arc<Self>, listener: Listener<T>) -> Unsub
    where
        T: 'static,
    {
        let id = {
            let mut entries = self.lock();
            entries.0 += 1;
            let id = entries.0;
            entries.1.push((id, listener));
            id
        };
        let set = self.clone();
        Box::new(move || set.lock().1.retain(|(held, _)| *held != id))
    }

    /// The listeners now, so one that adds or removes another does not disturb the walk.
    fn snapshot(&self) -> Vec<Listener<T>> {
        self.lock().1.iter().map(|(_, listener)| listener.clone()).collect()
    }

    fn call(&self, value: &T) {
        for listener in self.snapshot() {
            listener(value);
        }
    }

    fn clear(&self) {
        self.lock().1.clear();
    }
}

/// One session's hold on (or wait for) the helper.
struct LeaseData<F> {
    id: u64,
    hold: Arc<ListenerSet<()>>,
    change: Arc<ListenerSet<()>>,
    frame: Arc<ListenerSet<F>>,
    challenge: Arc<ListenerSet<Challenge>>,
    issue: Arc<ListenerSet<String>>,
}

impl<F> LeaseData<F> {
    fn clear(&self) {
        self.hold.clear();
        self.change.clear();
        self.frame.clear();
        self.challenge.clear();
        self.issue.clear();
    }
}

/// The run the holder declared in its hold.
#[derive(Clone, Copy)]
struct Declared {
    /// Tells one declaration from the next even at the same epoch.
    serial: u64,
    epoch: u64,
    by: u64,
}

struct State<F> {
    leases: Vec<Arc<LeaseData<F>>>,
    /// The session the helper serves; `None` when none activated it.
    holder: Option<u64>,
    /// Sessions that want the helper while another holds it, in asking order.
    waiting: Vec<u64>,
    disposed: bool,
    /// Bumped by every rebuild: a request that ends after one rebuilt nothing of its own.
    adapter_serial: u64,
    /// The helper-wide video-run counter.
    runs: u64,
    next_lease: u64,
    declarations: u64,
    declared: Option<Declared>,
    /// Challenges forwarded to the holder for that declaration, newest last.
    issued: Vec<String>,
    /// A grant for that declaration was relayed: its input may pass.
    granted: bool,
    current: Arc<dyn HelperAdapter<F>>,
    detach: Vec<Unsub>,
    /// A phone request was declined on the PC: no prompt until restart.
    declined: bool,
    /// The service start under way, shared by its callers.
    starting: Option<Shared<BoxFuture<HelperStatus>>>,
}

impl<F> State<F> {
    /// Nothing granted so far counts any more (a hold or run ended).
    fn forget_grants(&mut self) {
        self.issued.clear();
        self.granted = false;
    }
}

struct Core<F> {
    deps: HelperDeps<F>,
    state: Mutex<State<F>>,
}

impl<F: Clone + Send + Sync + 'static> Core<F> {
    fn state(&self) -> MutexGuard<'_, State<F>> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn current(&self) -> Arc<dyn HelperAdapter<F>> {
        self.state().current.clone()
    }

    fn lease_data(&self, id: u64) -> Option<Arc<LeaseData<F>>> {
        self.state().leases.iter().find(|lease| lease.id == id).cloned()
    }

    fn notify(lease: &LeaseData<F>) {
        lease.change.call(&());
    }

    fn notify_all(&self) {
        let leases = self.state().leases.clone();
        for lease in &leases {
            Self::notify(lease);
        }
    }

    /// Makes `adapter` the current one and listens to it. The listeners hold the helper weakly: the adapter
    /// is the helper's, not the other way round.
    fn attach(self: &Arc<Self>, adapter: Arc<dyn HelperAdapter<F>>) {
        let weak = Arc::downgrade(self);
        let changed = {
            let weak = weak.clone();
            adapter.on_desktop_changed(Arc::new(move |_: &()| {
                if let Some(core) = Weak::upgrade(&weak) {
                    core.notify_all();
                }
            }))
        };
        let framed = {
            let weak = weak.clone();
            adapter.on_frame(Arc::new(move |frame: &F| {
                let Some(core) = Weak::upgrade(&weak) else {
                    return;
                };
                let holder = {
                    let state = core.state();
                    state.holder.and_then(|id| state.leases.iter().find(|lease| lease.id == id).cloned())
                };
                if let Some(holder) = holder {
                    holder.frame.call(frame);
                }
            }))
        };
        let challenged = {
            let weak = weak.clone();
            adapter.on_grant_challenge(Arc::new(move |challenge: &Challenge| {
                let Some(core) = Weak::upgrade(&weak) else {
                    return;
                };
                let holder = {
                    let mut state = core.state();
                    // Only a holder that declared its run can answer one.
                    let Some(holder) = state.holder else {
                        return;
                    };
                    if state.declared.is_none_or(|declared| declared.by != holder) {
                        return;
                    }
                    state.issued.push(challenge.challenge.clone());
                    if state.issued.len() > CHALLENGES_OPEN {
                        state.issued.remove(0);
                    }
                    state.leases.iter().find(|lease| lease.id == holder).cloned()
                };
                if let Some(holder) = holder {
                    holder.challenge.call(challenge);
                }
            }))
        };
        let issued = adapter.on_helper_issue(Arc::new(move |code: &String| {
            let Some(core) = Weak::upgrade(&weak) else {
                return;
            };
            let holder = {
                let state = core.state();
                state.holder.and_then(|id| state.leases.iter().find(|lease| lease.id == id).cloned())
            };
            if let Some(holder) = holder {
                holder.issue.call(code);
            }
        }));
        let mut state = self.state();
        state.current = adapter;
        state.detach = vec![changed, framed, challenged, issued];
    }

    fn rebuild(self: &Arc<Self>) {
        let (detach, old) = {
            let mut state = self.state();
            (std::mem::take(&mut state.detach), state.current.clone())
        };
        for off in detach {
            off();
        }
        old.dispose();
        self.state().adapter_serial += 1;
        self.attach((self.deps.adapter)());
        let (holder, declared) = {
            let mut state = self.state();
            // A new connection: nothing granted on the old one holds.
            state.forget_grants();
            (state.holder, state.declared)
        };
        if let Some(holder) = holder {
            let current = self.current();
            if let Some(declared) = declared.filter(|declared| declared.by == holder) {
                current.set_video_run(declared.epoch);
            }
            drop(current.set_active(true));
        }
        self.notify_all();
    }

    /// Declares `epoch` for the holder `lease`; a new one revokes what was granted for the one before.
    fn declare(&self, lease: u64, epoch: u64) {
        let current = {
            let mut state = self.state();
            if state.declared.is_some_and(|declared| declared.by == lease && declared.epoch == epoch) {
                return;
            }
            state.declarations += 1;
            state.declared = Some(Declared { serial: state.declarations, epoch, by: lease });
            state.forget_grants();
            state.current.clone()
        };
        current.set_video_run(epoch);
    }

    /// `lease` holds the helper from now on, in this order: on a handover the helper is deactivated (it
    /// releases what it held and revokes the previous holder's grant and challenges), the new holder starts a
    /// fresh run (declared), then the helper is activated for it.
    fn take(&self, lease: &LeaseData<F>, handover: bool) -> BoxFuture<()> {
        {
            let mut state = self.state();
            state.holder = Some(lease.id);
            state.waiting.retain(|waiting| *waiting != lease.id);
            state.declared = None;
            state.forget_grants();
        }
        if handover {
            drop(self.current().set_active(false));
        }
        lease.hold.call(&());
        self.current().set_active(true)
    }

    fn set_active(&self, lease: &Arc<LeaseData<F>>, active: bool) -> BoxFuture<()> {
        let ready: BoxFuture<()> = Box::pin(async {});
        {
            let state = self.state();
            if state.disposed || !state.leases.iter().any(|held| held.id == lease.id) {
                return ready;
            }
        }
        if active {
            {
                let mut state = self.state();
                if state.holder == Some(lease.id) || state.waiting.contains(&lease.id) {
                    return ready;
                }
                if state.holder.is_some() {
                    state.waiting.push(lease.id);
                    drop(state);
                    // It decided before it asked: it re-reads `owned_elsewhere()`.
                    Self::notify(lease);
                    return ready;
                }
            }
            let activated = self.take(lease, false);
            self.notify_all();
            return activated;
        }
        let heir = {
            let mut state = self.state();
            state.waiting.retain(|waiting| *waiting != lease.id);
            if state.holder != Some(lease.id) {
                return ready;
            }
            state.holder = None;
            state.declared = None;
            state.forget_grants();
            state.waiting.first().copied()
        };
        if let Some(heir) = heir.and_then(|id| self.lease_data(id)) {
            let activated = self.take(&heir, true);
            self.notify_all();
            return activated;
        }
        self.notify_all();
        self.current().set_active(false)
    }

    fn send_grant(self: &Arc<Self>, lease: u64, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        let (run, current) = {
            let mut state = self.state();
            if state.holder != Some(lease) {
                return refused(NOT_HOLDER);
            }
            let Some(run) = state.declared.filter(|run| run.by == lease && run.epoch == grant.epoch) else {
                return refused(WRONG_RUN);
            };
            let Some(index) = state.issued.iter().position(|issued| *issued == grant.challenge) else {
                return refused(NO_CHALLENGE);
            };
            // Each challenge answers once, as on the helper.
            state.issued.remove(index);
            (run, state.current.clone())
        };
        let relayed = current.send_grant(grant);
        let core = self.clone();
        Box::pin(async move {
            relayed.await?;
            let mut state = core.state();
            if state.declared.is_some_and(|declared| declared.serial == run.serial) {
                state.granted = true;
            }
            Ok(())
        })
    }

    fn install_state(self: &Arc<Self>, controller_key: Option<String>) -> BoxFuture<InstallState> {
        let asked = self.deps.installer.state(controller_key);
        let core = self.clone();
        Box::pin(async move {
            let state = asked.await;
            let (disposed, current) = {
                let state = core.state();
                (state.disposed, state.current.clone())
            };
            if !disposed && state == InstallState::Installed && !current.installed() {
                core.rebuild();
            }
            state
        })
    }

    fn declined_answer(self: &Arc<Self>, controller_key: &str) -> BoxFuture<InstallResult> {
        let asked = self.deps.installer.state(Some(controller_key.to_string()));
        Box::pin(async move {
            InstallResult { outcome: InstallOutcome::Declined, state: asked.await, detail: Some(DECLINED_ON_PC.to_string()) }
        })
    }

    fn request_install(self: &Arc<Self>, controller_key: &str) -> BoxFuture<InstallResult> {
        if self.state().declined {
            return self.declined_answer(controller_key);
        }
        let serial = self.state().adapter_serial;
        // Relative to this phone's key: `installed` is current and enrolls it.
        let before = self.deps.installer.state(Some(controller_key.to_string()));
        let core = self.clone();
        let key = controller_key.to_string();
        Box::pin(async move {
            let before = before.await;
            if core.state().declined {
                return core.declined_answer(&key).await;
            }
            // A request already prompting (this phone's) is joined by the installer.
            let outcome = core.deps.installer.request(key).await;
            if outcome.outcome == InstallOutcome::Declined {
                core.state().declined = true;
            }
            let (disposed, current_serial, current) = {
                let state = core.state();
                (state.disposed, state.adapter_serial, state.current.clone())
            };
            let changed = before != InstallState::Installed || !current.installed();
            if !disposed
                && changed
                && serial == current_serial
                && matches!(outcome.outcome, InstallOutcome::Installed | InstallOutcome::Updated)
            {
                core.rebuild();
            }
            outcome
        })
    }

    fn ensure_running(self: &Arc<Self>) -> BoxFuture<HelperStatus> {
        if self.current().connected() {
            return Box::pin(async { HelperStatus { installed: true, running: true, version: None } });
        }
        let mut state = self.state();
        let shared = match &state.starting {
            Some(starting) => starting.clone(),
            None => {
                let started = self.deps.installer.ensure_running();
                let core = self.clone();
                let starting: Shared<BoxFuture<HelperStatus>> = (Box::pin(async move {
                    let status = started.await;
                    core.state().starting = None;
                    status
                }) as BoxFuture<HelperStatus>)
                    .shared();
                state.starting = Some(starting.clone());
                starting
            }
        };
        drop(state);
        Box::pin(shared)
    }
}

/// One screen session's view of the shared helper.
pub(super) struct SecureDesktopLease<F> {
    core: Arc<Core<F>>,
    data: Arc<LeaseData<F>>,
}

impl<F: Clone + Send + Sync + 'static> SecureDesktopLease<F> {
    fn holds(&self) -> bool {
        self.core.state().holder == Some(self.data.id)
    }

    pub(super) fn installed(&self) -> bool {
        self.core.current().installed()
    }

    pub(super) fn connected(&self) -> bool {
        self.core.current().connected()
    }

    pub(super) fn desktop(&self) -> Option<String> {
        self.core.current().desktop()
    }

    pub(super) fn session(&self) -> Option<u32> {
        self.core.current().session()
    }

    pub(super) fn locked(&self) -> Option<bool> {
        self.core.current().locked()
    }

    /// Another session holds the helper now: this one's runs are not declared, its grants and input are
    /// refused, and it hears no frames, challenges or issues.
    pub(super) fn owned_elsewhere(&self) -> bool {
        let holder = self.core.state().holder;
        holder.is_some() && holder != Some(self.data.id)
    }

    /// A video-run epoch no session has used: one helper-wide counter, only rising.
    pub(super) fn mint_video_run(&self) -> u64 {
        let mut state = self.core.state();
        state.runs += 1;
        state.runs
    }

    /// This session has just taken the hold: it starts a fresh run now (minted, declared through
    /// `set_video_run`), after the previous holder's grant was revoked and before the helper is activated.
    pub(super) fn on_hold(&self, listener: Listener<()>) -> Unsub {
        self.data.hold.add(listener)
    }

    pub(super) fn set_active(&self, active: bool) -> BoxFuture<()> {
        self.core.set_active(&self.data, active)
    }

    pub(super) fn send_input(&self, command: ScreenInput) -> BoxFuture<Result<(), HelperError>> {
        let current = {
            let state = self.core.state();
            if state.holder != Some(self.data.id) {
                return refused(NOT_HOLDER);
            }
            if !state.granted || state.declared.is_none_or(|declared| declared.by != self.data.id) {
                return refused(NOT_GRANTED);
            }
            state.current.clone()
        };
        current.send_input(command)
    }

    pub(super) fn send_grant(&self, grant: Grant) -> BoxFuture<Result<(), HelperError>> {
        self.core.send_grant(self.data.id, grant)
    }

    pub(super) fn set_video_run(&self, epoch: u64) {
        if self.holds() {
            self.core.declare(self.data.id, epoch);
        }
    }

    pub(super) fn latest_frame(&self) -> Option<F> {
        if self.holds() { self.core.current().latest_frame() } else { None }
    }

    pub(super) fn on_frame(&self, listener: Listener<F>) -> Unsub {
        self.data.frame.add(listener)
    }

    pub(super) fn on_desktop_changed(&self, listener: Listener<()>) -> Unsub {
        self.data.change.add(listener)
    }

    pub(super) fn on_grant_challenge(&self, listener: Listener<Challenge>) -> Unsub {
        self.data.challenge.add(listener)
    }

    pub(super) fn on_helper_issue(&self, listener: Listener<String>) -> Unsub {
        self.data.issue.add(listener)
    }

    /// The install state (for that phone when its key is given); never prompts.
    pub(super) fn install_state(&self, controller_key: Option<String>) -> BoxFuture<InstallState> {
        self.core.install_state(controller_key)
    }

    /// The paired phone's install request with its controller key: at most one prompt, none after a decline.
    pub(super) fn request_install(&self, controller_key: &str) -> BoxFuture<InstallResult> {
        self.core.request_install(controller_key)
    }

    /// Brings a stopped service up, unless the helper is connected (then it runs). Sessions starting together
    /// share one attempt.
    pub(super) fn ensure_running(&self) -> BoxFuture<HelperStatus> {
        self.core.ensure_running()
    }

    /// This session is done with the helper: the hold or the wait ends (as `set_active(false)`), and its
    /// listeners are dropped. Idempotent.
    pub(super) fn dispose(&self) {
        let known = self.core.state().leases.iter().any(|held| held.id == self.data.id);
        if !known {
            return;
        }
        // The hold passes on synchronously (the future only waits for the deactivation).
        drop(self.core.set_active(&self.data, false));
        self.core.state().leases.retain(|held| held.id != self.data.id);
        self.data.clear();
    }
}

pub(super) struct SecureDesktopHelper<F> {
    core: Arc<Core<F>>,
}

impl<F: Clone + Send + Sync + 'static> SecureDesktopHelper<F> {
    pub(super) fn new(deps: HelperDeps<F>) -> Self {
        let first = (deps.adapter)();
        let core = Arc::new(Core {
            state: Mutex::new(State {
                leases: Vec::new(),
                holder: None,
                waiting: Vec::new(),
                disposed: false,
                adapter_serial: 0,
                runs: 0,
                next_lease: 0,
                declarations: 0,
                declared: None,
                issued: Vec::new(),
                granted: false,
                current: first.clone(),
                detach: Vec::new(),
                declined: false,
                starting: None,
            }),
            deps,
        });
        core.attach(first);
        Self { core }
    }

    /// A new session's lease; one taken after `dispose` is inert.
    pub(super) fn lease(&self) -> SecureDesktopLease<F> {
        let mut state = self.core.state();
        state.next_lease += 1;
        let data = Arc::new(LeaseData {
            id: state.next_lease,
            hold: ListenerSet::new(),
            change: ListenerSet::new(),
            frame: ListenerSet::new(),
            challenge: ListenerSet::new(),
            issue: ListenerSet::new(),
        });
        if !state.disposed {
            state.leases.push(data.clone());
        }
        drop(state);
        SecureDesktopLease { core: self.core.clone(), data }
    }

    /// The adapter is disposed and every lease detached.
    pub(super) fn dispose(&self) {
        let (detach, current, leases) = {
            let mut state = self.core.state();
            if state.disposed {
                return;
            }
            state.disposed = true;
            let detach = std::mem::take(&mut state.detach);
            state.holder = None;
            state.declared = None;
            state.forget_grants();
            state.waiting.clear();
            (detach, state.current.clone(), std::mem::take(&mut state.leases))
        };
        for off in detach {
            off();
        }
        current.dispose();
        for lease in &leases {
            lease.clear();
        }
    }
}
