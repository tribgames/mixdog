//! The saved-server list operations: the list, rename, per-server settings and forget. A change of the saved model login is applied to
//! the server's attached link behind the answer.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_app_protocol::v2::connections::SshHost;
use mixdog_rt::TaskClass;
use mixdog_ssh::connect_failure::ConnectError;
use serde_json::Value;

use crate::attempts::{AttemptError, ServerLinks};
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
}

impl HostList {
    pub fn new(hosts: Arc<SshHostStore>, links: Arc<dyn HostLinks>) -> Self {
        Self { hosts, links }
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
        let record = self.hosts.get(id).ok_or_else(|| AttemptError::new("This SSH server is no longer saved."))?;
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

    /// Removes only the saved entry.
    pub async fn forget(&self, id: &str) -> Result<(), AttemptError> {
        self.hosts.forget(non_empty(id, "id")?).await.map_err(store_error)
    }
}
