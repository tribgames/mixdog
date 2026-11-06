//! The fill of a secret request (Node's `fillSecretInput` of `browser/host-agent.ts` and
//! `typeComputerSecret` / `bindComputerSecret` of `secret-input.ts`): the value the card handed
//! the slot is taken exactly once, after the request's session, binding and lock are checked,
//! and goes to the browser or computer host command for that one fill. Every refusal drops the
//! request's slots and binding unused and answers only its outcome. The value is registered for
//! its session's redaction and is never logged, persisted or put in an answer.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_api::ClaimedHostChannel;
use mixdog_core_api::CoreError;
use mixdog_core_api::HostCapability;
use mixdog_core_api::HostClaim;
use mixdog_core_api::HostError;
use mixdog_core_api::ids::Method;
use mixdog_core_api::ids::ThreadId;
use mixdog_js::JsRegex;
use mixdog_protocol::JsonValue;
use mixdog_tools::desktop::host::HOST_COMMAND_FAILED;
use mixdog_tools::desktop::host::HostCommandError;
use mixdog_tools::desktop::host::HostCommands;
use serde_json::Value;
use serde_json::json;

use super::SECRET_SAVE_SUFFIX;
use super::SECRET_USERNAME_SUFFIX;
use super::SecretSlots;
use super::redact::SessionSecrets;

/// What the agent hears about a fill (`human-gate/requests.mjs` `HANDOFF_OUTCOMES`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SecretOutcome {
    Entered,
    NoField,
    PageChanged,
    Blocked,
    Expired,
}

impl SecretOutcome {
    pub fn text(self) -> &'static str {
        match self {
            Self::Entered => "entered",
            Self::NoField => "no_field",
            Self::PageChanged => "page_changed",
            Self::Blocked => "blocked",
            Self::Expired => "expired",
        }
    }

    fn from_text(text: &str) -> Option<Self> {
        [Self::Entered, Self::NoField, Self::PageChanged, Self::Blocked, Self::Expired].into_iter().find(|o| o.text() == text)
    }
}

/// The two locks a fill checks before it takes the value.
pub trait FillGates: Send + Sync {
    /// `takeoverGate.assertFree(session)`: false while the session's page is handed to the user
    /// (its takeover is pending); another session's takeover never blocks it.
    fn browser_free(&self, thread: &ThreadId) -> bool;
    /// `beginComputerOperation()()`: false while a human-only approval is pending.
    fn computer_free(&self) -> bool;
}

/// A Computer Use command to the host (`host.executeSerialized`). `Err` is the failure's
/// message, which says whether the window or field is gone.
#[async_trait]
pub trait ComputerCommands: Send + Sync {
    async fn execute(&self, thread: &ThreadId, command: Value) -> Result<Value, String>;
}

/// `STALE_TARGET`: a computer input error that says its window or ref no longer exists.
fn stale_target(message: &str) -> bool {
    JsRegex::new_static(r"stale_target|\bis stale\b|stale or invalid", "i").is_match(message)
}

/// The bound field as a fresh read shows it after the background write.
struct BoundField {
    /// The field's ref in that read: a read retires every earlier ref.
    reference: String,
    value: String,
    /// UIA IsPassword / MSAA protected, as the typing guard reads them; true when unreadable.
    is_password: bool,
}

/// The fills of the secret requests: the slots they take from, the secrets of the sessions they
/// filled, and the locks and host commands they go through.
pub struct SecretFill {
    slots: Arc<SecretSlots>,
    sessions: SessionSecrets,
    gates: Arc<dyn FillGates>,
    computer: Arc<dyn ComputerCommands>,
    channel: Arc<dyn ClaimedHostChannel>,
}

impl SecretFill {
    /// `slots` is the registry `approval/provideSecret` fills.
    pub fn new(slots: Arc<SecretSlots>, gates: Arc<dyn FillGates>, computer: Arc<dyn ComputerCommands>, channel: Arc<dyn ClaimedHostChannel>) -> Self {
        Self { slots, sessions: SessionSecrets::new(), gates, computer, channel }
    }

