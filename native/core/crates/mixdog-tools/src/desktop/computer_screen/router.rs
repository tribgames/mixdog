//! The one serialized path every screen input, backend switch and release of one session takes to a desktop
//! (Node: `screen-input-router.ts`). Two backends can inject: `Desktop` (the in-process injector on the
//! ordinary desktop) and `Secure` (the secure-desktop helper).
//!
//! - Presses per backend, with origin: each press is recorded under the backend that injected it and the
//!   desktop it landed on (Windows session + desktop), keyed by origin and key. Its release goes back only
//!   through that backend, and only while that backend reports the same identity, so it never reaches
//!   another session or desktop.
//! - Released at defined points, then forgotten: `release_all` (stop, revoke, downgrade, demote, viewer
//!   leave, `screen-release`) and `switch_to` (the previous backend's presses, before the switch). A press
//!   its backend cannot deliver at that moment (unreachable, on another desktop, a failed or abandoned
//!   send) is dropped and counted through `on_dropped`; nothing is kept for later.
//! - Serialized: input, switches and releases run strictly in order, one at a time, so a release always
//!   follows the in-flight command it must undo. A call takes its place in the queue when it is made, not
//!   when its future is first polled.
//! - Cancellable: `cancel` bumps a generation; queued input from before it is dropped when its turn comes,
//!   a multi-command plan stops between commands, and AltGr text stops before the text and before each
//!   modifier re-press. Releases are never cancelled.
//! - Abandonable: `abandon` (the session's stop deadline) fails every in-flight and later backend call at
//!   once, so a backend that stopped answering cannot hold the queue.
//! - Idempotent: releasing with nothing held sends nothing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;

use async_trait::async_trait;
use mixdog_core_api::domain::computer::DesktopIdentity;
use mixdog_core_api::domain::computer::PointerButton;
use mixdog_core_api::domain::computer::ScreenInput;
use tokio::sync::oneshot;
use tokio::sync::watch;

pub(super) type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BackendId {
    Desktop,
    Secure,
}

impl BackendId {
    fn index(self) -> usize {
        match self {
            Self::Desktop => 0,
            Self::Secure => 1,
        }
    }
}

const BACKENDS: [BackendId; 2] = [BackendId::Desktop, BackendId::Secure];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RouteOutcome {
    Applied,
    Rejected,
}

/// A backend send that did not complete: the desktop refused it, or the router was abandoned.
#[derive(Debug)]
pub(super) struct SendError;

#[async_trait]
pub(super) trait ScreenBackend: Send + Sync {
    /// Completes once the desktop accepted the command; fails otherwise.
    async fn send(&self, command: ScreenInput) -> Result<(), SendError>;
    /// The desktop a command sent now would land on; `None` while unknown or unreachable (then no press is
    /// made and no release is delivered).
    fn identity(&self) -> Option<DesktopIdentity>;
}

/// Whether the plan may still run; re-read when its turn comes and before each command.
pub(super) type Allowed = Arc<dyn Fn() -> bool + Send + Sync>;

/// A hook that runs inside a switch's turn; a failure does not stop the switch.
pub(super) type Hook = Box<dyn FnOnce() -> BoxFuture<Result<(), SendError>> + Send>;

/// Hooks run inside a switch's turn, so activation and the backend change are one atomic step relative to
/// input.
#[derive(Default)]
pub(super) struct SwitchHooks {
    pub before: Option<Hook>,
    pub after: Option<Hook>,
}

/// Ctrl, Alt and Win (generic and sided). Text typed while one of them is held would fire a shortcut instead
/// of typing.
const SHORTCUT_MODIFIER_VKS: [u32; 8] = [0x11, 0x12, 0x5b, 0x5c, 0xa2, 0xa3, 0xa4, 0xa5];
/// AltGr: Windows reports it as Right Alt, with Left Ctrl synthesized beside it.
const ALTGR_RIGHT_ALT: u32 = 0xa5;
const ALTGR_VKS: [u32; 2] = [0xa2, ALTGR_RIGHT_ALT];

fn same_desktop(a: Option<&DesktopIdentity>, b: Option<&DesktopIdentity>) -> bool {
    matches!((a, b), (Some(a), Some(b)) if a.session == b.session && a.desktop == b.desktop)
}

/// A held press's map key within its backend: origin plus key or button.
fn held_key(origin: &DesktopIdentity, hold: &str) -> String {
    format!("{}|{}|{hold}", origin.session, origin.desktop)
}

fn button_name(button: PointerButton) -> &'static str {
    match button {
        PointerButton::Left => "left",
        PointerButton::Right => "right",
        PointerButton::Middle => "middle",
    }
}

