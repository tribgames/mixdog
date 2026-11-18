//! What the connect flow answers for a refused login the user answered a question for, and for a cancel.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshAgentState, SshAgentStatus, SshConnectResult, SshFailed, SshFailure, SshFailureKind};
use mixdog_ssh::askpass::{AskpassKind, AskpassPrompter, AskpassQuestion};
use mixdog_ssh::context::{AskpassEnv, AttemptContext};

use super::after_cancel;
use crate::login::{with_login_retry, AskpassControl, LoginHelpers, StartedAskpass};

struct NoEnv;

impl AskpassEnv for NoEnv {
    fn env(&self) -> Vec<(String, String)> {
        Vec::new()
    }
    fn closed(&self) -> bool {
        false
    }
    fn control_dir(&self) -> Option<PathBuf> {
        None
    }
}

struct Control(Option<AskpassKind>);

#[async_trait]
impl AskpassControl for Control {
    fn cancelled(&self) -> bool {
        false
    }
    fn refused(&self) -> Option<AskpassKind> {
        self.0
    }
    async fn close(&self) {}
}

struct Helpers(Option<AskpassKind>);

#[async_trait]
impl LoginHelpers for Helpers {
    async fn start_askpass(&self, _prompter: Arc<dyn AskpassPrompter>) -> io::Result<StartedAskpass> {
        Ok(StartedAskpass { env: Arc::new(NoEnv), control: Arc::new(Control(self.0)) })
    }
    async fn agent_status(&self) -> SshAgentStatus {
        SshAgentStatus { state: SshAgentState::Running, command: None }
    }
}

struct Nobody;

#[async_trait]
impl AskpassPrompter for Nobody {
    async fn ask(&self, _question: AskpassQuestion) -> Option<String> {
        None
    }
}

fn refused() -> SshConnectResult {
    SshConnectResult::failed(SshFailure {
        kind: SshFailureKind::Auth { keygen: "ssh-keygen".to_owned(), register: "ssh-copy-id h".to_owned(), agent: None },
        notice: None,
        code: Some("auth".to_owned()),
    })
}

async fn outcome(answered: Option<AskpassKind>) -> SshConnectResult {
    with_login_retry(&Helpers(answered), Arc::new(Nobody), AttemptContext::default(), |_| async { refused() }, || false).await
}

fn failure_kind(result: SshConnectResult) -> SshFailureKind {
    let SshConnectResult::Failed(SshFailed { failure, .. }) = result else { panic!("a refused login does not connect") };
    failure.kind
}

#[tokio::test]
async fn a_password_the_server_refused_is_not_met_with_the_guidance_to_create_a_key() {
    let SshFailureKind::Failed { message } = failure_kind(outcome(Some(AskpassKind::Password)).await) else {
        panic!("a refused password is told as such, not as a missing key")
    };
    assert!(message.contains("password") && !message.contains("key"), "{message}");
    let SshFailureKind::Failed { message } = failure_kind(outcome(Some(AskpassKind::Passphrase)).await) else { panic!("a refused passphrase") };
    assert!(message.contains("passphrase"), "{message}");
}

#[tokio::test]
async fn a_login_with_no_evidence_against_a_secret_keeps_the_login_failure_and_never_blames_one() {
    // An accepted key passphrase followed by the server refusing the public key is no refused secret: the session reports none.
    assert!(matches!(failure_kind(outcome(None).await), SshFailureKind::Auth { agent: Some(_), .. }));
}

#[test]
fn a_cancelled_attempt_that_did_not_connect_answers_cancelled() {
    let closed = SshConnectResult::failed(SshFailure { kind: SshFailureKind::Failed { message: "The connection to Box was closed.".to_owned() }, notice: None, code: Some("ssh-terminal".to_owned()) });
    assert_eq!(failure_kind(after_cancel(closed.clone(), true)), SshFailureKind::Cancelled);
    assert_eq!(after_cancel(closed.clone(), false), closed);
}
