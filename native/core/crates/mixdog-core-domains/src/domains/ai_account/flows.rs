//! Daemon-owned provider OAuth flows (`oauth-flows.mjs`): a started login is a core
//! [`LoginSession`]; the registry keeps it and clients see serializable status records.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;

use futures::future::BoxFuture;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::feed_publisher::LoginFeeds;
use serde_json::Value;
use serde_json::json;
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::failure::Failure;

pub const DEFAULT_FLOW_TTL_MS: u64 = 10 * 60 * 1000;

/// What a finished sign-in leaves to do (settling the account roster): `via_code` says a pasted
/// code delivered it, not the browser callback. `Ok(true)` is a completed login.
pub type Settle = Box<dyn FnOnce(bool) -> BoxFuture<'static, Result<bool, String>> + Send>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Complete,
    Failed,
    Cancelled,
    Expired,
}

impl State {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Complete => "complete",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Expired => "expired",
        }
    }
}

/// How a failed flow failed: a code that did not complete the login answers a status, one that
/// threw rethrows to the caller that pasted it.
#[derive(Clone)]
enum Ending {
    None,
    Falsy,
    Threw(String),
}

struct Flow {
    id: String,
    provider: String,
    session: Arc<dyn LoginSession>,
    /// What the sign-in showed last: the page or device code stays in the status after the login ends.
    shown: Shown,
    state: State,
    error: Option<String>,
    ending: Ending,
    completing: bool,
    timeout: Option<JoinHandle<()>>,
    settled: Arc<Notify>,
}

/// The page and codes a sign-in presented.
#[derive(Clone, Default)]
struct Shown {
    url: Option<String>,
    manual_url: Option<String>,
    user_code: Option<String>,
}

impl Shown {
    /// The state's page or device code; any other state shows nothing new.
    fn of(state: &LoginState) -> Option<Self> {
        match state {
            LoginState::Authorize { url, manual_url } => Some(Self { url: Some(url.clone()), manual_url: manual_url.clone(), user_code: None }),
            LoginState::DeviceCode { user_code, verification_uri, .. } => {
                Some(Self { url: Some(verification_uri.clone()), manual_url: None, user_code: Some(user_code.clone()) })
            }
            _ => None,
        }
    }
}

impl Flow {
    fn status(&self) -> Value {
        let Shown { url, manual_url, user_code } = self.shown.clone();
        json!({
            "flowId": self.id,
            "provider": self.provider,
            "url": url,
            "manualUrl": manual_url,
            "userCode": user_code,
            "state": self.state.as_str(),
            "completed": self.state == State::Complete,
            "error": self.error,
            "manualCodeSupported": manual_url.is_some(),
        })
    }
}

struct Registry {
    flows: HashMap<String, Flow>,
    active_by_provider: HashMap<String, String>,
    sequence: u64,
    /// The login:<flowId> feed of every flow: a flow stays readable, and so subscribable, as long as the registry keeps it.
    feeds: Arc<LoginFeeds>,
}

impl Registry {
    /// Publishes the flow's status as its feed's next update.
    fn publish(&self, id: &str) {
        if let Some(flow) = self.flows.get(id) {
            self.feeds.publish(id, flow.status());
        }
    }

    /// `finishFlow`: only a pending flow settles.
    fn finish(&mut self, id: &str, state: State, error: Option<String>, ending: Ending) -> bool {
        let Some(flow) = self.flows.get_mut(id) else { return false };
        if flow.state != State::Pending {
            return false;
        }
        flow.state = state;
        flow.error = error;
        flow.ending = ending;
        if let Some(timeout) = flow.timeout.take() {
            timeout.abort();
        }
        flow.settled.notify_waiters();
        if self.active_by_provider.get(&flow.provider).map(String::as_str) == Some(id) {
            self.active_by_provider.remove(&flow.provider);
        }
        self.publish(id);
        true
    }
}

fn base36(mut n: u64) -> String {
    if n == 0 {
        return "0".into();
    }
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
    }
    digits.reverse();
    String::from_utf8_lossy(&digits).into_owned()
}

/// `requiredFlowId`: `/^oauth_[a-z0-9_]+$/i`.
fn required_flow_id(value: &str) -> Result<String, Failure> {
    let id = mixdog_js::js_trim(value);
    let valid = id.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("oauth_"))
        && id.len() > 6
        && id[6..].chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if valid { Ok(id.to_owned()) } else { Err(Failure::type_error("OAuth flow id is invalid.")) }
}