    /// `redact` of the window process's registry: `text` with every value filled for the session
    /// hidden. A reply of the session that may carry a filled value goes through it.
    pub fn redact(&self, thread: &ThreadId, text: &str) -> String {
        self.sessions.redact(thread.as_str(), text)
    }

    /// The session ended: its secrets and focus leave memory.
    pub fn forget(&self, thread: &ThreadId) {
        self.sessions.forget(thread.as_str());
    }

    /// While a typed secret's field may hold focus, no capture leaves the host.
    pub fn focus_armed(&self, thread: &ThreadId) -> bool {
        self.sessions.focus_armed(thread.as_str())
    }

    /// The next input action (which moves on) lifts the hold.
    pub fn clear_focus(&self, thread: &ThreadId) {
        self.sessions.clear_focus(thread.as_str());
    }

    fn refuse(&self, request_id: &str, outcome: SecretOutcome) -> SecretOutcome {
        self.slots.discard(request_id);
        outcome
    }

    /// Bind a browser request to `thread`'s page, held by the desktop `claim`, once that desktop
    /// bound it (`secret_bind` answered an origin and a field form).
    pub fn bind_browser(&self, thread: &ThreadId, request_id: &str, claim: HostClaim) -> bool {
        self.slots.bind(request_id, thread.as_str(), claim)
    }

    /// `secret_bind` as the handoff tool sends it, served by the desktop that holds the page: the
    /// request is bound to the session and to that desktop's claim when the desktop bound the
    /// page (an origin and a field form came back).
    async fn bind_through(&self, thread: &ThreadId, input: JsonValue) -> Result<JsonValue, HostCommandError> {
        let request_id = request_id_of(&input).to_owned();
        let (claim, facts) = self.channel.request_claimed(HostCapability::Browser, BROWSER_COMMAND, command_params(thread, "secret_bind", input)).await.map_err(command_error)?;
        let named = |key: &str| facts.get(key).and_then(Value::as_str).is_some_and(|text| !text.is_empty());
        if named("origin") && named("form") {
            self.bind_browser(thread, &request_id, claim);
        }
        Ok(facts)
    }