/// What a command holds: the key it is held under, whether it presses, and the command that releases it;
/// `None` for a command that holds nothing.
fn hold_of(command: &ScreenInput) -> Option<(String, bool, ScreenInput)> {
    match command {
        ScreenInput::Button { button, down, .. } => Some((
            format!("btn:{}", button_name(*button)),
            *down,
            ScreenInput::Button { button: *button, down: false, at: None },
        )),
        ScreenInput::Key { vk, scan, extended, down } => Some((
            format!("key:{vk}:{scan}:{}", u8::from(*extended)),
            *down,
            ScreenInput::Key { vk: *vk, scan: *scan, extended: *extended, down: false },
        )),
        _ => None,
    }
}

/// A press a backend injected and has not released: its release command and the desktop it landed on. The
/// id tells one press from another that took its place under the same key.
#[derive(Clone, Debug)]
struct HeldPress {
    id: u64,
    release: ScreenInput,
    origin: DesktopIdentity,
}

/// Insertion-ordered like the map Node keeps: setting a key that is held replaces it in place.
#[derive(Default)]
struct HeldMap(Vec<(String, HeldPress)>);

impl HeldMap {
    fn get(&self, key: &str) -> Option<&HeldPress> {
        self.0.iter().find(|(held, _)| held == key).map(|(_, press)| press)
    }

    fn set(&mut self, key: String, press: HeldPress) {
        match self.0.iter_mut().find(|(held, _)| *held == key) {
            Some(entry) => entry.1 = press,
            None => self.0.push((key, press)),
        }
    }

    fn delete(&mut self, key: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|(held, _)| held != key);
        self.0.len() != before
    }

    fn presses(&self) -> Vec<HeldPress> {
        self.0.iter().map(|(_, press)| press.clone()).collect()
    }
}

struct State {
    generation: u64,
    active: Option<BackendId>,
    abandoned: bool,
    held: [HeldMap; 2],
    presses: u64,
}

struct Core {
    backends: [Arc<dyn ScreenBackend>; 2],
    on_dropped: Box<dyn Fn(BackendId, usize) + Send + Sync>,
    state: Mutex<State>,
    tail: Mutex<Option<oneshot::Receiver<()>>>,
    abandoned: watch::Sender<bool>,
}

/// The state a command reads, the generation it was made in and the gate it re-reads.
struct Live {
    core: Arc<Core>,
    generation: u64,
    allowed: Allowed,
}

impl Live {
    fn ok(&self) -> bool {
        // Read before the gate runs: the gate may read the router itself.
        let generation = self.core.state().generation;
        generation == self.generation && (self.allowed)()
    }
}

/// How a text command is typed given the modifiers this backend holds: `Plain` (none held), `AltGr` (only
/// AltGr held, on the current desktop: lifted around the text and restored after), or `Refused`.
enum TextModifiers {
    Plain,
    Refused,
    AltGr(Vec<String>),
}

impl Core {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn identity(&self, backend: BackendId) -> Option<DesktopIdentity> {
        self.backends[backend.index()].identity()
    }

    /// Runs a backend call that `abandon` cuts off: once abandoned it is not made and fails at once.
    async fn guard<T, Fut>(&self, call: impl FnOnce() -> Fut) -> Result<T, SendError>
    where
        Fut: Future<Output = Result<T, SendError>>,
    {
        if self.state().abandoned {
            return Err(SendError);
        }
        let mut abandoned = self.abandoned.subscribe();
        let call = call();
        tokio::pin!(call);
        tokio::select! {
            biased;
            () = async {
                let _ = abandoned.wait_for(|abandoned| *abandoned).await;
            } => Err(SendError),
            result = &mut call => result,
        }
    }

    async fn send(&self, backend: BackendId, command: ScreenInput) -> Result<(), SendError> {
        self.guard(|| self.backends[backend.index()].send(command)).await
    }

    /// Sends each press's release, in order, through `backend` while it reports that press's origin;
    /// returns how many could not be delivered.
    async fn deliver(&self, backend: BackendId, presses: Vec<HeldPress>) -> usize {
        let mut dropped = 0;
        for press in presses {
            let delivered = same_desktop(Some(&press.origin), self.identity(backend).as_ref())
                && self.send(backend, press.release).await.is_ok();
            if !delivered {
                dropped += 1;
            }
        }
        dropped
    }

    /// Sends the release of every press `backend` holds, through `backend`, and forgets them all. One it
    /// cannot deliver now is dropped and counted: nothing is carried to a later point.
    async fn release(&self, backend: BackendId) {
        let presses = {
            let mut state = self.state();
            let held = &mut state.held[backend.index()];
            let presses = held.presses();
            held.0.clear();
            presses
        };
        let dropped = self.deliver(backend, presses).await;
        if dropped > 0 {
            (self.on_dropped)(backend, dropped);
        }
    }

