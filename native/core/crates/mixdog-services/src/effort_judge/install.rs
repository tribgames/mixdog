//! Installs the effort-judge model from the release the bundled manifest
//! names: every file is downloaded with its exact size, checked against its
//! sha256 and renamed into place, so a broken or partial download never
//! replaces a working file. Files that already match are kept. `install.json`
//! records the installed release; a newer bundled manifest makes the install
//! stale and the next install downloads only what changed.

use std::path::{Path, PathBuf};

use mixdog_rt::CpuBulk;
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::effort_judge::model::{ModelConfig, available_on};
use crate::lane::on_lane;
use crate::model_install::{
    InstallError, ProgressSink, Spec, download_to_file, fsio, sha256_file, write_file_atomic,
};

const STAMP: &str = "install.json";
/// Derived from `tokenizer.json` by older installs; stale once it is replaced.
const DERIVED: [&str; 1] = ["tokenizer.bin"];
const BUNDLED: &str = include_str!("model-manifest.json");

#[derive(Debug, Clone, Deserialize)]
pub struct ManifestFile {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub release: String,
    files: std::collections::BTreeMap<String, ManifestFile>,
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.chars().all(|c| c.is_ascii_hexdigit())
}

impl Manifest {
    pub fn parse(text: &str) -> Result<Self, InstallError> {
        let manifest: Self = serde_json::from_str(text).map_err(|e| InstallError::Manifest(e.to_string()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The manifest shipped with this build.
    pub fn bundled() -> Result<Self, InstallError> {
        Self::parse(BUNDLED)
    }

    fn validate(&self) -> Result<(), InstallError> {
        let bad = self.release.is_empty()
            || self.files.is_empty()
            || self.files.values().any(|f| !valid_sha256(&f.sha256) || f.size == 0 || !f.url.starts_with("https://"));
        if bad { Err(InstallError::Manifest("release, files, sha256, size and https url are required".into())) } else { Ok(()) }
    }

    /// For tests that serve the files from a local server.
    pub fn with_files(release: &str, files: impl IntoIterator<Item = (String, ManifestFile)>) -> Self {
        Self { release: release.to_owned(), files: files.into_iter().collect() }
    }

    pub fn files(&self) -> impl Iterator<Item = (&String, &ManifestFile)> {
        self.files.iter()
    }
}

/// The release named by the stamp; empty when it is missing or damaged, so a
/// damaged stamp reads as not installed.
#[allow(clippy::disallowed_methods, reason = "a lane-job body: async callers go through `install_current_on`, the host's info reader runs it as a read-lane job")]
pub fn stamped_release(dir: &Path) -> String {
    std::fs::read(dir.join(STAMP))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|json| json["release"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// A complete install of some release (stamped).
pub fn install_stamped(dir: &Path) -> bool {
    !stamped_release(dir).is_empty()
}

/// The install is the release the manifest names.
pub fn install_current(dir: &Path, manifest: &Manifest) -> bool {
    stamped_release(dir) == manifest.release
}

/// [`install_current`] as a job on `lane`.
pub async fn install_current_on(lane: CpuBulk, dir: &Path, manifest: &Manifest) -> Result<bool, InstallError> {
    let (dir, release) = (dir.to_owned(), manifest.release.clone());
    on_lane(lane, move || stamped_release(&dir) == release).await.map_err(InstallError::io)
}

/// Files in `dir` that are missing or differ from the manifest sha256. When any
/// does, the stamp is removed so the folder reads as not installed and the next
/// install fetches only those files (a crash can leave a stamped model with its
/// tail zeroed: same size, wrong hash).
pub async fn invalidate_damaged(dir: &Path, manifest: &Manifest, lane: CpuBulk) -> Result<Vec<String>, InstallError> {
    let mut bad = Vec::new();
    for (name, file) in manifest.files() {
        let target = dir.join(name);
        let matches = fsio::exists(lane, &target).await.map_err(InstallError::io)?
            && sha256_file(lane, &target).await? == file.sha256.to_lowercase();
        if !matches {
            bad.push(name.clone());
        }
    }
    if !bad.is_empty() {
        let _ = fsio::remove_file(lane, &dir.join(STAMP)).await;
    }
    Ok(bad)
}

fn partial_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_owned();
    name.push(format!(".{}.part", std::process::id()));
    target.with_file_name(name)
}

/// Downloads what is missing or different, then stamps the release.
pub async fn install_model(
    dir: &Path,
    manifest: &Manifest,
    lane: CpuBulk,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<(), InstallError> {
    fsio::create_dir_all(lane, dir).await.map_err(InstallError::io)?;
    let mut replaced = false;
    for (name, file) in manifest.files() {
        let target = dir.join(name);
        let expected = file.sha256.to_lowercase();
        if fsio::exists(lane, &target).await.map_err(InstallError::io)? && sha256_file(lane, &target).await? == expected {
            continue;
        }
        let partial = partial_path(&target);
        let label = format!("effort judge {name}");
        let outcome = async {
            download_to_file(
                &Spec { url: &file.url, dest: &partial, max_bytes: file.size, expected_bytes: file.size, label: &label, lane },
                progress,
                cancel,
            )
            .await?;
            let actual = sha256_file(lane, &partial).await?;
            if actual != expected {
                return Err(InstallError::Hash { label: label.clone(), expected: expected.clone(), actual });
            }
            // From the first replaced file until the new stamp, the folder is a
            // mix of releases: without a stamp it reads as not installed, so an
            // interrupted install is never loaded.
            if !replaced {
                let _ = fsio::remove_file(lane, &dir.join(STAMP)).await;
            }
            fsio::rename(lane, &partial, &target).await.map_err(InstallError::io)
        }
        .await;
        let _ = fsio::remove_file(lane, &partial).await;
        outcome?;
        replaced = true;
    }
    if replaced {
        for name in DERIVED {
            let _ = fsio::remove_file(lane, &dir.join(name)).await;
        }
    }
    let stamp = serde_json::json!({ "release": manifest.release }).to_string();
    write_file_atomic(lane, &dir.join(STAMP), stamp.as_bytes()).await
}

/// Installs or updates the model unless it is already the current release. An
/// explicitly named folder is used as it is and only has to hold the files.
pub async fn ensure_installed(
    config: &ModelConfig,
    manifest: &Manifest,
    lane: CpuBulk,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<(), InstallError> {
    if config.explicit || (available_on(lane, config).await? && install_current_on(lane, &config.dir, manifest).await?) {
        if !available_on(lane, config).await? {
            return Err(InstallError::NotInstalled(config.dir.display().to_string()));
        }
        return Ok(());
    }
    install_model(&config.dir, manifest, lane, progress, cancel).await
}

/// After a load failure: re-verifies the files against the manifest hashes and
/// fetches only the damaged ones. Returns the repaired file names.
pub async fn repair(
    config: &ModelConfig,
    manifest: &Manifest,
    lane: CpuBulk,
    progress: Option<&ProgressSink>,
    cancel: &CancellationToken,
) -> Result<Vec<String>, InstallError> {
    if config.explicit {
        return Ok(Vec::new());
    }
    let bad = invalidate_damaged(&config.dir, manifest, lane).await?;
    if !bad.is_empty() {
        install_model(&config.dir, manifest, lane, progress, cancel).await?;
    }
    Ok(bad)
}
