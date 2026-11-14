//! The interactive login of an ssh operation: run it with BatchMode first, retry a refused login once through the askpass helper
//! (which asks the user on the connection that started the operation), and tell the user about their ssh-agent when the login
//! still fails.

use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{
    SshAgentState, SshAgentStatus, SshCleanupResult, SshConnectResult, SshFailed, SshFailure, SshFailureKind,
};
use mixdog_rt::DurabilityIo;
use mixdog_ssh::agent::{agent_status, AgentState};
use mixdog_ssh::askpass::{AskpassPrompter, AskpassServer, AskpassSession};
use mixdog_ssh::context::{AskpassEnv, AttemptContext, ClaimedResources, SshEnv};
use mixdog_ssh::private_dir::resolve_plain_dir;

/// What the login retry needs to know of an operation's result.
pub trait LoginOutcome: Sized {
    fn is_ok(&self) -> bool;
    /// The server refused the login (the failure the askpass retry and the agent hint are for).
    fn refused_login(&self) -> bool;
    /// What the operation answers when the user dismissed the question.
    fn cancelled() -> Self;
    /// The same refusal with the state of the user's ssh-agent.
    fn with_agent(self, agent: SshAgentStatus) -> Self;
}

fn cancelled_failure() -> SshFailure {
    SshFailure { kind: SshFailureKind::Cancelled, code: None }
}

fn refused(failed: &SshFailed) -> bool {
    matches!(failed.failure.kind, SshFailureKind::Auth { .. })
}

fn agent_added(failed: SshFailed, agent: SshAgentStatus) -> SshFailed {
    match failed.failure {
        SshFailure { kind: SshFailureKind::Auth { keygen, register, .. }, code } => SshFailed {
            ok: false,
            failure: SshFailure { kind: SshFailureKind::Auth { keygen, register, agent: Some(agent) }, code },
        },
        _ => failed,
    }
}

impl LoginOutcome for SshConnectResult {
    fn is_ok(&self) -> bool {
        matches!(self, Self::Connected(_))
    }

    fn refused_login(&self) -> bool {
        matches!(self, Self::Failed(failed) if refused(failed))
    }

    fn cancelled() -> Self {
        Self::failed(cancelled_failure())
    }

    fn with_agent(self, agent: SshAgentStatus) -> Self {
        match self {
            Self::Failed(failed) => Self::Failed(agent_added(failed, agent)),
            connected => connected,
        }
    }
}

impl LoginOutcome for SshCleanupResult {
    fn is_ok(&self) -> bool {
        matches!(self, Self::Done(_))
    }

    fn refused_login(&self) -> bool {
        matches!(self, Self::Failed(failed) if refused(failed))
    }

    fn cancelled() -> Self {
        Self::failed(cancelled_failure())
    }

    fn with_agent(self, agent: SshAgentStatus) -> Self {
        match self {
            Self::Failed(failed) => Self::Failed(agent_added(failed, agent)),
            done => done,
        }
    }
}

/// The running askpass session as the retry holds it.
#[async_trait]
pub trait AskpassControl: Send + Sync {
    /// The user dismissed or timed out a question of the session.
    fn cancelled(&self) -> bool;
    /// Ends the session.
    async fn close(&self);
}

#[async_trait]
impl AskpassControl for AskpassSession {
    fn cancelled(&self) -> bool {
        AskpassSession::cancelled(self)
    }

    async fn close(&self) {
        AskpassSession::close(self).await;
    }
}

/// An askpass session: the environment that points ssh at it, and how to end it.
pub struct StartedAskpass {
    pub env: Arc<dyn AskpassEnv>,
    pub control: Arc<dyn AskpassControl>,
}

/// What the login retry reaches the machine through.
#[async_trait]
pub trait LoginHelpers: Send + Sync {
    /// Opens the endpoint the askpass helper dials, asking `prompter` for every question.
    async fn start_askpass(&self, prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass>;
    /// The state of this PC's ssh-agent.
    async fn agent_status(&self) -> SshAgentStatus;
}

/// The helpers of this PC: the `mixdog-askpass` helper executable of the ssh environment and the ssh-agent.
pub struct EnvLoginHelpers {
    env: Arc<SshEnv>,
    io: DurabilityIo,
    /// Folder the askpass helper is copied under when its own path is not plain ASCII (Windows).
    user_data: PathBuf,
    /// Where the desktop that claimed the host role keeps the helper: read when a login needs it, as the claim comes after this
    /// was built.
    resources: Arc<ClaimedResources>,
}

impl EnvLoginHelpers {
    pub fn new(env: Arc<SshEnv>, io: DurabilityIo, user_data: PathBuf, resources: Arc<ClaimedResources>) -> Self {
        Self { env, io, user_data, resources }
    }
}

fn agent_state(state: AgentState) -> SshAgentState {
    match state {
        AgentState::Running => SshAgentState::Running,
        AgentState::Empty => SshAgentState::Empty,
        AgentState::Stopped => SshAgentState::Stopped,
        AgentState::Disabled => SshAgentState::Disabled,
        AgentState::Missing => SshAgentState::Missing,
        AgentState::Unknown => SshAgentState::Unknown,
    }
}

#[async_trait]
impl LoginHelpers for EnvLoginHelpers {
    async fn start_askpass(&self, prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass> {
        let env = self.resources.applied(&self.env);
        let helper = env
            .askpass_helper
            .clone()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "the askpass helper is not installed"))?;
        let base = resolve_plain_dir(&env, &self.user_data, "askpass").await;
        let session = Arc::new(AskpassServer::new(prompter, self.io, env.platform).with_plain_base(base).start(&helper).await?);
        Ok(StartedAskpass { env: session.clone(), control: session })
    }

    async fn agent_status(&self) -> SshAgentStatus {
        let status = agent_status(&self.env).await;
        SshAgentStatus { state: agent_state(status.state), command: status.command }
    }
}

/// Runs `run` once with `base`, again with the askpass session after a refused login (unless the operation was cancelled), and
/// adds the ssh-agent's state to a login that is still refused.
pub async fn with_login_retry<T, F, Fut>(
    helpers: &dyn LoginHelpers,
    prompter: Arc<dyn AskpassPrompter>,
    base: AttemptContext,
    mut run: F,
    is_cancelled: impl Fn() -> bool,
) -> T
where
    T: LoginOutcome,
    F: FnMut(AttemptContext) -> Fut,
    Fut: Future<Output = T>,
{
    let first = run(base.clone()).await;
    let last = if first.refused_login() && !is_cancelled() {
        match helpers.start_askpass(prompter).await {
            Err(error) => {
                tracing::warn!("[ssh-login] the askpass session could not be started: {error}");
                first
            }
            Ok(session) => {
                let second = run(AttemptContext { askpass: Some(session.env.clone()), ..base }).await;
                let dismissed = session.control.cancelled();
                session.control.close().await;
                if dismissed && !second.is_ok() { T::cancelled() } else { second }
            }
        }
    } else {
        first
    };
    if last.refused_login() { last.with_agent(helpers.agent_status().await) } else { last }
}
