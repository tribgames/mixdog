//! Signing in to an agent: the CLI's own interactive login, run for the user. The page it prints
//! is the flow's state for the client to open, a code that page shows is written to the CLI, and
//! the CLI stores the credential itself: Mixdog reads the page's address and the exit, nothing else.
//!
//! A sign-in is a [`LoginSession`] kept by the account service's flow registry, so it is started,
//! read, completed and cancelled by the `account/*OAuthProviderLogin` calls every provider
//! sign-in uses, and published on `login:<flowId>`. The registry's own expiry ends one the user
//! walked away from.

use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use async_trait::async_trait;
use mixdog_core_api::call::CoreRequest;
use mixdog_core_api::call::Reply;
use mixdog_core_api::domain::common::AbsPath;
use mixdog_core_api::domain::common::EventSource;
use mixdog_core_api::domain::login::LoginError;
use mixdog_core_api::domain::login::LoginFailure;
use mixdog_core_api::domain::login::LoginInput;
use mixdog_core_api::domain::login::LoginSession;
use mixdog_core_api::domain::login::LoginState;
use mixdog_core_api::domain::process::ExitStatus;
use mixdog_core_api::domain::process::OutputStream;
use mixdog_core_api::domain::process::ProcessEvent;
use mixdog_core_api::domain::process::ProcessManager;
use mixdog_core_api::error::CoreError;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::OpScopes;
use mixdog_core_domains::domains::ai_account::failure::Failure;
use mixdog_core_domains::domains::ai_account::flows::OAuthFlows;
use mixdog_core_domains::domains::ai_account::flows::Settle;
use mixdog_protocol::ProcessHandle;
use mixdog_rt::TaskClass;
use serde_json::Value;
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use crate::agents::AccountEvent;
use crate::agents::Agents;
use crate::agents::Readiness;
use crate::agents::lock;
use crate::connection::Launch;
use crate::connection::spawn_piped;
use crate::preset::AgentPreset;

const DOMAIN: &str = "account";
const BEGIN: &str = "account/beginOAuthProviderLogin";
const FORGET: &str = "account/forgetProviderAuth";

/// The first web address in a line the CLI wrote, without the terminal's colour codes around it.
pub fn page_in(line: &str) -> Option<String> {
    let at = line.find("https://")?;
    let page: String = line[at..].chars().take_while(|c| !c.is_whitespace() && !c.is_control()).collect();
    (page.len() > "https://".len()).then_some(page)
}

struct Shared {
    state: watch::Sender<LoginState>,
    /// The cursor over `state`, taken out for the wait of the one `next` that runs.
    cursor: Mutex<Option<watch::Receiver<LoginState>>>,
    next_turn: mixdog_rt::Gate,
    /// Fires once the terminal state was delivered: queued `next` callers end with `None`.
    ended: CancellationToken,
    delivered_terminal: AtomicBool,
    processes: Arc<dyn ProcessManager>,
    handle: ProcessHandle,
    /// Fired by a cancel and by the feature being turned off.
    stop: CancellationToken,
}

impl Shared {
    /// Moves to `next` unless the sign-in already ended.
    fn advance(&self, next: LoginState) {
        self.state.send_if_modified(|current| {
            if current.is_terminal() {
                return false;
            }
            *current = next;
            true
        });
    }

    fn failed(&self, message: String) {
        self.advance(LoginState::Failed(LoginFailure::Failed { code: "agentLogin".into(), message }));
    }
}