fn failure_text(failure: &LoginFailure) -> String {
    match failure {
        LoginFailure::Denied => "Authorization was denied.".into(),
        LoginFailure::Expired => "The authorization request expired.".into(),
        LoginFailure::Unavailable { capability } => format!("{capability} is unavailable."),
        LoginFailure::Failed { message, .. } => message.clone(),
        LoginFailure::VerificationRequired { url, .. } => format!("Verify the account at {url} before signing in again."),
    }
}

#[derive(Clone)]
pub struct OAuthFlows {
    inner: Arc<Mutex<Registry>>,
    ttl: Duration,
}

impl OAuthFlows {
    pub fn new(ttl: Duration, feeds: Arc<LoginFeeds>) -> Self {
        let registry = Registry { flows: HashMap::new(), active_by_provider: HashMap::new(), sequence: 0, feeds };
        Self { inner: Arc::new(Mutex::new(registry)), ttl: ttl.max(Duration::from_millis(1)) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `register`: keeps the live session and answers its status. A newer login of the same
    /// provider supersedes a pending one.
    pub fn register(&self, provider: &str, session: Box<dyn LoginSession>, settle: Settle) -> Result<Value, Failure> {
        let provider = mixdog_js::js_trim(provider).to_owned();
        if provider.is_empty() {
            return Err(Failure::error("OAuth provider login is missing its provider id."));
        }
        let session: Arc<dyn LoginSession> = Arc::from(session);
        let (id, status) = {
            let mut reg = self.lock();
            if let Some(prior) = reg.active_by_provider.get(&provider).cloned() {
                if reg.finish(&prior, State::Cancelled, Some("Superseded by a newer OAuth login.".into()), Ending::None) {
                    reg.flows[&prior].session.cancel();
                }
            }
            reg.sequence += 1;
            let now = chrono::Utc::now().timestamp_millis().max(0) as u64;
            let id = format!("oauth_{}_{}", base36(now), base36(reg.sequence));
            let flow = Flow {
                id: id.clone(),
                provider: provider.clone(),
                session: session.clone(),
                shown: Shown::of(&session.state()).unwrap_or_default(),
                state: State::Pending,
                error: None,
                ending: Ending::None,
                completing: false,
                timeout: None,
                settled: Arc::new(Notify::new()),
            };
            let status = flow.status();
            reg.feeds.open(&id, status.clone());
            reg.flows.insert(id.clone(), flow);
            reg.active_by_provider.insert(provider, id.clone());
            (id, status)
        };
        let this = self.clone();
        let expiry_id = id.clone();
        let ttl = self.ttl;
        let timeout = tokio::spawn(async move {
            tokio::time::sleep(ttl).await;
            let mut reg = this.lock();
            if reg.finish(&expiry_id, State::Expired, Some("OAuth login expired.".into()), Ending::None) {
                reg.flows[&expiry_id].session.cancel();
            }
        });
        if let Some(flow) = self.lock().flows.get_mut(&id) {
            flow.timeout = Some(timeout);
        }
        let this = self.clone();
        tokio::spawn(async move { this.watch(id, session, settle).await });
        Ok(status)
    }

    /// Follows the session to its end: a sign-in settles once, whether the callback or a pasted
    /// code delivered it.
    async fn watch(&self, id: String, session: Arc<dyn LoginSession>, settle: Settle) {
        let mut settle = Some(settle);
        while let Some(state) = session.next().await {
            if !self.lock().flows.get(&id).is_some_and(|f| f.state == State::Pending) {
                return;
            }
            match state {
                LoginState::Done { .. } => {
                    let via_code = self.lock().flows.get(&id).is_some_and(|f| f.completing);
                    let Some(settle) = settle.take() else { return };
                    let outcome = settle(via_code).await;
                    let mut reg = self.lock();
                    match outcome {
                        Ok(true) => reg.finish(&id, State::Complete, None, Ending::None),
                        Ok(false) if via_code => {
                            reg.finish(&id, State::Failed, Some("OAuth code did not complete the login.".into()), Ending::Falsy)
                        }
                        Ok(false) => reg.finish(&id, State::Failed, Some("OAuth login did not complete.".into()), Ending::None),
                        Err(message) => reg.finish(&id, State::Failed, Some(message.clone()), Ending::Threw(message)),
                    };
                    return;
                }
                LoginState::Failed(failure) => {
                    let message = failure_text(&failure);
                    self.lock().finish(&id, State::Failed, Some(message.clone()), Ending::Threw(message));
                    return;
                }
                LoginState::Cancelled => {
                    self.lock().finish(&id, State::Cancelled, None, Ending::None);
                    return;
                }
                // The sign-in page or device code arrived: the flow's status carries it.
                LoginState::Starting | LoginState::DeviceCode { .. } | LoginState::Authorize { .. } | LoginState::Waiting => {
                    let mut reg = self.lock();
                    if let (Some(shown), Some(flow)) = (Shown::of(&state), reg.flows.get_mut(&id)) {
                        flow.shown = shown;
                    }
                    reg.publish(&id);
                }
            }
        }
    }

    fn require(reg: &Registry, id: &str) -> Result<String, Failure> {
        let key = required_flow_id(id)?;
        if reg.flows.contains_key(&key) {
            Ok(key)
        } else {
            Err(Failure::error("OAuth login flow is no longer available."))
        }
    }

    pub fn status(&self, id: &str) -> Result<Value, Failure> {
        let reg = self.lock();
        let key = Self::require(&reg, id)?;
        Ok(reg.flows[&key].status())
    }

    pub async fn complete(&self, id: &str, raw_code: &str) -> Result<Value, Failure> {
        let (key, session, settled) = {
            let mut reg = self.lock();
            let key = Self::require(&reg, id)?;
            let flow = reg.flows.get_mut(&key).expect("required flow exists");
            if flow.state != State::Pending {
                return Err(Failure::error("OAuth login flow is no longer pending."));
            }
            if !flow.status()["manualCodeSupported"].as_bool().unwrap_or(false) {
                return Err(Failure::error("This OAuth provider does not accept a manual code."));
            }
            let code = mixdog_js::js_trim(raw_code);
            if code.is_empty() || mixdog_js::utf16_len(code) > 16_384 {
                return Err(Failure::type_error("OAuth code is invalid."));
            }
            if flow.completing {
                return Err(Failure::error("OAuth login flow is already being completed."));
            }
            flow.completing = true;
            (key, flow.session.clone(), flow.settled.clone())
        };
        let code = mixdog_js::js_trim(raw_code).to_owned();
        let notified = settled.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let provided = session.provide(LoginInput::AuthorizationCode(code)).await;
        let result = match provided {
            Ok(()) => {
                if self.lock().flows.get(&key).is_some_and(|f| f.state == State::Pending) {
                    notified.await;
                }
                Ok(())
            }
            Err(LoginError::Failed(failure)) => {
                let message = failure_text(&failure);
                self.lock().finish(&key, State::Failed, Some(message.clone()), Ending::Threw(message.clone()));
                Err(Failure::error(message))
            }
            Err(LoginError::InputNotExpected) => Err(Failure::error("This OAuth provider does not accept a manual code.")),
            Err(LoginError::Finished | LoginError::Busy) => Err(Failure::error("OAuth login flow is no longer pending.")),
        };
        let mut reg = self.lock();
        if let Some(flow) = reg.flows.get_mut(&key) {
            flow.completing = false;
        }
        result?;
        if let Ending::Threw(message) = reg.flows[&key].ending.clone() {
            return Err(Failure::error(message));
        }
        Ok(reg.flows[&key].status())
    }

    pub async fn cancel(&self, id: &str) -> Result<Value, Failure> {
        let mut reg = self.lock();
        let key = Self::require(&reg, id)?;
        if reg.finish(&key, State::Cancelled, None, Ending::None) {
            reg.flows[&key].session.cancel();
        }
        Ok(reg.flows[&key].status())
    }

    /// `cancelAll`: shutdown.
    pub fn cancel_all(&self) {
        let mut reg = self.lock();
        let ids: Vec<String> = reg.flows.keys().cloned().collect();
        for id in ids {
            if reg.finish(&id, State::Cancelled, None, Ending::None) {
                reg.flows[&id].session.cancel();
            }
        }
        for flow in reg.flows.values_mut() {
            if let Some(timeout) = flow.timeout.take() {
                timeout.abort();
            }
        }
        reg.active_by_provider.clear();
        for id in reg.flows.keys() {
            reg.feeds.close(id);
        }
        reg.flows.clear();
    }
}
