//! The `migrate/profile` domain: a core that was started without the Electron profile (standalone, or before the desktop
//! knew the directory) is told the profile later.
//!
//! - `migrate/profile/status` reports the generation the profile move is at and the profile the core has recorded.
//! - `migrate/profile/adopt` names the profile directory and runs generation 2 of the profile move
//!   ([`supplement::run`]: the saved SSH hosts, port forwards, paired PCs and server windows move to `<D>/desktop/`).
//!   It never runs the first pass's late profile pass.
//!
//! Both methods are Local-only, and `adopt` is refused to a Window (the core reads and moves files from the directory
//! named). The directory must be absolute and exist. Once a profile is recorded (`migration/profile-gen.json`, else the
//! migration's late manifest, else its manifest), only that profile may be named again, so a different directory is never
//! read from or deleted in. Only the files [`supplement`] lists are ever opened. A repeated adopt of the same profile
//! changes nothing.

#![allow(clippy::disallowed_methods, reason = "every file read here is the body of a job of an interactive-io or durability-io lane")]

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::PoisonError;

use async_trait::async_trait;
use mixdog_app_protocol::v2::migrate_profile::MigrateProfileAdoptParams;
use mixdog_app_protocol::v2::migrate_profile::MigrateProfileAdopted;
use mixdog_app_protocol::v2::migrate_profile::MigrateProfileStatus;
use mixdog_app_protocol::v2::migrate_profile::MigrateProfileStatusParams;
use mixdog_core_api::CoreError;
use mixdog_core_api::CoreRequest;
use mixdog_core_api::Reply;
use mixdog_core_api::ids::ConnectionId;
use mixdog_core_api::ids::Method;
use mixdog_core_api::service::Admit;
use mixdog_core_api::service::DomainService;
use mixdog_core_base::support::decode;
use mixdog_core_base::support::failed;
use mixdog_core_base::support::on_lane;
use mixdog_core_base::support::on_lane_wait;
use mixdog_core_base::support::invalid;
use mixdog_core_base::support::wrong_method;
use mixdog_migrate::desktop_profile::desktop_profile_dir_with;
use mixdog_migrate::desktop_profile::supplement;
use mixdog_migrate::framework::MigrationRoots;
use mixdog_rt::DurabilityIo;
use mixdog_rt::InteractiveIo;
use mixdog_rt::LaneTokens;
use mixdog_store::schema::migration::LATE_MANIFEST_PATH;
use mixdog_store::schema::migration::MANIFEST_PATH;
use mixdog_store::schema::migration::Manifest;
use mixdog_store::schema::migration::PROFILE_GEN_PATH;
use serde::Deserialize;
use serde_json::Value;

const DOMAIN: &str = "migrate";

/// The generation of a data dir whose journal holds no marker (the first pass's).
const FIRST_GENERATION: u32 = 1;

/// The fields of `migration/profile-gen.json` this domain reads (the file is the supplement pass's own journal).
#[derive(Deserialize)]
struct Marker {
    generation: u32,
    profile: String,
}

pub struct MigrateProfileService {
    data: PathBuf,
    home: PathBuf,
    interactive: InteractiveIo,
    durability: DurabilityIo,
    /// One adopt at a time: the journal is republished after every step.
    adopting: Arc<Mutex<()>>,
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("{}: {error}", path.display())),
    }
}

/// `Some(profile)` when the manifest exists (its profile may be none).
fn manifest_profile(path: &Path) -> Result<Option<Option<String>>, String> {
    let Some(bytes) = read_optional(path)? else { return Ok(None) };
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(Some(manifest.roots.profile))
}

/// The generation the data dir's profile move is at and the profile it has recorded: the supplement journal's, else the
/// late manifest's, else the first manifest's.
fn recorded(data: &Path) -> Result<(u32, Option<String>), String> {
    let marker_path = data.join(PROFILE_GEN_PATH);
    if let Some(bytes) = read_optional(&marker_path)? {
        let marker: Marker = serde_json::from_slice(&bytes).map_err(|error| format!("{}: {error}", marker_path.display()))?;
        return Ok((marker.generation, Some(marker.profile)));
    }
    for relative in [LATE_MANIFEST_PATH, MANIFEST_PATH] {
        if let Some(profile) = manifest_profile(&data.join(relative))? {
            return Ok((FIRST_GENERATION, profile));
        }
    }
    Ok((FIRST_GENERATION, None))
}