    fn text_modifiers(&self, backend: BackendId) -> TextModifiers {
        let here = self.identity(backend);
        let held: Vec<(String, HeldPress)> = self.state().held[backend.index()]
            .0
            .iter()
            .filter(|(_, entry)| matches!(entry.release, ScreenInput::Key { vk, .. } if SHORTCUT_MODIFIER_VKS.contains(&vk)))
            .cloned()
            .collect();
        if held.is_empty() {
            return TextModifiers::Plain;
        }
        let vk_of = |entry: &HeldPress| match entry.release {
            ScreenInput::Key { vk, .. } => Some(vk),
            _ => None,
        };
        let alt_gr = held.iter().any(|(_, entry)| vk_of(entry) == Some(ALTGR_RIGHT_ALT))
            && held.iter().all(|(_, entry)| {
                vk_of(entry).is_some_and(|vk| ALTGR_VKS.contains(&vk)) && same_desktop(Some(&entry.origin), here.as_ref())
            });
        if alt_gr {
            TextModifiers::AltGr(held.into_iter().map(|(id, _)| id).collect())
        } else {
            TextModifiers::Refused
        }
    }

    /// Types literal text. Under a held shortcut modifier it is refused (never queued or retried) so it
    /// cannot fire a shortcut. Under AltGr alone the session's own AltGr keys are lifted, the text is typed
    /// as Unicode, and the keys are pressed again, so the phone's held state is unchanged and the target
    /// sees plain characters.
    ///
    /// `live` (generation + authorization) is checked before the text and before each re-press. Once it
    /// fails nothing positive is sent: the text is skipped, no modifier is pressed again, and the modifiers
    /// already lifted are no longer held (they are up). Only modifiers not yet lifted stay held, for the
    /// release that follows the cancel.
    ///
    /// The AltGr keys' origin is rechecked against the backend's identity before every lift, before the text
    /// and before every re-press. Once it no longer matches, nothing more is sent to this backend from
    /// here; the keys not yet lifted cannot be released on their desktop now, so they are dropped and
    /// counted.
    async fn send_text(&self, backend: BackendId, command: &ScreenInput, live: &Live) -> bool {
        let lifts = match self.text_modifiers(backend) {
            TextModifiers::Refused => return false,
            TextModifiers::Plain => {
                if !live.ok() {
                    return false;
                }
                return self.send(backend, command.clone()).await.is_ok();
            }
            TextModifiers::AltGr(lifts) => lifts,
        };
        // `text_modifiers` only chose AltGr with every key on the current identity.
        let origin = self.identity(backend);
        let mut moved = false;
        let mut on_origin = |core: &Core| {
            if !moved && !same_desktop(origin.as_ref(), core.identity(backend).as_ref()) {
                moved = true;
            }
            !moved
        };
        let mut lifted: Vec<&String> = Vec::new();
        let mut lifts_done = true;
        for id in &lifts {
            let Some(entry) = self.state().held[backend.index()].get(id).cloned() else {
                continue;
            };
            if !on_origin(self) {
                lifts_done = false;
                break;
            }
            if self.send(backend, entry.release).await.is_err() {
                // Its state is uncertain: it stays held, so a release still follows.
                lifts_done = false;
                break;
            }
            lifted.push(id);
        }
        let mut typed = false;
        if lifts_done && live.ok() && on_origin(self) {
            typed = self.send(backend, command.clone()).await.is_ok();
        }
        for id in &lifted {
            let Some(entry) = self.state().held[backend.index()].get(id).cloned() else {
                continue;
            };
            let ScreenInput::Key { vk, scan, extended, .. } = entry.release else {
                continue;
            };
            if !live.ok() || !on_origin(self) {
                // Cancelled (or moved desktop): the key is up; never pressed again.
                self.state().held[backend.index()].delete(id);
                continue;
            }
            // Still held while it is re-pressed: a cancel landing now is followed by a release of it.
            let _ = self.send(backend, ScreenInput::Key { vk, scan, extended, down: true }).await;
        }
        if moved {
            // Not yet lifted, and their desktop is no longer reachable here.
            let mut unreleasable = 0;
            {
                let mut state = self.state();
                for id in &lifts {
                    if !lifted.contains(&id) && state.held[backend.index()].delete(id) {
                        unreleasable += 1;
                    }
                }
            }
            if unreleasable > 0 {
                (self.on_dropped)(backend, unreleasable);
            }
        }
        typed
    }

