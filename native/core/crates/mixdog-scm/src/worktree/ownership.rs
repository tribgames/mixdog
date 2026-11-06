//! Live owner leases and shared references. Durable ownership is the registry record's
//! `ownerSessionId` (the session retains the worktree across restarts); the lease says which
//! runtime of that session holds it right now. A lease is matched on the exact owner
//! (`sessionId` + `runtimeToken`); the pid is a diagnostic hint only, never the identity.
//!
//! Leases live at `<root>/.owners/<id>.json`, outside the checkout, so they never show up as
//! untracked files in it.

#![allow(clippy::disallowed_methods, clippy::disallowed_types, reason = "every blocking std::fs call in this module is the body of a lane job")]

use std::path::Path;
use std::path::PathBuf;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::error::ScmFailure;
use crate::repo::on_lane;
use crate::worktree::errors;
use crate::worktree::manager::Worktrees;
use crate::worktree::manager::entry_json;
use crate::worktree::names::managed_root;
use crate::worktree::registry::WorktreeRecord;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Owner {
    pub session_id: String,
    pub runtime_token: String,
    #[serde(default)]
    pub pid: Option<u32>,
}

impl Owner {
    pub fn validate(&self) -> Result<(), ScmFailure> {
        if self.session_id.trim().is_empty() || self.runtime_token.trim().is_empty() {
            return Err(ScmFailure::invalid("owner", "a session id and a runtime token"));
        }
        if self.pid == Some(0) {
            return Err(ScmFailure::invalid("owner.pid", "a positive integer or null"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    #[serde(flatten)]
    pub owner: Owner,
    pub entry_id: String,
    #[serde(default)]
    pub claimed_at: Option<i64>,
}

pub fn same_owner(left: &Option<Owner>, right: &Owner) -> bool {
    left.as_ref()
        .is_some_and(|left| left.session_id == right.session_id && left.runtime_token == right.runtime_token)
}

/// A destructive operation needs proof of death, not merely a failed probe: no pid, or a probe
/// that cannot tell, reads as alive.
pub fn pid_alive_or_unknown(pid: Option<u32>) -> bool {
    let Some(pid) = pid.filter(|pid| *pid > 0) else {
        return true;
    };
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only probes the process table.
        let found = unsafe { libc::kill(pid as libc::pid_t, 0) };
        found == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
        use windows_sys::Win32::Foundation::GetLastError;
        use windows_sys::Win32::System::Threading::GetExitCodeProcess;
        use windows_sys::Win32::System::Threading::OpenProcess;
        use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
        const STILL_ACTIVE: u32 = 259;
        // SAFETY: plain handle calls; the handle is closed before returning.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() != ERROR_INVALID_PARAMETER;
            }
            let mut code = 0u32;
            let known = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            !known || code == STILL_ACTIVE
        }
    }
}

pub(crate) fn lease_path(data_dir: &Path, record: &WorktreeRecord) -> PathBuf {
    managed_root(data_dir, Path::new(&record.repo_common_dir))
        .join(".owners")
        .join(format!("{}.json", record.id))
}

fn read_lease_file(path: &Path, record_id: &str) -> Result<Option<Lease>, ScmFailure> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    // A lease that does not parse or validate is no lease.
    let Ok(mut lease) = serde_json::from_slice::<Lease>(&bytes) else {
        return Ok(None);
    };
    if lease.owner.validate().is_err() {
        return Ok(None);
    }
    if lease.entry_id.is_empty() {
        lease.entry_id = record_id.to_owned();
    }
    Ok(Some(lease))
}