/// The same directory, spelled alike or resolving to one place.
fn same_directory(a: &Path, b: &Path) -> bool {
    a == b
        || match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

/// What `status` answers, read from the data dir.
fn status(data: &Path) -> Result<MigrateProfileStatus, CoreError> {
    let (generation, profile) = recorded(data).map_err(|error| failed(DOMAIN, error))?;
    Ok(MigrateProfileStatus { generation, completed_with_profile: profile.is_some(), profile })
}

/// Validates the named directory against the recorded profile and runs the supplement pass.
fn adopt(mut roots: MigrationRoots, adopting: &Mutex<()>) -> Result<MigrateProfileAdopted, CoreError> {
    // Absolute only; then spelled as the launcher's profile is (`locate`), so the journal records the same form.
    let Some(named) = roots.profile.as_deref().filter(|path| path.is_absolute()).and_then(|path| desktop_profile_dir_with(Some(path), &|_| None))
    else {
        return Err(invalid("userData", "an absolute path"));
    };
    roots.profile = Some(named.clone());
    if !named.is_dir() {
        return Err(invalid("userData", "an existing directory"));
    }
    let _one = adopting.lock().unwrap_or_else(PoisonError::into_inner);
    let (_, recorded) = recorded(&roots.data).map_err(|error| failed(DOMAIN, error))?;
    if let Some(recorded) = recorded {
        if !same_directory(&named, Path::new(&recorded)) {
            return Err(invalid("userData", "the profile directory already recorded for this data directory"));
        }
    }
    let outcome = supplement::run(&roots).map_err(|error| failed(DOMAIN, error.to_string()))?;
    Ok(MigrateProfileAdopted { generation: outcome.generation, moved: outcome.moved })
}

impl MigrateProfileService {
    /// `data` is `<D>` and `home` `<H>` of the migration; the file work runs on the lanes of `tokens`.
    pub fn new(data: PathBuf, home: PathBuf, tokens: &LaneTokens) -> Self {
        Self { data, home, interactive: tokens.interactive_io, durability: tokens.durability_io, adopting: Arc::new(Mutex::new(())) }
    }
}

fn reply<T: serde::Serialize>(answer: &T) -> Result<Reply, CoreError> {
    serde_json::to_value(answer).map(Reply::Value).map_err(|error| failed(DOMAIN, error.to_string()))
}

#[async_trait]
impl DomainService for MigrateProfileService {
    async fn call(&self, req: CoreRequest) -> Result<Reply, CoreError> {
        match req.method.as_str() {
            "migrate/profile/status" => {
                let _params: MigrateProfileStatusParams = decode(&req)?;
                let data = self.data.clone();
                reply(&on_lane(self.interactive, &req.ctx.cancel, move |_| status(&data)).await??)
            }
            "migrate/profile/adopt" => {
                let params: MigrateProfileAdoptParams = decode(&req)?;
                let roots = MigrationRoots { data: self.data.clone(), home: self.home.clone(), profile: Some(PathBuf::from(params.user_data)) };
                let adopting = self.adopting.clone();
                reply(&on_lane_wait(self.durability, &req.ctx.cancel, move |_| adopt(roots, &adopting)).await??)
            }
            other => Err(wrong_method(DOMAIN, other)),
        }
    }

    fn methods(&self) -> &'static [&'static str] {
        &["migrate/profile/status", "migrate/profile/adopt"]
    }

    fn notify(&self, _method: Method, _params: Value, _from: ConnectionId) -> Admit {
        Admit::Accepted
    }
}

#[cfg(test)]
#[path = "migrate_profile_tests.rs"]
mod tests;