    async fn run_dispatch(&self, commands: Vec<ScreenInput>, live: Live) -> RouteOutcome {
        let active = self.state().active;
        let Some(backend) = active else {
            return RouteOutcome::Rejected;
        };
        if !live.ok() {
            return RouteOutcome::Rejected;
        }
        for command in commands {
            if !live.ok() {
                return RouteOutcome::Rejected;
            }
            if matches!(command, ScreenInput::Text(_)) {
                if !self.send_text(backend, &command, &live).await {
                    return RouteOutcome::Rejected;
                }
                continue;
            }
            let hold = hold_of(&command);
            let here = self.identity(backend);
            let key = match (&hold, &here) {
                (Some((hold, _, _)), Some(here)) => Some(held_key(here, hold)),
                _ => None,
            };
            if let Some((_, down, release)) = hold {
                let owned = key.as_ref().is_some_and(|key| self.state().held[backend.index()].get(key).is_some());
                if !down && !owned {
                    continue;
                }
                if down {
                    // A press is only made where its landing place is known, so its release can be
                    // routed back to exactly that desktop.
                    let (Some(key), Some(here)) = (&key, here) else {
                        return RouteOutcome::Rejected;
                    };
                    // Held before it is sent: a down whose delivery is uncertain is still released.
                    let mut state = self.state();
                    state.presses += 1;
                    let id = state.presses;
                    state.held[backend.index()].set(key.clone(), HeldPress { id, release, origin: here });
                }
                if self.send(backend, command).await.is_err() {
                    return RouteOutcome::Rejected;
                }
                if !down && let Some(key) = &key {
                    self.state().held[backend.index()].delete(key);
                }
            } else if self.send(backend, command).await.is_err() {
                return RouteOutcome::Rejected;
            }
        }
        RouteOutcome::Applied
    }

    async fn run_dispatch_keys(&self, downs: Vec<ScreenInput>, live: Live) -> RouteOutcome {
        let active = self.state().active;
        let origin = active.and_then(|backend| self.identity(backend));
        let (Some(backend), Some(origin)) = (active, origin) else {
            return RouteOutcome::Rejected;
        };
        if !live.ok() {
            return RouteOutcome::Rejected;
        }
        let mut pressed: Vec<(String, u64, HeldPress)> = Vec::new();
        let mut complete = true;
        for down in downs {
            let hold = hold_of(&down);
            let Some((hold, true, release)) = hold else {
                complete = false;
                break;
            };
            if !live.ok() || !same_desktop(Some(&origin), self.identity(backend).as_ref()) {
                complete = false;
                break;
            }
            let key = held_key(&origin, &hold);
            if self.state().held[backend.index()].get(&key).is_some() {
                continue;
            }
            let press = {
                let mut state = self.state();
                state.presses += 1;
                let press = HeldPress { id: state.presses, release, origin: origin.clone() };
                // Held before it is sent: a down whose delivery is uncertain is still released.
                state.held[backend.index()].set(key.clone(), press.clone());
                press
            };
            pressed.push((key, press.id, press));
            if self.send(backend, down).await.is_err() {
                complete = false;
                break;
            }
        }
        // Released in reverse; a release point that ran meanwhile already took (and released or dropped)
        // any of them it found.
        let owed: Vec<HeldPress> = {
            let mut state = self.state();
            let held = &mut state.held[backend.index()];
            let still: Vec<bool> = pressed.iter().map(|(key, id, _)| held.get(key).is_some_and(|press| press.id == *id)).collect();
            for ((key, _, _), still) in pressed.iter().zip(&still) {
                if *still {
                    held.delete(key);
                }
            }
            pressed.iter().zip(&still).filter(|(_, still)| **still).map(|((_, _, press), _)| press.clone()).rev().collect()
        };
        let dropped = self.deliver(backend, owed).await;
        if dropped > 0 {
            (self.on_dropped)(backend, dropped);
        }
        if complete && dropped == 0 { RouteOutcome::Applied } else { RouteOutcome::Rejected }
    }

    async fn run_switch(&self, next: Option<BackendId>, hooks: SwitchHooks) {
        let SwitchHooks { before, after } = hooks;
        let previous = self.state().active;
        if let Some(previous) = previous
            && Some(previous) != next
        {
            self.release(previous).await;
        }
        if let Some(before) = before {
            let _ = self.guard(before).await;
        }
        self.state().active = next;
        if let Some(after) = after {
            let _ = self.guard(after).await;
        }
    }
}

pub(super) struct ScreenInputRouter {
    core: Arc<Core>,
}