/// Follows the CLI to its exit: the page it prints, then how it ended.
async fn follow(shared: Arc<Shared>, mut events: Box<dyn EventSource<ProcessEvent>>) {
    // Each stream's unfinished line: the prompt the CLI leaves open on one is no part of what it writes on the other.
    let (mut out, mut err): (Vec<u8>, Vec<u8>) = Default::default();
    // The last whole line of the CLI's stderr: why it gave up, when it did.
    let mut said = String::new();
    let exit = loop {
        let event = tokio::select! {
            biased;
            () = shared.stop.cancelled() => break None,
            event = events.next() => event,
        };
        match event {
            Some(ProcessEvent::Output { stream, bytes, .. }) => {
                let reason = stream == OutputStream::Stderr;
                let line = if reason { &mut err } else { &mut out };
                for byte in bytes {
                    if byte != b'\n' {
                        line.push(byte);
                        continue;
                    }
                    let text = String::from_utf8_lossy(&std::mem::take(line)).trim().to_owned();
                    if let Some(page) = page_in(&text) {
                        // The page takes the user to a code where the CLI has no callback of its own to receive it.
                        shared.advance(LoginState::Authorize { url: page.clone(), manual_url: Some(page) });
                    } else if reason && !text.is_empty() {
                        said = text;
                    }
                }
            }
            Some(ProcessEvent::Exited { exit, .. }) => break Some(exit),
            // A source that ended without the exit tells nothing of the process.
            None => break None,
        }
    };
    match exit {
        Some(exit) if exit.status == ExitStatus::Code(0) => shared.advance(LoginState::Done { account: None }),
        Some(_) if said.is_empty() => shared.failed("The sign-in ended without signing in.".into()),
        Some(_) => shared.failed(said),
        None => {
            let _ = shared.processes.kill(&shared.handle);
            if shared.stop.is_cancelled() {
                shared.advance(LoginState::Cancelled);
            } else {
                shared.failed("The sign-in's process was lost.".into());
            }
        }
    }
}

struct AgentLogin(Arc<Shared>);

#[async_trait]
impl LoginSession for AgentLogin {
    fn state(&self) -> LoginState {
        self.0.state.borrow().clone()
    }

    async fn next(&self) -> Option<LoginState> {
        if self.0.delivered_terminal.load(Ordering::Acquire) {
            return None;
        }
        let state = self
            .0
            .next_turn
            .run(&self.0.ended, async {
                let mut cursor = lock(&self.0.cursor).take()?;
                let changed = cursor.changed().await;
                let state = changed.ok().map(|()| cursor.borrow_and_update().clone());
                *lock(&self.0.cursor) = Some(cursor);
                state
            })
            .await
            .ok()??;
        if state.is_terminal() {
            self.0.delivered_terminal.store(true, Ordering::Release);
            self.0.ended.cancel();
        }
        Some(state)
    }

    /// The code the sign-in page showed: the CLI reads it as a line.
    async fn provide(&self, input: LoginInput) -> Result<(), LoginError> {
        let LoginInput::AuthorizationCode(code) = input;
        match &*self.0.state.borrow() {
            state if state.is_terminal() => return Err(LoginError::Finished),
            LoginState::Authorize { .. } | LoginState::Waiting => {}
            _ => return Err(LoginError::InputNotExpected),
        }
        let mut line = code.trim().as_bytes().to_vec();
        line.push(b'\n');
        match self.0.processes.write_stdin_whole(&self.0.handle, line).await {
            Ok(()) => {
                self.0.advance(LoginState::Waiting);
                Ok(())
            }
            Err(_) => Err(LoginError::Finished),
        }
    }

    fn cancel(&self) {
        self.0.stop.cancel();
        self.0.advance(LoginState::Cancelled);
        let _ = self.0.processes.kill(&self.0.handle);
    }
}