fn write_lease_file(path: &Path, lease: &Lease) -> Result<(), ScmFailure> {
    let dir = path.parent().ok_or_else(|| ScmFailure::invalid("path", "a file path"))?;
    std::fs::create_dir_all(dir)?;
    let temp = path.with_extension(format!("json.tmp-{}", std::process::id()));
    std::fs::write(&temp, serde_json::to_vec(lease).map_err(|e| ScmFailure::git(e.to_string()))?)?;
    std::fs::rename(&temp, path)?;
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn shared_leases(record: &WorktreeRecord) -> serde_json::Map<String, Value> {
    record
        .extra
        .get("sharedLeases")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

impl Worktrees {
    pub async fn read_owner_lease(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Option<Lease>, ScmFailure> {
        let path = lease_path(self.data_dir(), record);
        let id = record.id.clone();
        on_lane(self.scm().lane, cancel, move || read_lease_file(&path, &id)).await?
    }

    /// Binds the runtime `owner` to the worktree: writes the lease file.
    pub(crate) async fn write_owner_lease(&self, record: &WorktreeRecord, owner: &Owner, cancel: &CancellationToken) -> Result<Lease, ScmFailure> {
        owner.validate()?;
        let lease = Lease { owner: owner.clone(), entry_id: record.id.clone(), claimed_at: Some(now_ms()) };
        let (path, written) = (lease_path(self.data_dir(), record), lease.clone());
        on_lane(self.scm().lane, cancel, move || write_lease_file(&path, &written)).await??;
        Ok(lease)
    }

    /// Every live lease on the record: the owner's and each sharing session's.
    pub async fn leases_of(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<Vec<Lease>, ScmFailure> {
        let mut leases: Vec<Lease> = self.read_owner_lease(record, cancel).await?.into_iter().collect();
        for value in shared_leases(record).into_values() {
            if let Ok(lease) = serde_json::from_value::<Lease>(value) {
                leases.push(lease);
            }
        }
        Ok(leases)
    }

    /// The session runtime `owner` takes the worktree. Another session's claim becomes a shared
    /// reference; the first claim of an unowned worktree makes the claimant its owner.
    pub async fn claim_owner(&self, entry_id: &str, owner: Owner, cancel: &CancellationToken) -> Result<Value, ScmFailure> {
        owner.validate()?;
        let found = self
            .record(cancel, entry_id)
            .await?
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let repo = self.scm().open(Path::new(&found.project_path), cancel).await?;
        let _lock = repo.lock_repository().await?;
        let mut current = self
            .record(cancel, entry_id)
            .await?
            .filter(|r| r.state == "ready")
            .ok_or_else(|| errors::missing(Some(entry_id.to_owned()), None, None))?;
        let lease = Lease {
            owner: owner.clone(),
            entry_id: entry_id.to_owned(),
            claimed_at: Some(now_ms()),
        };
        if let Some(holder) = current.owner_session_id.clone().filter(|holder| *holder != owner.session_id) {
            let _ = holder;
            let reference_added = !current.shared_session_ids.contains(&owner.session_id);
            if reference_added {
                current.shared_session_ids.push(owner.session_id.clone());
            }
            let mut leases = shared_leases(&current);
            let previous = leases
                .get(&owner.session_id)
                .and_then(|v| serde_json::from_value::<Lease>(v.clone()).ok());
            leases.insert(owner.session_id.clone(), serde_json::to_value(&lease).unwrap_or(Value::Null));
            current.extra.insert("sharedLeases".into(), Value::Object(leases));
            current.extra.insert("disposable".into(), json!(false));
            self.put_record(cancel, current.clone()).await?;
            let replaced = previous.filter(|p| !same_owner(&Some(p.owner.clone()), &owner));
            return Ok(json!({ "entry": entry_json(&current), "lease": lease, "referenceAdded": reference_added, "replaced": replaced }));
        }
        if current.owner_session_id.is_none() {
            let other = self
                .all_records(cancel)
                .await?
                .into_iter()
                .find(|r| r.owner_session_id.as_deref() == Some(owner.session_id.as_str()) && r.id != entry_id);
            if let Some(other) = other {
                return Err(ScmFailure::coded(
                    errors::WORKTREE_REVISION_CONFLICT,
                    mixdog_protocol::DomainErrorDetail::WorktreeRevisionConflict {
                        entry_id: Some(other.id),
                        remaining: None,
                        branch: None,
                        tx_id: None,
                        expected_revision: None,
                        revision: None,
                    },
                ));
            }
            current.owner_session_id = Some(owner.session_id.clone());
            self.put_record(cancel, current.clone()).await?;
        }
        let previous = self.read_owner_lease(&current, cancel).await?;
        let path = lease_path(self.data_dir(), &current);
        let written = lease.clone();
        on_lane(self.scm().lane, cancel, move || write_lease_file(&path, &written)).await??;
        let replaced = previous.filter(|p| !same_owner(&Some(p.owner.clone()), &owner));
        Ok(json!({ "entry": entry_json(&current), "lease": lease, "replaced": replaced }))
    }

    /// Releases the live lease when, and only when, exactly `owner` holds it. Durable ownership
    /// (the session retaining the worktree) is unchanged.
    pub async fn release_owner(
        &self,
        entry_id: &str,
        owner: Owner,
        forget_reference: bool,
        cancel: &CancellationToken,
    ) -> Result<Value, ScmFailure> {
        owner.validate()?;
        let Some(found) = self.record(cancel, entry_id).await? else {
            return Ok(json!({ "released": false }));
        };
        let repo = self.scm().open(Path::new(&found.project_path), cancel).await?;
        let _lock = repo.lock_repository().await?;
        let Some(mut current) = self.record(cancel, entry_id).await? else {
            return Ok(json!({ "released": false }));
        };
        let mut leases = shared_leases(&current);
        let shared = leases
            .get(&owner.session_id)
            .and_then(|v| serde_json::from_value::<Lease>(v.clone()).ok())
            .map(|l| l.owner);
        if same_owner(&shared, &owner) {
            leases.remove(&owner.session_id);
            current.extra.insert("sharedLeases".into(), Value::Object(leases));
            if forget_reference {
                current.shared_session_ids.retain(|id| *id != owner.session_id);
            }
            self.put_record(cancel, current).await?;
            return Ok(json!({ "released": true }));
        }
        let held = self.read_owner_lease(&current, cancel).await?.map(|l| l.owner);
        if !same_owner(&held, &owner) {
            return Ok(json!({ "released": false }));
        }
        let path = lease_path(self.data_dir(), &current);
        on_lane(self.scm().lane, cancel, move || std::fs::remove_file(path).or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound { Ok(()) } else { Err(e) }
        }))
        .await??;
        Ok(json!({ "released": true }))
    }

    /// Whether a runtime still holds the worktree: the owner's or a sharer's lease whose
    /// process is alive or cannot be told dead.
    pub async fn owner_live(&self, record: &WorktreeRecord, cancel: &CancellationToken) -> Result<bool, ScmFailure> {
        Ok(self
            .leases_of(record, cancel)
            .await?
            .iter()
            .any(|lease| pid_alive_or_unknown(lease.owner.pid)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pid_is_alive_when_it_is_ours_or_unknown_and_dead_when_proven() {
        assert!(pid_alive_or_unknown(Some(std::process::id())));
        assert!(pid_alive_or_unknown(None));
        let mut child = std::process::Command::new(if cfg!(windows) { "cmd" } else { "true" })
            .args(if cfg!(windows) { vec!["/c", "exit"] } else { vec![] })
            .spawn()
            .unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!pid_alive_or_unknown(Some(pid)));
    }

    #[test]
    fn leases_round_trip_and_garbage_is_no_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".owners").join("w.json");
        let lease = Lease {
            owner: Owner { session_id: "s".into(), runtime_token: "t".into(), pid: Some(7) },
            entry_id: "w".into(),
            claimed_at: Some(1),
        };
        write_lease_file(&path, &lease).unwrap();
        assert_eq!(read_lease_file(&path, "w").unwrap(), Some(lease));
        std::fs::write(&path, b"{ nope").unwrap();
        assert_eq!(read_lease_file(&path, "w").unwrap(), None);
    }
}