impl ScreenInputRouter {
    /// `on_dropped(backend, count)`: a release point dropped `count` presses `backend` could not release.
    pub(super) fn new(
        desktop: Arc<dyn ScreenBackend>,
        secure: Arc<dyn ScreenBackend>,
        on_dropped: impl Fn(BackendId, usize) + Send + Sync + 'static,
    ) -> Self {
        let (abandoned, _) = watch::channel(false);
        Self {
            core: Arc::new(Core {
                backends: [desktop, secure],
                on_dropped: Box::new(on_dropped),
                state: Mutex::new(State {
                    generation: 0,
                    active: None,
                    abandoned: false,
                    held: [HeldMap::default(), HeldMap::default()],
                    presses: 0,
                }),
                tail: Mutex::new(None),
                abandoned,
            }),
        }
    }

    pub(super) fn active_backend(&self) -> Option<BackendId> {
        self.core.state().active
    }

    /// Any press is held.
    pub(super) fn holds_input(&self) -> bool {
        self.core.state().held.iter().any(|held| !held.0.is_empty())
    }

    /// Queued input from before this call is dropped; releases still run.
    pub(super) fn cancel(&self) {
        self.core.state().generation += 1;
    }

    /// No backend is sent anything more: in-flight calls fail now, later ones fail at once, so the
    /// releases that follow are dropped. Permanent.
    pub(super) fn abandon(&self) {
        let mut state = self.core.state();
        if state.abandoned {
            return;
        }
        state.abandoned = true;
        state.generation += 1;
        self.core.abandoned.send_replace(true);
    }

    /// Takes the call's place in the queue now; the returned future runs the task when its turn comes.
    fn enqueue<T, F>(&self, task: impl FnOnce(Arc<Core>) -> F + Send + 'static) -> BoxFuture<T>
    where
        T: Send + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        let (done, next) = oneshot::channel();
        let previous = self.core.tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).replace(next);
        let core = self.core.clone();
        Box::pin(async move {
            if let Some(previous) = previous {
                // The previous step ended, or its future was dropped: either way it is this one's turn.
                let _ = previous.await;
            }
            let outcome = task(core).await;
            let _ = done.send(());
            outcome
        })
    }

    fn live(&self, allowed: Allowed) -> Live {
        Live { core: self.core.clone(), generation: self.core.state().generation, allowed }
    }

    /// Injects a plan through the active backend. `allowed` is re-read when the plan's turn comes and
    /// before each command (and inside AltGr text), so a stop, revoke or downgrade that lands while it
    /// waits drops it. An up is sent only for a press this backend holds on its current desktop; any other
    /// up is skipped (it is not ours to lift here).
    pub(super) fn dispatch(&self, commands: Vec<ScreenInput>, allowed: Allowed) -> BoxFuture<RouteOutcome> {
        let live = self.live(allowed);
        self.enqueue(move |core| async move { core.run_dispatch(commands, live).await })
    }

    /// An atomic key combo (`screen-keys`) through the active backend, as one step of the queue: each key
    /// pressed in order, then every key it pressed released in reverse. Presses are recorded with their
    /// origin like any other, so a release point landing between steps still finds them.
    ///
    /// `allowed` (generation + control) is re-read before each press, and the desktop must stay the one the
    /// combo started on. Once either fails, no further key is pressed. The releases are never gated by
    /// `allowed`: whatever the combo pressed is lifted, in reverse, through this backend while it reports
    /// the keys' origin; one it cannot deliver there is dropped and counted. A key this backend already
    /// holds on that desktop (a modifier the phone holds down) is neither pressed nor released.
    pub(super) fn dispatch_keys(&self, downs: Vec<ScreenInput>, allowed: Allowed) -> BoxFuture<RouteOutcome> {
        let live = self.live(allowed);
        self.enqueue(move |core| async move { core.run_dispatch_keys(downs, live).await })
    }

    /// Releases every press on every backend. Runs after any in-flight command, is never cancelled, and is
    /// idempotent.
    pub(super) fn release_all(&self) -> BoxFuture<()> {
        self.enqueue(|core| async move {
            for backend in BACKENDS {
                core.release(backend).await;
            }
        })
    }

    /// Makes `next` the active backend (`None`: none can inject). Before the switch, the previous
    /// backend's presses are released through it.
    pub(super) fn switch_to(&self, next: Option<BackendId>, hooks: SwitchHooks) -> BoxFuture<()> {
        self.enqueue(move |core| async move { core.run_switch(next, hooks).await })
    }

    /// Resolves once every queued step has run.
    pub(super) fn settled(&self) -> BoxFuture<()> {
        self.enqueue(|_| async {})
    }
}
