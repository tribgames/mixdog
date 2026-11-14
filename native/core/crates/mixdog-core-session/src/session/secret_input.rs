//! Secret input (Node's `apps/desktop/src/main/secret-input.ts` over `secret-requests.ts`): the
//! value the card or a paired phone hands `approval/provideSecret` for a human-gate `secret`
//! request is held in a one-shot slot under the request id the runtime minted, and the request
//! is bound to the session and target it was made for. The fill that consumes the slot
//! (`fill`) takes the value once, after the binding is checked, and hands it to the host
//! command for that one fill. The value is never logged, echoed, recorded in an op record (an
//! op digest of a short code would let it be guessed), persisted or sent back; the answer says
//! only that it was taken.

mod computer;
mod fill;
mod gates;
mod human_only;
#[cfg(test)]
mod human_only_merge_tests;
mod redact;
mod replies;
mod saved_login;
mod saved_login_host;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::PoisonError;
use std::time::Duration;

use tokio::time::Instant;

use async_trait::async_trait;
use mixdog_app_protocol::rpc::RequestId;
use mixdog_app_protocol::v2::approval::ApprovalProvideSecretParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::HostClaim;
use mixdog_core_api::DomainService;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::wrong_method;
use serde_json::Value;
use serde_json::json;

pub use computer::ComputerSecretHosts;
pub use computer::HostComputerCommands;
pub use computer::SavedLoginComputerBackend;
pub use computer::SavedLoginTurnClock;
pub use computer::SavedLoginTurns;
pub use computer::SettlingSavedLogins;
pub use fill::ComputerCommands;
pub use fill::FillGates;
pub use fill::SecretFill;
pub use fill::SecretHostCommands;
pub use fill::SecretOutcome;
pub use gates::TakeoverGates;
pub use gates::TakeoverHold;
pub use gates::TakeoverHolds;
pub(crate) use gates::takeover_hold;
pub use human_only::GatedComputerBackend;
pub use human_only::HumanOnlyLock;
pub use human_only::HumanOnlyService;
pub use redact::SessionSecrets;
pub use replies::Redact;
pub use replies::RedactingComputerBackend;
pub use replies::RedactingHostCommands;
pub use saved_login::FillContext;
pub use saved_login::FullRedactor;
pub use saved_login::PixelGuard;
pub use saved_login::SavedLoginField;
pub use saved_login::SavedLoginRegistry;
pub use saved_login::SavedLoginTurn;
pub use saved_login::SavedLoginValue;
pub use saved_login::SavedLoginVault;
pub use saved_login::SavedLoginWorker;
pub use saved_login::SavedLogins;
pub use saved_login::WindowPids;
pub use saved_login::fill_saved_login;
pub use saved_login_host::HelperWindowPids;
pub use saved_login_host::HostSavedLoginWorker;
pub use saved_login_host::HostSavedLogins;
pub use saved_login::pixels_allowed;

/// A thrown `TypeError`/`Error`: its message is the whole answer.
fn thrown(message: &str) -> CoreError {
    failed("approval", message)
}

/// `requiredString(requestId, 'secret request id', 120)`.
pub(super) fn required_request_id(id: &RequestId) -> Result<&str, &'static str> {
    let RequestId::String(id) = id else { return Err("secret request id must be a string.") };
    let id = mixdog_js::js_trim(id);
    if id.is_empty() || mixdog_js::utf16_len(id) > 120 {
        return Err("secret request id is invalid.");
    }
    Ok(id)
}

pub const PROVIDE_SECRET: &str = "approval/provideSecret";

/// `SECRET_INPUT_TIMEOUT_MS`: how long a provided value waits to be filled.
pub const SECRET_INPUT_TIMEOUT: Duration = Duration::from_millis(120_000);
/// `BINDING_TIMEOUT_MS`: a binding outlives the card's own wait (the runtime's 120 s) a little.
pub const SECRET_BINDING_TIMEOUT: Duration = Duration::from_millis(180_000);
const MAX_SECRET_LENGTH: usize = 4_096;
/// `shared/secret-slots.ts`.
pub const SECRET_USERNAME_SUFFIX: &str = "-username";
pub const SECRET_SAVE_SUFFIX: &str = "-save";

/// `/^secret_[A-Za-z0-9-]{8,80}$/`.
fn is_request_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("secret_") else { return false };
    (8..=80).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `TARGET_TOKEN` (`/^[\w.:#@-]+$/`, ASCII `\w`) within `max` characters: a window id or field
/// ref as the runtime validates it.
fn is_target_token(token: &str, max: usize) -> bool {
    !token.is_empty() && token.len() <= max && token.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:#@-".contains(&b))
}

