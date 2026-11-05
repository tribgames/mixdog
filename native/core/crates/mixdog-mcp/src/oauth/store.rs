//! Where a sign-in lives: the secret store (`mixdog-secrets`, the Node-compatible keychain) holds
//! the credentials; beside it, two non-secret files per account tell the rest of the app what is
//! stored without a keychain read — `<account>.rev` (the entry's revision, with `+tokens` when it
//! holds tokens) and `<account>.who` (who the sign-in belongs to).

use std::path::PathBuf;

use mixdog_rt::DurabilityIo;
use mixdog_rt::LaneToken;
use serde::Deserialize;
use serde::Serialize;
use tokio_util::sync::CancellationToken;

pub use mixdog_secrets::MemoryStore;
pub use mixdog_secrets::SecretError as StoreError;
pub use mixdog_secrets::SecretStore;

use super::account::Identity;
use super::account::can_force_account_choice;

/// Runs a blocking closure on the durability lane.
async fn on_lane<T: Send + 'static>(io: DurabilityIo, work: impl FnOnce() -> T + Send + 'static) -> Result<T, StoreError> {
    let job = io.submit(&CancellationToken::new(), move |_lane| work()).map_err(|_| StoreError::new("the durability lane is full"))?;
    job.await.map_err(|e| StoreError::new(format!("{e:?}")))
}

pub const TOKENS_FLAG: &str = "+tokens";

/// The revision marker: `deleted` when there is no entry, the revision, plus the tokens flag.
pub fn marker_of(revision: Option<&str>, has_tokens: bool) -> String {
    match revision {
        None => "deleted".to_owned(),
        Some(revision) if has_tokens => format!("{revision}{TOKENS_FLAG}"),
        Some(revision) => revision.to_owned(),
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhoFile {
    #[serde(default)]
    account: String,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    forced_choice: bool,
}

/// Who a stored sign-in belongs to, as the status lists it.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StoredIdentity {
    pub account: String,
    pub workspace: String,
    pub forced_choice: bool,
}

/// The non-secret marker files of the accounts, under `<plugin data>/mcp-oauth/`.
#[derive(Clone)]
pub struct MarkerFiles {
    dir: PathBuf,
    io: DurabilityIo,
}

#[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
fn write_atomic(dir: &std::path::Path, name: &str, text: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join(name)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

impl MarkerFiles {
    pub fn new(plugin_data: PathBuf, io: DurabilityIo) -> Self {
        Self { dir: plugin_data.join("mcp-oauth"), io }
    }

    pub async fn write_revision(&self, account: &str, revision: Option<&str>, has_tokens: bool) -> Result<(), StoreError> {
        let (dir, name, text) = (self.dir.clone(), format!("{account}.rev"), marker_of(revision, has_tokens));
        on_lane(self.io, move || write_atomic(&dir, &name, &text)).await?.map_err(|e| StoreError::new(e.to_string()))
    }

    /// Writes who the sign-in belongs to, or removes the file when signed out.
    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    pub async fn write_identity(
        &self,
        account: &str,
        identity: Option<(&Identity, Option<&str>)>,
    ) -> Result<(), StoreError> {
        let (dir, name) = (self.dir.clone(), format!("{account}.who"));
        let text = identity.map(|(who, authorization_endpoint)| {
            serde_json::to_string(&WhoFile {
                account: who.account.clone(),
                workspace: who.workspace.clone(),
                forced_choice: can_force_account_choice(authorization_endpoint),
            })
            .unwrap_or_default()
        });
        on_lane(self.io, move || match text {
            Some(text) => write_atomic(&dir, &name, &text),
            None => std::fs::remove_file(dir.join(&name)).or_else(|e| if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
        })
        .await?
        .map_err(|e| StoreError::new(e.to_string()))
    }

    #[allow(clippy::disallowed_methods, reason = "runs as a durability-lane job")]
    async fn read(&self, name: String) -> Option<String> {
        let path = self.dir.join(name);
        on_lane(self.io, move || std::fs::read_to_string(path).ok()).await.ok().flatten()
    }

    /// Whether tokens are stored for `account`, from the marker alone.
    pub async fn has_tokens(&self, account: &str) -> bool {
        self.read(format!("{account}.rev")).await.is_some_and(|m| m.ends_with(TOKENS_FLAG))
    }

    pub async fn identity(&self, account: &str) -> Option<StoredIdentity> {
        let text = self.read(format!("{account}.who")).await?;
        let file: WhoFile = serde_json::from_str(&text).ok()?;
        Some(StoredIdentity { account: file.account, workspace: file.workspace, forced_choice: file.forced_choice })
    }
}
