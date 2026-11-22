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

/// The identity of the installation whose data directory is `data_dir`, made on first use and kept in it. It names the
/// installation's sign-ins in a secret store other installations share, so a copy of the directory that leaves this
/// file out is another installation. `None`: the directory could not keep one.
#[allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "one small file, read once while the daemon is composed")]
pub fn installation_identity(data_dir: &std::path::Path) -> Option<String> {
    use std::io::Write;
    let path = data_dir.join("installation-id");
    let kept = || std::fs::read_to_string(&path).ok().map(|text| text.trim().to_owned()).filter(|id| !id.is_empty());
    if let Some(id) = kept() {
        return Some(id);
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::create_dir_all(data_dir).ok()?;
    // Written whole under another name and then given its own: the name never holds less than an identity, and a
    // name that exists is not replaced.
    let staged = data_dir.join(format!("installation-id.{id}.tmp"));
    let written = std::fs::File::create(&staged).and_then(|mut file| {
        file.write_all(id.as_bytes())?;
        file.sync_all()
    });
    let made = written.and_then(|()| std::fs::hard_link(&staged, &path));
    let _ = std::fs::remove_file(&staged);
    match made {
        Ok(()) => Some(id),
        // Another process of this installation made it first.
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => kept(),
        Err(_) => None,
    }
}

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
    pub async fn write_identity(&self, account: &str, identity: Option<(&Identity, Option<&str>)>) -> Result<(), StoreError> {
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
    /// The marker's text; `Ok(None)` when it cannot be read (Node's `catch { return false }`
    /// in `hasStoredMcpOAuthTokens`), `Err` when the read job did not run, which says nothing
    /// about the file and must not read as "signed out".
    async fn read(&self, name: String) -> Result<Option<String>, StoreError> {
        let path = self.dir.join(name);
        on_lane(self.io, move || std::fs::read_to_string(path).ok()).await
    }

    /// Whether tokens are stored for `account`, from the marker alone.
    pub async fn has_tokens(&self, account: &str) -> Result<bool, StoreError> {
        Ok(self.read(format!("{account}.rev")).await?.is_some_and(|m| m.ends_with(TOKENS_FLAG)))
    }

    /// The revision of the entry stored for `account`, from the marker alone; `None` when it lists no entry.
    pub async fn revision(&self, account: &str) -> Result<Option<String>, StoreError> {
        let marker = self.read(format!("{account}.rev")).await?;
        let revision = marker.map(|marker| {
            let marker = marker.trim();
            marker.strip_suffix(TOKENS_FLAG).unwrap_or(marker).to_owned()
        });
        Ok(revision.filter(|revision| !revision.is_empty() && revision != "deleted"))
    }

    pub async fn identity(&self, account: &str) -> Result<Option<StoredIdentity>, StoreError> {
        let Some(text) = self.read(format!("{account}.who")).await? else { return Ok(None) };
        let file: Option<WhoFile> = serde_json::from_str(&text).ok();
        Ok(file.map(|file| StoredIdentity { account: file.account, workspace: file.workspace, forced_choice: file.forced_choice }))
    }
}

#[cfg(test)]
#[allow(clippy::disallowed_methods, reason = "the test reads the directory it made")]
mod tests {
    use super::installation_identity;

    /// Several starts of a new installation at once: each reads the one identity, whole, and nothing else is left in
    /// the directory. The file never exists without its content, so no start reads it empty.
    #[test]
    fn every_start_of_a_new_installation_reads_the_one_whole_identity() {
        let dir = tempfile::tempdir().unwrap();
        let ids: Vec<Option<String>> = std::thread::scope(|scope| {
            let starts: Vec<_> = (0..8).map(|_| scope.spawn(|| installation_identity(dir.path()))).collect();
            starts.into_iter().map(|start| start.join().unwrap()).collect()
        });
        let first = ids[0].clone().expect("an identity");
        assert_eq!(first.len(), 32, "{first}");
        assert!(ids.iter().all(|id| id.as_ref() == Some(&first)), "{ids:?}");
        let left: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|entry| entry.unwrap().file_name()).collect();
        assert_eq!(left, ["installation-id"]);
        assert_eq!(installation_identity(dir.path()), Some(first));
    }
}
