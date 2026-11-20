//! The cleanup of a saved server: its window and link go first (its daemon is about to be removed), then Mixdog is removed from the
//! server over ssh, a refused login retried once through the askpass helper (the questions go to the connection that started the
//! cleanup, named by the operation id it chose), and, when asked, the saved entry is forgotten.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshCleanupPhase, SshCleanupProgress, SshCleanupRequest, SshCleanupResult, SshLocalForget};
use mixdog_core_api::ids::ConnectionId;
use mixdog_ssh::bootstrap::ServerPayloads;
use mixdog_ssh::cleanup::{CleanupOptions, CleanupProgress, CleanupReport, cleanup_server};
use mixdog_ssh::command::{SshTarget, parse_ssh_target};
use mixdog_ssh::connect_failure::{ConnectError, failure_of};
use mixdog_ssh::context::{AttemptContext, Platform, SshEnv};
use mixdog_ssh::said;

use crate::attempts::{AttemptError, Attempts};
use crate::host_list_ops::{LocalForget, forget_in_turn, host_views};
use crate::host_store::{SshHostRecord, SshHostStore};
use crate::login::{LoginHelpers, with_login_retry};
use crate::restore::attempt_context;

/// What removes Mixdog from a server.
#[async_trait]
pub trait ServerCleaner: Send + Sync {
    async fn remove(
        &self,
        context: &AttemptContext,
        target: &SshTarget,
        remove_user_data: bool,
        progress: &(dyn Fn(CleanupProgress) + Sync),
    ) -> Result<CleanupReport, ConnectError>;
    fn platform(&self) -> Platform;
}

/// The cleanup over this PC's ssh; a server that holds none of this build gets it uploaded from `payloads` first.
pub struct EnvCleaner {
    pub env: Arc<SshEnv>,
    pub payloads: Arc<dyn ServerPayloads + Send>,
}

#[async_trait]
impl ServerCleaner for EnvCleaner {
    async fn remove(
        &self,
        context: &AttemptContext,
        target: &SshTarget,
        remove_user_data: bool,
        progress: &(dyn Fn(CleanupProgress) + Sync),
    ) -> Result<CleanupReport, ConnectError> {
        let options = CleanupOptions { remove_user_data, payloads: self.payloads.as_ref() };
        cleanup_server(&self.env, context, target, options, progress).await
    }

    fn platform(&self) -> Platform {
        self.env.platform
    }
}

/// Where the cleanup is, for the connection that started it (`connections/ssh/cleanupProgress`).
pub type CleanupProgressSink = Arc<dyn Fn(SshCleanupProgress) + Send + Sync>;

pub struct CleanupDeps {
    pub hosts: Arc<SshHostStore>,
    pub attempts: Arc<Attempts>,
    pub cleaner: Arc<dyn ServerCleaner>,
    pub login: Arc<dyn LoginHelpers>,
}

pub struct Cleanup {
    deps: CleanupDeps,
}

fn progress_of(operation_id: &str, progress: CleanupProgress) -> SshCleanupProgress {
    let (phase, said) = match progress {
        CleanupProgress::Connect => (SshCleanupPhase::Connect, None),
        CleanupProgress::Stop { detail } => (SshCleanupPhase::Stop, Some(detail)),
        CleanupProgress::Remove { detail } => (SshCleanupPhase::Remove, Some(detail)),
        CleanupProgress::Done => (SshCleanupPhase::Done, None),
    };
    let (detail, detail_notice) = said.map_or((None, None), |said| (Some(said.english), Some(said.message)));
    SshCleanupProgress { operation_id: operation_id.to_owned(), phase, detail, detail_notice }
}

impl Cleanup {
    pub fn new(deps: CleanupDeps) -> Self {
        Self { deps }
    }

    /// Cleans the saved server `id` for `caller`. A refused request (no operation id, an unknown server) is an error; a cleanup
    /// that failed is a `Failed` result the dialog shows. The result lists the saved servers after it.
    pub async fn cleanup(
        &self,
        caller: ConnectionId,
        id: &str,
        request: SshCleanupRequest,
        progress: CleanupProgressSink,
    ) -> Result<SshCleanupResult, AttemptError> {
        if request.operation_id.is_empty() {
            return Err(AttemptError::new("operationId must be a non-empty string."));
        }
        if id.is_empty() {
            return Err(AttemptError::new("id must be a non-empty string."));
        }
        let record = self.deps.hosts.get(id).ok_or_else(|| AttemptError::new(said::SERVER_NOT_SAVED.plain().english))?;
        self.run(caller, record, request, progress).await
    }

    /// Cleans a server that was never saved (its first connection failed), named as the connect dialog was given it. Nothing is
    /// saved or forgotten: the request's `forget` does not apply.
    pub async fn cleanup_target(
        &self,
        caller: ConnectionId,
        target: &str,
        mut request: SshCleanupRequest,
        progress: CleanupProgressSink,
    ) -> Result<SshCleanupResult, AttemptError> {
        if request.operation_id.is_empty() {
            return Err(AttemptError::new("operationId must be a non-empty string."));
        }
        request.forget = false;
        let record = self.deps.hosts.ensure_for_target(target, "").map_err(|error| AttemptError::new(error.to_string()))?;
        self.run(caller, record, request, progress).await
    }

    async fn run(
        &self,
        caller: ConnectionId,
        record: SshHostRecord,
        request: SshCleanupRequest,
        progress: CleanupProgressSink,
    ) -> Result<SshCleanupResult, AttemptError> {
        let target = parse_ssh_target(&record.target).map_err(|error| AttemptError::new(error.to_string()))?;
        // The server's turn for the whole cleanup, the forget included: no connection installs the server again, or saves it,
        // between the removal of its software and the removal of its entry.
        let _turn = self.deps.hosts.turn(&target.key()).await;
        let prompter = self.deps.attempts.operation_prompter(caller, request.operation_id.clone(), target.label().to_owned());
        let mut result = with_login_retry(
            self.deps.login.as_ref(),
            prompter,
            attempt_context(&record),
            |context| self.remove(&record, &target, &request, &progress, context),
            || false,
        )
        .await;
        if let SshCleanupResult::Done(done) = &mut result {
            // Only after the server itself was cleaned, so a failure leaves the entry for "Forget" to retry (the uninstall is not run
            // again). The remote result stands whatever the local one is.
            if request.forget {
                done.forget = Some(match forget_in_turn(&self.deps.hosts, &self.deps.attempts, &record.id).await {
                    LocalForget::Done => SshLocalForget { ok: true, error: None, notice: None },
                    LocalForget::Failed { message, notice } => SshLocalForget { ok: false, error: Some(message), notice: Some(notice) },
                });
            }
            done.hosts = host_views(&self.deps.hosts, self.deps.attempts.links());
        }
        Ok(result)
    }

    async fn remove(
        &self,
        record: &SshHostRecord,
        target: &SshTarget,
        request: &SshCleanupRequest,
        progress: &CleanupProgressSink,
        context: AttemptContext,
    ) -> SshCleanupResult {
        // The server's window goes first: its daemon is about to be removed.
        let links = self.deps.attempts.links();
        if links.is_open(&record.id) {
            links.close(&record.id).await;
        }
        let sink = |step: CleanupProgress| progress(progress_of(&request.operation_id, step));
        match self.deps.cleaner.remove(&context, target, request.remove_user_data, &sink).await {
            Ok(_) => SshCleanupResult::done(Vec::new(), None, None),
            Err(error) => SshCleanupResult::failed(failure_of(&error, target, self.deps.cleaner.platform()).into_failure()),
        }
    }
}