/// The timer that drops an entry when it expires; it is cancelled when the entry leaves the map
/// (`clearTimeout`), and never keeps the process alive.
struct Timer(tokio::task::JoinHandle<()>);

impl Drop for Timer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A held entry. `generation` names this hold: a timer that woke before its entry was replaced
/// finds a newer generation and leaves the replacement alone (`map.get(id)?.timer === timer`).
struct Held<T> {
    value: T,
    generation: u64,
    /// Fixed when the entry is held: the timer sleeps until it, and an entry the timer has not yet
    /// removed (the task is late) is still refused once it is overdue.
    deadline: Instant,
    _timer: Timer,
}

/// What a secret request was bound to when it was made: its session, and for a Computer Use
/// request the exact window and field ref the agent named (never a focused field).
#[derive(Clone)]
enum Target {
    /// The page is the host's; the claim is the desktop that bound it, which alone may receive the value.
    Browser { claim: HostClaim },
    Computer { window_id: String, reference: String },
}

#[derive(Clone)]
struct Bound {
    session: String,
    target: Target,
}

/// A browser request's binding: its session and the desktop claim that holds the page.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct BrowserBinding {
    pub session: String,
    pub claim: HostClaim,
}

/// A Computer Use request's binding.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct ComputerBinding {
    pub session: String,
    pub window_id: String,
    pub reference: String,
}

#[derive(Clone, Copy)]
enum Which {
    Slot,
    Binding,
}

#[derive(Default)]
struct State {
    generation: u64,
    slots: HashMap<String, Held<String>>,
    bindings: HashMap<String, Held<Bound>>,
}

struct Inner {
    timeout: Duration,
    binding_timeout: Duration,
    state: Mutex<State>,
}

impl Inner {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The deadline of hold `generation` of `id`: the entry leaves memory unless a newer hold
    /// replaced it.
    fn expire(&self, which: Which, id: &str, generation: u64) {
        let mut state = self.state();
        match which {
            Which::Slot => expire_entry(&mut state.slots, id, generation),
            Which::Binding => expire_entry(&mut state.bindings, id, generation),
        }
    }
}

fn expire_entry<T>(map: &mut HashMap<String, Held<T>>, id: &str, generation: u64) {
    if let Entry::Occupied(entry) = map.entry(id.to_owned())
        && entry.get().generation == generation
    {
        entry.remove();
    }
}

/// `drop` less the timer (it goes with the entry): the value that was held.
fn drop_entry<T>(map: &mut HashMap<String, Held<T>>, id: &str) -> Option<T> {
    match map.entry(id.to_owned()) {
        Entry::Occupied(entry) => Some(entry.remove().value),
        Entry::Vacant(_) => None,
    }
}

/// The one-shot value slots and the bindings of the secret requests (`createSecretRequests`).
/// Every entry leaves memory at its deadline, whether or not anything asks for it again.
/// Needs a Tokio runtime for the deadlines.
pub struct SecretSlots {
    inner: Arc<Inner>,
}

impl SecretSlots {
    pub fn new(timeout: Duration) -> Self {
        Self::with_binding_timeout(timeout, SECRET_BINDING_TIMEOUT)
    }

    pub fn with_binding_timeout(timeout: Duration, binding_timeout: Duration) -> Self {
        Self { inner: Arc::new(Inner { timeout, binding_timeout, state: Mutex::new(State::default()) }) }
    }

    fn timer(&self, which: Which, id: &str, generation: u64, deadline: Instant) -> Timer {
        let inner = Arc::downgrade(&self.inner);
        let id = id.to_owned();
        Timer(tokio::spawn(async move {
            mixdog_rt::time::sleep_until(deadline).await;
            if let Some(inner) = inner.upgrade() {
                inner.expire(which, &id, generation);
            }
        }))
    }

    fn hold_slot(&self, id: &str, value: String) {
        let mut state = self.inner.state();
        state.generation += 1;
        let generation = state.generation;
        let deadline = Instant::now() + self.inner.timeout;
        let timer = self.timer(Which::Slot, id, generation, deadline);
        state.slots.insert(id.to_owned(), Held { value, generation, deadline, _timer: timer });
    }

    fn hold_binding(&self, id: &str, bound: Bound) {
        let mut state = self.inner.state();
        state.generation += 1;
        let generation = state.generation;
        let deadline = Instant::now() + self.inner.binding_timeout;
        let timer = self.timer(Which::Binding, id, generation, deadline);
        state.bindings.insert(id.to_owned(), Held { value: bound, generation, deadline, _timer: timer });
    }

    /// `bind`: the request is for `session`'s browser page, which the host holds; false (nothing
    /// bound) unless `request_id` is a runtime-minted one.
    pub fn bind(&self, request_id: &str, session: &str, claim: HostClaim) -> bool {
        if !is_request_id(request_id) {
            return false;
        }
        self.hold_binding(request_id, Bound { session: session.to_owned(), target: Target::Browser { claim } });
        true
    }