impl Agents {
    /// Starts `preset`'s own login. A sign-in of the preset that still runs is ended first.
    pub async fn begin_login(self: &Arc<Self>, preset: &AgentPreset) -> Result<Box<dyn LoginSession>, String> {
        if !self.enabled() {
            return Err("ACP agents are turned off in Settings.".to_owned());
        }
        let login = preset.login.as_ref().ok_or_else(|| format!("{} has no sign-in to start from the app.", preset.label))?;
        let cwd = AbsPath::new(self.parts.probe_cwd.clone()).ok_or_else(|| "The sign-in has no folder to start in.".to_owned())?;
        let stop = CancellationToken::new();
        if let Some(prior) = lock(&self.logins).insert(preset.id.clone(), stop.clone()) {
            prior.cancel();
        }
        self.account_left(&preset.id, AccountEvent::Left);
        let launch = Launch { program: self.program(preset), args: login.args.clone(), env: preset.env.clone(), env_remove: login.env_remove.clone(), cwd };
        let (handle, events) =
            spawn_piped(&self.parts.processes, launch).await.map_err(|fault| format!("{}'s sign-in did not start: {fault}", preset.label))?;
        let (state, cursor) = watch::channel(LoginState::Starting);
        let shared = Arc::new(Shared {
            state,
            cursor: Mutex::new(Some(cursor)),
            next_turn: mixdog_rt::Gate::default(),
            ended: CancellationToken::new(),
            delivered_terminal: AtomicBool::new(false),
            processes: self.parts.processes.clone(),
            handle,
            stop,
        });
        drop(mixdog_rt::spawn("acp.login", TaskClass::Work, follow(shared.clone(), events)));
        Ok(Box::new(AgentLogin(shared)))
    }

    /// What a finished sign-in leaves to do: the CLI is looked at again, and the sign-in held only if it now opens a session.
    pub fn settle_login(self: &Arc<Self>, preset: &AgentPreset) -> Settle {
        let (agents, preset) = (self.clone(), preset.clone());
        Box::new(move |_| {
            Box::pin(async move {
                match agents.look(&preset).await {
                    // The account the user signed in with is not the one the agent refused.
                    Some(Readiness::Ready { .. }) => {
                        agents.answered(&preset).await;
                        agents.account_left(&preset.id, AccountEvent::SignedIn);
                        Ok(true)
                    }
                    Some(Readiness::SignedOut { .. }) => Err(format!("{} still reports that it is signed out.", preset.label)),
                    Some(other) => Err(crate::agents::Refusal::NotReady(other).message(&preset)),
                    None => Ok(false),
                }
            })
        })
    }
}

/// The account service with the agents' sign-ins: a login begun for an agent's route provider is the agent's
/// own, registered with the flows every other sign-in uses; every other call is the account service's.
pub struct AgentLogins {
    pub inner: Arc<dyn DomainService>,
    pub agents: Arc<Agents>,
    /// The registry the wrapped account service reads, completes and cancels its flows in.
    pub flows: OAuthFlows,
    /// The account domain's op gates: a begin repeated with its `opId` answers the first one's flow.
    pub ops: OpScopes,
}

#[async_trait]
impl DomainService for AgentLogins {
    fn methods(&self) -> &'static [&'static str] {
        self.inner.methods()
    }

    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        let provider = req.params.get("providerId").and_then(Value::as_str).unwrap_or_default().trim().to_owned();
        // Forgetting an agent's sign-in is the agent's own sign-out: Mixdog holds no credential of it to remove.
        if req.method.as_str() == FORGET
            && let Some(preset) = self.agents.preset_of_route(&provider)
        {
            let sign_out =
                || async { self.agents.sign_out(preset).await.map(|()| Value::Bool(true)).map_err(|message| Failure::error(message).into_core(DOMAIN)) };
            return self.ops.run(&req, None, sign_out, || async { Ok(Value::Bool(true)) }).await;
        }
        let Some(preset) = (req.method.as_str() == BEGIN).then(|| self.agents.preset_of_route(&provider)).flatten() else {
            return self.inner.call(req).await;
        };
        let begin = || async {
            if let Some(prior) = self.flows.supersede(&provider) {
                prior.released().await;
            }
            let session = self.agents.begin_login(preset).await.map_err(|message| Failure::error(message).into_core(DOMAIN))?;
            self.flows.register(&provider, session, self.agents.settle_login(preset)).map_err(|failure| failure.into_core(DOMAIN))
        };
        self.ops.run(&req, Some(("providerLogin", provider.clone())), begin, || async { Ok(Value::Null) }).await
    }

    fn notify(&self, method: Method, params: Value, from: ConnectionId) -> Admit {
        self.inner.notify(method, params, from)
    }
}