    /// `fillSecretInput`: one secret the user typed into the card, filled into the page the
    /// request was bound to (`secret_bind`), never the selected tab or the focused field, in the
    /// order Node checks it: the value was provided (`expired`), the binding is this session's
    /// and its takeover lock is free (`blocked`), the bound desktop still holds the claim and its
    /// page, document, origin and field are the bound ones (`page_changed`, `no_field`), and only
    /// then the value is taken and sent, to that desktop alone. Every refusal drops the request's
    /// slots and binding unused, and registers nothing for redaction: only a value that is sent
    /// is remembered. The sign-in the user chose to save is stored by the desktop after it was
    /// entered.
    pub async fn fill_browser(&self, thread: &ThreadId, request_id: &str) -> SecretOutcome {
        let session = thread.as_str();
        let binding = self.slots.browser_binding(request_id);
        if !self.slots.has(request_id) {
            return self.refuse(request_id, SecretOutcome::Expired);
        }
        let Some(binding) = binding.filter(|b| b.session == session && self.gates.browser_free(thread)) else {
            return self.refuse(request_id, SecretOutcome::Blocked);
        };
        // Phase one: the bound desktop checks the page, with no value on the wire. It answers
        // `ready` and its own host id, or the outcome that refuses the fill.
        let check = self
            .channel
            .request_to(&binding.claim, HostCapability::Browser, BROWSER_COMMAND, command_params(thread, "secret_precheck", json!({ "request_id": request_id })))
            .await;
        let answer = check.ok();
        let text = answer.as_ref().and_then(|a| a.get("text")).and_then(Value::as_str).unwrap_or_default();
        let from_bound_host = answer.as_ref().and_then(|a| a.get("hostId")).and_then(Value::as_str) == Some(binding.claim.host.as_str());
        if text != "ready" || !from_bound_host {
            let refusal = SecretOutcome::from_text(text).filter(|o| *o != SecretOutcome::Entered).unwrap_or(SecretOutcome::Blocked);
            return self.refuse(request_id, refusal);
        }
        // Phase two: the value is taken and sent, to the desktop that answered and only while it
        // still holds the claim.
        let value = self.slots.take(request_id);
        // The deadline can pass between the check and the take (a Node turn cannot interleave).
        if value.is_empty() {
            return self.refuse(request_id, SecretOutcome::Expired);
        }
        let username = self.slots.take(&format!("{request_id}{SECRET_USERNAME_SUFFIX}"));
        let save = self.slots.take(&format!("{request_id}{SECRET_SAVE_SUFFIX}")) == "1";
        self.slots.discard(request_id);
        self.sessions.remember(session, &value);
        let input = json!({ "request_id": request_id, "value": value, "username": username, "save": save });
        match self.channel.request_to(&binding.claim, HostCapability::Browser, BROWSER_COMMAND, command_params(thread, "secret_fill", input)).await {
            Ok(answer) => answer.get("text").and_then(Value::as_str).and_then(SecretOutcome::from_text).unwrap_or(SecretOutcome::Blocked),
            Err(_) => SecretOutcome::Blocked,
        }
    }
    /// `bindComputerSecret` (`secret_bind`): bind the request to the exact window and field ref
    /// the agent named. `bound`, or `no_field` when that target is missing or not a plain token.
    pub fn computer_bind(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String {
        let bound = self.slots.bind_computer(request_id, thread.as_str(), window_id, reference);
        if bound { "bound" } else { "no_field" }.to_owned()
    }

    /// Re-reads the window with the bound ref named: the host marks the element that ref pointed
    /// at (`bound_ref`, by its runtime identity, which survives the read's new refs) and says
    /// whether it is a password field. Nothing from the read is returned or stored.
    async fn read_bound_field(&self, thread: &ThreadId, window_id: &str, reference: &str) -> Option<BoundField> {
        let command = json!({
            "action": "find",
            "session_id": thread.as_str(),
            "window_id": window_id,
            "ref": reference,
            "max_elements": 1000,
        });
        let reply = self.computer.execute(thread, command).await.ok()?;
        let field = reply.get("elements")?.as_array()?.iter().find(|element| element.get("bound_ref") == Some(&Value::Bool(true)))?;
        let reference = field.get("ref").and_then(Value::as_str).filter(|r| !r.is_empty())?;
        Some(BoundField {
            reference: reference.to_owned(),
            value: field.get("value").and_then(Value::as_str).unwrap_or_default().to_owned(),
            is_password: field.get("is_password") != Some(&Value::Bool(false)),
        })
    }

    /// `typeComputerSecret`: type the request's value once into the window and field ref it was
    /// bound to at request time (`computer_bind`), never the focused field, through the ordinary
    /// input path, discarding its reply (the capture of a field holding the secret never leaves).
    /// The binding and the lock are checked before the value is taken: a request never bound
    /// (`no_field`), a target other than its binding (`page_changed`) or a held session or
    /// screen (`blocked`) drops the value and binding unused, never types it. `window_id` and
    /// `reference` are the target the agent names now; empty names none.
    pub async fn computer_input(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> String {
        self.type_computer(thread, request_id, window_id, reference).await.text().to_owned()
    }

    async fn type_computer(&self, thread: &ThreadId, request_id: &str, window_id: &str, reference: &str) -> SecretOutcome {
        let session = thread.as_str();
        let binding = self.slots.computer_binding(request_id);
        if !self.slots.has(request_id) {
            return self.refuse(request_id, SecretOutcome::Expired);
        }
        let Some(binding) = binding else { return self.refuse(request_id, SecretOutcome::NoField) };
        if binding.session != session {
            return self.refuse(request_id, SecretOutcome::Blocked);
        }
        if (!window_id.is_empty() && window_id != binding.window_id) || (!reference.is_empty() && reference != binding.reference) {
            return self.refuse(request_id, SecretOutcome::PageChanged);
        }
        if !self.gates.computer_free() {
            return self.refuse(request_id, SecretOutcome::Blocked);
        }
        let value = self.slots.take(request_id);
        if value.is_empty() {
            return self.refuse(request_id, SecretOutcome::Expired);
        }
        self.slots.discard(request_id);
        self.sessions.remember(session, &value);
        self.sessions.arm_focus(session);
        match self.type_into(thread, &value, &binding.window_id, &binding.reference).await {
            Ok(()) => SecretOutcome::Entered,
            // The window or field went away: the input path refuses a stale target before typing.
            Err(message) if stale_target(&message) => SecretOutcome::PageChanged,
            Err(_) => SecretOutcome::Blocked,
        }
    }

    async fn type_into(&self, thread: &ThreadId, value: &str, window_id: &str, reference: &str) -> Result<(), String> {
        // Every secret first goes in by the background value write: a password is never sent as
        // keystrokes, which could land in another window.
        let write = json!({ "action": "type", "text": value, "session_id": thread.as_str(), "ref": reference, "window_id": window_id });
        self.computer.execute(thread, write).await?;
        let mut chars = value.chars();
        let first = chars.next().map(String::from);
        if chars.next().is_none() {
            return Ok(());
        }
        // A background write sets one control's value, so a segmented code input (one digit per
        // box) keeps only the first digit. The field is read back and identified by the element
        // the bound ref pointed at, not by a ref. Best effort: a read that fails or finds nothing
        // leaves the result the write itself produced.
        let Some(field) = self.read_bound_field(thread, window_id, reference).await else { return Ok(()) };
        // Real keystrokes (focus advancing box to box) only when the field is positively
        // re-identified, is not a password, and holds just the first character: a one-character
        // box. The foreground delivery is held to this window and refuses when the foreground moves.
        if field.is_password || Some(&field.value) != first.as_ref() {
            return Ok(());
        }
        let foreground = json!({
            "action": "type",
            "text": value,
            "session_id": thread.as_str(),
            "ref": field.reference,
            "window_id": window_id,
            "delivery": "foreground",
        });
        self.computer.execute(thread, foreground).await.map(drop)
    }
}

/// The `host/browser/command` method the desktop serves.
const BROWSER_COMMAND: Method = Method("host/browser/command");

fn command_params(thread: &ThreadId, action: &str, input: JsonValue) -> JsonValue {
    json!({ "threadId": thread, "action": action, "input": input })
}

/// A host failure as the browser tools read it (`ChannelHostCommands`).
fn command_error(error: HostError) -> HostCommandError {
    match error {
        HostError::Rpc { code, message, data } => HostCommandError::Rpc { code, message, timing: data.and_then(|data| data.get("timing").cloned()) },
        HostError::Core(CoreError::CapabilityUnavailable { .. }) => HostCommandError::NoHost,
        HostError::Core(_) => HostCommandError::Rpc { code: HOST_COMMAND_FAILED, message: String::new(), timing: None },
    }
}

/// The browser host commands of the handoff tool, with the secret request's two runtime-only
/// actions served here: `secret_bind` binds the request to the session and the desktop that
/// bound its page, and `secret_input` fills it (the agent's `browser` tool never sees these; its
/// schema has no such action). Every other command goes to the host as it is.
pub struct SecretHostCommands {
    inner: Arc<dyn HostCommands>,
    fill: Arc<SecretFill>,
}

impl SecretHostCommands {
    pub fn new(inner: Arc<dyn HostCommands>, fill: Arc<SecretFill>) -> Self {
        Self { inner, fill }
    }
}

fn request_id_of(input: &JsonValue) -> &str {
    input.get("request_id").and_then(Value::as_str).unwrap_or_default()
}

#[async_trait]
impl HostCommands for SecretHostCommands {
    async fn browser(&self, thread: &ThreadId, action: &str, input: JsonValue, cancel: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        match action {
            "secret_input" => {
                let outcome = self.fill.fill_browser(thread, request_id_of(&input)).await;
                Ok(json!({ "text": outcome.text() }))
            }
            "secret_bind" => self.fill.bind_through(thread, input).await,
            _ => self.inner.browser(thread, action, input, cancel).await,
        }
    }

    async fn visualize(&self, thread: &ThreadId, cwd: &str, action: &str, input: JsonValue, cancel: &mixdog_rt::CancellationToken) -> Result<JsonValue, HostCommandError> {
        self.inner.visualize(thread, cwd, action, input, cancel).await
    }
}