    /// `bindComputer`: false (nothing bound) unless the id is a runtime-minted one, the session
    /// is named and the window and ref are plain tokens.
    pub fn bind_computer(&self, request_id: &str, session: &str, window_id: &str, reference: &str) -> bool {
        if !is_request_id(request_id) || session.is_empty() {
            return false;
        }
        if !is_target_token(window_id, 128) || !is_target_token(reference, 64) {
            return false;
        }
        let target = Target::Computer { window_id: window_id.to_owned(), reference: reference.to_owned() };
        self.hold_binding(request_id, Bound { session: session.to_owned(), target });
        true
    }

    /// `binding`: the session a browser request is bound to, left in place (the fill drops it
    /// with `discard`).
    pub fn browser_binding(&self, request_id: &str) -> Option<BrowserBinding> {
        let state = self.inner.state();
        match state.bindings.get(request_id) {
            Some(Held { value: Bound { session, target: Target::Browser { claim } }, deadline, .. }) if Instant::now() < *deadline => {
                Some(BrowserBinding { session: session.clone(), claim: claim.clone() })
            }
            _ => None,
        }
    }

    /// `computerBinding`, left in place.
    pub fn computer_binding(&self, request_id: &str) -> Option<ComputerBinding> {
        let state = self.inner.state();
        match state.bindings.get(request_id) {
            Some(Held { value: Bound { session, target: Target::Computer { window_id, reference } }, deadline, .. }) if Instant::now() < *deadline => {
                Some(ComputerBinding { session: session.clone(), window_id: window_id.clone(), reference: reference.clone() })
            }
            _ => None,
        }
    }

    /// `provide`: false (nothing held) when the id is not a runtime-minted one or the value is
    /// empty or over 4096 UTF-16 units. Any caller that names the id may provide: the session
    /// and target binding is checked where the value is consumed.
    pub fn provide(&self, request_id: &str, value: &str) -> bool {
        if !is_request_id(request_id) || value.is_empty() || mixdog_js::utf16_len(value) > MAX_SECRET_LENGTH {
            return false;
        }
        self.hold_slot(request_id, value.to_owned());
        true
    }

    /// `has`: a value was handed for the request (it is not taken).
    pub fn has(&self, request_id: &str) -> bool {
        self.inner.state().slots.get(request_id).is_some_and(|held| Instant::now() < held.deadline)
    }

    /// `take`: one-shot; the slot is empty afterwards, and an absent one reads as `""`.
    pub fn take(&self, request_id: &str) -> String {
        let mut state = self.inner.state();
        match state.slots.entry(request_id.to_owned()) {
            // An overdue value is gone, as if its timer had run: it is not handed out.
            Entry::Occupied(entry) => {
                let held = entry.remove();
                if Instant::now() < held.deadline { held.value } else { String::new() }
            }
            Entry::Vacant(_) => String::new(),
        }
    }

    /// `discard`: the value, username and save slots of the request and its binding, unused.
    pub fn discard(&self, request_id: &str) {
        let mut state = self.inner.state();
        for id in [request_id.to_owned(), format!("{request_id}{SECRET_USERNAME_SUFFIX}"), format!("{request_id}{SECRET_SAVE_SUFFIX}")] {
            drop_entry(&mut state.slots, &id);
        }
        drop_entry(&mut state.bindings, request_id);
    }
}

/// `approval/provideSecret`: the card's or a paired phone's value into the slot of a request.
pub struct SecretInputService {
    slots: Arc<SecretSlots>,
}

impl SecretInputService {
    pub fn new(slots: Arc<SecretSlots>) -> Self {
        Self { slots }
    }
}

#[async_trait]
impl DomainService for SecretInputService {
    fn methods(&self) -> &'static [&'static str] {
        &[PROVIDE_SECRET]
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            PROVIDE_SECRET => {
                // The op record would hold the request: it is refused before the value is read.
                req.op.as_ref().ok_or(CoreError::OpIdRequired)?;
                let params: ApprovalProvideSecretParams = decode(&req)?;
                let id = required_request_id(&params.request_id).map_err(thrown)?;
                // The IPC handler answers `false` for a refusal; the wire result is empty, so a
                // refusal is an error (decisions.md, "wu-secret-input").
                if !self.slots.provide(id, &params.secret) {
                    return Err(thrown("secret was not accepted."));
                }
                Ok(Reply::Value(json!({})))
            }
            other => Err(wrong_method("secret input", other)),
        }
    }

    fn notify(&self, _: Method, _: Value, _: ConnectionId) -> Admit {
        Admit::Accepted
    }
}
