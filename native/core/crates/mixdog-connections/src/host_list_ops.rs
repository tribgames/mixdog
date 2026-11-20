//! The saved-server list operations: the list, rename, per-server settings and forget. A change of the saved model login is applied to
//! the server's attached link behind the answer.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::{SshForgetDone, SshForgetFailed, SshForgetResult, SshHost, SshMessage};
use mixdog_rt::TaskClass;
use mixdog_ssh::command::parse_ssh_target;
use mixdog_ssh::connect_failure::ConnectError;
use serde_json::Value;

use crate::attempts::{AttemptError, Attempts, ServerLinks};
use crate::host_store::{ModelLogin as StoredModelLogin, SshHostRecord, SshHostStore};
use crate::link::LinkPool;
use crate::link_machine::ModelLogin;
use crate::view::ssh_host_view;

/// The server links, as far as the list reaches them: whether a server is attached and which model login it runs in.
#[async_trait]
pub trait HostLinks: ServerLinks {
    /// The server's daemon restarts in `login` (its running sessions stop) and the link attaches to it again; nothing when the
    /// server has no link.
    async fn apply_model_login(&self, id: &str, login: ModelLogin) -> Result<(), ConnectError>;
}

#[async_trait]
impl HostLinks for LinkPool {
    async fn apply_model_login(&self, id: &str, login: ModelLogin) -> Result<(), ConnectError> {
        match self.get(id) {
            Some(link) => link.apply_model_login(login).await,
            None => Ok(()),
        }
    }
}

/// The saved servers as the dialog shows them, each with whether its link is attached.
pub fn host_views(hosts: &SshHostStore, links: &dyn ServerLinks) -> Vec<SshHost> {
    hosts.list().iter().map(|record| ssh_host_view(record, links.is_open(&record.id))).collect()
}

fn saved_login(record: Option<SshHostRecord>) -> ModelLogin {
    match record.and_then(|record| record.settings).and_then(|settings| settings.model_login) {
        Some(StoredModelLogin::Server) => ModelLogin::Server,
        None => ModelLogin::Pc,
    }
}

fn store_error(error: impl std::fmt::Display) -> AttemptError {
    AttemptError::new(error.to_string())
}

fn non_empty<'a>(value: &'a str, what: &str) -> Result<&'a str, AttemptError> {
    if value.is_empty() { Err(AttemptError::new(format!("{what} must be a non-empty string."))) } else { Ok(value) }
}

pub struct HostList {
    hosts: Arc<SshHostStore>,
    links: Arc<dyn HostLinks>,
    /// The connect flow's attempts, the ones a forget retires.
    attempts: Arc<Attempts>,
}

impl HostList {
    pub fn new(hosts: Arc<SshHostStore>, links: Arc<dyn HostLinks>, attempts: Arc<Attempts>) -> Self {
        Self { hosts, links, attempts }
    }

    /// `connections/ssh/list`.
    pub fn list(&self) -> Vec<SshHost> {
        host_views(&self.hosts, self.links.as_ref())
    }

    /// A new name for the server (trimmed, at most 80 characters); an empty name changes nothing.
    pub async fn rename(&self, id: &str, name: &str) -> Result<(), AttemptError> {
        self.hosts.rename(non_empty(id, "id")?, name).await.map_err(store_error)
    }

    /// Replaces the server's settings with the validated `settings` and answers with the server as saved. When the saved model
    /// login changed, the attached server's daemon restarts in it behind the answer: its progress and any failure show in the
    /// link's state, not as a failed save.
    pub async fn update_settings(&self, id: &str, settings: &Value) -> Result<SshHost, AttemptError> {
        let id = non_empty(id, "id")?;
        let before = saved_login(self.hosts.get(id));
        self.hosts.update_settings(id, settings).await.map_err(store_error)?;
        let record = self.hosts.get(id).ok_or_else(|| AttemptError::new(mixdog_ssh::said::SERVER_NOT_SAVED.plain().english))?;
        let after = saved_login(Some(record.clone()));
        if before != after {
            let links = self.links.clone();
            let id = id.to_owned();
            drop(mixdog_rt::spawn("host-model-login", TaskClass::Control, async move {
                if let Err(error) = links.apply_model_login(&id, after).await {
                    tracing::warn!("[ssh-hosts] the model login of a server could not be applied: {error}");
                }
            }));
        }
        Ok(ssh_host_view(&record, self.links.is_open(&record.id)))
    }

    /// Forgets the server: its link is closed and its saved entry removed. Its host-key pins and generated ssh config stay where
    /// they are (a server added again finds its key already trusted), and the user's own ssh files are never touched. A failure
    /// is a typed answer: the reason reaches the window by code.
    pub async fn forget(&self, id: &str) -> Result<SshForgetResult, AttemptError> {
        let id = non_empty(id, "id")?;
        Ok(match forget_saved(&self.hosts, &self.attempts, id).await {
            LocalForget::Done => SshForgetResult::Done(SshForgetDone { ok: true }),
            LocalForget::Failed { message, notice } => SshForgetResult::Failed(SshForgetFailed { ok: false, message, notice: Some(notice) }),
        })
    }
}

#[cfg(test)]
#[path = "forget_results_tests.rs"]
mod forget_results_tests;

/// How the local half of a forget ended. A failure is typed: the cause by code, and the saved entry is still there.
pub enum LocalForget {
    Done,
    /// The cause in English and by code (always present: a failed forget never reaches the window as raw text).
    Failed {
        message: String,
        notice: SshMessage,
    },
}

/// The one local forget of a saved server, used by the list's Forget and by the cleanup that removes the server software. It never
/// touches the server. The entry failing to be removed is `saved-entry-removal-failed`, whose operating-system cause goes to the
/// log; the entry then stays for a retry.
///
/// The whole of it runs in the server's turn (see [`SshHostStore::turn`]), which a connection holds from its check to the end of
/// its save: a forget is wholly before or after it.
pub async fn forget_saved(hosts: &SshHostStore, attempts: &Attempts, id: &str) -> LocalForget {
    let key = hosts.get(id).and_then(|record| parse_ssh_target(&record.target).ok()).map(|target| target.key());
    let _turn = match &key {
        Some(key) => Some(hosts.turn(key).await),
        None => None,
    };
    forget_in_turn(hosts, attempts, id).await
}

/// [`forget_saved`] for a caller that holds the server's turn: the server's link is closed, its entry removed, and then every
/// attempt inspected for it retired, so a confirmation registered at any point before the entry was gone (also one that came
/// while the link was closing) does not save it again.
pub(crate) async fn forget_in_turn(hosts: &SshHostStore, attempts: &Attempts, id: &str) -> LocalForget {
    // Read in the turn: what a connection that held it before saved is what is removed.
    let record = hosts.get(id);
    let links = attempts.links();
    if links.is_open(id) {
        links.close(id).await;
    }
    if let Err(error) = hosts.forget(id).await {
        tracing::warn!("[ssh-hosts] the saved entry {id} could not be removed: {error}");
        let name = record.map_or_else(|| id.to_owned(), |record| record.name);
        let said = mixdog_ssh::said::SAVED_ENTRY_REMOVAL_FAILED.said([("name", name)]);
        return LocalForget::Failed { message: said.english, notice: said.message };
    }
    if let Some(target) = record.as_ref().and_then(|record| parse_ssh_target(&record.target).ok()) {
        attempts.retire_target(&target.key());
    }
    LocalForget::Done
}
